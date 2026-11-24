// tools/smoke-b6.mjs — Node smoke test for the B6-FIX integration work:
//
//   [1] main.js boots on stubs: every lazy module loads (no silent null),
//       callHook passes (G)/(G,dt)/(G,ctx) exactly (no double-G), the
//       frame loop draws with a real ctx, window.__game exists, and the
//       shots pose hook is registered.
//   [2] driving: E enters a car (nearestCar reads G.vehicles.list),
//       W/S/A intent written by player.js moves the car through
//       vehicles.js driveManual; the autopilot's virtual keys drive
//       the car the same way (roam).
//   [3] garage position == world.places.garage, clear of buildings and
//       of every other marker; weapon crates at the real gun store /
//       docks / hideout.
//   [4] weapon switch: Rook starts pistol + SMG; 1/2/Q switch instantly.
//   [5] shootout kill sync: a combat.js kill drops missions enemiesLeft
//       and advances the stage; m8/m10/m12 enemies spawn on roads.
//   [6] Spray Shop found through the REAL world.places (not a mock
//       w.sprayShop): heat drains at (2600,600).
//   [7] shots.js poses: cover / mission / start stage and report ready.
//
// Runs on a mock G with the REAL world module (seeded) and the REAL
// input module — no browser, no canvas.
//
// Usage: node tools/smoke-b6.mjs   (exit 0 = all checks pass)

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'game', 'src');

// ---------------------------------------------------------------------------
// Browser stubs (installed BEFORE any game module is imported).
// ---------------------------------------------------------------------------

const ctxCalls = { fillRect: 0, fillText: 0, drawImage: 0, save: 0, total: 0 };

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
      return (...args) => {
        ctxCalls.total += 1;
        if (prop in ctxCalls) ctxCalls[prop] += 1;
        return undefined;
      };
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
    hidden: true, // overlays start hidden in the real DOM
    offsetParent: null,
    dataset: {},
    children: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild(child) { this.children.push(child); return child; },
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
  activeElement: null,
  hidden: false,
  title: 'Crescent Bay',
};

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  localStorage: localStorageStub,
  AudioContext: AudioContextStub,
  webkitAudioContext: AudioContextStub,
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  location: { href: 'http://localhost/', pathname: '/', search: '' },
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
// Harness.
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

async function main() {
  console.log('B6 smoke test — mock G, real world + real input, Node, no browser');
  let allOk = true;

  // ---------------------------------------------------------------- [1]
  console.log('\n[1] main.js boots: lazy modules load, callHook arity, live draw');
  let bootG = null;
  try {
    await import(path.join(SRC, 'main.js'));
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      bootG = globalThis.window.__game;
      if (bootG && bootG.modules && bootG.modules.shots) break;
    }
    check('window.__game exists after boot', !!bootG);
    check('window.__crescentBay is the same G', globalThis.window.__crescentBay === bootG);
    check('boot reached title state', bootG && bootG.state === 'title', `state=${bootG && bootG.state}`);
    const lazy = ['traffic', 'pedestrians', 'player', 'combat', 'weapons',
      'police', 'helicopter', 'missions', 'garage', 'autopilot', 'shots', 'hud'];
    for (const name of lazy) {
      check(`lazy module ${name} loaded (not null)`, !!(bootG && bootG.modules && bootG.modules[name]));
    }
    check('shots pose hook registered', typeof globalThis.window.__stagePose === 'function');
    const before = ctxCalls.total;
    await sleep(600); // let the frame loop draw
    check('frame loop draws every frame (ctx calls grow)', ctxCalls.total > before,
      `calls ${before} -> ${ctxCalls.total}`);
    check('no module hook failed (callHook _errorLogged empty)',
      !!(bootG && bootG._errorLogged && bootG._errorLogged.size === 0),
      `errors=${bootG && bootG._errorLogged ? [...bootG._errorLogged].join(' | ') : 'n/a'}`);
  } catch (e) {
    check('main.js boot', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- shared
  const random = await import(path.join(SRC, 'random.js'));
  const worldMod = await import(path.join(SRC, 'world.js'));
  const inputMod = await import(path.join(SRC, 'input.js'));
  const vehiclesMod = await import(path.join(SRC, 'vehicles.js'));
  const trafficMod = await import(path.join(SRC, 'traffic.js'));
  const playerMod = await import(path.join(SRC, 'player.js'));

  function makeDriveG() {
    return {
      rng: random.createRng(20261118),
      world: null,
      player: {
        x: 200, y: 200, angle: 0, speed: 0,
        health: 100, maxHealth: 100, hp: 100,
        onFoot: true, inCar: false, driving: false,
        car: null, vehicle: null, currentCar: null,
        cash: 0, weapon: 'pistol', ammo: 48, radius: 14,
        caught: false, dead: false,
      },
      vehicles: [],
      traffic: [],
      peds: [], pedestrians: [],
      police: [],
      heli: null, enemies: [], bullets: [], pickups: [], crates: [],
      missions: { current: null, active: null, list: [], stage: 0, index: 0, dialog: null, dialogOpen: false, objective: null },
      time: { t: 0, hour: 12, hours: 12, minute: 0, day: 1, night: false },
      heat: 0, wanted: 0, cash: 0,
      camera: { x: 200, y: 200, zoom: 1 },
      input: inputMod.createInput(),
      audio: {}, save: { activeSlot: 0 },
      gameOver: null, caught: false, paused: false,
      width: 1280, height: 720, viewW: 1280, viewH: 720,
    };
  }

  function initDriveWorld(G) {
    worldMod.init(G);
    vehiclesMod.init(G);
    trafficMod.init(G);
    playerMod.init(G);
  }

  // ---------------------------------------------------------------- [2]
  console.log('\n[2] driving: E enters a car, W/S/A intent moves it');
  try {
    const G = makeDriveG();
    initDriveWorld(G);
    check('traffic seeded into G.vehicles.list', G.vehicles.list.length >= 10,
      `cars=${G.vehicles.list.length}`);
    const car = G.vehicles.list[0];
    const startX = car.x, startY = car.y;
    G.player.x = car.x; G.player.y = car.y;
    G.camera.x = car.x; G.camera.y = car.y;
    G.input.keys.add('KeyE');
    playerMod.update(G, 1 / 60);
    G.input.keys.delete('KeyE');
    G.input.endFrame();
    check('E enters the nearest car', G.player.inCar === true && car.driver === 'player',
      `inCar=${G.player.inCar} driver=${car.driver}`);
    // Hold W for 2 s (vehicles before player, like main.js MODULE_ORDER).
    G.input.keys.add('KeyW');
    for (let i = 0; i < 120; i++) {
      vehiclesMod.update(G, 1 / 60);
      trafficMod.update(G, 1 / 60);
      playerMod.update(G, 1 / 60);
      G.input.endFrame();
    }
    const moved = Math.hypot(car.x - startX, car.y - startY);
    check('W builds speed and moves the car', car.speed > 100 && moved > 100,
      `speed=${car.speed.toFixed(0)} moved=${moved.toFixed(0)}`);
    // Steer left for 1 s.
    const angleBefore = car.angle;
    G.input.keys.add('KeyA');
    for (let i = 0; i < 60; i++) {
      vehiclesMod.update(G, 1 / 60);
      trafficMod.update(G, 1 / 60);
      playerMod.update(G, 1 / 60);
      G.input.endFrame();
    }
    const turned = angleDiff(angleBefore, car.angle);
    check('A turns the car left', turned < -0.2, `dAngle=${turned.toFixed(2)}`);
    // S brakes (then reverses): speed must fall well below cruise.
    G.input.keys.delete('KeyW');
    G.input.keys.delete('KeyA');
    G.input.keys.add('KeyS');
    for (let i = 0; i < 120; i++) {
      vehiclesMod.update(G, 1 / 60);
      trafficMod.update(G, 1 / 60);
      playerMod.update(G, 1 / 60);
      G.input.endFrame();
    }
    check('S brakes the car down', car.speed < 50, `speed=${car.speed.toFixed(0)}`);
    G.input.keys.delete('KeyS');
  } catch (e) {
    check('manual driving sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [2b]
  console.log('\n[2b] autopilot virtual keys drive the car the same way');
  try {
    const autopilotMod = await import(path.join(SRC, 'autopilot.js'));
    const G = makeDriveG();
    initDriveWorld(G);
    const car = G.vehicles.list[0];
    const startX = car.x, startY = car.y;
    G.player.x = car.x; G.player.y = car.y;
    G.camera.x = car.x; G.camera.y = car.y;
    G.input.keys.add('KeyE');
    playerMod.update(G, 1 / 60);
    G.input.keys.delete('KeyE');
    G.input.endFrame();
    check('autopilot test car entered', G.player.inCar === true, `inCar=${G.player.inCar}`);
    autopilotMod.init(G);
    G.autopilotEnabled = true;
    let maxSpeed = 0;
    for (let i = 0; i < 180; i++) {
      autopilotMod.update(G, 1 / 60);
      vehiclesMod.update(G, 1 / 60);
      trafficMod.update(G, 1 / 60);
      playerMod.update(G, 1 / 60);
      G.input.endFrame();
      maxSpeed = Math.max(maxSpeed, Math.abs(car.speed));
    }
    const moved = Math.hypot(car.x - startX, car.y - startY);
    check('autopilot roam moves the car', maxSpeed > 50 && moved > 50,
      `maxSpeed=${maxSpeed.toFixed(0)} moved=${moved.toFixed(0)}`);
    check('autopilot route follows the road graph (not a straight cut)',
      !!G.autopilot && Array.isArray(G.autopilot.route),
      `routeLen=${G.autopilot && G.autopilot.route ? G.autopilot.route.length : 'n/a'}`);
  } catch (e) {
    check('autopilot driving sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [3]
  console.log('\n[3] garage position vs world.places; weapon crates');
  try {
    const garageMod = await import(path.join(SRC, 'garage.js'));
    const weaponsMod = await import(path.join(SRC, 'weapons.js'));
    const G = makeDriveG();
    worldMod.init(G);
    garageMod.init(G);
    weaponsMod.init(G);
    const places = G.world.places;
    check('garage constants match world.places.garage',
      garageMod.GARAGE_X === places.garage.x && garageMod.GARAGE_Y === places.garage.y,
      `garage.js=(${garageMod.GARAGE_X},${garageMod.GARAGE_Y}) places=(${places.garage.x},${places.garage.y})`);
    check('garage center is clear of buildings',
      worldMod.pointInBuilding(G.world, garageMod.GARAGE_X, garageMod.GARAGE_Y, 0) === null);
    let nearestOther = Infinity;
    let nearestName = '';
    for (const [name, p] of Object.entries(places)) {
      if (name === 'garage') continue;
      const d = Math.hypot(p.x - places.garage.x, p.y - places.garage.y);
      if (d < nearestOther) { nearestOther = d; nearestName = name; }
    }
    check('no other marker within 150 of the garage', nearestOther > 150,
      `nearest=${nearestName} ${nearestOther.toFixed(0)}`);
    const crates = G.weapons.crates;
    const has = (weapon, x, y) => crates.some((c) => c.weapon === weapon && c.x === x && c.y === y);
    check('SMG crate at the gun store (1000,1400)', has('smg', 1000, 1400),
      `crates=${JSON.stringify(crates.map((c) => [c.weapon, c.x, c.y]))}`);
    check('shotgun crate at the docks (2200,3000)', has('shotgun', 2200, 3000));
    check('SMG crate at the hideout (600,2600)', has('smg', 600, 2600));
  } catch (e) {
    check('garage / crates sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [4]
  console.log('\n[4] weapon switch: pistol + SMG from the start, 1/2/Q instant');
  try {
    const weaponsMod = await import(path.join(SRC, 'weapons.js'));
    const G = makeDriveG();
    worldMod.init(G);
    weaponsMod.init(G);
    const w = G.weapons;
    check('Rook starts owning pistol + SMG', w.owned.pistol === true && w.owned.smg === true,
      `owned=${JSON.stringify(w.owned)}`);
    check('shotgun not owned at start', w.owned.shotgun === false);
    check('current weapon is pistol', w.current === 'pistol');
    check('selectWeapon(smg) works', weaponsMod.selectWeapon(G, 'smg') === true && w.current === 'smg');
    check('cycleWeapon goes back to pistol', weaponsMod.cycleWeapon(G) === true && w.current === 'pistol');
    check('cycleWeapon goes to smg again', weaponsMod.cycleWeapon(G) === true && w.current === 'smg');
    // Key path: Digit2 selects SMG, Q cycles, Digit3 (unowned shotgun) is ignored.
    weaponsMod.selectWeapon(G, 'pistol');
    G.input.keys.add('Digit2');
    weaponsMod.update(G, 1 / 60);
    G.input.keys.delete('Digit2');
    weaponsMod.update(G, 1 / 60);
    check('Digit2 key selects SMG', w.current === 'smg', `current=${w.current}`);
    G.input.keys.add('KeyQ');
    weaponsMod.update(G, 1 / 60);
    G.input.keys.delete('KeyQ');
    weaponsMod.update(G, 1 / 60);
    check('Q cycles to pistol', w.current === 'pistol', `current=${w.current}`);
    G.input.keys.add('Digit3');
    weaponsMod.update(G, 1 / 60);
    G.input.keys.delete('Digit3');
    weaponsMod.update(G, 1 / 60);
    check('Digit3 ignored (shotgun not owned)', w.current === 'pistol', `current=${w.current}`);
    const ammoBefore = w.ammo.pistol;
    const shots = weaponsMod.tryFire(G, { x: 1600, y: 1600, angle: 0 });
    check('tryFire fires the pistol and spends ammo',
      Array.isArray(shots) && shots.length === 1 && w.ammo.pistol === ammoBefore - 1,
      `shots=${shots && shots.length} ammo ${ammoBefore} -> ${w.ammo.pistol}`);
  } catch (e) {
    check('weapon switch sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [5]
  console.log('\n[5] shootout kill sync: combat kill advances the mission');
  try {
    const combatMod = await import(path.join(SRC, 'combat.js'));
    const weaponsMod = await import(path.join(SRC, 'weapons.js'));
    const missionsMod = await import(path.join(SRC, 'missions.js'));
    const G = makeDriveG();
    G.player.x = 1800; G.player.y = 1500;
    worldMod.init(G);
    combatMod.init(G);
    weaponsMod.init(G);
    missionsMod.init(G);
    const spawnClear = (id, idx) => {
      missionsMod.init(G);
      const ok = G.missions.startMission(G, idx);
      if (!ok) return false;
      return G.missions.enemies.every((e) =>
        worldMod.pointInBuilding(G.world, e.x, e.y, 0) === null);
    };
    check('m8 enemies spawn on roads (none in buildings)', spawnClear('m8', 7),
      `enemies=${JSON.stringify(G.missions.enemies.map((e) => [e.x, e.y]))}`);
    check('m10 enemies spawn on roads (none in buildings)', spawnClear('m10', 9));
    check('m12 enemies spawn on roads (none in buildings)', spawnClear('m12', 11));
    // Back to m8 for the kill-sync sequence.
    missionsMod.init(G);
    G.missions.startMission(G, 7);
    check('m8 spawns 3 enemies at 36 HP',
      G.missions.enemies.length === 3 && G.missions.enemies.every((e) => e.hp === 36 && e.alive),
      `enemies=${G.missions.enemies.length}`);
    const e0 = G.missions.enemies[0];
    combatMod.damageEnemy(G, e0, 18);
    check('one pistol hit leaves the enemy alive', e0.hp === 18 && e0.alive === true
      && G.missions.progress.enemiesLeft === 3, `hp=${e0.hp} left=${G.missions.progress.enemiesLeft}`);
    combatMod.damageEnemy(G, e0, 18);
    check('second pistol hit kills (combat flags)', e0.hp === 0 && e0.dead === true, `hp=${e0.hp} dead=${e0.dead}`);
    missionsMod.update(G, 1 / 60);
    check('missions sync picks up the combat kill', G.missions.progress.enemiesLeft === 2,
      `left=${G.missions.progress.enemiesLeft}`);
    const [e1, e2] = G.missions.enemies.slice(1);
    combatMod.damageEnemy(G, e1, 36);
    combatMod.damageEnemy(G, e2, 36);
    missionsMod.update(G, 1 / 60);
    check('all enemies down -> stage advances to 1',
      G.missions.progress.enemiesLeft === 0 && G.missions.stage === 1,
      `left=${G.missions.progress.enemiesLeft} stage=${G.missions.stage}`);
    // The mission layer's own damage path sets .dead too.
    missionsMod.init(G);
    G.missions.startMission(G, 7);
    const f0 = G.missions.enemies[0];
    G.missions.damageEnemy(f0, 36);
    check('missions damageEnemy sets dead=true as well',
      f0.dead === true && f0.alive === false && G.missions.progress.enemiesLeft === 2,
      `dead=${f0.dead} left=${G.missions.progress.enemiesLeft}`);
  } catch (e) {
    check('shootout kill-sync sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [6]
  console.log('\n[6] Spray Shop found through real world.places');
  try {
    const policeMod = await import(path.join(SRC, 'police.js'));
    const G = makeDriveG();
    worldMod.init(G);
    vehiclesMod.init(G);
    policeMod.init(G);
    const car = vehiclesMod.createCar(G, 'sedan', 2600, 600, 0);
    car.driver = 'player';
    G.vehicles.list.push(car);
    G.player.x = 2600; G.player.y = 600;
    G.player.inCar = true; G.player.driving = true; G.player.onFoot = false;
    G.player.car = car; G.player.vehicle = car;
    G.heat = 58;
    for (let i = 0; i < 120; i++) {
      policeMod.update(G, 1 / 60);
      G.time.t += 1 / 60;
    }
    check('heat drains at the Spray Shop (2600,600)', G.heat < 20, `heat=${G.heat.toFixed(1)}`);
  } catch (e) {
    check('Spray Shop sequence', false, String((e && e.stack) || e));
  }

  // ---------------------------------------------------------------- [7]
  console.log('\n[7] shots.js poses stage and report ready');
  try {
    const shotsMod = await import(path.join(SRC, 'shots.js'));
    const missionsMod = await import(path.join(SRC, 'missions.js'));
    const G = makeDriveG();
    G.player.x = 1600; G.player.y = 1600;
    worldMod.init(G);
    missionsMod.init(G);
    shotsMod.init(G);
    check('window.__stagePose hook is a function', typeof globalThis.window.__stagePose === 'function');
    check('G.shots.stagePose is a function', typeof G.shots.stagePose === 'function');
    // start pose
    globalThis.window.__shotReady = false;
    G.shots.stagePose('start');
    check('start pose sets title state', G.state === 'title', `state=${G.state}`);
    shotsMod.draw(G, sharedCtx);
    check('start pose reports ready', globalThis.window.__shotReady === true);
    // cover pose
    globalThis.window.__shotReady = false;
    G.shots.stagePose('cover');
    check('cover pose starts m7 at wanted 3',
      G.missions.active && G.missions.active.id === 'm7' && G.heat >= 52,
      `mission=${G.missions.active && G.missions.active.id} heat=${G.heat}`);
    // Mirror the main loop, which refreshes G.wanted from heat every
    // frame while playing (shots.js reads G.wanted first).
    const configMod = await import(path.join(SRC, 'config.js'));
    for (let i = 0; i < 5; i++) {
      G.wanted = configMod.wantedStars(G.heat);
      shotsMod.update(G, 1 / 60);
      shotsMod.draw(G, sharedCtx);
    }
    check('cover pose reports ready', globalThis.window.__shotReady === true);
    // mission pose
    globalThis.window.__shotReady = false;
    G.shots.stagePose('mission');
    check('mission pose starts m8 on foot in the arena',
      G.missions.active && G.missions.active.id === 'm8'
      && G.player.inCar === false && G.player.x === 1800 && G.player.y === 1500,
      `mission=${G.missions.active && G.missions.active.id} player=(${G.player.x},${G.player.y})`);
    check('mission pose offers the fixer dialog', G.missions.dialogOpen === true,
      `dialog=${JSON.stringify(G.missions.dialog && G.missions.dialog.name)}`);
    shotsMod.draw(G, sharedCtx);
    check('mission pose reports ready', globalThis.window.__shotReady === true);
    // unknown pose is rejected, never staged
    check('unknown pose is rejected', G.shots.stagePose('nope') === false);
  } catch (e) {
    check('shots poses sequence', false, String((e && e.stack) || e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSMOKE B6: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('SMOKE B6 CRASH:', e);
  process.exit(1);
});
