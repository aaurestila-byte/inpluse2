package com.inpulsedj.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inpulsedj.midi.LinkPhase
import com.inpulsedj.midi.LinkState
import com.inpulsedj.midi.MidiDeviceSummary
import com.inpulsedj.midi.MidiKind
import com.inpulsedj.usb.UsbDeviceSummary

private val Ink = Color(0xFF101418)
private val PanelBg = Color(0xFF1A2027)
private val Line = Color(0xFF2A333D)
private val TextHi = Color(0xFFE8EDF2)
private val TextLo = Color(0xFF8D99A6)
private val Ok = Color(0xFF4ADE80)
private val Warn = Color(0xFFFBBF24)
private val Bad = Color(0xFFF87171)
private val CcBlue = Color(0xFF7DD3FC)
private val BendViolet = Color(0xFFC4B5FD)
private val Mono = FontFamily.Monospace

@Composable
fun InpulseTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Ok, onPrimary = Ink, background = Ink, surface = PanelBg, onSurface = TextHi
        ),
        content = content
    )
}

@Composable
fun MonitorScreen(vm: MonitorViewModel) {
    val link by vm.linkState.collectAsStateWithLifecycle()
    val midi by vm.midiDevices.collectAsStateWithLifecycle()
    val usb by vm.usbDevices.collectAsStateWithLifecycle()
    val log by vm.log.collectAsStateWithLifecycle()
    val stats by vm.stats.collectAsStateWithLifecycle()
    val hideRealtime by vm.hideRealtime.collectAsStateWithLifecycle()
    val paused by vm.paused.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    var showDetails by remember { mutableStateOf(true) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Ink).safeDrawingPadding(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item { StatusCard(link, usb, stats.total, stats.perSecond) }

        item {
            val active = link.phase == LinkPhase.CONNECTED || link.phase == LinkPhase.OPENING
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { if (active) vm.disconnect() else vm.connect() },
                    modifier = Modifier.weight(1f)
                ) { Text(if (active) "Disconnect" else "Connect") }
                OutlinedButton(onClick = { vm.refreshAll() }, modifier = Modifier.weight(1f)) { Text("Rescan") }
                OutlinedButton(
                    onClick = { clipboard.setText(AnnotatedString(vm.buildReport())) },
                    modifier = Modifier.weight(1f)
                ) { Text("Copy report", maxLines = 1) }
            }
        }

        item {
            TextButton(onClick = { showDetails = !showDetails }) {
                Text(if (showDetails) "Hide device details" else "Show device details", color = TextLo)
            }
        }
        if (showDetails) {
            item { UsbSection(usb, onGrant = vm::requestUsbPermission) }
            item { MidiSection(midi, onConnect = vm::connectTo) }
        }

        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("MIDI monitor", color = TextHi, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("Hide clock", color = TextLo, fontSize = 12.sp)
                Switch(checked = hideRealtime, onCheckedChange = vm::setHideRealtime, modifier = Modifier.padding(horizontal = 6.dp))
                Text("Pause", color = TextLo, fontSize = 12.sp)
                Switch(checked = paused, onCheckedChange = vm::setPaused, modifier = Modifier.padding(horizontal = 6.dp))
                TextButton(onClick = vm::clearLog) { Text("Clear") }
            }
        }

        if (log.isEmpty()) {
            item {
                Text(
                    if (link.phase == LinkPhase.CONNECTED) "Connected. Move a fader or press a pad and the message appears here."
                    else "Nothing received yet. Connect the controller to see its raw MIDI messages.",
                    color = TextLo, fontSize = 13.sp
                )
            }
        }
        items(log, key = { it.seq }) { LogRow(it) }
    }
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Surface(color = PanelBg, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
    }
}

@Composable
private fun StatusCard(link: LinkState, usb: List<UsbDeviceSummary>, total: Long, perSecond: Int) {
    val (headline, tone) = when (link.phase) {
        LinkPhase.CONNECTED ->
            if (link.isInpulse) ("INPULSE 300 MK2 CONNECTED" to Ok)
            else ("MIDI device connected, but not recognised as an Inpulse 300" to Warn)
        LinkPhase.OPENING -> ("Connecting..." to Warn)
        LinkPhase.LOST -> ("Controller lost, waiting to reconnect" to Warn)
        LinkPhase.IDLE -> ("Disconnected" to TextLo)
        LinkPhase.NO_DEVICE -> ("No MIDI device found" to Bad)
        LinkPhase.MIDI_UNAVAILABLE -> ("Android MIDI is not available" to Bad)
    }
    val hercules = usb.firstOrNull { it.isHercules }
    val connected = link.phase == LinkPhase.CONNECTED

    Panel {
        Text(headline, color = tone, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        if (link.detail.isNotBlank()) Text(link.detail, color = TextLo, fontSize = 13.sp)
        HorizontalDivider(color = Line, modifier = Modifier.padding(vertical = 4.dp))

        when {
            hercules != null -> StatusRow("USB", "Hercules device attached (${hercules.vidPid})", Ok)
            usb.isEmpty() -> StatusRow("USB", "No USB devices visible to Android", Bad)
            else -> StatusRow("USB", "No Hercules device among ${usb.size} USB device(s)", Warn)
        }
        StatusRow("Controller", link.deviceName ?: "none", if (connected) Ok else TextLo)
        StatusRow("MIDI IN", if (link.midiInOpen) "open" else "closed", if (link.midiInOpen) Ok else if (connected) Bad else TextLo)
        StatusRow("MIDI OUT", if (link.midiOutOpen) "open" else "closed", if (link.midiOutOpen) Ok else if (connected) Warn else TextLo)
        StatusRow("Messages", "$total received, $perSecond per second", if (total > 0) Ok else TextLo)
    }
}

@Composable
private fun StatusRow(label: String, value: String, dot: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(10.dp))
        Text(label, color = TextLo, fontSize = 13.sp, modifier = Modifier.width(84.dp))
        Text(value, color = TextHi, fontSize = 13.sp)
    }
}

@Composable
private fun UsbSection(usb: List<UsbDeviceSummary>, onGrant: (String) -> Unit) {
    Panel {
        Text("USB devices seen by Android", color = TextHi, fontWeight = FontWeight.SemiBold)
        if (usb.isEmpty()) {
            Text(
                "None. Check that the OTG adapter and cable carry data and that the phone can power the controller (a powered hub helps if it will not enumerate).",
                color = TextLo, fontSize = 12.sp
            )
        }
        usb.forEach { d ->
            HorizontalDivider(color = Line)
            Text(
                "${d.vidPid}  ${d.product.ifBlank { "(unnamed)" }}",
                color = if (d.isHercules) Ok else TextHi, fontFamily = Mono, fontSize = 13.sp
            )
            Text(
                "Interfaces: " + d.interfaces.joinToString { "${it.id} ${it.label}" },
                color = TextLo, fontSize = 12.sp
            )
            if (!d.hasMidiStreaming) {
                Text("No USB MIDI streaming interface reported on this device.", color = Warn, fontSize = 12.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (d.hasPermission) "USB permission granted" else "USB permission not granted",
                    color = TextLo, fontSize = 12.sp, modifier = Modifier.weight(1f)
                )
                if (!d.hasPermission) TextButton(onClick = { onGrant(d.name) }) { Text("Grant USB permission") }
            }
        }
    }
}

@Composable
private fun MidiSection(devices: List<MidiDeviceSummary>, onConnect: (Int) -> Unit) {
    Panel {
        Text("MIDI devices (tap one to connect)", color = TextHi, fontWeight = FontWeight.SemiBold)
        if (devices.isEmpty()) {
            Text(
                "Android's MIDI service lists no devices. If the USB list above shows the Hercules, this phone is not exposing it as a class-compliant MIDI device.",
                color = TextLo, fontSize = 12.sp
            )
        }
        devices.forEach { d ->
            HorizontalDivider(color = Line)
            Column(Modifier.fillMaxWidth().clickable { onConnect(d.id) }.padding(vertical = 4.dp)) {
                Text(d.displayName, color = if (d.isInpulse300) Ok else TextHi, fontSize = 14.sp)
                Text("${d.transport}  ${d.vidPid}", color = TextLo, fontFamily = Mono, fontSize = 12.sp)
                Text(
                    "MIDI IN (controller to app): ${d.midiIn.size}   MIDI OUT (app to controller): ${d.midiOut.size}",
                    color = TextLo, fontSize = 12.sp
                )
            }
        }
    }
}

@Composable
private fun LogRow(line: LogLine) {
    val tone = when (line.kind) {
        MidiKind.NOTE_ON, MidiKind.NOTE_OFF -> Ok
        MidiKind.CONTROL_CHANGE -> CcBlue
        MidiKind.PITCH_BEND -> BendViolet
        else -> TextLo
    }
    Row(Modifier.fillMaxWidth()) {
        Text(line.time, color = TextLo, fontFamily = Mono, fontSize = 11.sp, modifier = Modifier.width(66.dp))
        Column {
            Text(line.text, color = tone, fontFamily = Mono, fontSize = 12.sp)
            Text(line.hex, color = TextLo, fontFamily = Mono, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
