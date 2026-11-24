// Crescent Bay — synth sound engine.
// Pure WebAudio, no external assets, no network. Every sound is
// synthesized from oscillators and filtered noise. Safe to load in
// environments without audio (Node smoke tests): all methods no-op
// until an AudioContext exists, and the context is only created
// lazily from a user gesture so browsers never autoplay-block us.

export function init(G) {
  const A = {
    ctx: null,
    master: null,
    _noiseBuf: null,
    _engineOsc: null,
    _engineGain: null,
    _engineOn: false,
    _muted: false,

    // Create (or resume) the context. Call from a user gesture.
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return true;
      }
      const AC = (typeof window !== 'undefined')
        ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AC) return false;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      } catch (e) { this.ctx = null; return false; }
      return true;
    },

    setMuted(m) {
      this._muted = !!m;
      if (this.master) this.master.gain.value = this._muted ? 0 : 0.55;
    },
    isMuted() { return this._muted; },

    // One oscillator blip. slideTo (Hz) bends the pitch over the note.
    tone(freq, dur, type, vol, slideTo, delay) {
      if (!this.ctx || !this.master) return;
      const t0 = this.ctx.currentTime + (delay || 0);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(Math.max(20, freq), t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol || 0.2), t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    },

    // Filtered white-noise burst (gunshots, crashes, skids).
    noise(dur, vol, filterFreq, type) {
      if (!this.ctx || !this.master) return;
      if (!this._noiseBuf) {
        const len = this.ctx.sampleRate * 0.5;
        this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this._noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      const t0 = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = type || 'lowpass'; f.frequency.value = filterFreq || 1200;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0002, vol || 0.3), t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t0); src.stop(t0 + dur + 0.05);
    },

    // Named effects. `weapon` is 'pistol' | 'smg' | 'shotgun'.
    shoot(weapon) {
      if (!this.ctx) return;
      if (weapon === 'shotgun') {
        this.noise(0.22, 0.5, 900);
        this.tone(140, 0.18, 'square', 0.22, 55);
      } else if (weapon === 'smg') {
        this.noise(0.08, 0.28, 2400, 'bandpass');
        this.tone(620, 0.06, 'square', 0.12, 220);
      } else {
        this.noise(0.12, 0.35, 1800, 'bandpass');
        this.tone(320, 0.1, 'square', 0.18, 110);
      }
    },
    dryClick() { this.tone(1400, 0.04, 'square', 0.08); },
    enemyShoot() { this.noise(0.1, 0.18, 1500, 'bandpass'); },
    hit() { this.tone(220, 0.12, 'sawtooth', 0.2, 90); },
    hurt() { this.tone(160, 0.25, 'sawtooth', 0.3, 60); this.noise(0.15, 0.2, 500); },
    pickup() { this.tone(660, 0.09, 'sine', 0.22); this.tone(990, 0.12, 'sine', 0.22, null, 0.07); },
    crate() { this.tone(440, 0.1, 'triangle', 0.25); this.tone(660, 0.1, 'triangle', 0.25, null, 0.08); this.tone(880, 0.16, 'triangle', 0.25, null, 0.16); },
    cash() { this.tone(880, 0.08, 'sine', 0.2); this.tone(1174, 0.14, 'sine', 0.2, null, 0.06); },
    crash() { this.noise(0.3, 0.45, 500); this.tone(90, 0.25, 'sine', 0.3, 45); },
    skid() { this.noise(0.18, 0.12, 3000, 'highpass'); },
    door() { this.tone(300, 0.08, 'square', 0.12, 180); },
    sirenBlip() { this.tone(950, 0.16, 'sine', 0.12, 1400); this.tone(1400, 0.16, 'sine', 0.12, 950, 0.16); },
    missionStart() { this.tone(523, 0.12, 'triangle', 0.22); this.tone(659, 0.12, 'triangle', 0.22, null, 0.1); },
    missionDone() {
      const seq = [523, 659, 784, 1046];
      seq.forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.24, null, i * 0.11));
    },
    missionFail() {
      const seq = [392, 330, 262];
      seq.forEach((f, i) => this.tone(f, 0.22, 'sawtooth', 0.16, null, i * 0.16));
    },
    arrest() { this.tone(440, 0.5, 'sawtooth', 0.2, 220); },
    heliHit() { this.tone(180, 0.15, 'square', 0.2, 90); this.noise(0.12, 0.2, 800); },

    // Continuous engine hum tied to speed (0..1). Cheap: one osc.
    setEngine(level) {
      if (!this.ctx || !this.master) return;
      const l = Math.max(0, Math.min(1, level || 0));
      if (l <= 0.02) {
        if (this._engineOsc) { try { this._engineOsc.stop(); } catch (e) {} this._engineOsc = null; this._engineGain = null; }
        return;
      }
      if (!this._engineOsc) {
        this._engineOsc = this.ctx.createOscillator();
        this._engineOsc.type = 'sawtooth';
        this._engineGain = this.ctx.createGain();
        this._engineGain.gain.value = 0.02;
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 700;
        this._engineOsc.connect(f); f.connect(this._engineGain); this._engineGain.connect(this.master);
        this._engineOsc.start();
      }
      const t = this.ctx.currentTime;
      this._engineOsc.frequency.setTargetAtTime(55 + l * 130, t, 0.08);
      this._engineGain.gain.setTargetAtTime(0.015 + l * 0.05, t, 0.08);
    },
  };

  G.audio = A;
  return A;
}

export function update(G, dt) {
  // Engine hum follows the player's car speed; silent on foot.
  const A = G && G.audio;
  if (!A || !A.ctx) return;
  const p = G.player || {};
  const driving = p.car && !p.onFoot;
  const spd = driving && p.car ? Math.abs(p.car.speed || 0) / (p.car.topSpeed || 500) : 0;
  A.setEngine(driving ? spd : 0);
}

export function draw() {}
