// Cross DJ Pro Audio Engine & Offline Performance Suite
// Compatible with Hercules DJControl Inpulse 300 MK2 & Standalone Offline Operation

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// Audio Engine Setup
const AC = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = AC.createGain();
masterGain.gain.value = 0.85;

// Master Analyser for VU Meter
const masterAnalyser = AC.createAnalyser();
masterAnalyser.fftSize = 64;
masterGain.connect(masterAnalyser);
masterAnalyser.connect(AC.destination);

// Offline Mix Recorder Engine
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordTimerInterval = null;
let recordSeconds = 0;
const mediaDest = AC.createMediaStreamDestination();
masterGain.connect(mediaDest);

// Master Clock & Sync
let xfadeCurve = 'smooth'; // 'smooth', 'sharp', 'cut'
let midiOutput = null;

// Helpers
const fmt = s => {
  if (isNaN(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}.${String(sc).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
};
const fmtMinSec = s => {
  if (isNaN(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const dB = v => (v < 0.5 ? -32 * (1 - v * 2) : 14 * (v * 2 - 1));
const flt = (type, freq) => {
  const n = AC.createBiquadFilter();
  n.type = type;
  n.frequency.value = freq;
  return n;
};

// Decks State Model
const D = {};

function createDeck(id) {
  const d = {
    id,
    buf: null,
    src: null,
    name: 'No track loaded',
    artist: 'DJ An2ny Offline',
    off: 0,
    t0: 0,
    play: false,
    rate: 1,
    bend: 0,
    eff: 1,
    cue: 0,
    hot: new Array(8).fill(null),
    lp: null, // Loop { s, e }
    sl: null, // Slip loop state
    bpm: 0,
    origBpm: 0,
    pk: null,
    touch: false,
    prev: false,
    acc: 0,
    last: 0,
    bt: 0,
    rotation: 0,
    padMode: 'hotcue', // 'hotcue', 'roll', 'sampler', 'fx'
    key: null,
    keyObj: null,
    syncActive: false,
    // EQ Kill states
    killLo: false,
    killMi: false,
    killHi: false,
    rawLo: 0.5,
    rawMi: 0.5,
    rawHi: 0.5,
    tempoRange: 0.16, // +- 16% default
    keylock: true,
    col: id === 'A' ? '#ff7700' : '#00c3ff',
    fg: '#ffffff',
  };

  // Deck Audio Chain
  d.g = AC.createGain(); // Gain
  d.lo = flt('lowshelf', 250);
  d.mi = flt('peaking', 1000);
  d.mi.Q.value = 0.7;
  d.hi = flt('highshelf', 3500);
  d.fl = flt('allpass', 1000); // Filter
  
  // FX Send / Insert
  d.fxGain = AC.createGain();
  d.fxDelay = AC.createDelay();
  d.fxDelay.delayTime.value = 0.25;
  d.fxFeedback = AC.createGain();
  d.fxFeedback.gain.value = 0.35;
  d.fxDelay.connect(d.fxFeedback);
  d.fxFeedback.connect(d.fxDelay);
  d.fxDelay.connect(d.fxGain);

  d.v = AC.createGain(); // Channel Volume
  d.x = AC.createGain(); // Crossfader

  // Deck Analyser for Real-time Waveform Frequency Visualizer & VU Meter
  d.analyser = AC.createAnalyser();
  d.analyser.fftSize = 256;
  d.analyser.smoothingTimeConstant = 0.65;
  d.freqData = new Uint8Array(d.analyser.frequencyBinCount);
  d.timeData = new Uint8Array(d.analyser.frequencyBinCount);

  // Routing:
  // Source -> g -> lo -> mi -> hi -> fl -> v -> x -> master
  d.g.connect(d.lo);
  d.lo.connect(d.mi);
  d.mi.connect(d.hi);
  d.hi.connect(d.fl);
  d.fl.connect(d.v);
  
  // FX routing
  d.fl.connect(d.fxDelay);
  d.fxGain.connect(d.v);
  d.fxGain.gain.value = 0; // default dry

  d.v.connect(d.x);
  d.v.connect(d.analyser);
  d.x.connect(masterGain);

  d.pos = () => {
    if (!d.play) return d.off;
    let p = d.off + (AC.currentTime - d.t0) * d.eff;
    if (d.lp && p >= d.lp.e) {
      const dur = d.lp.e - d.lp.s;
      p = dur > 0 ? d.lp.s + ((p - d.lp.s) % dur) : d.lp.s;
    }
    return Math.min(p, d.buf ? d.buf.duration : 0);
  };

  d.kill = () => {
    if (d.src) {
      d.src.onended = null;
      try { d.src.stop(); } catch (e) {}
      d.src = null;
    }
  };

  d.start = () => {
    d.kill();
    if (!d.buf) return;
    const s = AC.createBufferSource();
    s.buffer = d.buf;
    s.playbackRate.value = d.eff;
    s.connect(d.g);
    s.onended = () => {
      if (d.src === s) {
        d.src = null;
        d.play = false;
        d.off = 0;
        updateTransportUI(d);
      }
    };
    d.t0 = AC.currentTime;
    s.start(0, d.off);
    d.src = s;
  };

  d.go = () => {
    if (!d.buf || d.play) return;
    const other = d.id === 'A' ? D.B : D.A;
    if (d.syncActive && other.play && other.bpm && d.bpm) {
      // Auto-quantize phase on play start to match master deck beat!
      const masterBpm = other.bpm * other.rate;
      const beatLenMaster = 60 / masterBpm;
      const beatLenThis = 60 / (d.bpm * d.rate);
      const masterPhase = (other.pos() % beatLenMaster) / beatLenMaster;
      const curBeat = Math.round(d.pos() / beatLenThis);
      d.off = Math.max(0, curBeat * beatLenThis + masterPhase * beatLenThis);
    }
    d.start();
    d.play = true;
    updateTransportUI(d);
  };

  d.stop = () => {
    if (!d.play) return;
    d.off = d.pos();
    d.play = false;
    d.lp = null;
    d.kill();
    updateTransportUI(d);
  };

  d.seek = t => {
    if (!d.buf) return;
    d.lp = null;
    d.off = Math.max(0, Math.min(t, d.buf.duration - 0.05));
    if (d.play) {
      d.t0 = AC.currentTime;
      d.start();
    }
  };

  d.setEff = () => {
    if (d.play) {
      d.off = d.pos();
      d.t0 = AC.currentTime;
    }
    d.eff = Math.max(0.1, d.rate * (1 + d.bend));
    if (d.src) {
      d.src.playbackRate.value = d.eff;
    }
    const bpmDisplay = (d.bpm * d.rate).toFixed(2);
    const pitchOffset = ((d.rate - 1) * 100).toFixed(1);
    $(`#bpm-val-${d.id}`).textContent = d.bpm ? bpmDisplay : '0.00';
    const hdrBpm = $(`#hdr-bpm-val-${d.id}`);
    if (hdrBpm) hdrBpm.textContent = d.bpm ? bpmDisplay : '0.00';
    $(`#pitch-val-${d.id}`).textContent = (d.rate >= 1 ? '+' : '') + pitchOffset + '%';
  };

  return d;
}

D.A = createDeck('A');
D.B = createDeck('B');

// Param Setter
function param(id, p, v) {
  const d = D[id];
  if (!d) return;

  if (p === 'vol') {
    d.v.gain.value = v * v;
  } else if (p === 'gain') {
    d.g.gain.value = v * 2;
  } else if (p === 'lo') {
    d.rawLo = v;
    if (!d.killLo) d.lo.gain.value = dB(v);
  } else if (p === 'mi') {
    d.rawMi = v;
    if (!d.killMi) d.mi.gain.value = dB(v);
  } else if (p === 'hi') {
    d.rawHi = v;
    if (!d.killHi) d.hi.gain.value = dB(v);
  } else if (p === 'fl') {
    if (Math.abs(v - 0.5) < 0.04) {
      d.fl.type = 'allpass';
    } else if (v < 0.5) {
      d.fl.type = 'lowpass';
      d.fl.frequency.value = 150 * Math.pow(130, v * 2);
    } else {
      d.fl.type = 'highpass';
      d.fl.frequency.value = 20 * Math.pow(400, (v - 0.5) * 2);
    }
  } else if (p === 'tempo') {
    const inverted = $('#inv-tempo')?.checked || false;
    const x = inverted ? 1 - v : v;
    d.rate = 1 + (x - 0.5) * d.tempoRange;
    d.setEff();

    // If master deck tempo changes, automatically update any synced deck!
    const other = id === 'A' ? D.B : D.A;
    if (other && other.syncActive) {
      syncDeck(other, true);
    }
  }

  const el = $(`[data-d="${id}"][data-p="${p}"]`);
  if (el) el.value = Math.round(v * 100);
}

// Crossfader calculation
function xfade(x) {
  if (xfadeCurve === 'cut') {
    D.A.x.gain.value = x < 0.95 ? 1 : (1 - x) * 20;
    D.B.x.gain.value = x > 0.05 ? 1 : x * 20;
  } else if (xfadeCurve === 'sharp') {
    D.A.x.gain.value = Math.min(1, Math.cos(x * Math.PI / 2) * 1.4);
    D.B.x.gain.value = Math.min(1, Math.sin(x * Math.PI / 2) * 1.4);
  } else {
    // Equal power smooth
    D.A.x.gain.value = Math.cos(x * Math.PI / 2);
    D.B.x.gain.value = Math.sin(x * Math.PI / 2);
  }
  $('#crossfader').value = Math.round(x * 100);
}

// Controller LED Communication
function sendMidi(msg) {
  if (midiOutput) {
    try { midiOutput.send(msg); } catch (e) {}
  }
}

function updateTransportUI(d) {
  const plBtn = $(`#btn-play-${d.id}`);
  const cueBtn = $(`#btn-cue-${d.id}`);
  if (plBtn) {
    plBtn.classList.toggle('playing', d.play);
    plBtn.innerHTML = d.play ? '❚❚ PAUSE' : '▶ PLAY';
  }
  if (cueBtn) {
    const atCue = !d.play && d.buf && Math.abs(d.off - d.cue) < 0.05;
    cueBtn.classList.toggle('active', atCue);
  }
  const syncBtn = $(`#btn-sync-${d.id}`);
  if (syncBtn) {
    syncBtn.classList.toggle('active', Boolean(d.syncActive));
  }

  // MIDI LEDs for Inpulse 300 MK2
  const st = 0x90 | (d.id === 'A' ? 1 : 2);
  sendMidi([st, 7, d.play ? 127 : 0]);
  sendMidi([st, 6, (!d.play && d.buf && Math.abs(d.off - d.cue) < 0.05) ? 127 : 0]);
  sendMidi([st, 5, d.syncActive ? 127 : 0]);
  sendMidi([st, 9, d.syncActive ? 127 : 0]);
}

function updateHotCueUI(d) {
  for (let i = 0; i < 8; i++) {
    const btn = $(`[data-deck="${d.id}"][data-pad="${i}"]`);
    if (btn && d.padMode === 'hotcue') {
      btn.classList.toggle('set', d.hot[i] != null);
      btn.textContent = d.hot[i] != null ? `CUE ${i + 1}` : `${i + 1}`;
    }
  }
}

function cueDown(d) {
  if (!d.buf) return;
  if (d.play) {
    d.stop();
    d.seek(d.cue);
  } else if (Math.abs(d.off - d.cue) < 0.05) {
    d.prev = true;
    d.go();
  } else {
    d.cue = d.off;
    updateTransportUI(d);
  }
}

function cueUp(d) {
  if (d.prev) {
    d.prev = false;
    d.stop();
    d.seek(d.cue);
  }
}

function triggerHotCue(d, i, del = false) {
  if (!d.buf) return;
  if (del) {
    d.hot[i] = null;
  } else if (d.hot[i] == null) {
    d.hot[i] = d.pos();
  } else {
    d.seek(d.hot[i]);
  }
  updateHotCueUI(d);
  saveHotCuesToDB(d);
}

// Jog Wheel Physics & Pitch Bend
function jog(d, delta, scratch) {
  if (!d.buf) return;
  if (scratch && d.touch) {
    d.acc += delta * 0.015;
    const now = performance.now();
    if (now - d.last > 30) {
      d.seek(d.pos() + d.acc);
      d.rotation += d.acc * 50;
      d.acc = 0;
      d.last = now;
    }
  } else {
    // Pitch Bend Nudge
    d.bend = Math.max(-0.25, Math.min(0.25, delta * 0.012));
    d.setEff();
    clearTimeout(d.bt);
    d.bt = setTimeout(() => {
      d.bend = 0;
      d.setEff();
    }, 130);
  }
}

// Looping & Rolls
const ROLL_BEATS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
const LATCH_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

function loopOn(d, beats, roll = false) {
  if (!d.buf || !d.play || !d.src) return;
  const p = d.pos();
  const now = AC.currentTime;
  if (roll) d.sl = { p, t: now };
  d.off = p;
  d.t0 = now;
  const beatSec = 60 / (d.bpm || 120);
  d.lp = { s: p, e: Math.min(p + beats * beatSec, d.buf.duration) };
  d.src.loopStart = d.lp.s;
  d.src.loopEnd = d.lp.e;
  d.src.loop = true;
  $(`#loop-active-${d.id}`)?.classList.add('active');
}

function loopOff(d, slip = false) {
  if (!d.lp) return;
  const now = AC.currentTime;
  if (slip && d.sl) {
    const t = d.sl.p + (now - d.sl.t) * d.eff;
    d.sl = null;
    d.seek(t);
  } else {
    const p = d.pos();
    d.lp = null;
    d.off = p;
    d.t0 = now;
    if (d.src) d.src.loop = false;
  }
  $(`#loop-active-${d.id}`)?.classList.remove('active');
}

// Professional DJ Sync Engine with Intelligent BPM Ratio & Phase Lock
function syncDeck(d, silent = false) {
  const other = d.id === 'A' ? D.B : D.A;
  if (!d.buf || !other.buf || !d.bpm || !other.bpm) return;

  // Toggle sync off if already active and user manually clicked the button
  if (!silent && d.syncActive) {
    d.syncActive = false;
    $(`#btn-sync-${d.id}`)?.classList.remove('active', 'synced');
    sendMidi([0x90 | (d.id === 'A' ? 1 : 2), 5, 0]);
    sendMidi([0x90 | (d.id === 'A' ? 1 : 2), 9, 0]);
    return;
  }

  // Set this deck as sync-locked
  d.syncActive = true;
  other.syncActive = false; // Reference master
  $(`#btn-sync-${other.id}`)?.classList.remove('active');

  // Master BPM is other deck's effective current tempo
  const masterBpm = other.bpm * other.rate;

  // 1. Calculate best matching ratio (1:1, half-tempo, or double-tempo)
  const ratio1 = masterBpm / d.bpm;
  const ratioHalf = (masterBpm * 0.5) / d.bpm;
  const ratioDouble = (masterBpm * 2.0) / d.bpm;

  let targetBpm = masterBpm;
  let bestRatio = ratio1;
  if (Math.abs(ratioHalf - 1) < Math.abs(bestRatio - 1)) {
    bestRatio = ratioHalf;
    targetBpm = masterBpm * 0.5;
  }
  if (Math.abs(ratioDouble - 1) < Math.abs(bestRatio - 1)) {
    bestRatio = ratioDouble;
    targetBpm = masterBpm * 2.0;
  }

  const neededRate = targetBpm / d.bpm;

  // 2. Ensure tempoRange is wide enough to accommodate the needed rate
  const requiredRange = Math.abs(neededRate - 1);
  if (requiredRange > d.tempoRange) {
    if (requiredRange <= 0.16) d.tempoRange = 0.16;
    else d.tempoRange = 0.50;
    const pill = $(`#tempo-range-${d.id}`);
    if (pill) pill.textContent = `±${Math.round(d.tempoRange * 100)}%`;
  }

  // 3. Set rate and physically align slider
  d.rate = neededRate;
  d.setEff();

  const inverted = $('#inv-tempo')?.checked || false;
  const normalizedSlider = (neededRate - 1) / d.tempoRange + 0.5;
  const clampedSlider = Math.max(0, Math.min(1, normalizedSlider));
  const finalSliderVal = inverted ? 1 - clampedSlider : clampedSlider;
  const sliderEl = $(`#tempo-slider-${d.id}`);
  if (sliderEl) sliderEl.value = Math.round(finalSliderVal * 100);

  // 4. Instant Phase Lock (Beat Grid Alignment)
  const beatLenMaster = 60 / masterBpm;
  const beatLenThis = 60 / (d.bpm * d.rate);

  if (other.play && d.play) {
    // Both playing: align phase immediately so kicks hit at the exact same instant
    const masterPhase = (other.pos() % beatLenMaster) / beatLenMaster;
    const thisPhase = (d.pos() % beatLenThis) / beatLenThis;
    let phaseDiff = thisPhase - masterPhase;
    if (phaseDiff > 0.5) phaseDiff -= 1;
    if (phaseDiff < -0.5) phaseDiff += 1;

    d.seek(Math.max(0, d.pos() - phaseDiff * beatLenThis));
  } else if (other.play && !d.play) {
    // Other deck is playing, this deck is stopped / cue ready:
    // Align playhead phase to match master phase so hitting PLAY drops right on beat!
    const masterPhase = (other.pos() % beatLenMaster) / beatLenMaster;
    const curBeat = Math.round(d.pos() / beatLenThis);
    d.off = Math.max(0, curBeat * beatLenThis + masterPhase * beatLenThis);
    d.seek(d.off);
  }

  // 5. Button glow & MIDI feedback
  const syncBtn = $(`#btn-sync-${d.id}`);
  if (syncBtn) {
    syncBtn.classList.add('active', 'synced');
    setTimeout(() => syncBtn.classList.remove('synced'), 600);
  }
  sendMidi([0x90 | (d.id === 'A' ? 1 : 2), 5, 127]);
  sendMidi([0x90 | (d.id === 'A' ? 1 : 2), 9, 127]);
}

// Sampler Bank
const SAMPLER_BUFFERS = new Array(8).fill(null);
const samplerGain = AC.createGain();
samplerGain.gain.value = 0.9;
samplerGain.connect(masterGain);

function triggerSample(idx) {
  const buf = SAMPLER_BUFFERS[idx];
  if (!buf) return;
  const s = AC.createBufferSource();
  s.buffer = buf;
  s.connect(samplerGain);
  s.start();

  const pad = $(`[data-sm="${idx}"]`);
  if (pad) {
    pad.style.boxShadow = '0 0 16px var(--led-green)';
    setTimeout(() => { pad.style.boxShadow = ''; }, 150);
  }
}

// BPM Detection & Peak Extraction
function detectBPM(buf) {
  const x = buf.getChannelData(0);
  const hop = Math.floor(buf.sampleRate / 100);
  const tot = Math.floor(x.length / hop);
  const n = Math.min(tot, 6000);
  const s0 = Math.floor((tot - n) / 2);
  const e = new Float32Array(n);
  const o = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let a = 0;
    const b = (s0 + i) * hop;
    for (let j = 0; j < hop; j += 4) a += Math.abs(x[b + j] || 0);
    e[i] = a;
  }
  for (let i = 1; i < n; i++) o[i] = Math.max(0, e[i] - e[i - 1]);

  let best = 0;
  let bb = 124;
  for (let bpm = 75; bpm <= 175; bpm += 0.5) {
    const lag = 6000 / bpm;
    let sc = 0;
    for (let i = 0; i + lag + 1 < n; i++) {
      const k = Math.floor(i + lag);
      const f = i + lag - k;
      sc += o[i] * (o[k] * (1 - f) + (o[k + 1] || 0) * f);
    }
    if (sc > best) {
      best = sc;
      bb = bpm;
    }
  }
  return bb;
}

// =============================================================
// AUTOMATIC MUSICAL KEY DETECTION ALGORITHM (CAMELOT WHEEL SYSTEM)
// Uses Chromagram Pitch Class Profile (PCP) & Krumhansl-Schmuckler
// Key Correlation Profiles to detect musical tonic & mode.
// =============================================================

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Camelot Wheel Code Tables (Circle of Fifths mapping)
// Major: C(0)->8B, C#(1)->3B, D(2)->10B, D#(3)->5B, E(4)->12B, F(5)->7B,
//        F#(6)->2B, G(7)->9B, G#(8)->4B, A(9)->11B, A#(10)->6B, B(11)->1B
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];

// Minor: C(0)->5A, C#(1)->12A, D(2)->7A, D#(3)->2A, E(4)->9A, F(5)->4A,
//        F#(6)->11A, G(7)->6A, G#(8)->1A, A(9)->8A, A#(10)->3A, B(11)->10A
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

// Krumhansl-Schmuckler Key Profiles (12 semitones relative to tonic)
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function detectMusicalKey(buf) {
  if (!buf || buf.duration < 0.5) {
    return { key: '8A', name: 'Am', camelot: '8A', mode: 'minor', full: '8A (Am)' };
  }

  const sampleRate = buf.sampleRate;
  const channelData = buf.getChannelData(0);
  const totalSamples = channelData.length;

  const windowSize = 4096;
  const numWindows = 8;
  const chroma = new Float64Array(12);

  // Semitone frequency table across 4 octaves (C2 ~65.4Hz to B5 ~987.8Hz)
  const targetFrequencies = [];
  for (let midi = 36; midi <= 83; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const pitchClass = midi % 12; // 0 = C, 1 = C#, ..., 11 = B
    targetFrequencies.push({ freq, pitchClass });
  }

  const startOffset = Math.floor(totalSamples * 0.15);
  const endOffset = Math.floor(totalSamples * 0.75);
  const step = Math.max(windowSize, Math.floor((endOffset - startOffset) / numWindows));

  for (let w = 0; w < numWindows; w++) {
    const offset = startOffset + w * step;
    if (offset + windowSize > totalSamples) break;

    // Run Goertzel algorithm on target semitone frequencies for this window
    for (let fIdx = 0; fIdx < targetFrequencies.length; fIdx++) {
      const { freq, pitchClass } = targetFrequencies[fIdx];
      const k = (windowSize * freq) / sampleRate;
      const omega = (2 * Math.PI * k) / windowSize;
      const coeff = 2 * Math.cos(omega);

      let q1 = 0;
      let q2 = 0;
      for (let i = 0; i < windowSize; i++) {
        // Hann windowing
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
        const sample = channelData[offset + i] * hann;
        const q0 = coeff * q1 - q2 + sample;
        q2 = q1;
        q1 = q0;
      }
      const power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
      chroma[pitchClass] += Math.sqrt(Math.max(0, power));
    }
  }

  // Normalize chroma vector
  let maxChroma = 0;
  for (let i = 0; i < 12; i++) {
    if (chroma[i] > maxChroma) maxChroma = chroma[i];
  }
  if (maxChroma > 0) {
    for (let i = 0; i < 12; i++) chroma[i] /= maxChroma;
  }

  // Correlate with 24 keys (12 Major, 12 Minor) using Pearson correlation
  let bestScore = -Infinity;
  let bestTonic = 0;
  let bestMode = 'major';

  function correlation(x, y) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    const n = 12;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
  }

  for (let r = 0; r < 12; r++) {
    // Major correlation
    const majProfile = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      majProfile[i] = KS_MAJOR[(i - r + 12) % 12];
    }
    const scoreMaj = correlation(chroma, majProfile);
    if (scoreMaj > bestScore) {
      bestScore = scoreMaj;
      bestTonic = r;
      bestMode = 'major';
    }

    // Minor correlation
    const minProfile = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      minProfile[i] = KS_MINOR[(i - r + 12) % 12];
    }
    const scoreMin = correlation(chroma, minProfile);
    if (scoreMin > bestScore) {
      bestScore = scoreMin;
      bestTonic = r;
      bestMode = 'minor';
    }
  }

  const tonicName = PITCH_CLASSES[bestTonic];
  const shortName = bestMode === 'major' ? `${tonicName}` : `${tonicName}m`;
  const camelot = bestMode === 'major' ? MAJOR_CAMELOT[bestTonic] : MINOR_CAMELOT[bestTonic];
  const full = `${camelot} (${shortName})`;

  return {
    tonic: bestTonic,
    tonicName,
    mode: bestMode,
    name: shortName,
    camelot,
    full,
  };
}

// Harmonic compatibility helper between two Camelot keys
function areKeysHarmonicallyCompatible(keyA, keyB) {
  if (!keyA || !keyB || keyA === '--' || keyB === '--') return false;
  const matchA = keyA.match(/(\d+)([AB])/i);
  const matchB = keyB.match(/(\d+)([AB])/i);
  if (!matchA || !matchB) return false;

  const numA = parseInt(matchA[1], 10);
  const letterA = matchA[2].toUpperCase();
  const numB = parseInt(matchB[1], 10);
  const letterB = matchB[2].toUpperCase();

  // 1. Exact match (e.g. 8A & 8A)
  if (numA === numB && letterA === letterB) return true;
  // 2. Relative Major/Minor (e.g. 8A & 8B)
  if (numA === numB) return true;
  // 3. Adjacent hour on Camelot Wheel (e.g. 8A & 7A, 8A & 9A, 12A & 1A)
  if (letterA === letterB) {
    const diff = Math.abs(numA - numB);
    if (diff === 1 || diff === 11) return true;
  }
  return false;
}

function updateHarmonicMixingHUD() {
  const boxA = $('#key-hud-box-A');
  const boxB = $('#key-hud-box-B');
  const keyA = D.A?.key;
  const keyB = D.B?.key;

  const isCompatible = areKeysHarmonicallyCompatible(keyA, keyB);
  if (boxA) boxA.classList.toggle('harmonic-match', isCompatible);
  if (boxB) boxB.classList.toggle('harmonic-match', isCompatible);
}

// 3-Band Frequency Waveform Peak Extraction (Bass = Red, Mid = Green, High = Blue)
function extractFrequencyPeaks(buf, count = 800) {
  const x = buf.getChannelData(0);
  const len = x.length;
  const sr = buf.sampleRate;
  const step = Math.max(1, Math.floor(len / count));

  const bass = new Float32Array(count);
  const mid = new Float32Array(count);
  const high = new Float32Array(count);
  const maxAmp = new Float32Array(count);

  // 1-pole discrete lowpass filter for bass (cutoff ~250 Hz)
  const dt = 1 / sr;
  const rcLow = 1 / (2 * Math.PI * 250);
  const alphaLow = dt / (rcLow + dt);

  // 1-pole discrete highpass filter for treble (cutoff ~2500 Hz)
  const rcHigh = 1 / (2 * Math.PI * 2500);
  const alphaHigh = rcHigh / (rcHigh + dt);

  let lowPrev = 0;
  let highPrevIn = 0;
  let highPrevOut = 0;

  const innerStride = Math.max(1, Math.floor(step / 32));

  for (let i = 0; i < count; i++) {
    const blockStart = i * step;
    const blockEnd = Math.min(len, blockStart + step);

    let maxB = 0;
    let maxM = 0;
    let maxH = 0;
    let maxA = 0;

    for (let j = blockStart; j < blockEnd; j += innerStride) {
      const s = x[j] || 0;
      const absS = Math.abs(s);
      if (absS > maxA) maxA = absS;

      // Lowpass for bass
      lowPrev = lowPrev + alphaLow * (s - lowPrev);
      const bVal = Math.abs(lowPrev);
      if (bVal > maxB) maxB = bVal;

      // Highpass for high
      highPrevOut = alphaHigh * (highPrevOut + s - highPrevIn);
      highPrevIn = s;
      const hVal = Math.abs(highPrevOut);
      if (hVal > maxH) maxH = hVal;

      // Mid band
      const mVal = Math.abs(s - lowPrev - highPrevOut);
      if (mVal > maxM) maxM = mVal;
    }

    bass[i] = maxB;
    mid[i] = maxM;
    high[i] = maxH;
    maxAmp[i] = maxA;
  }

  // Normalize bands across the entire track
  let peakB = 0, peakM = 0, peakH = 0, peakA = 0;
  for (let i = 0; i < count; i++) {
    if (bass[i] > peakB) peakB = bass[i];
    if (mid[i] > peakM) peakM = mid[i];
    if (high[i] > peakH) peakH = high[i];
    if (maxAmp[i] > peakA) peakA = maxAmp[i];
  }
  peakB = peakB || 1;
  peakM = peakM || 1;
  peakH = peakH || 1;
  peakA = peakA || 1;

  for (let i = 0; i < count; i++) {
    bass[i] /= peakB;
    mid[i] /= peakM;
    high[i] /= peakH;
    maxAmp[i] /= peakA;
  }

  return { bass, mid, high, maxAmp, count };
}

const extractPeaks = extractFrequencyPeaks;

// Load Audio File / Buffer into Deck
async function loadTrackIntoDeck(d, buffer, title, artist = 'Local Track', explicitKey = null) {
  AC.resume();
  d.stop();
  d.off = 0;
  d.cue = 0;
  d.hot = new Array(8).fill(null);
  d.buf = buffer;
  d.name = title;
  d.artist = artist;
  d.pk = extractFrequencyPeaks(buffer);
  d.bpm = detectBPM(buffer);
  d.origBpm = d.bpm;

  // Musical Key Detection (Camelot Wheel system)
  if (explicitKey) {
    d.keyObj = typeof explicitKey === 'object' ? explicitKey : { camelot: explicitKey.split(' ')[0], full: explicitKey };
    d.key = d.keyObj.camelot || explicitKey;
  } else {
    d.keyObj = detectMusicalKey(buffer);
    d.key = d.keyObj.camelot;
  }

  $(`#track-name-${d.id}`).textContent = `DECK ${d.id}: ${title.toUpperCase()}`;
  $(`#track-artist-${d.id}`).textContent = artist;
  const bpmStr = d.bpm.toFixed(2);
  $(`#bpm-val-${d.id}`).textContent = bpmStr;
  const hdrBpm = $(`#hdr-bpm-val-${d.id}`);
  if (hdrBpm) hdrBpm.textContent = bpmStr;
  $(`#time-large-${d.id}`).textContent = fmt(0);
  $(`#time-sub-${d.id}`).textContent = fmt(buffer.duration);
  $(`#key-val-${d.id}`).textContent = `#${d.keyObj?.camelot || d.key || '?'}`;

  updateHarmonicMixingHUD();
  updateTransportUI(d);
  updateHotCueUI(d);
  restoreHotCuesFromDB(d);
  renderSavedTracksList();
}

// Real-time Frequency Spectrum Analyzer Extractor
function getDeckFrequencyActivity(d) {
  if (!d.play || !d.buf) {
    return { bass: 0, mid: 0, high: 0, total: 0, hasSignal: false };
  }
  d.analyser.getByteFrequencyData(d.freqData);
  d.analyser.getByteTimeDomainData(d.timeData);

  // Bass / Low frequencies: bins 1 - 8 (approx 30Hz - 300Hz)
  let bassSum = 0;
  for (let i = 1; i <= 8; i++) bassSum += d.freqData[i];
  const bass = bassSum / (8 * 255);

  // Mid frequencies: bins 9 - 34 (approx 300Hz - 2.8kHz)
  let midSum = 0;
  for (let i = 9; i <= 34; i++) midSum += d.freqData[i];
  const mid = midSum / (26 * 255);

  // High frequencies: bins 35 - 80 (approx 2.8kHz - 10.5kHz)
  let highSum = 0;
  for (let i = 35; i <= 80; i++) highSum += d.freqData[i];
  const high = highSum / (46 * 255);

  const total = Math.min(1, bass * 0.55 + mid * 0.3 + high * 0.15);
  return { bass, mid, high, total, hasSignal: total > 0.015 };
}

// Overview Waveform Canvas Drawing
function drawOverviewWave(d) {
  const canvas = $(`#overview-wf-${d.id}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const isBending = Boolean(d.bend && Math.abs(d.bend) > 0.0001);
  const highlightEl = $(`#bend-highlight-${d.id}`);
  if (highlightEl) {
    highlightEl.classList.toggle(`active-bend-${d.id.toLowerCase()}`, isBending);
  }

  if (!d.pk || !d.buf) {
    ctx.fillStyle = '#1c2033';
    ctx.font = '12px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NO TRACK LOADED', W / 2, H / 2 + 4);
    return;
  }

  const T = d.buf.duration;
  const act = getDeckFrequencyActivity(d);

  // Background gradient / subtle bend wash
  if (isBending) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, W, 2);
    ctx.fillRect(0, H - 2, W, 2);
    ctx.restore();
  }

  // Draw 3-Band Frequency color-coded peaks: Bass in RED, Mids in GREEN, Highs in BLUE
  const numPeaks = d.pk.count || d.pk.maxAmp?.length || 600;
  for (let i = 0; i < W; i++) {
    const peakIdx = Math.floor((i / W) * numPeaks);
    const a = d.pk.maxAmp ? (d.pk.maxAmp[peakIdx] || 0) : ((d.pk[peakIdx] || 0));
    const b = d.pk.bass ? (d.pk.bass[peakIdx] || 0) : 0.5;
    const m = d.pk.mid ? (d.pk.mid[peakIdx] || 0) : 0.5;
    const totalH = Math.max(1, a * (H * 0.88));

    // Highs (Blue #38bdf8) - Outer Treble Envelope
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(i, (H - totalH) / 2, 1, totalH);

    // Mids (Green #22c55e) - Middle Body
    const midH = Math.max(1, totalH * (0.3 + 0.55 * m));
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(i, (H - midH) / 2, 1, midH);

    // Bass (Red #ef4444) - Punchy Core
    const bassH = Math.max(1, totalH * (0.15 + 0.7 * b));
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(i, (H - bassH) / 2, 1, bassH);
  }

  // Loop region highlight
  if (d.lp) {
    ctx.fillStyle = d.fg;
    ctx.globalAlpha = 0.28;
    const sX = (d.lp.s / T) * W;
    const eX = (d.lp.e / T) * W;
    ctx.fillRect(sX, 0, eX - sX, H);
    ctx.globalAlpha = 1;
  }

  // Cue point
  ctx.fillStyle = '#f59e0b';
  ctx.globalAlpha = 0.85;
  ctx.fillRect((d.cue / T) * W, 0, 2, H);

  // Hot cues
  ctx.fillStyle = '#38bdf8';
  d.hot.forEach((hc, idx) => {
    if (hc != null) {
      const x = (hc / T) * W;
      ctx.fillRect(x - 1, 0, 2, H);
      ctx.font = '9px monospace';
      ctx.fillText(`${idx + 1}`, x + 3, 10);
    }
  });

  // Playhead with real-time frequency aura
  const curX = (d.pos() / T) * W;
  if (d.play && act.hasSignal) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.2 + act.bass * 0.5;
    const auraW = 8 + act.bass * 20;
    ctx.fillRect(Math.max(0, curX - auraW / 2), 0, auraW, H);
    ctx.restore();
  }

  // Playhead with jog bend aura
  if (isBending) {
    ctx.save();
    ctx.fillStyle = d.col;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.max(0, curX - 6), 0, 12, H);
    ctx.font = '700 10px ui-sans-serif, sans-serif';
    ctx.textAlign = 'right';
    ctx.globalAlpha = 0.9;
    const pct = (d.bend * 100).toFixed(1);
    ctx.fillText(`${d.bend > 0 ? '▶ +' : '◀ '}${pct}% BEND`, W - 8, 12);
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(curX, 0, 2, H);
}

// Parallel Scrolling Waveform Canvas (Cross DJ Signature Feature)
function drawParallelWaves() {
  const canvas = $('#parallel-waves');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const halfH = H / 2;
  const centerLine = W / 2;

  // Deck A (Top Half - Orange)
  drawSingleParallelWave(ctx, D.A, 0, halfH, W, '#ff7700');

  // Deck B (Bottom Half - Cyan)
  drawSingleParallelWave(ctx, D.B, halfH, halfH, W, '#00c3ff');

  // Divider
  ctx.fillStyle = '#1c2032';
  ctx.fillRect(0, halfH - 1, W, 2);

  // Center Playhead Line
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.fillRect(centerLine - 1, 0, 2, H);
  ctx.shadowBlur = 0;

  // Beat phase sync marker
  updatePhaseMeter();
}

function drawSingleParallelWave(ctx, d, topY, height, W, color) {
  if (!d.buf || !d.pk) {
    ctx.fillStyle = '#141724';
    ctx.fillRect(0, topY, W, height);
    return;
  }

  const act = getDeckFrequencyActivity(d);
  const curPos = d.pos();
  const dur = d.buf.duration;
  const centerLine = W / 2;
  const centerY = topY + height / 2;
  const zoomSec = 8; // 8 seconds visible across the screen
  const pxPerSec = W / zoomSec;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, topY, W, height);
  ctx.clip();

  // Subtle live frequency background reactive wash when playing
  if (d.play && act.total > 0.02) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.04 + act.bass * 0.07;
    ctx.fillRect(0, topY, W, height);
  }

  const totalPeaks = d.pk.count || d.pk.length || 600;
  const peakTimeStep = dur / totalPeaks;

  const startSec = curPos - (centerLine / pxPerSec);
  const endSec = curPos + ((W - centerLine) / pxPerSec);

  const startIdx = Math.max(0, Math.floor(startSec / peakTimeStep));
  const endIdx = Math.min(totalPeaks, Math.ceil(endSec / peakTimeStep));

  // Render scrolling waveform bars with 3-band frequency visualization:
  // Bass in RED (#ef4444), Mids in GREEN (#22c55e), Highs in BLUE (#38bdf8)
  for (let i = startIdx; i < endIdx; i++) {
    const peakTime = i * peakTimeStep;
    const x = centerLine + (peakTime - curPos) * pxPerSec;

    const a = d.pk.maxAmp ? (d.pk.maxAmp[i] || 0) : (d.pk[i] || 0);
    const b = d.pk.bass ? (d.pk.bass[i] || 0) : 0.5;
    const m = d.pk.mid ? (d.pk.mid[i] || 0) : 0.5;

    const baseH = a * (height * 0.84);

    // Live frequency analyzer modulation for bars near the center active playhead
    const distFromCenter = Math.abs(x - centerLine);
    let liveH = baseH;

    if (d.play && distFromCenter < 240) {
      const prox = 1 - (distFromCenter / 240); // 1 at center, 0 at outer edges
      const boost = (act.bass * 0.55 + act.mid * 0.3) * prox;
      liveH = baseH * (1 + boost);
    }

    const barW = 2;

    // 1. HIGHS (Blue: #38bdf8) - Outer Treble Envelope
    ctx.fillStyle = '#38bdf8';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, centerY - liveH / 2, barW, liveH);

    // 2. MIDS (Green: #22c55e) - Vocals, Snares, Synths
    const midH = Math.max(2, liveH * (0.35 + 0.5 * m));
    ctx.fillStyle = '#22c55e';
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x, centerY - midH / 2, barW, midH);

    // 3. BASS (Red: #ef4444) - Kick Drum & Sub-Bass Core
    const bassBoost = (d.play && act.bass > 0.08) ? (1 + act.bass * 0.5) : 1;
    const bassH = Math.max(2, liveH * (0.2 + 0.65 * b) * bassBoost);
    ctx.fillStyle = '#ef4444';
    ctx.globalAlpha = 1.0;
    ctx.fillRect(x, centerY - bassH / 2, barW, bassH);
  }

  // Active Loop region shading in scrolling waveform
  if (d.lp) {
    const sX = centerLine + (d.lp.s - curPos) * pxPerSec;
    const eX = centerLine + (d.lp.e - curPos) * pxPerSec;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.22;
    ctx.fillRect(sX, topY, eX - sX, height);
  }

  // Beat Grid Marker Lines with beat transient highlighting
  if (d.bpm > 0) {
    const beatDur = 60 / (d.bpm * d.rate);
    const startBeat = Math.floor(startSec / beatDur);
    const endBeat = Math.ceil(endSec / beatDur);

    for (let b = startBeat; b <= endBeat; b++) {
      const bTime = b * beatDur;
      const bx = centerLine + (bTime - curPos) * pxPerSec;
      const isBar = b % 4 === 0;

      // Glow beat lines near center on bass kicks
      const bDist = Math.abs(bx - centerLine);
      const nearCenter = d.play && bDist < 30 && act.bass > 0.3;

      ctx.fillStyle = nearCenter ? '#ffffff' : (isBar ? '#ffffff' : '#8899aa');
      ctx.globalAlpha = nearCenter ? 0.9 : (isBar ? 0.6 : 0.22);
      ctx.fillRect(bx, topY, isBar ? 2 : 1, height);
    }
  }

  // Real-Time Frequency Activity Oscilloscope / Spectrum Ribbon at Playhead
  if (d.play && act.hasSignal) {
    // Dynamic radial frequency pulse at center
    const pulseRad = 20 + act.bass * 35;
    const grad = ctx.createRadialGradient(centerLine, centerY, 0, centerLine, centerY, pulseRad);
    grad.addColorStop(0, d.id === 'A' ? 'rgba(255, 119, 0, 0.5)' : 'rgba(0, 195, 255, 0.5)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(centerLine - pulseRad, topY, pulseRad * 2, height);

    // Live frequency bin needles (14 active spectrum bars dancing right around the center playhead)
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    const bars = 14;
    for (let b = 0; b < bars; b++) {
      const binIdx = Math.min(d.freqData.length - 1, b * 3 + 2);
      const binVal = (d.freqData[binIdx] || 0) / 255;
      const bh = Math.max(1, binVal * (height * 0.88));
      const bx = centerLine + (b - bars / 2) * 3;
      ctx.fillRect(bx, centerY - bh / 2, 2, bh);
    }
  }

  // Real-time Frequency Spectrum HUD (LOW / MID / HIGH Activity)
  ctx.save();
  ctx.font = '700 9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Deck identifier
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.fillText(d.id, 10, topY + 4);

  // Live frequency meters
  if (d.play) {
    const meterY = topY + 4;
    const meterX = 28;
    const barW = 20;
    const barH = 5;

    // LOW (Bass)
    ctx.fillStyle = '#ff4444';
    ctx.globalAlpha = 0.85;
    ctx.fillText('L', meterX, meterY);
    ctx.fillRect(meterX + 10, meterY + 1, barW * act.bass, barH);

    // MID
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('M', meterX + 42, meterY);
    ctx.fillRect(meterX + 52, meterY + 1, barW * act.mid, barH);

    // HI (Treble)
    ctx.fillStyle = '#22c55e';
    ctx.fillText('H', meterX + 84, meterY);
    ctx.fillRect(meterX + 94, meterY + 1, barW * act.high, barH);
  }
  ctx.restore();

  ctx.restore();
}

// Phase Meter (Visual Beat Alignment)
function updatePhaseMeter() {
  const marker = $('#phase-marker');
  if (!marker || !D.A.buf || !D.B.buf || !D.A.bpm || !D.B.bpm) {
    if (marker) marker.style.left = '50%';
    return;
  }

  const beatA = 60 / (D.A.bpm * D.A.rate);
  const beatB = 60 / (D.B.bpm * D.B.rate);

  const phaseA = (D.A.pos() % beatA) / beatA;
  const phaseB = (D.B.pos() % beatB) / beatB;

  let diff = phaseB - phaseA;
  if (diff > 0.5) diff -= 1;
  if (diff < -0.5) diff += 1;

  // diff is in range -0.5 to +0.5
  const pct = 50 + diff * 100;
  const isMatch = Math.abs(diff) < 0.05;
  marker.style.left = `${Math.max(5, Math.min(95, pct))}%`;
  marker.style.background = isMatch ? '#22c55e' : (Math.abs(diff) < 0.15 ? '#f59e0b' : '#ef4444');

  const matchText = $('#sync-match-text');
  if (matchText) {
    matchText.style.color = isMatch ? '#22c55e' : (Math.abs(diff) < 0.15 ? '#f59e0b' : 'var(--text-muted)');
    matchText.style.textShadow = isMatch ? '0 0 10px rgba(34, 197, 94, 0.8)' : 'none';
  }
}

// Stereo VU Meter Animation
function updateVUMeters() {
  const actA = getDeckFrequencyActivity(D.A);
  const actB = getDeckFrequencyActivity(D.B);

  const levelA = D.A.play ? Math.min(8, Math.floor(actA.total * 9.5)) : 0;
  const levelB = D.B.play ? Math.min(8, Math.floor(actB.total * 9.5)) : 0;

  renderVU('A', levelA);
  renderVU('B', levelB);
}

function renderVU(deckId, activeCount) {
  const leds = $$(`#vu-meter-${deckId} .vu-led`);
  // Leds are ordered top to bottom: index 0 is RED clip, 1 is AMBER, 2-7 are GREEN
  // activeCount 8 lights up all 8
  const total = leds.length;
  leds.forEach((led, idx) => {
    // idx 0 is top
    const fromBottom = total - 1 - idx;
    led.classList.toggle('on', fromBottom < activeCount);
  });
}

// Vinyl Platter Rotation & Scratching
function animatePlatters() {
  ['A', 'B'].forEach(id => {
    const d = D[id];
    if (d.play && !d.touch) {
      // 33 RPM = ~200 deg/sec
      d.rotation += 2.5 * d.eff;
    }
    const needle = $(`#jog-needle-${id}`);
    if (needle) {
      needle.style.transform = `rotate(${d.rotation}deg)`;
    }
  });
}

// -------------------------------------------------------------
// OFFLINE AUDIO SYNTHESIS ENGINE (BUILT-IN DEMO TRACKS)
// Allows 100% offline instant DJ mixing with zero external files
// -------------------------------------------------------------

function generateOfflineDemoTrack(genre) {
  const sr = AC.sampleRate;
  let bpm = 124;
  let bars = 16;
  if (genre === 'techno') { bpm = 130; bars = 16; }
  else if (genre === 'dnb') { bpm = 174; bars = 32; }
  else if (genre === 'hiphop') { bpm = 95; bars = 8; }

  const beatLen = 60 / bpm;
  const barLen = beatLen * 4;
  const totalDuration = bars * barLen;
  const totalSamples = Math.floor(sr * totalDuration);

  const buffer = AC.createBuffer(2, totalSamples, sr);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Helper sound synthesizers directly into float buffers
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const beatTime = (bar * 4 + beat) * beatLen;
      const beatSamp = Math.floor(beatTime * sr);

      // Kick drum
      const isKick = (genre === 'dnb') ? (beat === 0 || beat === 2.5) : (genre === 'hiphop' ? (beat === 0 || beat === 2) : true);
      if (isKick) {
        for (let i = 0; i < sr * 0.22 && beatSamp + i < totalSamples; i++) {
          const t = i / sr;
          const freq = Math.max(35, 150 * Math.exp(-t * 28));
          const val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 14);
          left[beatSamp + i] += val * 0.7;
          right[beatSamp + i] += val * 0.7;
        }
      }

      // Snare / Clap on beat 2 and 4
      if (beat === 1 || beat === 3) {
        for (let i = 0; i < sr * 0.18 && beatSamp + i < totalSamples; i++) {
          const t = i / sr;
          const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22);
          const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 30);
          const val = (noise * 0.6 + tone * 0.4) * 0.55;
          left[beatSamp + i] += val;
          right[beatSamp + i] += val * 0.95;
        }
      }

      // Hi-Hats (8th notes and 16th notes)
      for (let sub = 0; sub < 4; sub++) {
        const hatSamp = beatSamp + Math.floor((sub * beatLen / 4) * sr);
        const isOpen = (sub === 2);
        const hatLen = isOpen ? sr * 0.12 : sr * 0.035;
        if (hatSamp < totalSamples) {
          for (let i = 0; i < hatLen && hatSamp + i < totalSamples; i++) {
            const t = i / sr;
            const noise = (Math.random() * 2 - 1) * Math.exp(-t * (isOpen ? 25 : 80));
            left[hatSamp + i] += noise * 0.18;
            right[hatSamp + i] += noise * 0.2;
          }
        }
      }

      // Bassline note per beat
      const bassFreq = genre === 'techno' ? 48 : (genre === 'dnb' ? (bar % 2 === 0 ? 55 : 44) : 65);
      for (let i = 0; i < sr * (beatLen * 0.85) && beatSamp + i < totalSamples; i++) {
        const t = i / sr;
        const val = Math.sin(2 * Math.PI * bassFreq * t) * Math.exp(-t * 2.5);
        left[beatSamp + i] += val * 0.4;
        right[beatSamp + i] += val * 0.4;
      }
    }
  }

  // Normalize
  let maxAmp = 0;
  for (let i = 0; i < totalSamples; i++) {
    maxAmp = Math.max(maxAmp, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (maxAmp > 0) {
    const scale = 0.92 / maxAmp;
    for (let i = 0; i < totalSamples; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  return buffer;
}

// Generate Offline Sound Effects for Sampler
function initOfflineSampleBank() {
  const sr = AC.sampleRate;

  // 1. Airhorn
  const hornBuf = AC.createBuffer(2, sr * 0.7, sr);
  const hl = hornBuf.getChannelData(0);
  const hr = hornBuf.getChannelData(1);
  for (let i = 0; i < hl.length; i++) {
    const t = i / sr;
    const f1 = 466, f2 = 587, f3 = 700;
    const val = (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t) + Math.sin(2 * Math.PI * f3 * t)) / 3;
    hl[i] = hr[i] = val * Math.min(1, t * 20) * Math.exp(-t * 2.5) * 0.8;
  }
  SAMPLER_BUFFERS[0] = hornBuf;

  // 2. 808 Sub Drop
  const subBuf = AC.createBuffer(2, sr * 1.0, sr);
  const sl = subBuf.getChannelData(0);
  const srCh = subBuf.getChannelData(1);
  for (let i = 0; i < sl.length; i++) {
    const t = i / sr;
    const f = Math.max(30, 120 * Math.exp(-t * 3));
    sl[i] = srCh[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 1.5) * 0.9;
  }
  SAMPLER_BUFFERS[1] = subBuf;

  // 3. Laser Zap
  const laserBuf = AC.createBuffer(2, sr * 0.4, sr);
  const ll = laserBuf.getChannelData(0);
  const lr = laserBuf.getChannelData(1);
  for (let i = 0; i < ll.length; i++) {
    const t = i / sr;
    const f = 2400 * Math.exp(-t * 20);
    ll[i] = lr[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) * 0.75;
  }
  SAMPLER_BUFFERS[2] = laserBuf;

  // 4. Scratch Stab
  const scratchBuf = AC.createBuffer(2, sr * 0.35, sr);
  const scl = scratchBuf.getChannelData(0);
  const scr = scratchBuf.getChannelData(1);
  for (let i = 0; i < scl.length; i++) {
    const t = i / sr;
    const f = 300 + Math.sin(t * 80) * 200;
    scl[i] = scr[i] = (Math.sin(2 * Math.PI * f * t) + (Math.random() - 0.5) * 0.4) * Math.exp(-t * 8) * 0.75;
  }
  SAMPLER_BUFFERS[3] = scratchBuf;

  // 5. Clap Verb
  const clapBuf = AC.createBuffer(2, sr * 0.5, sr);
  const cl = clapBuf.getChannelData(0);
  const cr = clapBuf.getChannelData(1);
  for (let i = 0; i < cl.length; i++) {
    const t = i / sr;
    cl[i] = cr[i] = (Math.random() * 2 - 1) * Math.exp(-t * 10) * 0.7;
  }
  SAMPLER_BUFFERS[4] = clapBuf;

  // 6. Synth Chime
  const chimeBuf = AC.createBuffer(2, sr * 0.8, sr);
  const chl = chimeBuf.getChannelData(0);
  const chr = chimeBuf.getChannelData(1);
  for (let i = 0; i < chl.length; i++) {
    const t = i / sr;
    chl[i] = chr[i] = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 3.5) * 0.7;
  }
  SAMPLER_BUFFERS[5] = chimeBuf;

  // 7. Impact Boom
  const boomBuf = AC.createBuffer(2, sr * 1.2, sr);
  const bml = boomBuf.getChannelData(0);
  const bmr = boomBuf.getChannelData(1);
  for (let i = 0; i < bml.length; i++) {
    const t = i / sr;
    bml[i] = bmr[i] = ((Math.random() * 2 - 1) * 0.3 + Math.sin(2 * Math.PI * 60 * t) * 0.7) * Math.exp(-t * 2.2);
  }
  SAMPLER_BUFFERS[6] = boomBuf;

  // 8. White Noise Sweep
  const noiseBuf = AC.createBuffer(2, sr * 0.9, sr);
  const nzl = noiseBuf.getChannelData(0);
  const nzr = noiseBuf.getChannelData(1);
  for (let i = 0; i < nzl.length; i++) {
    const t = i / sr;
    nzl[i] = nzr[i] = (Math.random() * 2 - 1) * Math.sin(t / 0.9 * Math.PI) * 0.6;
  }
  SAMPLER_BUFFERS[7] = noiseBuf;
}

// =============================================================
// OFFLINE INDEXEDDB PERSISTENT DATABASE ENGINE
// Syncs tracks, hot cues, settings, and recorded mixes locally
// =============================================================
const DB_NAME = 'CrossDJ_Database';
const DB_VERSION = 1;
let dbInstance = null;

function initDatabase() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB not supported on this browser.');
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => {
      console.error('IndexedDB open error:', e);
      resolve(null);
    };
    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      const statusBadge = $('#db-status-badge');
      if (statusBadge) {
        statusBadge.textContent = '💾 DB Synced';
        statusBadge.style.borderColor = 'var(--led-green)';
        statusBadge.style.color = 'var(--led-green)';
      }
      loadSavedRecordingsFromDB();
      loadSavedTracksFromDB();
      loadSettingsFromDB();
      resolve(dbInstance);
    };
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('cues')) {
        db.createObjectStore('cues', { keyPath: 'trackName' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
  });
}

// 1. Recordings Database Operations
function saveRecordingToDB(title, blob, duration) {
  if (!dbInstance) return;
  const tx = dbInstance.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const record = {
    title,
    blob,
    duration,
    date: new Date().toISOString()
  };
  const req = store.add(record);
  req.onsuccess = () => {
    loadSavedRecordingsFromDB();
  };
}

function loadSavedRecordingsFromDB() {
  if (!dbInstance) return;
  const tx = dbInstance.transaction('recordings', 'readonly');
  const store = tx.objectStore('recordings');
  const req = store.getAll();
  req.onsuccess = () => {
    const recordings = req.result || [];
    const countEl = $('#rec-count');
    if (countEl) countEl.textContent = recordings.length;

    const list = $('#recordings-list');
    if (!list) return;
    list.innerHTML = '';
    if (recordings.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No mixes recorded yet. Tap "● REC MIX" in the header to record your live mix and download it offline.</p>';
      return;
    }

    recordings.reverse().forEach(rec => {
      const url = URL.createObjectURL(rec.blob);
      const item = document.createElement('div');
      item.className = 'recording-item';
      item.innerHTML = `
        <div class="rec-info">
          <strong>${rec.title}</strong>
          <span style="color:var(--text-dim);font-size:11px">${fmtMinSec(rec.duration || 0)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <audio src="${url}" controls style="height:28px"></audio>
          <a href="${url}" download="${rec.title}" class="rec-download-btn">DOWNLOAD</a>
          <button class="delete-rec-btn" data-id="${rec.id}" style="background:#261214;border:1px solid #7f1d1d;color:#fca5a5;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer" title="Delete from Database">🗑️</button>
        </div>
      `;
      item.querySelector('.delete-rec-btn')?.addEventListener('click', () => {
        deleteRecordingFromDB(rec.id);
      });
      list.appendChild(item);
    });
  };
}

function deleteRecordingFromDB(id) {
  if (!dbInstance) return;
  const tx = dbInstance.transaction('recordings', 'readwrite');
  tx.objectStore('recordings').delete(id);
  tx.oncomplete = () => loadSavedRecordingsFromDB();
}

// 2. Custom Tracks Database Operations & Phone Scanner Engine
let cachedDatabaseTracks = [];

function isAudioFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|aiff|alac)$/i.test(file.name);
}

async function scanDirectoryEntries(dirHandle, collected = []) {
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        if (isAudioFile(file)) collected.push(file);
      } else if (entry.kind === 'directory') {
        await scanDirectoryEntries(entry, collected);
      }
    }
  } catch (err) {
    console.warn('Directory scanner error:', err);
  }
  return collected;
}

async function processScannedAudioFiles(fileList) {
  const files = Array.from(fileList).filter(isAudioFile);
  if (files.length === 0) {
    alert('No audio files detected in the selected location.');
    return;
  }

  const progressWrap = $('#scan-progress-wrap');
  const progressBar = $('#scan-progress-bar');
  const progressStatus = $('#scan-progress-status');
  const progressCount = $('#scan-progress-count');

  if (progressWrap) progressWrap.style.display = 'flex';
  AC.resume();

  let savedCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pct = Math.round(((i + 1) / files.length) * 100);
    if (progressStatus) progressStatus.textContent = `Scanning: ${file.name}`;
    if (progressCount) progressCount.textContent = `${i + 1} / ${files.length} (${pct}%)`;
    if (progressBar) progressBar.style.width = `${pct}%`;

    try {
      const arr = await file.arrayBuffer();
      let duration = 0;
      let bpm = 0;
      let key = '8A (Am)';
      try {
        const audioBuf = await AC.decodeAudioData(arr.slice(0));
        duration = audioBuf.duration;
        bpm = detectBPM(audioBuf);
        const keyObj = detectMusicalKey(audioBuf);
        key = keyObj.full;

        // Auto-load first track into Deck A if empty
        if (i === 0 && !D.A.buf) {
          loadTrackIntoDeck(D.A, audioBuf, file.name, 'Phone Storage', key);
        } else if (i === 1 && !D.B.buf) {
          loadTrackIntoDeck(D.B, audioBuf, file.name, 'Phone Storage', key);
        }
      } catch (_) {}

      await saveTrackToDB(file.name, file.size, file.type || 'audio/mpeg', arr, duration, bpm, key);
      savedCount++;
    } catch (err) {
      console.warn('Error reading audio file:', file.name, err);
    }
  }

  if (progressStatus) progressStatus.textContent = `✅ Scan complete! ${savedCount} audio tracks saved to database.`;
  if (progressBar) progressBar.style.width = '100%';
  setTimeout(() => {
    if (progressWrap) progressWrap.style.display = 'none';
  }, 3500);

  loadSavedTracksFromDB();
}

function saveTrackToDB(name, size, type, arrayBuffer, duration, bpm = 0, key = '') {
  return new Promise((resolve) => {
    if (!dbInstance) {
      resolve(null);
      return;
    }
    const tx = dbInstance.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const record = {
      name,
      size,
      type,
      data: arrayBuffer,
      duration,
      bpm,
      key: key || '8A (Am)',
      dateAdded: new Date().toISOString()
    };
    const req = store.add(record);
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
}

function loadSavedTracksFromDB() {
  if (!dbInstance) return;
  const tx = dbInstance.transaction('tracks', 'readonly');
  const store = tx.objectStore('tracks');
  const req = store.getAll();
  req.onsuccess = () => {
    cachedDatabaseTracks = req.result || [];
    const countEl = $('#saved-tracks-count');
    if (countEl) countEl.textContent = cachedDatabaseTracks.length;
    renderSavedTracksList();
  };
}

function renderSavedTracksList() {
  const list = $('#saved-tracks-list');
  if (!list) return;

  const searchQuery = ($('#track-search-input')?.value || '').trim().toLowerCase();
  const sortBy = $('#track-sort-select')?.value || 'newest';

  let filtered = cachedDatabaseTracks.filter(track => {
    if (!searchQuery) return true;
    return track.name.toLowerCase().includes(searchQuery);
  });

  if (sortBy === 'name') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === 'duration') {
    filtered.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  } else if (sortBy === 'key') {
    filtered.sort((a, b) => {
      const getWeight = (t) => {
        const m = (t.key || '').match(/(\d+)([AB])/i);
        if (!m) return 999;
        return parseInt(m[1], 10) * 2 + (m[2].toUpperCase() === 'B' ? 1 : 0);
      };
      return getWeight(a) - getWeight(b);
    });
  } else {
    // newest
    filtered.sort((a, b) => (new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0)));
  }

  list.innerHTML = '';
  if (filtered.length === 0) {
    if (cachedDatabaseTracks.length === 0) {
      list.innerHTML = '<p id="empty-db-msg" style="color:var(--text-muted);font-size:12px">No tracks saved in database yet. Tap "🔍 Scan Phone Audio" or drop files above to permanently store them.</p>';
    } else {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No tracks match your search filter.</p>';
    }
    return;
  }

  const activeDeckKey = (D.A.play ? D.A.key : (D.B.play ? D.B.key : D.A.key)) || D.A.key;

  filtered.forEach(track => {
    const item = document.createElement('div');
    item.className = 'demo-track-card';
    item.style.padding = '8px 12px';
    const sizeMB = (track.size / (1024 * 1024)).toFixed(1);
    const durStr = fmtMinSec(track.duration || 0);
    const ext = track.name.split('.').pop().toUpperCase();
    const bpmBadge = track.bpm ? `<span style="background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px">${track.bpm.toFixed(1)} BPM</span>` : '';
    const trackKey = track.key || '8A (Am)';
    const isHarmonicMatch = areKeysHarmonicallyCompatible(activeDeckKey, trackKey);
    const harmonicBadge = isHarmonicMatch
      ? `<span style="background:rgba(16,185,129,0.18);border:1px solid #10b981;color:#34d399;font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px">✨ Match</span>`
      : '';

    item.innerHTML = `
      <div class="demo-track-info" style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;overflow:hidden">
          <span style="background:#242c48;color:#93c5fd;font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px">${ext}</span>
          <h4 style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#fff">${track.name}</h4>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
          <p style="font-size:10px;color:var(--text-dim)">${durStr} • ${sizeMB} MB</p>
          ${bpmBadge}
          <span class="camelot-badge" style="background:#1e1b4b;border:1px solid #6366f1;color:#a5b4fc;font-size:9px;font-weight:800;padding:1px 4px;border-radius:3px">${trackKey}</span>
          ${harmonicBadge}
        </div>
      </div>
      <div class="load-btn-group" style="display:flex;gap:4px">
        <button class="btn-load btn-load-a db-load-btn" data-target="A">Deck A</button>
        <button class="btn-load btn-load-b db-load-btn" data-target="B">Deck B</button>
        <button class="btn-load db-sync-b-btn" style="background:#7c3aed;color:#fff" title="Load into Deck B and sync tempo to Deck A">⚡ Sync B</button>
        <button class="db-del-btn" style="background:#261214;border:1px solid #7f1d1d;color:#fca5a5;padding:4px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer" title="Delete from Database">✕</button>
      </div>
    `;

    item.querySelector('.btn-load-a')?.addEventListener('click', async () => {
      AC.resume();
      const buf = await AC.decodeAudioData(track.data.slice(0));
      loadTrackIntoDeck(D.A, buf, track.name, 'Phone Storage', track.key);
      if (window.innerHeight < 540) $('.bottom-drawer')?.classList.remove('open-drawer');
    });

    item.querySelector('.btn-load-b')?.addEventListener('click', async () => {
      AC.resume();
      const buf = await AC.decodeAudioData(track.data.slice(0));
      loadTrackIntoDeck(D.B, buf, track.name, 'Phone Storage', track.key);
      if (window.innerHeight < 540) $('.bottom-drawer')?.classList.remove('open-drawer');
    });

    item.querySelector('.db-sync-b-btn')?.addEventListener('click', async () => {
      AC.resume();
      const buf = await AC.decodeAudioData(track.data.slice(0));
      await loadTrackIntoDeck(D.B, buf, track.name, 'Phone Storage', track.key);
      syncDeck(D.B);
      if (window.innerHeight < 540) $('.bottom-drawer')?.classList.remove('open-drawer');
    });

    item.querySelector('.db-del-btn')?.addEventListener('click', () => {
      deleteTrackFromDB(track.id);
    });

    list.appendChild(item);
  });
}

function deleteTrackFromDB(id) {
  if (!dbInstance) return;
  const tx = dbInstance.transaction('tracks', 'readwrite');
  tx.objectStore('tracks').delete(id);
  tx.oncomplete = () => loadSavedTracksFromDB();
}

function clearAllDBTracks() {
  if (!dbInstance) return;
  if (!confirm('Are you sure you want to clear all saved database tracks?')) return;
  const tx = dbInstance.transaction('tracks', 'readwrite');
  tx.objectStore('tracks').clear();
  tx.oncomplete = () => loadSavedTracksFromDB();
}

// 3. Hot Cues Database Operations
function saveHotCuesToDB(d) {
  if (!dbInstance || !d.name || d.name === 'No track loaded') return;
  try {
    const tx = dbInstance.transaction('cues', 'readwrite');
    tx.objectStore('cues').put({
      trackName: d.name,
      hot: [...d.hot],
      updated: Date.now()
    });
  } catch (e) {}
}

function restoreHotCuesFromDB(d) {
  if (!dbInstance || !d.name) return;
  try {
    const tx = dbInstance.transaction('cues', 'readonly');
    const req = tx.objectStore('cues').get(d.name);
    req.onsuccess = () => {
      if (req.result && Array.isArray(req.result.hot)) {
        d.hot = [...req.result.hot];
        updateHotCueUI(d);
      }
    };
  } catch (e) {}
}

// 4. Settings Database Operations
function saveSettingsToDB(key, value) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
  } catch (e) {}
}

function loadSettingsFromDB() {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.forEach(item => {
        if (item.key === 'master-vol') {
          const el = $('#master-vol');
          if (el) {
            el.value = item.value;
            masterGain.gain.value = (item.value / 100) * (item.value / 100);
          }
        } else if (item.key === 'inv-tempo') {
          const el = $('#inv-tempo');
          if (el) el.checked = Boolean(item.value);
        } else if (item.key === 'xfadeCurve') {
          xfadeCurve = item.value;
          $$('.curve-opt').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.curve === xfadeCurve);
          });
        }
      });
    };
  } catch (e) {}
}

// -------------------------------------------------------------
// OFFLINE MIX RECORDER TO HIGH FIDELITY WAV
// -------------------------------------------------------------

function toggleMixRecording() {
  AC.resume();
  const btn = $('#btn-record-mix');
  const timer = $('#record-timer');

  if (isRecording) {
    // STOP Recording
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    clearInterval(recordTimerInterval);
    btn.classList.remove('recording');
    btn.innerHTML = `<span class="rec-dot"></span> ● REC MIX`;
  } else {
    // START Recording
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(mediaDest.stream);
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = saveRecordedMix;
      mediaRecorder.start(250);
      isRecording = true;
      recordSeconds = 0;
      btn.classList.add('recording');
      btn.innerHTML = `<span class="rec-dot"></span> ■ STOP (0:00)`;

      recordTimerInterval = setInterval(() => {
        recordSeconds++;
        const timeStr = fmtMinSec(recordSeconds);
        btn.innerHTML = `<span class="rec-dot"></span> ■ STOP (${timeStr})`;
        if (timer) timer.textContent = timeStr;
      }, 1000);
    } catch (err) {
      alert('Could not start audio recorder: ' + err.message);
    }
  }
}

function saveRecordedMix() {
  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const now = new Date();
  const title = `DJ_An2ny_Mix_${now.toISOString().slice(0, 10)}_${now.getHours()}h${String(now.getMinutes()).padStart(2, '0')}m.webm`;
  saveRecordingToDB(title, blob, recordSeconds);
}

// -------------------------------------------------------------
// MIDI CONTROLLER ENGINE (HERCULES INPULSE 300 MK2 MAPPING)
// -------------------------------------------------------------

const MIDI_MAP = { 0: 'vol', 1: 'fl', 2: 'lo', 3: 'mi', 4: 'hi', 5: 'gain', 8: 'tempo' };

function handleMidiMessage(e) {
  const [s, a, b] = e.data;
  const t = s & 0xf0;
  const ch = s & 0x0f;

  const hex = [s, a, b].map(x => x.toString(16).padStart(2, '0')).join(' ');
  const logEl = $('#midi-log-text');
  if (logEl) logEl.textContent = `MIDI: ${hex}`;

  const dk = ch === 1 ? D.A : ch === 2 ? D.B : null;

  if (t === 0x90 || t === 0x80) {
    const on = t === 0x90 && b > 0;
    if (dk) {
      if (a === 7 && on) dk.play ? dk.stop() : dk.go();
      else if (a === 6) on ? cueDown(dk) : cueUp(dk);
      else if (a === 8) dk.touch = on;
      else if ((a === 5 || a === 9) && on) syncDeck(dk);
    }

    const pd = ch === 6 ? D.A : ch === 7 ? D.B : null;
    if (pd) {
      const idx = a & 7;
      const grp = a >> 3;
      if (grp < 2) {
        if (on) triggerHotCue(pd, idx, grp === 1);
      } else if (grp === 2) {
        on ? loopOn(pd, ROLL_BEATS[idx], true) : loopOff(pd, true);
      } else if (grp === 4) {
        if (on) (pd.lp ? loopOff(pd, false) : loopOn(pd, LATCH_BEATS[idx], false));
      } else if (grp === 6) {
        if (on) triggerSample(idx);
      }
    }
  } else if (t === 0xb0) {
    if (a >= 0x20 && a < 0x40) return;
    const v = b / 127;
    if (ch === 0 && a === 0) xfade(v);
    if (!dk) return;
    if (MIDI_MAP[a]) param(dk.id, MIDI_MAP[a], v);
    else if (a === 9 || a === 10) jog(dk, b < 64 ? b : b - 128, a === 10);
  }
}

async function connectMidiController() {
  AC.resume();
  const statusEl = $('#controller-status');
  try {
    const access = await navigator.requestMIDIAccess();
    const updatePorts = () => {
      let foundName = '';
      midiOutput = null;
      access.inputs.forEach(i => {
        if (/inpulse/i.test(i.name) || /dj/i.test(i.name) || /controller/i.test(i.name)) {
          i.onmidimessage = handleMidiMessage;
          foundName = i.name;
        } else {
          i.onmidimessage = handleMidiMessage;
        }
      });
      access.outputs.forEach(o => {
        if (/inpulse/i.test(o.name) || /dj/i.test(o.name)) midiOutput = o;
      });

      if (statusEl) {
        if (foundName) {
          statusEl.textContent = `Connected: ${foundName}`;
          statusEl.classList.add('connected');
        } else {
          statusEl.textContent = 'MIDI Ready (Touch Controls Active)';
          statusEl.classList.remove('connected');
        }
      }
    };
    updatePorts();
    access.onstatechange = updatePorts;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'MIDI Unavail (Touch / Keyboard Active)';
  }
}

// -------------------------------------------------------------
// UI INITIALIZATION & EVENT LISTENERS
// -------------------------------------------------------------

function setupEventListeners() {
  // Master Volume
  $('#master-vol')?.addEventListener('input', e => {
    masterGain.gain.value = (e.target.value / 100) * 1.2;
  });

  // Crossfader
  $('#crossfader')?.addEventListener('input', e => {
    xfade(e.target.value / 100);
  });

  // Crossfader Curve options
  $$('.curve-opt').forEach(opt => {
    opt.addEventListener('click', e => {
      $$('.curve-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      xfadeCurve = opt.dataset.curve;
      xfade($('#crossfader').value / 100);
    });
  });

  // Connect MIDI button
  $('#btn-connect-midi')?.addEventListener('click', connectMidiController);

  // Record Mix button
  $('#btn-record-mix')?.addEventListener('click', toggleMixRecording);
  $('#btn-top-rec')?.addEventListener('click', toggleMixRecording);

  // Cross DJ Top Header Load Track (+) Buttons
  $('#btn-load-track-A')?.addEventListener('click', () => {
    AC.resume();
    const drawer = $('.bottom-drawer');
    if (drawer) {
      drawer.classList.add('open-drawer');
      $$('.tab-btn').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      $('[data-tab="demos"]')?.classList.add('active');
      $('#tab-demos')?.classList.add('active');
    }
  });

  $('#btn-load-track-B')?.addEventListener('click', () => {
    AC.resume();
    const drawer = $('.bottom-drawer');
    if (drawer) {
      drawer.classList.add('open-drawer');
      $$('.tab-btn').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      $('[data-tab="demos"]')?.classList.add('active');
      $('#tab-demos')?.classList.add('active');
    }
  });

  // Settings Gear & Top Pill
  $('#btn-settings-gear')?.addEventListener('click', () => {
    $('.bottom-drawer')?.classList.toggle('open-drawer');
  });

  $('#btn-top-sampler')?.addEventListener('click', () => {
    AC.resume();
    const drawer = $('.bottom-drawer');
    if (drawer) {
      drawer.classList.add('open-drawer');
      $$('.tab-btn').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      $('[data-tab="sampler"]')?.classList.add('active');
      $('#tab-sampler')?.classList.add('active');
    }
  });

  // Center Mode Switcher (Mixer vs Waveforms)
  $('#btn-view-waves')?.addEventListener('click', () => {
    $('#btn-view-waves')?.classList.add('active');
    $('#btn-view-mixer')?.classList.remove('active');
    const w = $('#center-view-waves');
    const m = $('#center-view-mixer');
    if (w) w.style.display = 'flex';
    if (m) m.style.display = 'none';
  });

  $('#btn-view-mixer')?.addEventListener('click', () => {
    $('#btn-view-mixer')?.classList.add('active');
    $('#btn-view-waves')?.classList.remove('active');
    const w = $('#center-view-waves');
    const m = $('#center-view-mixer');
    if (w) w.style.display = 'none';
    if (m) m.style.display = 'flex';
  });

  // Clear Hot Cues (Trash can button)
  $('#btn-clear-cue-A')?.addEventListener('click', () => {
    D.A.hot = new Array(8).fill(null);
    updateHotCueUI(D.A);
    saveHotCuesToDB(D.A);
  });
  $('#btn-clear-cue-B')?.addEventListener('click', () => {
    D.B.hot = new Array(8).fill(null);
    updateHotCueUI(D.B);
    saveHotCuesToDB(D.B);
  });

  // Crossfader Nudge / Cut buttons
  $('#btn-xfade-left')?.addEventListener('click', () => xfade(0));
  $('#btn-xfade-right')?.addEventListener('click', () => xfade(1));

  // FX Buttons interactive filter toggle
  $$('.cdj-fx-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const isA = btn.id.includes('a');
      const d = isA ? D.A : D.B;
      const t = btn.textContent.toLowerCase();
      if (t.includes('lp')) {
        param(d.id, 'fl', 0.25);
      } else if (t.includes('hp')) {
        param(d.id, 'fl', 0.75);
      } else {
        param(d.id, 'fl', 0.5);
      }
    });
  });

  // Deck Controls
  ['A', 'B'].forEach(id => {
    const d = D[id];

    // Transport buttons
    $(`#btn-play-${id}`)?.addEventListener('click', () => {
      AC.resume();
      d.play ? d.stop() : d.go();
    });

    $(`#btn-cue-${id}`)?.addEventListener('pointerdown', () => {
      AC.resume();
      cueDown(d);
    });
    $(`#btn-cue-${id}`)?.addEventListener('pointerup', () => cueUp(d));

    $(`#btn-sync-${id}`)?.addEventListener('click', () => syncDeck(d));

    // Nudge + / - buttons
    $(`#nudge-plus-${id}`)?.addEventListener('click', () => jog(d, 8, false));
    $(`#nudge-minus-${id}`)?.addEventListener('click', () => jog(d, -8, false));

    // Tempo range cycle
    $(`#tempo-range-${id}`)?.addEventListener('click', e => {
      const ranges = [0.08, 0.16, 0.50];
      const curIdx = ranges.indexOf(d.tempoRange);
      d.tempoRange = ranges[(curIdx + 1) % ranges.length];
      e.target.textContent = `±${Math.round(d.tempoRange * 100)}%`;
      const slider = $(`#tempo-slider-${id}`);
      if (slider) param(id, 'tempo', slider.value / 100);
    });

    // Keylock toggle
    $(`#keylock-${id}`)?.addEventListener('click', e => {
      d.keylock = !d.keylock;
      e.target.classList.toggle('active', d.keylock);
    });

    // Slider inputs (Volume, EQ, Filter, Tempo, Gain)
    $$(`[data-d="${id}"]`).forEach(input => {
      input.addEventListener('input', e => {
        param(id, e.target.dataset.p, e.target.value / 100);
      });
    });

    // EQ Kill buttons
    $(`#kill-hi-${id}`)?.addEventListener('click', e => {
      d.killHi = !d.killHi;
      e.target.classList.toggle('active', d.killHi);
      d.hi.gain.value = d.killHi ? -70 : dB(d.rawHi);
    });
    $(`#kill-mid-${id}`)?.addEventListener('click', e => {
      d.killMi = !d.killMi;
      e.target.classList.toggle('active', d.killMi);
      d.mi.gain.value = d.killMi ? -70 : dB(d.rawMi);
    });
    $(`#kill-low-${id}`)?.addEventListener('click', e => {
      d.killLo = !d.killLo;
      e.target.classList.toggle('active', d.killLo);
      d.lo.gain.value = d.killLo ? -70 : dB(d.rawLo);
    });

    // Loop controls
    $(`#loop-in-${id}`)?.addEventListener('click', () => {
      if (d.buf) d.lp = { s: d.pos(), e: d.buf.duration };
    });
    $(`#loop-out-${id}`)?.addEventListener('click', () => {
      if (d.buf && d.lp) {
        d.lp.e = Math.max(d.lp.s + 0.1, d.pos());
        d.start();
        $(`#loop-active-${id}`)?.classList.add('active');
      }
    });
    $(`#loop-active-${id}`)?.addEventListener('click', () => {
      d.lp ? loopOff(d, false) : loopOn(d, 4, false);
    });
    $(`#loop-half-${id}`)?.addEventListener('click', () => {
      if (d.lp) {
        const half = (d.lp.e - d.lp.s) / 2;
        d.lp.e = d.lp.s + half;
      }
    });
    $(`#loop-double-${id}`)?.addEventListener('click', () => {
      if (d.lp && d.buf) {
        const double = (d.lp.e - d.lp.s) * 2;
        d.lp.e = Math.min(d.buf.duration, d.lp.s + double);
      }
    });

    // Pad mode tabs
    $$(`[data-deck-tab="${id}"]`).forEach(tab => {
      tab.addEventListener('click', () => {
        $$(`[data-deck-tab="${id}"]`).forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        d.padMode = tab.dataset.mode;
        renderPads(d);
      });
    });

    // Performance Pads
    $$(`[data-deck="${id}"][data-pad]`).forEach(pad => {
      const idx = +pad.dataset.pad;
      pad.addEventListener('pointerdown', e => {
        AC.resume();
        if (d.padMode === 'hotcue') {
          triggerHotCue(d, idx, e.shiftKey);
        } else if (d.padMode === 'roll') {
          pad.classList.add('active-roll');
          loopOn(d, ROLL_BEATS[idx], true);
        } else if (d.padMode === 'sampler') {
          triggerSample(idx);
        } else if (d.padMode === 'fx') {
          d.fxGain.gain.value = (idx + 1) * 0.15;
          pad.classList.add('set');
        }
      });
      pad.addEventListener('pointerup', () => {
        if (d.padMode === 'roll') {
          pad.classList.remove('active-roll');
          loopOff(d, true);
        } else if (d.padMode === 'fx') {
          d.fxGain.gain.value = 0;
          pad.classList.remove('set');
        }
      });
    });

    // Overview Waveform Seek Click / Drag
    const overviewEl = $(`#overview-wf-${id}`);
    if (overviewEl) {
      overviewEl.addEventListener('pointerdown', e => {
        AC.resume();
        const rect = overviewEl.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        if (d.buf) d.seek(ratio * d.buf.duration);
      });
    }

    // Touch & Scratch on Jog Platter
    const platter = $(`#jog-platter-${id}`);
    if (platter) {
      let isScratching = false;
      let startAngle = 0;
      let prevX = 0;

      platter.addEventListener('pointerdown', e => {
        AC.resume();
        isScratching = true;
        d.touch = true;
        prevX = e.clientX;
        platter.classList.add('touching');
        platter.setPointerCapture(e.pointerId);
      });

      platter.addEventListener('pointermove', e => {
        if (!isScratching) return;
        const delta = e.clientX - prevX;
        prevX = e.clientX;
        jog(d, delta * 3, true);
      });

      const endScratch = e => {
        if (isScratching) {
          isScratching = false;
          d.touch = false;
          platter.classList.remove('touching');
          try { platter.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      platter.addEventListener('pointerup', endScratch);
      platter.addEventListener('pointercancel', endScratch);
    }
  });

  // Wheel Jog Pitch Bend on Overview and Parallel Waveforms
  document.addEventListener('wheel', e => {
    const wf = e.target.closest('.overview-canvas, .parallel-wave-canvas');
    if (wf) {
      e.preventDefault();
      AC.resume();
      let d = null;
      if (wf.id.includes('overview-wf-A')) d = D.A;
      else if (wf.id.includes('overview-wf-B')) d = D.B;
      else {
        // Parallel waveform: upper half Deck A, lower half Deck B
        const rect = wf.getBoundingClientRect();
        d = (e.clientY - rect.top) < rect.height / 2 ? D.A : D.B;
      }
      if (d && d.buf) {
        const delta = e.deltaX !== 0 ? (e.deltaX > 0 ? 4 : -4) : (e.deltaY > 0 ? -4 : 4);
        jog(d, delta, false);
      }
    }
  }, { passive: false });

  // Library Drawer Toggle & Close (Mobile Landscape & Compact Mode)
  $('#btn-toggle-library')?.addEventListener('click', () => {
    $('.bottom-drawer')?.classList.toggle('open-drawer');
  });

  $('#btn-close-drawer')?.addEventListener('click', () => {
    $('.bottom-drawer')?.classList.remove('open-drawer');
  });

  // Download ZIP Handler (programmatic Blob trigger works cleanly inside iframes & mobile)
  $$('.btn-trigger-download, a[href="/api/download-zip"]').forEach(el => {
    el.addEventListener('click', async e => {
      e.preventDefault();
      const originalText = el.textContent;
      el.textContent = '⏳ Preparing ZIP…';
      try {
        const response = await fetch('/api/download-zip');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const tempLink = document.createElement('a');
        tempLink.href = blobUrl;
        tempLink.setAttribute('download', 'inpulse-300-mk2-cross-dj.zip');
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        tempLink.click();
        document.body.removeChild(tempLink);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        el.textContent = '✅ Download Started!';
        setTimeout(() => { el.textContent = originalText; }, 2500);
      } catch (err) {
        console.warn('Blob download fetch error, falling back to direct link:', err);
        window.location.href = '/api/download-zip';
      }
    });
  });

  // Bottom Drawer Tabs
  $$('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab-btn').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`)?.classList.add('active');
    });
  });

  // Offline Demo Tracks Buttons
  $$('.btn-load').forEach(btn => {
    btn.addEventListener('click', async () => {
      AC.resume();
      const genre = btn.dataset.genre;
      const targetDeckId = btn.dataset.target;
      const d = D[targetDeckId];

      btn.textContent = 'BUILDING…';
      setTimeout(() => {
        const buffer = generateOfflineDemoTrack(genre);
        const titles = {
          house: 'Neon Groove (House 124)',
          techno: 'Cyber Pulse (Techno 130)',
          dnb: 'Gravity Rush (DnB 174)',
          hiphop: 'Sunset Chill (HipHop 95)',
        };
        const keys = {
          house: '8A (Am)',
          techno: '6A (Gm)',
          dnb: '11A (F#m)',
          hiphop: '4A (Fm)',
        };
        loadTrackIntoDeck(d, buffer, titles[genre] || 'Offline Beat', 'DJ An2ny Offline', keys[genre]);
        btn.textContent = `DECK ${targetDeckId}`;
        // In mobile landscape mode, auto-close drawer once loaded
        if (window.innerHeight < 540) {
          $('.bottom-drawer')?.classList.remove('open-drawer');
        }
      }, 50);
    });
  });

  // Phone Audio Scanner & Folder Picker
  $('#btn-scan-phone')?.addEventListener('click', () => {
    $('#audio-file-input')?.click();
  });

  $('#btn-scan-folder')?.addEventListener('click', async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await window.showDirectoryPicker();
        const files = await scanDirectoryEntries(dirHandle);
        await processScannedAudioFiles(files);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    $('#audio-folder-input')?.click();
  });

  $('#audio-folder-input')?.addEventListener('change', e => {
    if (e.target.files.length) processScannedAudioFiles(e.target.files);
  });

  // Track search & sort filters
  $('#track-search-input')?.addEventListener('input', renderSavedTracksList);
  $('#track-sort-select')?.addEventListener('change', renderSavedTracksList);

  // Custom Local File Upload
  const fileInput = $('#audio-file-input');
  const dropZone = $('#upload-drop-zone');

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--deck-b)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = '';
    });
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      if (e.dataTransfer.files.length) processScannedAudioFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) processScannedAudioFiles(e.target.files);
    });
  }
}

async function handleLoadedFiles(files) {
  AC.resume();
  for (const file of files) {
    try {
      const arr = await file.arrayBuffer();
      const buf = await AC.decodeAudioData(arr.slice(0));
      await saveTrackToDB(file.name, file.size, file.type, arr, buf.duration);

      // Auto-load to empty deck or Deck A
      if (!D.A.buf) loadTrackIntoDeck(D.A, buf, file.name);
      else if (!D.B.buf) loadTrackIntoDeck(D.B, buf, file.name);
      else loadTrackIntoDeck(D.A, buf, file.name);

      if (window.innerHeight < 540) {
        $('.bottom-drawer')?.classList.remove('open-drawer');
      }
    } catch (e) {
      alert(`Could not decode audio file: ${file.name}`);
    }
  }
}

function renderPads(d) {
  const pads = $$(`[data-deck="${d.id}"][data-pad]`);
  pads.forEach((pad, idx) => {
    pad.className = 'cdj-pad-cell pad-btn';
    if (d.padMode === 'hotcue') {
      pad.textContent = d.hot[idx] != null ? `CUE ${idx + 1}` : `${idx + 1}`;
      if (d.hot[idx] != null) pad.classList.add('set');
    } else if (d.padMode === 'roll') {
      const beats = ['1/16', '1/8', '1/4', '1/2', '1', '2', '4', '8'];
      pad.textContent = beats[idx];
    } else if (d.padMode === 'sampler') {
      const smNames = ['HORN', '808', 'ZAP', 'SCRTCH', 'CLAP', 'CHIME', 'BOOM', 'NOISE'];
      pad.textContent = smNames[idx];
    } else if (d.padMode === 'fx') {
      const fxNames = ['DLY 1', 'DLY 2', 'DLY 3', 'DLY 4', 'REV 1', 'REV 2', 'FLT 1', 'FLT 2'];
      pad.textContent = fxNames[idx];
    }
  });
}

// -------------------------------------------------------------
// MAIN TICK RUNTIME LOOP (60 FPS)
// -------------------------------------------------------------

function runAnimationLoop() {
  ['A', 'B'].forEach(id => {
    const d = D[id];
    if (d.buf) {
      const cur = d.pos();
      const dur = d.buf.duration;
      const rem = dur - cur;

      const timeLarge = $(`#time-large-${id}`);
      const timeSub = $(`#time-sub-${id}`);
      if (timeLarge) timeLarge.textContent = fmt(cur);
      if (timeSub) timeSub.textContent = fmt(rem);

      drawOverviewWave(d);
    }
  });

  drawParallelWaves();
  updateVUMeters();
  animatePlatters();

  requestAnimationFrame(runAnimationLoop);
}

// Boot Initialization
window.addEventListener('DOMContentLoaded', () => {
  // Default Mixer params
  ['A', 'B'].forEach(id => {
    param(id, 'vol', 0.85);
    param(id, 'gain', 0.5);
    param(id, 'hi', 0.5);
    param(id, 'mi', 0.5);
    param(id, 'lo', 0.5);
    param(id, 'fl', 0.5);
    param(id, 'tempo', 0.5);
  });
  xfade(0.5);

  setupEventListeners();
  initOfflineSampleBank();
  initDatabase();

  $('#btn-clear-db-tracks')?.addEventListener('click', clearAllDBTracks);
  $('#master-vol')?.addEventListener('change', e => saveSettingsToDB('master-vol', e.target.value));
  $('#inv-tempo')?.addEventListener('change', e => saveSettingsToDB('inv-tempo', e.target.checked));
  $$('.curve-opt').forEach(btn => {
    btn.addEventListener('click', () => saveSettingsToDB('xfadeCurve', btn.dataset.curve));
  });

  // PWA Install Handling
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = $('#btn-install-pwa');
    if (btn) btn.classList.add('primary');
  });

  function triggerPWAInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(({ outcome }) => {
        if (outcome === 'accepted') {
          const btn = $('#btn-install-pwa');
          if (btn) btn.style.display = 'none';
        }
        deferredInstallPrompt = null;
      });
    } else {
      alert(
        'To install as a desktop or mobile app:\n\n' +
        '• Chrome / Edge (PC/Mac): Click the install icon in the address bar or Menu ⋮ ➔ Install Inpulse 300 MK2 DJ.\n' +
        '• Chrome (Android): Tap Menu (⋮) ➔ Add to Home screen.\n' +
        '• Safari (iOS): Tap the Share button ➔ "Add to Home Screen".\n\n' +
        'Alternatively, use "Download ZIP" to download the full offline bundle!'
      );
    }
  }

  $('#btn-install-pwa')?.addEventListener('click', triggerPWAInstall);
  $('#btn-tab-install-pwa')?.addEventListener('click', triggerPWAInstall);

  // Preload Offline Demo Track on Deck A & Deck B so user can mix immediately
  setTimeout(() => {
    try {
      const bufA = generateOfflineDemoTrack('house');
      loadTrackIntoDeck(D.A, bufA, 'Neon Drive (House 124)', 'DJ An2ny Offline', '8A (Am)');
      const bufB = generateOfflineDemoTrack('techno');
      loadTrackIntoDeck(D.B, bufB, 'Cyber Pulse (Techno 130)', 'DJ An2ny Offline', '6A (Gm)');
    } catch (_) {}
  }, 100);

  runAnimationLoop();
});
