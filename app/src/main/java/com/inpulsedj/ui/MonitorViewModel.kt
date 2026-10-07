package com.inpulsedj.ui

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.inpulsedj.midi.LinkState
import com.inpulsedj.midi.MidiDeviceSummary
import com.inpulsedj.midi.MidiEvent
import com.inpulsedj.midi.MidiKind
import com.inpulsedj.midi.MidiLink
import com.inpulsedj.usb.UsbDeviceSummary
import com.inpulsedj.usb.UsbHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

data class LogLine(val seq: Long, val time: String, val kind: MidiKind, val text: String, val hex: String)

data class MonitorStats(val total: Long = 0, val perSecond: Int = 0, val hiddenRealtime: Long = 0)

class MonitorViewModel(private val app: Application) : AndroidViewModel(app) {

    private val startNs = System.nanoTime()

    // The MIDI thread only does a non-blocking trySend; formatting and UI updates happen elsewhere.
    private val events = Channel<MidiEvent>(8192, BufferOverflow.DROP_OLDEST)
    private val total = AtomicLong()
    private val usbHelper = UsbHelper(app)

    private val link = MidiLink(
        context = app,
        onEvent = { ev ->
            total.incrementAndGet()
            events.trySend(ev)
        },
        log = { Log.d(TAG, it) }
    )

    val linkState: StateFlow<LinkState> = link.state
    val midiDevices: StateFlow<List<MidiDeviceSummary>> = link.devices

    private val _usbDevices = MutableStateFlow<List<UsbDeviceSummary>>(emptyList())
    val usbDevices: StateFlow<List<UsbDeviceSummary>> = _usbDevices.asStateFlow()

    private val _log = MutableStateFlow<List<LogLine>>(emptyList())
    val log: StateFlow<List<LogLine>> = _log.asStateFlow()

    private val _stats = MutableStateFlow(MonitorStats())
    val stats: StateFlow<MonitorStats> = _stats.asStateFlow()

    private val _hideRealtime = MutableStateFlow(true)
    val hideRealtime: StateFlow<Boolean> = _hideRealtime.asStateFlow()

    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused.asStateFlow()

    private val clearRequested = AtomicLong()

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            refreshUsb()
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(UsbHelper.ACTION_USB_PERMISSION)
        }
        ContextCompat.registerReceiver(app, usbReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        refreshUsb()
        link.start()
        viewModelScope.launch(Dispatchers.Default) { drainLoop() }
    }

    fun connect() = link.connectDefault()
    fun connectTo(deviceId: Int) = link.connect(deviceId)
    fun disconnect() = link.disconnect()
    fun requestUsbPermission(deviceName: String) = usbHelper.requestPermission(deviceName)
    fun setHideRealtime(v: Boolean) { _hideRealtime.value = v }
    fun setPaused(v: Boolean) { _paused.value = v }
    fun clearLog() { clearRequested.incrementAndGet() }

    fun refreshAll() {
        refreshUsb()
        link.rescan()
    }

    private fun refreshUsb() {
        _usbDevices.value = usbHelper.snapshot()
    }

    /** Formats incoming events at ~25 Hz so a busy jog wheel cannot flood the UI. */
    private suspend fun drainLoop() {
        val lines = ArrayDeque<LogLine>()   // newest first
        var seq = 0L
        var seenClear = 0L
        var windowStart = System.nanoTime()
        var windowCount = 0
        var perSecond = 0
        var hidden = 0L

        while (true) {
            delay(40)
            var changed = false

            val clearNow = clearRequested.get()
            if (clearNow != seenClear) {
                seenClear = clearNow
                lines.clear()
                changed = true
            }

            while (true) {
                val ev = events.tryReceive().getOrNull() ?: break
                windowCount++
                if (_paused.value) continue
                val kind = ev.kind
                if (_hideRealtime.value && (kind == MidiKind.CLOCK || kind == MidiKind.ACTIVE_SENSING)) {
                    hidden++
                    continue
                }
                val ms = (ev.timestampNs - startNs) / 1_000_000.0
                lines.addFirst(LogLine(seq++, String.format(Locale.US, "%.3f", ms / 1000.0), kind, ev.describe(), ev.hex()))
                if (lines.size > MAX_LINES) lines.removeLast()
                changed = true
            }

            val now = System.nanoTime()
            if (now - windowStart >= 1_000_000_000L) {
                perSecond = windowCount
                windowCount = 0
                windowStart = now
            }
            if (changed) _log.value = lines.toList()
            _stats.value = MonitorStats(total.get(), perSecond, hidden)
        }
    }

    /** Plain-text report to paste back when something does not work or when writing the mapping. */
    fun buildReport(): String = buildString {
        val ls = linkState.value
        appendLine("Inpulse DJ - milestone 1 diagnostics")
        appendLine("Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}")
        appendLine("Link: ${ls.phase}  device=${ls.deviceName}  recognised=${ls.isInpulse}  midiIn=${ls.midiInOpen}  midiOut=${ls.midiOutOpen}")
        appendLine("Messages received: ${stats.value.total}")
        appendLine()
        appendLine("USB devices (UsbManager):")
        if (usbDevices.value.isEmpty()) appendLine("  none")
        usbDevices.value.forEach { d ->
            appendLine("  ${d.vidPid}  \"${d.product}\"  ${d.name}  permission=${d.hasPermission}")
            d.interfaces.forEach {
                appendLine("    interface ${it.id}: ${it.label} (class ${it.usbClass}/${it.subclass}), endpoints=${it.endpoints}")
            }
        }
        appendLine("MIDI devices (MidiManager):")
        if (midiDevices.value.isEmpty()) appendLine("  none")
        midiDevices.value.forEach { d ->
            appendLine("  id=${d.id}  \"${d.displayName}\"  ${d.transport}  ${d.vidPid}")
            appendLine("    MIDI IN ports (controller to app): ${d.midiIn.joinToString { "${it.number}:${it.name}" }}")
            appendLine("    MIDI OUT ports (app to controller): ${d.midiOut.joinToString { "${it.number}:${it.name}" }}")
        }
        appendLine()
        appendLine("Last messages (newest first):")
        log.value.take(100).forEach { appendLine("  ${it.time}  ${it.hex}  |  ${it.text}") }
    }

    override fun onCleared() {
        link.stop()
        try {
            app.unregisterReceiver(usbReceiver)
        } catch (e: IllegalArgumentException) {
            Log.d(TAG, "receiver already unregistered")
        }
    }

    private companion object {
        const val TAG = "InpulseDJ"
        const val MAX_LINES = 300
    }
}
