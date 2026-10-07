package com.inpulsedj.usb

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import android.os.Build
import com.inpulsedj.controller.Inpulse300Mk2

data class UsbInterfaceSummary(val id: Int, val usbClass: Int, val subclass: Int, val endpoints: Int) {
    val label: String
        get() = when {
            usbClass == 1 && subclass == 1 -> "Audio control"
            usbClass == 1 && subclass == 2 -> "Audio streaming"
            usbClass == 1 && subclass == 3 -> "MIDI streaming"
            usbClass == 3 -> "HID"
            usbClass == 0xFF -> "Vendor specific"
            else -> "Class %02X".format(usbClass)
        }
}

data class UsbDeviceSummary(
    val name: String,
    val vendorId: Int,
    val productId: Int,
    val product: String,
    val manufacturer: String,
    val interfaces: List<UsbInterfaceSummary>,
    val hasPermission: Boolean
) {
    val vidPid: String get() = "%04X:%04X".format(vendorId, productId)
    val isHercules: Boolean get() = vendorId == Inpulse300Mk2.GUILLEMOT_VENDOR_ID
    val hasMidiStreaming: Boolean get() = interfaces.any { it.usbClass == 1 && it.subclass == 3 }
}

/**
 * Reads what Android's USB host stack sees. The MIDI traffic itself goes through android.media.midi
 * (see MidiLink), so this class never opens or claims a USB interface: doing that would fight
 * the system's own USB MIDI driver.
 *
 * Note: there is no "android.permission.USB_PERMISSION" manifest permission. USB access is
 * granted per device at runtime, via [requestPermission] or by accepting the attach dialog.
 */
class UsbHelper(private val context: Context) {
    private val usb = context.getSystemService(Context.USB_SERVICE) as? UsbManager

    fun snapshot(): List<UsbDeviceSummary> {
        val m = usb ?: return emptyList()
        return m.deviceList.values.map { d ->
            UsbDeviceSummary(
                name = d.deviceName,
                vendorId = d.vendorId,
                productId = d.productId,
                product = d.productName.orEmpty(),
                manufacturer = d.manufacturerName.orEmpty(),
                interfaces = (0 until d.interfaceCount).map { i ->
                    val itf = d.getInterface(i)
                    UsbInterfaceSummary(itf.id, itf.interfaceClass, itf.interfaceSubclass, itf.endpointCount)
                },
                hasPermission = m.hasPermission(d)
            )
        }.sortedByDescending { it.isHercules }
    }

    fun requestPermission(deviceName: String) {
        val m = usb ?: return
        val d = m.deviceList[deviceName] ?: return
        // Android 12+ requires FLAG_MUTABLE here (the system fills in the result extras).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pi = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION).setPackage(context.packageName), flags
        )
        m.requestPermission(d, pi)
    }

    companion object {
        const val ACTION_USB_PERMISSION = "com.inpulsedj.USB_PERMISSION"
    }
}
