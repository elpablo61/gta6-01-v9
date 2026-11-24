// Crescent Bay — radio. Three procedural WebAudio stations, cycled
// with R. Music only, no talk. Station 1 ("Bay FM") is the default
// on New Game. The radio keeps playing through missions and free
// roam. Each station is a distinct 16-step loop sequenced live from
// G.audio's synth engine; if audio is unavailable (headless / Node)
// the station state and the HUD equalizer still advance on the clock
// so scripted checks can cycle all three stations and read the name.
//
// Stations:
//   0 Bay FM      — synthwave, driving bass, 112 BPM
//   1 Harbor Jazz — slow swing, 84 BPM, swung 8ths
//   2 Crescent Rock — driving rock riff, 132 BPM

export const STATIONS = [
  { name: 'Bay FM',       bpm: 112, wave: 'sawtooth', bassWave: 'sawtooth', swing: 0,    leadGain: 0.10, bassGain: 0.20 },
  { name: 'Harbor Jazz',  bpm: 84,  wave: 'triangle', bassWave: 'sine',     swing: 0.28, leadGain: 0.14, bassGain: 0.16 },
  { name: 'Crescent Rock', bpm: 132, wave: 'square',   bassWave: 'square',   swing: 0,    leadGain: 0.09, bassGain: 0.20 },
];

// 16-step patterns, semitone offsets from a root (A2 = 110 Hz).
// Bass drives the groove; lead plays sparse phrases; hats tick.
const PATTERNS = [
  { // Bay FM — synthwave: pulsing octave bass, airy lead
    root: 110,
    bass: [0, 0, 12, 0, 0, 12, 0, 10, 0, 0, 12, 0, 7, 0, 10, 12],
    lead: [-1, -1, 12, -1, 15, -1, 19, -1, -1, 12, -1, 15, -1, 19, 24, -1],
    hat:  [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1],
  },
  { // Harbor Jazz — walking bass, mellow swung lead
    root: 98,
    bass: [0, -1, 7, -1, 5, -1, 7, -1, 0, -1, 7, -1, 10, -1, 7, 5],
    lead: [12, -1, -1, 15, -1, 19, -1, -1, 17, -1, -1, 15, -1, 12, -1, -1],
    hat:  [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0],
  },
  { // Crescent Rock — riff bass, punchy lead stabs
    root: 82.4,
    bass: [0, 0, 0, 3, 0, 0, 5, 0, 0, 0, 3, 0, 7, 5, 3, 0],
    lead: [12, -1, 12, -1, -1, 15, -1, 12, -1, -1, 17, -1, 15, -1, 12, -1],
    hat:  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
];

function semitoneToFreq(root, semis) {
  return root * Math.pow(2, semis / 12);
}

function justPressed(G, code) {
  const inp = G && G.input;
  if (!inp) return false;
  if (typeof inp.justPressed === 'function') { try { return !!inp.justPressed(code); } catch (e) { return false; } }
  if (inp.pressed && typeof inp.pressed.has === 'function') return inp.pressed.has(code);
  if (inp.pressedKeys && typeof inp.pressedKeys.has === 'function') return inp.pressedKeys.has(code);
  if (code === 'KeyR' && inp.rPressed) return true;
  return false;
}

export function init(G) {
  const R = {
    station: 0,
    stations: STATIONS,
    playing: true,
    step: 0,
    nextStepTime: 0,
    eq: [0.2, 0.35, 0.25, 0.4, 0.3],
    _eqPhase: 0,

    stationName() { return STATIONS[this.station].name; },

    setStation(i) {
      const n = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length;
      if (n !== this.station) {
        this.station = n;
        this.step = 0;
        this.nextStepTime = 0;
        if (G.audio && G.audio.ensure) G.audio.ensure();
      }
      return this.stationName();
    },

    cycle() { return this.setStation(this.station + 1); },
    toggle() { this.playing = !this.playing; return this.playing; },
  };

  G.radio = R;
  return R;
}

function scheduleStep(G, R, stepIdx, when) {
  const A = G.audio;
  const st = STATIONS[R.station];
  const pat = PATTERNS[R.station];
  if (!A || !A.ctx || !A.master) return;
  const bassNote = pat.bass[stepIdx];
  if (bassNote >= 0) {
    const f = semitoneToFreq(pat.root, bassNote);
    const t0 = when - A.ctx.currentTime;
    A.tone(f, 0.22, st.bassWave, st.bassGain, null, Math.max(0, t0));
  }
  const leadNote = pat.lead[stepIdx];
  if (leadNote >= 0) {
    const f = semitoneToFreq(pat.root * 2, leadNote);
    const t0 = when - A.ctx.currentTime;
    A.tone(f, 0.3, st.wave, st.leadGain, null, Math.max(0, t0));
  }
  if (pat.hat[stepIdx]) {
    // Hat tick: schedule a short noise burst via a quiet high tone
    // plus the audio engine's noise if available.
    const t0 = when - A.ctx.currentTime;
    if (A.noise) {
      // Defer noise to the exact time using a tiny gain envelope trick:
      // noise() plays immediately, so only tick hats when close to now.
      if (Math.abs(t0) < 0.05) A.noise(0.03, 0.05, 6000, 'highpass');
    }
    A.tone(5200, 0.03, 'sine', 0.02, null, Math.max(0, t0));
  }
}

export function update(G, dt) {
  const R = G && G.radio;
  if (!R) return;

  if (justPressed(G, 'KeyR')) R.cycle();

  // Equalizer animation runs on the clock even without audio, so the
  // HUD always shows a living meter and headless checks still see it.
  R._eqPhase += dt || 0.016;
  const pat = PATTERNS[R.station];
  for (let i = 0; i < R.eq.length; i++) {
    const beat = pat.bass[R.step] >= 0 ? 1 : 0.4;
    R.eq[i] = Math.max(0.08, Math.min(1,
      (0.35 + 0.3 * Math.abs(Math.sin(R._eqPhase * (2 + i) + i * 1.7))) * (0.5 + 0.5 * beat)));
  }

  if (!R.playing) return;
  const A = G.audio;
  if (!A || !A.ctx) {
    // No audio context: advance the step clock so station state stays
    // in sync for scripted checks.
    R._clockAcc = (R._clockAcc || 0) + (dt || 0.016);
    const st = STATIONS[R.station];
    const stepDur = 60 / st.bpm / 2;
    while (R._clockAcc >= stepDur) { R._clockAcc -= stepDur; R.step = (R.step + 1) % 16; }
    return;
  }

  const st = STATIONS[R.station];
  const stepDur = 60 / st.bpm / 2; // 8th notes
  if (!R.nextStepTime || R.nextStepTime < A.ctx.currentTime - 0.1) {
    R.nextStepTime = A.ctx.currentTime + 0.05;
  }
  let guard = 0;
  while (R.nextStepTime < A.ctx.currentTime + 0.18 && guard++ < 8) {
    let when = R.nextStepTime;
    // Swing: delay odd 8th steps on the jazz station.
    if (st.swing && (R.step % 2 === 1)) when += stepDur * st.swing;
    scheduleStep(G, R, R.step, when);
    R.step = (R.step + 1) % 16;
    R.nextStepTime += stepDur;
  }
}

export function draw() {}
