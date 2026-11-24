// Crescent Bay — wiring: shared state G, game loop, overlay screens.
// This module knows the module contract, not the modules' internals:
// every game module exports init(G), update(G, dt), draw(G, ctx) when it
// has something to do, and main.js calls each of those only if it exists,
// wrapped so one broken module can never freeze the game. Modules that
// do not exist yet (phase 2: missions, garage, autopilot, shots, and the
// B2/B3 systems still being written) are loaded with a guarded dynamic
// import, so the title screen and smoke test work before they land.

// Modules already on disk (group 1 / B2 / B3) — static namespace imports
// are safe here: a missing export is just undefined, never a load error.
import * as config from './config.js';
import * as random from './random.js';
import * as inputMod from './input.js';
import * as world from './world.js';
import * as render from './render.js';
import * as vehicles from './vehicles.js';
import * as audio from './audio.js';
import * as radio from './radio.js';
import * as save from './save.js';

// Modules not yet on disk when this file was written — loaded lazily with
// a guarded dynamic import. A missing file resolves to null and the game
// keeps running without that system until its builder lands it.
const LAZY_MODULES = [
  'traffic', 'pedestrians', 'player', 'combat', 'weapons',
  'police', 'helicopter', 'missions', 'garage', 'autopilot', 'shots', 'hud',
];

export const STATIC_MODULES = {
  config, random, input: inputMod, world, render, vehicles, audio, radio, save,
};

export const MODULE_ORDER = [
  'input', 'world', 'vehicles', 'traffic', 'pedestrians', 'player',
  'combat', 'weapons', 'police', 'helicopter', 'missions', 'garage',
  'autopilot', 'audio', 'radio', 'save', 'render', 'hud', 'shots',
];

// ---- Shared state G (the contract every module reads and writes) ----
export function createGame() {
  const rng = random.createRng(config.SEED);
  const canvas = document.getElementById('game-canvas');
  const input = inputMod.createInput();
  return {
    rng,
    canvas,
    ctx: canvas.getContext('2d'),
    input,
    // World / entities (filled in by world.init and friends).
    world: null,
    player: {
      x: 200, y: 200, angle: 0, speed: 0, health: config.PLAYER_MAX_HEALTH,
      inCar: null, weapon: 'pistol',
      ammo: { pistol: config.WEAPONS.pistol.startAmmo, smg: 0, shotgun: 0 },
      owned: ['pistol'],
    },
    vehicles: [],
    traffic: [],
    peds: [],
    police: [],
    heli: null,
    missions: { index: 0, current: null, stage: 0, timeLeft: 0, completed: [] },
    time: { hour: 12, minute: 0, day: 1, night: false },
    heat: 0,
    wanted: 0,
    camera: { x: 200, y: 200 },
    audio: null,
    save: { slot: 0 },
    cash: 0,
    state: 'title', // title | playing | paused | dialog | gameover
    gameOverReason: null, // 'CAUGHT' | 'DOWN'
    modules: {},
    autopilot: null,
    _errorLogged: new Set(),
  };
}

// Call a module hook only if it exists; log each distinct failure once.
function callHook(G, mod, hook, ...args) {
  if (!mod) return;
  const fn = mod[hook];
  if (typeof fn !== 'function') return;
  try {
    fn(G, ...args);
  } catch (err) {
    const key = `${hook}:${err && err.message}`;
    if (!G._errorLogged.has(key)) {
      G._errorLogged.add(key);
      console.error(`[main] ${hook} failed:`, err);
    }
  }
}

async function loadLazyModules(G) {
  for (const name of LAZY_MODULES) {
    try {
      G.modules[name] = await import(`./${name}.js`);
    } catch {
      G.modules[name] = null; // not written yet — handled by the guards
    }
  }
}

function moduleByName(G, name) {
  if (name === 'input') return inputMod;
  if (Object.prototype.hasOwnProperty.call(STATIC_MODULES, name)) return STATIC_MODULES[name];
  return G.modules[name] || null;
}

function initAll(G) {
  for (const name of MODULE_ORDER) callHook(G, moduleByName(G, name), 'init', G);
}

function updateAll(G, dt) {
  // Autopilot runs BEFORE the dialog branch (spec §9.2): it must be able
  // to press E to accept a mission instead of deadlocking behind it.
  const ap = G.modules.autopilot;
  if (ap && typeof ap.update === 'function') {
    try { ap.update(G, dt); } catch (err) { console.error('[main] autopilot failed:', err); }
  }
  for (const name of MODULE_ORDER) {
    if (name === 'autopilot' || name === 'input') continue;
    callHook(G, moduleByName(G, name), 'update', G, dt);
  }
}

function drawAll(G) {
  const { ctx, canvas } = G;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const name of MODULE_ORDER) {
    if (name === 'input' || name === 'autopilot' || name === 'audio' || name === 'radio' || name === 'save') continue;
    callHook(G, moduleByName(G, name), 'draw', G, ctx);
  }
}

// ---- Overlay screens (DOM, semantic ids from the spec) ----
function show(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
function hide(id) { const el = document.getElementById(id); if (el) el.hidden = true; }
function hideAllOverlays() {
  for (const id of ['title-screen', 'pause-menu', 'game-over-screen', 'mission-dialog']) hide(id);
}

export function showGameOver(G, reason) {
  G.state = 'gameover';
  G.gameOverReason = reason;
  const title = document.getElementById('game-over-title');
  const text = document.getElementById('game-over-text');
  if (title) {
    title.textContent = reason === 'CAUGHT' ? 'CAUGHT' : 'DOWN';
    title.className = reason === 'CAUGHT' ? 'caught' : 'down';
  }
  if (text) {
    text.textContent = reason === 'CAUGHT'
      ? 'The law caught up with Rook in Crescent Bay.'
      : 'Rook went down in Crescent Bay.';
  }
  hideAllOverlays();
  show('game-over-screen');
}

function refreshSlots(G) {
  const slots = document.querySelectorAll('#save-slots .slot-btn');
  slots.forEach((btn, i) => {
    let label = `Slot ${i + 1}<br>Empty`;
    try {
      const mod = moduleByName(G, 'save');
      if (mod && typeof mod.describeSlot === 'function') {
        label = mod.describeSlot(G, i) || label;
      } else {
        const raw = localStorage.getItem(`crescent-bay-save-${i}`);
        if (raw) {
          const data = JSON.parse(raw);
          label = `Slot ${i + 1}<br>$${data.cash ?? 0} · M${(data.missionIndex ?? 0) + 1}`;
        }
      }
    } catch { label = `Slot ${i + 1}<br>Corrupt`; }
    btn.innerHTML = label;
  });
}

function wireOverlays(G) {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('new-game-btn', () => {
    G.save.slot = 0;
    startNewGame(G);
  });
  on('continue-btn', () => {
    const mod = moduleByName(G, 'save');
    let loaded = false;
    try {
      if (mod && typeof mod.load === 'function') loaded = !!mod.load(G, G.save.slot);
    } catch (err) { console.error('[main] load failed:', err); }
    if (!loaded) startNewGame(G);
    else { hideAllOverlays(); G.state = 'playing'; }
  });
  on('resume-btn', () => { hideAllOverlays(); G.state = 'playing'; });
  on('save-btn', () => {
    try {
      const mod = moduleByName(G, 'save');
      if (mod && typeof mod.saveGame === 'function') mod.saveGame(G, G.save.slot);
    } catch (err) { console.error('[main] save failed:', err); }
  });
  on('quit-btn', () => { G.state = 'title'; hideAllOverlays(); show('title-screen'); refreshSlots(G); });
  on('accept-btn', () => {
    const dlg = G.missions && G.missions.dialog;
    if (dlg && typeof dlg.accept === 'function') dlg.accept();
    hide('mission-dialog');
    if (G.state === 'dialog') G.state = 'playing';
  });
  on('decline-btn', () => { hide('mission-dialog'); if (G.state === 'dialog') G.state = 'playing'; });
  on('retry-btn', () => {
    const missions = moduleByName(G, 'missions');
    if (missions && typeof missions.restartMission === 'function') missions.restartMission(G);
    hideAllOverlays(); G.state = 'playing';
  });
  on('gameover-title-btn', () => { G.state = 'title'; hideAllOverlays(); show('title-screen'); refreshSlots(G); });
  document.querySelectorAll('#save-slots .slot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      G.save.slot = Number(btn.dataset.slot || 0);
      document.querySelectorAll('#save-slots .slot-btn').forEach((b) => {
        b.style.borderColor = b === btn ? '#ffd166' : '';
      });
    });
  });
}

export function startNewGame(G) {
  G.cash = 0;
  G.heat = 0;
  G.wanted = 0;
  G.time = { hour: 12, minute: 0, day: 1, night: false };
  G.missions = { index: 0, current: null, stage: 0, timeLeft: 0, completed: [] };
  G.player.health = config.PLAYER_MAX_HEALTH;
  G.player.x = 200; G.player.y = 200;
  G.player.inCar = null;
  G.player.weapon = 'pistol';
  G.player.ammo = { pistol: config.WEAPONS.pistol.startAmmo, smg: 0, shotgun: 0 };
  G.player.owned = ['pistol'];
  G.camera.x = G.player.x; G.camera.y = G.player.y;
  initAll(G);
  hideAllOverlays();
  G.state = 'playing';
}

// ---- Main loop ----
function resizeCanvas(G) {
  const { canvas } = G;
  const w = window.innerWidth, h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
}

function updateAim(G) {
  const { input, camera, canvas } = G;
  const worldX = camera.x + (input.mouseX - canvas.width / 2);
  const worldY = camera.y + (input.mouseY - canvas.height / 2);
  input.aimX = worldX;
  input.aimY = worldY;
  input.aimAngle = Math.atan2(worldY - G.player.y, worldX - G.player.x);
}

export function startLoop(G) {
  let last = performance.now();
  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(rawDt, 0.05); // clamp: a hiccup never jumps the sim
    resizeCanvas(G);
    updateAim(G);
    if (G.state === 'playing') {
      if (inputMod.pausePressed(G.input)) {
        G.state = 'paused'; show('pause-menu');
      } else {
        updateAll(G, dt);
        // Wanted stars follow heat; game-over is decided by the player /
        // police modules through showGameOver, checked here as a backstop.
        G.wanted = config.wantedStars(G.heat);
        if (G.player.health <= 0) showGameOver(G, 'DOWN');
        else if (G.player.caught) showGameOver(G, 'CAUGHT');
      }
    } else if (G.state === 'dialog') {
      // Autopilot must still run so it can accept the dialog (spec §9.2).
      const ap = G.modules.autopilot;
      if (ap && typeof ap.update === 'function') {
        try { ap.update(G, dt); } catch (err) { console.error('[main] autopilot failed:', err); }
      }
      if (inputMod.acceptPressed(G.input)) {
        document.getElementById('accept-btn')?.click();
      }
    } else if (G.state === 'paused') {
      if (inputMod.pausePressed(G.input)) { hideAllOverlays(); G.state = 'playing'; }
    }
    // Draw the world behind every overlay (title shows the living city).
    drawAll(G);
    G.input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---- Boot ----
export async function boot() {
  const G = createGame();
  window.__crescentBay = G; // debug / playtest probes
  inputMod.initInput(G.input, G.canvas);
  await loadLazyModules(G);
  initAll(G);
  wireOverlays(G);
  refreshSlots(G);
  show('title-screen');
  startLoop(G);
  return G;
}

boot().catch((err) => console.error('[main] boot failed:', err));
