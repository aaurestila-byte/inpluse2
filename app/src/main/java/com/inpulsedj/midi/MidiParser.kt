package com.inpulsedj.midi

/**
 * Turns a raw MIDI byte stream into [MidiEvent]s.
 * Handles running status, realtime bytes (0xF8..0xFF) interleaved inside other messages,
 * system common messages and SysEx that spans several buffers.
 * Not thread-safe: feed it from one thread only (the MIDI receiver thread).
 */
class MidiParser(private val onEvent: (MidiEvent) -> Unit) {

    private var status = 0      // current status byte, 0 = none (also cleared by system common messages)
    private var needed = 0      // data bytes the current status expects
    private var have = 0
    private val data = IntArray(2)

    private var inSysex = false
    private var sysex = ByteArray(256)
    private var sysexLen = 0

    fun reset() {
        status = 0; needed = 0; have = 0
        inSysex = false; sysexLen = 0
    }

    fun feed(buf: ByteArray, offset: Int, count: Int, timestampNs: Long) {
        val end = offset + count
        var i = offset
        while (i < end) {
            val b = buf[i].toInt() and 0xFF
            i++
            when {
                b >= 0xF8 -> onEvent(MidiEvent(b, timestampNs = timestampNs))   // realtime: never disturbs state
                b >= 0x80 -> statusByte(b, timestampNs)
                else -> dataByte(b, timestampNs)
            }
        }
    }

    private fun statusByte(b: Int, ts: Long) {
        if (inSysex) {
            if (b == 0xF7) {
                sysexAppend(0xF7)
                onEvent(MidiEvent(0xF0, timestampNs = ts, sysex = sysex.copyOf(sysexLen)))
                inSysex = false
                sysexLen = 0
                return
            }
            // Any other status byte aborts the SysEx; drop it and process this byte normally.
            inSysex = false
            sysexLen = 0
        }
        have = 0
        when {
            b == 0xF0 -> {
                inSysex = true
                sysexLen = 0
                sysexAppend(0xF0)
                status = 0
                needed = 0
            }
            b == 0xF7 -> { status = 0; needed = 0 }   // stray end-of-exclusive
            b >= 0xF0 -> when (b) {
                0xF1, 0xF3 -> { status = b; needed = 1 }
                0xF2 -> { status = b; needed = 2 }
                else -> {                              // 0xF4/F5 undefined, 0xF6 tune request
                    status = 0
                    needed = 0
                    onEvent(MidiEvent(b, timestampNs = ts))
                }
            }
            else -> {
                status = b
                val hi = b and 0xF0
                needed = if (hi == 0xC0 || hi == 0xD0) 1 else 2
            }
        }
    }

    private fun dataByte(b: Int, ts: Long) {
        if (inSysex) { sysexAppend(b); return }
        if (status == 0) return                       // orphan data byte, nothing to attach it to
        data[have++] = b
        if (have >= needed) {
            onEvent(MidiEvent(status, data[0], if (needed > 1) data[1] else 0, ts))
            have = 0                                  // keep status: running status
            if (status >= 0xF0) status = 0            // system common has no running status
        }
    }

    private fun sysexAppend(b: Int) {
        if (sysexLen >= MAX_SYSEX) return
        if (sysexLen == sysex.size) sysex = sysex.copyOf(sysex.size * 2)
        sysex[sysexLen++] = b.toByte()
    }

    private companion object {
        const val MAX_SYSEX = 64 * 1024
    }
}
