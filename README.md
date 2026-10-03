# Hercules DJControl Inpulse 300 MK2 - Cross DJ Web Edition

A complete, high-performance two-deck DJ application inspired by the Cross DJ UI and tailored for the **Hercules DJControl Inpulse 300 MK2** hardware controller. Runs 100% offline in modern desktop and mobile browsers.

---

## ✨ Features

- **Cross DJ UI & Signature Dual Scrolling Waveforms**:
  - Parallel scrolling waveforms with frequency-reactive visualizer and real-time beat grid alignment.
  - Phase meter bar for precise beatmatching.
- **Hardware MIDI Integration**:
  - Plug-and-play Web MIDI support for the **Hercules DJControl Inpulse 300 MK2**.
  - Dual jog platters with vinyl scratch and pitch bend response.
  - Beatmatch Guide (TEMPO up/down arrows and BEAT ALIGN guide LEDs).
  - 8 RGB performance pads per deck: Hot Cue, Loop Roll, Sampler Bank, and FX Unit.
  - Dual 3-band EQ (HI, MID, LOW), Filter knobs, Channel volume faders, and Crossfader.
- **Mobile Landscape Optimized**:
  - Full-screen side-by-side 3-column DJ layout (`[ Deck A ] [ Mixer ] [ Deck B ]`) designed for phone viewports (`100dvh`).
  - Notch and safe-area inset protection.
  - Slide-over music library drawer ("📂 Library").
- **100% Offline Audio Engine**:
  - Built-in 4-track procedural audio synthesizer generating 4 offline styles: **House (124 BPM)**, **Techno (130 BPM)**, **Drum & Bass (174 BPM)**, and **Hip-Hop (95 BPM)**.
  - Offline 8-slot sound effect sampler bank (Airhorn, 808 Sub Drop, Laser Zap, Scratch Stab, Clap Verb, Synth Chime, Impact Boom, White Noise Sweep).
  - Local audio file drag & drop (MP3, WAV, FLAC, M4A, OGG).
- **High-Fidelity Mix Recorder**:
  - Record your master output to uncompressed 16-bit 44.1 kHz WAV files directly in the browser and download offline.
- **PWA & Offline Installation**:
  - Installable as a Progressive Web App (PWA) on Windows, macOS, Linux, ChromeOS, iOS, and Android.

---

## 🚀 Getting Started

### Option 1: Direct Run (Browser)
Simply open `index.html` in Google Chrome, Microsoft Edge, Opera, or Brave (Web MIDI requires a Chromium-based browser).

### Option 2: Run with Node.js
```bash
npm install
npm start
```
Then visit `http://localhost:3000` in your browser.

---

## 🎛️ Hercules Inpulse 300 MK2 MIDI Mapping

| Control | MIDI Message | Function |
| :--- | :--- | :--- |
| **Deck A / B Play** | `0x90 0x01` / `0x91 0x01` | Toggle Play / Pause |
| **Deck A / B Cue** | `0x90 0x02` / `0x91 0x02` | Cue Return / Jump to Start |
| **Deck A / B Sync** | `0x90 0x03` / `0x91 0x03` | Beat & BPM Sync to Master Deck |
| **Jog Touch / Scratch** | `0x90 0x22` + `0xB0 0x21` | Vinyl Scratching |
| **Jog Outer Ring** | `0xB0 0x21` (unpressed) | Pitch Bend / Nudge |
| **Tempo Slider** | `0xB0 0x09` / `0xB1 0x09` | Pitch / BPM Tempo Adjustment |
| **Channel EQ** | `0xB0 0x14-0x16` | HI / MID / LOW 3-Band Equalizer |
| **Channel Filter** | `0xB0 0x17` / `0xB1 0x17` | High-Pass / Low-Pass Dual Filter |
| **Volume Faders** | `0xB0 0x00` / `0xB1 0x00` | Channel Gain & Level |
| **Crossfader** | `0xB0 0x08` | Deck A ⟷ Deck B Crossfade |
| **Pads (1 - 8)** | `0x90 0x10-0x17` | Hot Cues, Loop Roll, Sampler, FX |
