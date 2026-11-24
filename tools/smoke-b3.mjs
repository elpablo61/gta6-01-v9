// tools/smoke-b3.mjs — Node smoke test for the B3-SYS modules:
// audio, radio, save, hud, player, combat, weapons, police, helicopter.
//
// Runs each module's init/update/draw over a mock G (no browser, no
// canvas, no real AudioContext) and exercises the police + helicopter
// behaviours from the prose spec: wanted stars, spawns, Spray Shop
// drain, hiding decay, spotlight blocking decay, heli shootdown +
// 20s retreat + return, and the foot-cop arrest rule.
//
// Usage: node tools/smoke-b3.mjs   (exit 0 = all checks pass)

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'game', 'src');

// ---------------------------------------------------------------------------
// Browser stubs (installed BEFORE any game module is imported).
// ---------------------------------------------------------------------------

function makeCtx() {
  const grad = { addColorStop() {} };
  const target = { canvas: { width: 1280, height: 720 } };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return () => grad;
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}

const sharedCtx = makeCtx();

function makeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    width: 1280,
    height: 720,
    dataset: {},
    children: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild() { return el; },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    getContext() { return sharedCtx; },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1280, height: 720 };
    },
    focus() {},
    click() {},
  };
  return el;
}

const storageMap = new Map();
const localStorageStub = {
  getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
  setItem(k, v) { storageMap.set(k, String(v)); },
  removeItem(k) { storageMap.delete(k); },
  clear() { storageMap.clear(); },
  key(i) { return [...storageMap.keys()][i] || null; },
  get length() { return storageMap.size; },
};

class AudioParamStub {
  constructor() { this.value = 0; }
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  cancelScheduledValues() {}
}

class AudioNodeStub {
  constructor() {
    this.gain = new AudioParamStub();
    this.frequency = new AudioParamStub();
    this.detune = new AudioParamStub();
    this.type = 'sine';
    this.frequencyBinCount = 64;
    this.fftSize = 128;
  }
  connect() { return this; }
  disconnect() {}
  start() {}
  stop() {}
  getByteFrequencyData() {}
  getByteTimeDomainData() {}
}

class AudioContextStub {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = new AudioNodeStub();
  }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() { return new AudioNodeStub(); }
  createGain() { return new AudioNodeStub(); }
  createBufferSource() { return new AudioNodeStub(); }
  createBiquadFilter() { return new AudioNodeStub(); }
  createDelay() { return new AudioNodeStub(); }
  createDynamicsCompressor() { return new AudioNodeStub(); }
  createAnalyser() { return new AudioNodeStub(); }
  createBuffer() { return { getChannelData: () => new Float32Array(128) }; }
  decodeAudioData() { return Promise.resolve({}); }
}

const documentStub = {
  createElement: (tag) => makeElement(tag),
  getElementById: () => makeElement('div'),
  querySelector: () => makeElement('div'),
  querySelectorAll: () => [],
  getElementsByTagName: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: makeElement('body'),
  hidden: false,
  title: 'Crescent Bay',
};

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  localStorage: localStorageStub,
  AudioContext: AudioContextStub,
  webkitAudioContext: AudioContextStub,
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  location: { href: 'http://localhost/', pathname: '/' },
  document: documentStub,
};

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.AudioContext = AudioContextStub;
globalThis.webkitAudioContext = AudioContextStub;
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
}

// ---------------------------------------------------------------------------
// Mock G — the shared state the modules run on. Generous on purpose: the
// smoke test must not fail a module for a field the mock forgot.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  const fn = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.int = (lo, hi) => lo + Math.floor(fn() * (hi - lo + 1));
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length)];
  return fn;
}

function makeInput() {
  const keys = {};
  // NOTE: do NOT add a `down` helper here — some modules read
  // keys.down as the "walk down" direction flag, and a function value
  // is truthy, which made the mock player walk south forever.
  keys.has = (k) => !!keys[k];
  return {
    keys,
    pressed: new Set(),
    mouse: { x: 640, y: 360, down: false, clicked: false },
    mouseX: 640,
    mouseY: 360,
    mouseDown: false,
    aimX: 700,
    aimY: 360,
    update() {},
  };
}

function makeWorld() {
  const roads = [];
  for (let i = 0; i < 8; i++) roads.push(200 + i * 400);
  const junctions = [];
  for (const x of roads) for (const y of roads) junctions.push({ x, y });
  return {
    width: 3200,
    height: 3200,
    roads,
    junctions,
    buildings: [],
    districts: [],
    sprayShop: { x: 1700, y: 1700 },
    locations: { sprayShop: { x: 1700, y: 1700 } },
    garage: { x: 1000, y: 1000 },
    hideout: { x: 600, y: 600 },
  };
}

function makePlayerCar() {
  // NOTE: the car must NOT sit on the Spray Shop (mock world puts the
  // shop at 1700,1700): player.js snaps a driving player to the car,
  // and inside radius 150 heat drains at 50/s — which would empty the
  // wanted-3 scenario before the police/heli checks run.
  return {
    x: 1200, y: 1200, angle: 0, speed: 0,
    hp: 100, maxHp: 100, radius: 24,
    type: 'sedan', topSpeed: 380, occupied: true,
    color: '#c0c0c0', upgrades: {},
  };
}

function makeG() {
  const car = makePlayerCar();
  return {
    rng: mulberry32(20261118),
    world: makeWorld(),
    player: {
      x: 1600, y: 1600, angle: 0, speed: 0,
      health: 100, maxHealth: 100,
      onFoot: true, inCar: false, driving: false,
      car: null, vehicle: null, currentCar: null,
      cash: 1000, weapon: 'pistol', ammo: 48,
      radius: 14, caught: false, dead: false,
    },
    vehicles: [car],
    traffic: [],
    peds: [],
    pedestrians: [],
    police: [],
    heli: null,
    enemies: [],
    bullets: [],
    pickups: [],
    crates: [],
    missions: { current: null, active: null, list: [], stage: 0 },
    time: { t: 0, hour: 12, day: 1, night: false, dayTime: 0.5 },
    heat: 0,
    wanted: 0,
    cash: 1000,
    camera: { x: 1600, y: 1600, zoom: 1 },
    input: makeInput(),
    audio: {},
    save: { activeSlot: 0, slots: [null, null, null] },
    gameOver: null,
    caught: false,
    paused: false,
    width: 1280,
    height: 720,
  };
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function stepAll(mods, G, dt, frames) {
  for (let i = 0; i < frames; i++) {
    G.time.t += dt;
    for (const m of mods) {
      if (m.mod && typeof m.mod.update === 'function') m.mod.update(G, dt);
    }
  }
}

function drawAll(mods, G) {
  for (const m of mods) {
    if (m.mod && typeof m.mod.draw === 'function') m.mod.draw(G, sharedCtx);
  }
}

const MODULES = [
  'audio', 'radio', 'save', 'hud', 'player',
  'combat', 'weapons', 'police', 'helicopter',
];
// Debug hooks (harmless in normal runs):
//   SMOKE_ONLY=police,helicopter  — load only those modules (bisect helper)
//   SMOKE_TRACE=1                 — log per-second state in scenario [3]
const ONLY = process.env.SMOKE_ONLY
  ? process.env.SMOKE_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const TRACE = process.env.SMOKE_TRACE === '1';
const ACTIVE_MODULES = ONLY ? MODULES.filter((m) => ONLY.includes(m)) : MODULES;

async function main() {
  console.log('B3 smoke test — mock G, Node, no browser');
  const mods = [];
  let allOk = true;

  // 1. Import every B3 module.
  console.log('\n[1] imports');
  for (const name of ACTIVE_MODULES) {
    try {
      const mod = await import(path.join(SRC, name + '.js'));
      mods.push({ name, mod });
      check(`import ${name}`, true);
    } catch (e) {
      mods.push({ name, mod: null });
      check(`import ${name}`, false, String(e && e.message || e));
    }
  }

  // 2. init(G) on a fresh mock, then 60 idle frames + a draw pass.
  console.log('\n[2] init + idle update + draw (heat 0, on foot)');
  let G = makeG();
  for (const m of mods) {
    if (!m.mod) continue;
    try {
      if (typeof m.mod.init === 'function') m.mod.init(G);
      check(`${m.name}.init(G)`, true);
    } catch (e) {
      check(`${m.name}.init(G)`, false, String(e && e.message || e));
    }
  }
  try {
    stepAll(mods, G, 1 / 60, 60);
    check('update 60 frames @ heat 0', true);
  } catch (e) {
    check('update 60 frames @ heat 0', false, String(e && e.message || e));
  }
  try {
    drawAll(mods, G);
    check('draw pass @ heat 0', true);
  } catch (e) {
    check('draw pass @ heat 0', false, String(e && e.message || e));
  }
  check('no cops at heat 0', G.police.length === 0, `police=${G.police.length}`);
  check('heli inactive at heat 0', !G.heli || !G.heli.active, `active=${!!(G.heli && G.heli.active)}`);
  check('wanted 0 at heat 0', G.wanted === 0, `wanted=${G.wanted}`);

  // 3. Wanted 3 in a car: police + heli must show up; spotlight blocks decay.
  console.log('\n[3] wanted 3 (heat 58), driving — spawns + spotlight blocks decay');
  G = makeG();
  for (const m of mods) if (m.mod && typeof m.mod.init === 'function') m.mod.init(G);
  G.heat = 58;
  G.player.onFoot = false;
  G.player.inCar = true;
  G.player.driving = true;
  G.player.car = G.vehicles[0];
  G.player.vehicle = G.vehicles[0];
  G.player.speed = 200;
  G.player.x = 1000; G.player.y = 1000;
  try {
    if (TRACE) {
      for (let s = 0; s < 10; s++) {
        stepAll(mods, G, 1 / 60, 60);
        console.log(`    t=${s + 1}s heat=${G.heat.toFixed(1)} wanted=${G.wanted} police=${G.police.length} foot=${G.police.filter((c) => c.kind === 'foot').length} cars=${G.police.filter((c) => c.kind === 'car').length} heli=${!!(G.heli && G.heli.active)} spot=${!!(G.heli && G.heli.spotlightOn)} player=(${G.player.x.toFixed(0)},${G.player.y.toFixed(0)}) onFoot=${G.player.onFoot}`);
      }
    } else {
      stepAll(mods, G, 1 / 60, 600); // 10 s
    }
    drawAll(mods, G);
    check('update 600 frames @ heat 58', true);
  } catch (e) {
    check('update 600 frames @ heat 58', false, String(e && e.message || e));
  }
  const foot = G.police.filter((c) => c.kind === 'foot').length;
  const cars = G.police.filter((c) => c.kind === 'car').length;
  check('foot cops spawned at 1+ stars', foot >= 2, `foot=${foot}`);
  check('patrol cars spawned at 2+ stars', cars >= 2, `cars=${cars}`);
  check('wanted is 3 at heat 58', G.wanted === 3, `wanted=${G.wanted}`);
  check('heli active at 3 stars', !!(G.heli && G.heli.active), `active=${!!(G.heli && G.heli.active)}`);
  check('heli spotlight on Rook', !!(G.heli && G.heli.spotlightOn), `spotlightOn=${!!(G.heli && G.heli.spotlightOn)}`);
  check('heat did NOT decay under spotlight', G.heat >= 57, `heat=${G.heat.toFixed(1)}`);

  // 4. Roadblock at 4-5 stars.
  console.log('\n[4] wanted 4 (heat 74) — roadblock');
  G.heat = 74;
  try {
    stepAll(mods, G, 1 / 60, 120);
    check('update 120 frames @ heat 74', true);
  } catch (e) {
    check('update 120 frames @ heat 74', false, String(e && e.message || e));
  }
  const blocks = G.police.filter((c) => c.kind === 'roadblock').length;
  check('roadblock cars at 4 stars', blocks >= 2, `roadblock=${blocks}`);
  check('wanted is 4 at heat 74', G.wanted === 4, `wanted=${G.wanted}`);

  // 5. Heli shootdown: enough damage => smoke + retreat 20 s, then return.
  console.log('\n[5] heli shootdown — smoke, retreat 20 s, return at 3+ stars');
  G.heat = 58;
  const heliMod = mods.find((m) => m.name === 'helicopter');
  try {
    if (heliMod && typeof heliMod.mod.damageHeli === 'function') {
      heliMod.mod.damageHeli(G, 120);
    } else if (G.heli) {
      G.heli.hp = 0;
    }
    stepAll(mods, G, 1 / 60, 5);
    check('heli smoking after lethal damage', !!(G.heli && G.heli.smoking), `smoking=${!!(G.heli && G.heli.smoking)} state=${G.heli && G.heli.state}`);
    check('spotlight off while retreating', !(G.heli && G.heli.spotlightOn), `spotlightOn=${!!(G.heli && G.heli.spotlightOn)}`);
    stepAll(mods, G, 1 / 60, 21 * 60); // 21 s > 20 s retreat
    check('heli returned after retreat (wanted still 3+)', !!(G.heli && G.heli.active && G.heli.state === 'shadowing'), `active=${!!(G.heli && G.heli.active)} state=${G.heli && G.heli.state}`);
    check('heli hp restored on return', !!(G.heli && G.heli.hp > 0), `hp=${G.heli && G.heli.hp}`);
  } catch (e) {
    check('heli shootdown sequence', false, String(e && e.message || e));
  }

  // 6. Spray Shop: heat drains fast inside radius 150.
  console.log('\n[6] Spray Shop — heat drain 50/s inside radius 150');
  G.heat = 58;
  // The player is driving, and player.js snaps a driver to their car —
  // so the CAR has to be at the shop, not just the player.
  G.vehicles[0].x = 1700; G.vehicles[0].y = 1700;
  G.player.x = 1700; G.player.y = 1700; // on top of the mock spray shop
  try {
    stepAll(mods, G, 1 / 60, 120); // 2 s
    check('heat drained at Spray Shop', G.heat < 20, `heat=${G.heat.toFixed(1)}`);
  } catch (e) {
    check('heat drained at Spray Shop', false, String(e && e.message || e));
  }

  // 7. Hiding decay: no police within 450 for 3 s => heat decays.
  console.log('\n[7] hiding — heat decays with no police within 450');
  G = makeG();
  for (const m of mods) if (m.mod && typeof m.mod.init === 'function') m.mod.init(G);
  G.heat = 40; // 2 stars; cops will spawn, so keep shoving them far away
  G.player.x = 1000; G.player.y = 1000;
  try {
    for (let i = 0; i < 6 * 60; i++) {
      G.time.t += 1 / 60;
      for (const c of G.police) { c.x = G.player.x + 800; c.y = G.player.y + 800; }
      for (const m of mods) if (m.mod && typeof m.mod.update === 'function') m.mod.update(G, 1 / 60);
      for (const c of G.police) { c.x = G.player.x + 800; c.y = G.player.y + 800; }
    }
    check('heat decayed while hidden', G.heat < 30, `heat=${G.heat.toFixed(1)} (was 40)`);
  } catch (e) {
    check('heat decayed while hidden', false, String(e && e.message || e));
  }

  // 8. Arrest: slow on-foot player, foot cop within 30 for 1.2 s => CAUGHT.
  console.log('\n[8] arrest — foot cop within 30 of a slow on-foot player for 1.2 s');
  G = makeG();
  for (const m of mods) if (m.mod && typeof m.mod.init === 'function') m.mod.init(G);
  G.heat = 20; // 1 star
  G.player.x = 1000; G.player.y = 1000;
  G.player.onFoot = true;
  G.player.speed = 0;
  try {
    stepAll(mods, G, 1 / 60, 30); // let a foot cop spawn
    const cop = G.police.find((c) => c.kind === 'foot');
    check('foot cop present for arrest test', !!cop, `foot=${G.police.filter((c) => c.kind === 'foot').length}`);
    if (cop) {
      cop.x = G.player.x + 10;
      cop.y = G.player.y;
      if (process.env.SMOKE_TRACE8 === '1') {
        for (let s = 0; s < 6; s++) {
          stepAll(mods, G, 1 / 60, 15);
          const c2 = G.police.find((c) => c.kind === 'foot');
          console.log(`    t=${((s + 1) * 0.25).toFixed(2)}s player=(${G.player.x.toFixed(0)},${G.player.y.toFixed(0)}) speed=${G.player.speed} onFoot=${G.player.onFoot} cop=${c2 ? `(${c2.x.toFixed(0)},${c2.y.toFixed(0)}) timer=${(c2.arrestTimer || 0).toFixed(2)}` : 'gone'} gameOver=${G.gameOver}`);
        }
      } else {
        stepAll(mods, G, 1 / 60, 90); // 1.5 s > 1.2 s
      }
      check('player CAUGHT after 1.2 s in range', G.gameOver === 'CAUGHT' || G.player.caught === true, `gameOver=${G.gameOver} caught=${G.player.caught}`);
    }
  } catch (e) {
    check('arrest sequence', false, String(e && e.message || e));
  }

  // 9. Mission script can call the heli up (m9) even at low stars.
  console.log('\n[9] mission script — m9 calls the heli at 1 star');
  G = makeG();
  for (const m of mods) if (m.mod && typeof m.mod.init === 'function') m.mod.init(G);
  G.heat = 20;
  G.missions.current = { id: 'm9' };
  G.player.x = 1000; G.player.y = 1000;
  try {
    stepAll(mods, G, 1 / 60, 120);
    check('heli up for m9 at 1 star', !!(G.heli && G.heli.active), `active=${!!(G.heli && G.heli.active)}`);
    G.missions.current = null;
    G.heat = 0;
    stepAll(mods, G, 1 / 60, 600); // 10 s to leave
    check('heli leaves when wanted < 3 and no mission', !(G.heli && G.heli.active), `active=${!!(G.heli && G.heli.active)}`);
  } catch (e) {
    check('mission heli sequence', false, String(e && e.message || e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE B3: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('SMOKE B3 CRASH:', e);
  process.exitCode = 1;
});
