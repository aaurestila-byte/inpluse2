# Inpulse DJ - Milestone 1: real hardware connection test

Status: **written, not yet compiled or run.** It was produced without Android Studio or a device,
so the first build may need small fixes, and nothing here has been tested against a real Inpulse 300 MK2.
Compatibility is not claimed until the test below passes on your hardware.

## Build
1. Android Studio (current stable) > Open > select this folder. Accept the Gradle sync.
   `gradle-wrapper.jar` and `gradlew` are not included; Studio downloads Gradle 8.9 from
   `gradle/wrapper/gradle-wrapper.properties`. Run `gradle wrapper` once if you want `gradlew`.
2. If Studio offers the AGP / Kotlin upgrade assistant, accepting it is fine. `targetSdk` is 35;
   raise it to 36 for Android 16 once your SDK has it.
3. Run on a physical Android 10+ phone (USB OTG). An emulator cannot see the controller.

## Hardware test
1. Close other DJ or MIDI apps first. Only one app should hold the controller.
2. Open the app, then plug the Inpulse in through the OTG cable (or plug first, then open).
3. Expected: the status card turns green with **INPULSE 300 MK2 CONNECTED**, MIDI IN / MIDI OUT show `open`.
4. Move a fader, turn a knob, press a pad, spin a jog wheel. Every message appears with its raw bytes.
5. Unplug and replug: the status goes to "lost" and reconnects by itself. Disconnect disables auto-reconnect until you press Connect.
6. If it fails, tap **Copy report** and paste it back. It contains VID:PID, USB interfaces, MIDI ports and the last 100 messages.

## What is in this milestone
- `midi/MidiParser.kt`: byte-stream parser (running status, interleaved realtime, SysEx, 14-bit pitch bend).
- `midi/MidiLink.kt`: android.media.midi discovery, open, MIDI IN/OUT, auto-reconnect, `send()` for LED feedback.
- `usb/UsbHelper.kt`: UsbManager enumeration (VID, PID, interfaces) and runtime USB permission request.
- `ui/`: diagnostics + monitor screen. MIDI thread only does a non-blocking `trySend`; the UI updates at ~25 Hz.

## Assumptions to confirm on the real unit
- The controller is identified by its Android-reported name containing "inpulse" and "300". The product ID is not
  hard-coded because it has not been verified; read it from the report.
- USB vendor ID 0x06F8 (Guillemot / Hercules) is used only to highlight the device and to filter the attach dialog.
- Port 0 is used for both MIDI IN and MIDI OUT.

## Next milestones (not started)
2. Controller mapping (JSON, MIDI Learn), written from captured real messages.
3. Audio engine (Oboe/AAudio), two decks, mixer, foreground service.
4. Beat grid, BPM, SYNC. 5. Waveforms, settings, full UI.
