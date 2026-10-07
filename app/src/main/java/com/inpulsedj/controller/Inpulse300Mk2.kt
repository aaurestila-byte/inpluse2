package com.inpulsedj.controller

/**
 * Identification only for Milestone 1. The control mapping is deliberately not here yet:
 * it will be written from messages captured off the real hardware, not guessed.
 */
object Inpulse300Mk2 {
    const val DISPLAY_NAME = "Hercules DJ Inpulse 300 MK2"

    /** Guillemot Corp. (Hercules). Informational: used to highlight the device, not to identify it. */
    const val GUILLEMOT_VENDOR_ID = 0x06F8

    /**
     * Matches on the names Android reports for the device. The product id is intentionally not
     * hard-coded: read it from the diagnostics screen on the real unit first.
     */
    fun matches(names: List<String>): Boolean {
        val s = names.joinToString(" ").lowercase()
        return s.contains("inpulse") && s.contains("300")
    }
}
