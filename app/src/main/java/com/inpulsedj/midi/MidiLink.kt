package com.inpulsedj.midi

import android.content.Context
import android.hardware.usb.UsbDevice
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiInputPort
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import androidx.core.os.BundleCompat
import com.inpulsedj.controller.Inpulse300Mk2
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.Closeable
import java.io.IOException

data class MidiPortSummary(val number: Int, val name: String)

data class MidiDeviceSummary(
    val id: Int,
    val displayName: String,
    val transport: String,
    val vendorId: Int?,
    val productId: Int?,
    /** Ports sending data controller -> app ("MIDI IN" from the app's point of view). */
    val midiIn: List<MidiPortSummary>,
    /** Ports receiving data app -> controller ("MIDI OUT", used for LED feedback). */
    val midiOut: List<MidiPortSummary>,
    val isInpulse300: Boolean
) {
    val vidPid: String
        get() = if (vendorId != null && productId != null) "%04X:%04X".format(vendorId, productId) else "n/a"
}

enum class LinkPhase { MIDI_UNAVAILABLE, NO_DEVICE, IDLE, OPENING, CONNECTED, LOST }

data class LinkState(
    val phase: LinkPhase = LinkPhase.NO_DEVICE,
    val deviceName: String? = null,
    val isInpulse: Boolean = false,
    val midiInOpen: Boolean = false,
    val midiOutOpen: Boolean = false,
    val detail: String = ""
)

/**
 * Talks to the real controller through android.media.midi (which is what Android uses for
 * USB class-compliant MIDI devices). Incoming bytes are parsed on the MIDI service thread and
 * handed to [onEvent]; keep that callback non-blocking.
 *
 * Reconnect: when the connected device disappears the link goes to LOST and re-opens the same
 * device (matched by name) when it reappears, unless the user pressed Disconnect.
 */
class MidiLink(
    context: Context,
    private val onEvent: (MidiEvent) -> Unit,
    private val log: (String) -> Unit = {}
) {
    private val manager = context.getSystemService(Context.MIDI_SERVICE) as? MidiManager
    private val handler = Handler(Looper.getMainLooper())

    private val _devices = MutableStateFlow<List<MidiDeviceSummary>>(emptyList())
    val devices: StateFlow<List<MidiDeviceSummary>> = _devices.asStateFlow()

    private val _state = MutableStateFlow(LinkState())
    val state: StateFlow<LinkState> = _state.asStateFlow()

    private var infos: List<MidiDeviceInfo> = emptyList()
    private var device: MidiDevice? = null
    private var outPort: MidiOutputPort? = null          // device -> app
    @Volatile private var inPort: MidiInputPort? = null  // app -> device
    private var receiver: Receiver? = null
    private var connectedId = -1
    private var wantedName: String? = null
    private var userDisconnected = false
    private var attempts = 0
    private var generation = 0
    private var started = false

    private val callback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(info: MidiDeviceInfo) {
            infos = infos.filter { it.id != info.id } + info
            publishDevices()
            autoConnectIfWanted(info)
        }

        override fun onDeviceRemoved(info: MidiDeviceInfo) {
            infos = infos.filter { it.id != info.id }
            publishDevices()
            if (info.id == connectedId) onLost(info)
        }
    }

    @Suppress("DEPRECATION")
    fun start() {
        if (started) return
        val m = manager
        if (m == null) {
            _state.value = LinkState(
                phase = LinkPhase.MIDI_UNAVAILABLE,
                detail = "This phone does not provide Android's MIDI service (android.software.midi)."
            )
            return
        }
        started = true
        m.registerDeviceCallback(callback, handler)
        rescan()
        infos.firstOrNull { it.toSummary().isInpulse300 }?.let { autoConnectIfWanted(it) }
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        if (started) manager?.unregisterDeviceCallback(callback)
        started = false
        closeInternal()
    }

    @Suppress("DEPRECATION")
    fun rescan() {
        val m = manager ?: return
        infos = m.devices.toList()
        publishDevices()
    }

    /** Connect to the Inpulse if present, otherwise the first MIDI device (raw monitor still works). */
    fun connectDefault() {
        val target = infos.firstOrNull { it.toSummary().isInpulse300 } ?: infos.firstOrNull() ?: return
        connect(target.id)
    }

    fun connect(deviceId: Int) {
        val info = infos.firstOrNull { it.id == deviceId } ?: return
        userDisconnected = false
        attempts = 0
        open(info)
    }

    fun disconnect() {
        userDisconnected = true
        generation++
        handler.removeCallbacksAndMessages(null)
        closeInternal()
        _state.value = LinkState(
            phase = if (infos.isEmpty()) LinkPhase.NO_DEVICE else LinkPhase.IDLE,
            detail = "Disconnected. Press Connect to open the controller again."
        )
    }

    /** Send raw MIDI to the controller (LED feedback). Returns false if MIDI OUT is not open. */
    fun send(bytes: ByteArray): Boolean {
        val port = inPort ?: return false
        return try {
            port.send(bytes, 0, bytes.size)
            true
        } catch (e: IOException) {
            log("send failed: $e")
            false
        }
    }

    // ---- internals -------------------------------------------------------------------------

    private fun publishDevices() {
        _devices.value = infos.map { it.toSummary() }
        val s = _state.value
        if (s.phase == LinkPhase.NO_DEVICE || s.phase == LinkPhase.IDLE) {
            val none = infos.isEmpty()
            _state.value = s.copy(
                phase = if (none) LinkPhase.NO_DEVICE else LinkPhase.IDLE,
                detail = if (none) "Plug the controller in with a USB OTG cable."
                else "MIDI device found. Press Connect."
            )
        }
    }

    private fun isBusy() = _state.value.phase.let { it == LinkPhase.CONNECTED || it == LinkPhase.OPENING }

    private fun autoConnectIfWanted(info: MidiDeviceInfo) {
        if (userDisconnected || isBusy()) return
        val s = info.toSummary()
        val wanted = wantedName
        val match = if (wanted != null) s.displayName == wanted else s.isInpulse300
        if (!match) return
        // Give Android a moment to finish enumerating the USB device.
        handler.postDelayed({
            if (!userDisconnected && !isBusy() && infos.any { it.id == info.id }) {
                attempts = 0
                open(info)
            }
        }, 300)
    }

    private fun open(info: MidiDeviceInfo) {
        val m = manager ?: return
        closeInternal()
        val gen = ++generation
        val s = info.toSummary()
        _state.value = LinkState(
            phase = LinkPhase.OPENING,
            deviceName = s.displayName,
            isInpulse = s.isInpulse300,
            detail = "Opening MIDI device..."
        )
        m.openDevice(info, { dev ->
            when {
                gen != generation -> closeQuietly(dev)          // user cancelled while opening
                dev == null -> onOpenFailed(info)
                else -> onOpened(info, s, dev)
            }
        }, handler)
    }

    private fun onOpened(info: MidiDeviceInfo, s: MidiDeviceSummary, dev: MidiDevice) {
        val rx = Receiver()
        var inOpen = false
        var outOpen = false
        try {
            if (info.outputPortCount > 0) {
                outPort = dev.openOutputPort(0)?.also { it.connect(rx); outOpen = true }
            }
            if (info.inputPortCount > 0) {
                inPort = dev.openInputPort(0)
                inOpen = inPort != null
            }
        } catch (e: Exception) {
            log("opening ports failed: $e")
        }
        if (!outOpen && !inOpen) {
            closeQuietly(dev)
            onOpenFailed(info)
            return
        }
        device = dev
        receiver = rx
        connectedId = info.id
        wantedName = s.displayName
        attempts = 0
        _state.value = LinkState(
            phase = LinkPhase.CONNECTED,
            deviceName = s.displayName,
            isInpulse = s.isInpulse300,
            midiInOpen = outOpen,
            midiOutOpen = inOpen,
            detail = when {
                !outOpen -> "MIDI IN could not be opened, so no messages will arrive."
                !inOpen -> "MIDI OUT could not be opened (another app may hold it). Receiving only."
                else -> "MIDI IN and MIDI OUT open."
            }
        )
    }

    private fun onOpenFailed(info: MidiDeviceInfo) {
        val s = info.toSummary()
        if (!userDisconnected && attempts < MAX_ATTEMPTS) {
            attempts++
            _state.value = LinkState(
                phase = LinkPhase.OPENING,
                deviceName = s.displayName,
                isInpulse = s.isInpulse300,
                detail = "Could not open yet (try $attempts of $MAX_ATTEMPTS). Retrying..."
            )
            handler.postDelayed({
                val current = infos.firstOrNull { it.id == info.id }
                if (current != null && !userDisconnected && _state.value.phase != LinkPhase.CONNECTED) open(current)
            }, 800L * attempts)
        } else {
            _state.value = LinkState(
                phase = LinkPhase.IDLE,
                deviceName = s.displayName,
                isInpulse = s.isInpulse300,
                detail = "Could not open the MIDI ports. Close any other DJ or MIDI app that may be using the controller, then press Connect."
            )
        }
    }

    private fun onLost(info: MidiDeviceInfo) {
        val s = info.toSummary()
        closeInternal()
        _state.value = LinkState(
            phase = LinkPhase.LOST,
            deviceName = s.displayName,
            isInpulse = s.isInpulse300,
            detail = "Controller disconnected. It will reconnect automatically when it reappears."
        )
    }

    private fun closeInternal() {
        val rx = receiver
        if (rx != null) {
            try {
                outPort?.disconnect(rx)
            } catch (e: Exception) {
                log("disconnect: $e")
            }
        }
        closeQuietly(outPort)
        closeQuietly(inPort)
        closeQuietly(device)
        outPort = null
        inPort = null
        device = null
        receiver = null
        connectedId = -1
    }

    private fun closeQuietly(c: Closeable?) {
        try {
            c?.close()
        } catch (e: IOException) {
            log("close: $e")
        }
    }

    /** Runs on the MIDI service thread. Own parser per connection so running status starts clean. */
    private inner class Receiver : MidiReceiver() {
        private val parser = MidiParser(onEvent)

        override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
            parser.feed(msg, offset, count, if (timestamp == 0L) System.nanoTime() else timestamp)
        }
    }

    private companion object {
        const val MAX_ATTEMPTS = 5
    }
}

private fun MidiDeviceInfo.toSummary(): MidiDeviceSummary {
    val p = properties
    val name = p.getString(MidiDeviceInfo.PROPERTY_NAME).orEmpty()
    val product = p.getString(MidiDeviceInfo.PROPERTY_PRODUCT).orEmpty()
    val maker = p.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER).orEmpty()
    val usb = BundleCompat.getParcelable(p, MidiDeviceInfo.PROPERTY_USB_DEVICE, UsbDevice::class.java)

    val midiIn = mutableListOf<MidiPortSummary>()
    val midiOut = mutableListOf<MidiPortSummary>()
    for (port in ports) {
        val ps = MidiPortSummary(port.portNumber, port.name.orEmpty())
        // PortInfo.TYPE_OUTPUT = the device's output = data coming into the app.
        if (port.type == MidiDeviceInfo.PortInfo.TYPE_OUTPUT) midiIn += ps else midiOut += ps
    }

    return MidiDeviceSummary(
        id = id,
        displayName = name.ifBlank { product }.ifBlank { "MIDI device $id" },
        transport = when (type) {
            MidiDeviceInfo.TYPE_USB -> "USB"
            MidiDeviceInfo.TYPE_VIRTUAL -> "Virtual"
            MidiDeviceInfo.TYPE_BLUETOOTH -> "Bluetooth"
            else -> "Other"
        },
        vendorId = usb?.vendorId,
        productId = usb?.productId,
        midiIn = midiIn,
        midiOut = midiOut,
        isInpulse300 = Inpulse300Mk2.matches(listOf(name, product, maker))
    )
}
