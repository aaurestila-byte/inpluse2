package com.inpulsedj.midi

enum class MidiKind {
    NOTE_OFF, NOTE_ON, POLY_PRESSURE, CONTROL_CHANGE, PROGRAM_CHANGE, CHANNEL_PRESSURE, PITCH_BEND,
    SYSEX, TIME_CODE, SONG_POSITION, SONG_SELECT, TUNE_REQUEST,
    CLOCK, START, CONTINUE, STOP, ACTIVE_SENSING, SYSTEM_RESET, UNKNOWN
}

/**
 * One parsed MIDI message, kept exactly as received (a Note On with velocity 0 stays a Note On,
 * so the monitor shows what the hardware really sends).
 * [status] is the full status byte, e.g. 0x90 or channel 0.
 */
class MidiEvent(
    val status: Int,
    val data1: Int = 0,
    val data2: Int = 0,
    val timestampNs: Long = 0L,
    val sysex: ByteArray? = null
) {
    val isChannelMessage: Boolean get() = status in 0x80..0xEF

    /** 0-15 on the wire; show as channel + 1. -1 for system messages. */
    val channel: Int get() = if (isChannelMessage) status and 0x0F else -1

    val kind: MidiKind
        get() = if (isChannelMessage) {
            when (status and 0xF0) {
                0x80 -> MidiKind.NOTE_OFF
                0x90 -> MidiKind.NOTE_ON
                0xA0 -> MidiKind.POLY_PRESSURE
                0xB0 -> MidiKind.CONTROL_CHANGE
                0xC0 -> MidiKind.PROGRAM_CHANGE
                0xD0 -> MidiKind.CHANNEL_PRESSURE
                0xE0 -> MidiKind.PITCH_BEND
                else -> MidiKind.UNKNOWN
            }
        } else {
            when (status) {
                0xF0 -> MidiKind.SYSEX
                0xF1 -> MidiKind.TIME_CODE
                0xF2 -> MidiKind.SONG_POSITION
                0xF3 -> MidiKind.SONG_SELECT
                0xF6 -> MidiKind.TUNE_REQUEST
                0xF8 -> MidiKind.CLOCK
                0xFA -> MidiKind.START
                0xFB -> MidiKind.CONTINUE
                0xFC -> MidiKind.STOP
                0xFE -> MidiKind.ACTIVE_SENSING
                0xFF -> MidiKind.SYSTEM_RESET
                else -> MidiKind.UNKNOWN
            }
        }

    /** 14-bit value for pitch bend / song position (LSB arrives first). Pitch bend centre is 8192. */
    val value14: Int get() = (data2 shl 7) or data1

    fun describe(): String {
        val ch = channel + 1
        return when (kind) {
            MidiKind.NOTE_ON ->
                if (data2 == 0) "Note On   ch$ch  note $data1  vel 0 (release)"
                else "Note On   ch$ch  note $data1  vel $data2"
            MidiKind.NOTE_OFF -> "Note Off  ch$ch  note $data1  vel $data2"
            MidiKind.POLY_PRESSURE -> "Poly AT   ch$ch  note $data1  val $data2"
            MidiKind.CONTROL_CHANGE -> "CC        ch$ch  cc $data1  val $data2"
            MidiKind.PROGRAM_CHANGE -> "Program   ch$ch  prog $data1"
            MidiKind.CHANNEL_PRESSURE -> "Chan AT   ch$ch  val $data1"
            MidiKind.PITCH_BEND -> "PitchBend ch$ch  $value14  (${value14 - 8192})"
            MidiKind.SYSEX -> "SysEx  ${sysex?.size ?: 0} bytes"
            MidiKind.TIME_CODE -> "MTC quarter frame  $data1"
            MidiKind.SONG_POSITION -> "Song position  $value14"
            MidiKind.SONG_SELECT -> "Song select  $data1"
            MidiKind.TUNE_REQUEST -> "Tune request"
            MidiKind.CLOCK -> "Clock"
            MidiKind.START -> "Start"
            MidiKind.CONTINUE -> "Continue"
            MidiKind.STOP -> "Stop"
            MidiKind.ACTIVE_SENSING -> "Active sensing"
            MidiKind.SYSTEM_RESET -> "System reset"
            MidiKind.UNKNOWN -> "Unknown status %02X".format(status)
        }
    }

    /** Raw bytes as hex, e.g. "B0 21 40". */
    fun hex(): String {
        sysex?.let { s -> return s.joinToString(" ") { "%02X".format(it) } }
        val dataBytes = when {
            status in 0x80..0xEF -> if ((status and 0xF0) == 0xC0 || (status and 0xF0) == 0xD0) 1 else 2
            status == 0xF2 -> 2
            status == 0xF1 || status == 0xF3 -> 1
            else -> 0
        }
        val sb = StringBuilder("%02X".format(status))
        if (dataBytes >= 1) sb.append(' ').append("%02X".format(data1))
        if (dataBytes >= 2) sb.append(' ').append("%02X".format(data2))
        return sb.toString()
    }
}

/** Builders for MIDI sent back to the controller (LED feedback). Channels are 0-15. */
object MidiBytes {
    fun noteOn(channel: Int, note: Int, velocity: Int) = byteArrayOf(
        (0x90 or (channel and 0x0F)).toByte(), (note and 0x7F).toByte(), (velocity and 0x7F).toByte()
    )

    fun noteOff(channel: Int, note: Int, velocity: Int = 0) = byteArrayOf(
        (0x80 or (channel and 0x0F)).toByte(), (note and 0x7F).toByte(), (velocity and 0x7F).toByte()
    )

    fun controlChange(channel: Int, controller: Int, value: Int) = byteArrayOf(
        (0xB0 or (channel and 0x0F)).toByte(), (controller and 0x7F).toByte(), (value and 0x7F).toByte()
    )

    /** [value14] is 0..16383 with 8192 at centre. */
    fun pitchBend(channel: Int, value14: Int): ByteArray {
        val v = value14.coerceIn(0, 16383)
        return byteArrayOf((0xE0 or (channel and 0x0F)).toByte(), (v and 0x7F).toByte(), ((v shr 7) and 0x7F).toByte())
    }

    fun clock() = byteArrayOf(0xF8.toByte())
}
