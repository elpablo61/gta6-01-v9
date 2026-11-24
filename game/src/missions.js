// missions.js — 12-mission linear story arc for "Crescent Bay".
// Written fresh from the prose spec (gta6-01-v4-prose-spec.md §2, §4, §9.1).
// Self-contained: it owns mission state, markers, timers, dialogs, the
// m2 courier car, shootout enemies, pickups and crates, and exposes
// everything the autopilot and the HUD need through G.missions.
// It never assumes another module's internals: every read of shared
// state (player, cash, heat, bullets, garage, heli, save) is guarded
// with defaults, so it works even if a neighbouring module is absent.
//
// Contract: ES module. Exports init(G), update(G, dt), draw(G, ctx).
// Shared state G holds: rng, world, player, vehicles, traffic, peds,
// police, heli, missions, time, heat, wanted, camera, input, audio,
// save, cash. City: Crescent Bay. Player: Rook. Fixers: Mara and Dex.
// No Rockstar / GTA terms anywhere. Game-over words are CAUGHT / DOWN.

const ROADS = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
const WORLD = 3200;

// Named places, all snapped to the road grid (roads at 200 + i * 400).
const PLACE = {
  market: { x: 600, y: 600 },
  downtown: { x: 2200, y: 1000 },
  club: { x: 1000, y: 1800 },
  marina: { x: 3000, y: 1400 },
  airport: { x: 2600, y: 2600 },
  plane: { x: 3000, y: 2600 },
  hideout: { x: 600, y: 2600 },
  docks: { x: 2600, y: 2200 },
  bank: { x: 1800, y: 1000 },
  garage: { x: 1000, y: 2200 },
};

const MISSION_DEFS = [
  { id: 'm1', name: 'First Job', kind: 'drive', fixer: 'Mara', reward: 400, timeLimit: 300,
    hook: 'Rook. Simple job. Pick up the package at the market, bring it downtown. Don\'t make me regret trusting you.' },
  { id: 'm2', name: 'Tail Chase', kind: 'chase', fixer: 'Mara', reward: 700, timeLimit: 300,
    hook: 'A courier is running my route without paying. Ram his car four times. Hard. He\'ll slow down each time you hit him.' },
  { id: 'm3', name: 'Hot Wheels', kind: 'checkpoint', fixer: 'Dex', reward: 900, timeLimit: 240,
    hook: 'Three stops, one clock. Club, marina, airport. Beat the timer and the cash is yours.' },
  { id: 'm4', name: 'Dockside', kind: 'drive', fixer: 'Mara', reward: 1100, timeLimit: 360,
    hook: 'Crate waiting at the marina. Bring it to the hideout. The docks are hot tonight, so keep moving.' },
  { id: 'm5', name: 'Midnight Run', kind: 'drive', fixer: 'Dex', reward: 1400, timeLimit: 300, night: true,
    hook: 'Night run. Pick up at the club, drop at the docks. Headlights on, mouth shut.' },
  { id: 'm6', name: 'Collector', kind: 'drive', fixer: 'Mara', reward: 1800, timeLimit: 420,
    hook: 'Five money drops scattered around the city. Collect them all, then come home.' },
  { id: 'm7', name: 'Highway Heat', kind: 'drive', fixer: 'Dex', reward: 4600, timeLimit: 420,
    hook: 'Get to the airport. The police will be all over you — lose them and the payday is big.' },
  { id: 'm8', name: 'Crescent Job', kind: 'shootout', fixer: 'Mara', reward: 6200, timeLimit: 600,
    hook: 'Act one ends here. Three of them in the plaza. Use the cover, grab the health and ammo, then get out.' },
  { id: 'm9', name: 'Sky Watch', kind: 'escape', fixer: 'Dex', reward: 2000, timeLimit: 420,
    hook: 'The police helicopter is up and its spotlight is on you. Hiding won\'t work under it. Keep moving and reach the hideout.' },
  { id: 'm10', name: 'Full Auto', kind: 'shootout', fixer: 'Mara', reward: 2500, timeLimit: 420,
    hook: 'Five of them at the docks. There are weapon crates in the arena — take a better gun, clear the place, then walk out.' },
  { id: 'm11', name: 'Tune-Up', kind: 'garage', fixer: 'Dex', reward: 3000, timeLimit: 420,
    hook: 'Take your car to the Fixer Garage and buy at least one upgrade. Then prove it was worth it — three timed stops across the city.' },
  { id: 'm12', name: 'Bay Finale', kind: 'finale', fixer: 'Mara', reward: 8000, timeLimit: 600,
    hook: 'The bank. Four of them inside, a helicopter over your head, roadblocks on the way out. Grab the loot, reach the plane. Biggest score of your life.' },
];

// ---------------------------------------------------------------- helpers
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function nearestRoadCoord(v) {
  let best = ROADS[0], bd = Infinity;
  for (const r of ROADS) { const d = Math.abs(r - v); if (d < bd) { bd = d; best = r; } }
  return best;
}
function nearestRoadPoint(x, y) {
  // Snap to the closest point on the road graph: nearest road line in x or y.
  const sx = nearestRoadCoord(x), sy = nearestRoadCoord(y);
  if (Math.abs(x - sx) <= Math.abs(y - sy)) return { x: sx, y };
  return { x, y: sy };
}
function roadIndex(v) { return clamp(Math.round((v - 200) / 400), 0, 7); }

// BFS on the 8x8 junction graph. Returns a list of {x, y} waypoints
// from the junction nearest (fx, fy) to the junction nearest (tx, ty).
function findRoute(fx, fy, tx, ty) {
  const si = roadIndex(fx), sj = roadIndex(fy);
  const ti = roadIndex(tx), tj = roadIndex(ty);
  const key = (i, j) => i * 8 + j;
  const prev = new Map([[key(si, sj), -1]]);
  const queue = [[si, sj]];
  while (queue.length) {
    const [i, j] = queue.shift();
    if (i === ti && j === tj) break;
    for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (ni < 0 || ni > 7 || nj < 0 || nj > 7) continue;
      if (prev.has(key(ni, nj))) continue;
      prev.set(key(ni, nj), key(i, j));
      queue.push([ni, nj]);
    }
  }
  const path = [];
  let cur = key(ti, tj);
  if (!prev.has(cur)) return [{ x: ROADS[ti], y: ROADS[tj] }];
  while (cur !== -1) {
    path.push({ x: ROADS[cur >> 3], y: ROADS[cur & 7] });
    cur = prev.get(cur);
  }
  path.reverse();
  return path;
}

function getPlayerPos(G) {
  const p = G && G.player;
  if (!p) return { x: 1600, y: 1600 };
  if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
  if (p.pos && typeof p.pos.x === 'number') return { x: p.pos.x, y: p.pos.y };
  return { x: 1600, y: 1600 };
}
function getPlayerCar(G) {
  const p = G && G.player;
  if (!p) return null;
  return p.car || p.vehicle || p.currentCar || null;
}
function getPlayerSpeed(G) {
  const car = getPlayerCar(G);
  if (car && typeof car.speed === 'number') return Math.abs(car.speed);
  const p = G && G.player;
  if (p && typeof p.speed === 'number') return Math.abs(p.speed);
  return 0;
}
function getCash(G) {
  if (G && typeof G.cash === 'number') return G.cash;
  if (G && G.player && typeof G.player.cash === 'number') return G.player.cash;
  return 0;
}
function setCash(G, v) {
  if (!G) return;
  if (typeof G.cash === 'number' || G.cash === undefined) G.cash = v;
  if (G.player && typeof G.player.cash === 'number') G.player.cash = v;
}
function setHeat(G, v) {
  if (!G) return;
  G.heat = v;
  if (G.police && typeof G.police === 'object') G.police.heat = v;
  if (typeof G.wantedHeat === 'number') G.wantedHeat = v;
}
function getHeat(G) {
  if (G && typeof G.heat === 'number') return G.heat;
  if (G && G.police && typeof G.police.heat === 'number') return G.police.heat;
  return 0;
}
function setHour(G, h) {
  if (!G) return;
  if (!G.time || typeof G.time !== 'object') G.time = {};
  // Render + traffic read .hours; other code reads .hour — keep both in
  // sync or night never renders (hoursOf defaults to 12 = permanent noon).
  G.time.hour = h;
  G.time.hours = h;
  G.time.night = h < 6 || h >= 19;
}
// Did the player press E this frame? Tries every input shape the game
// exposes, with edge detection for the raw key set.
let prevE = false;
function pressedE(G) {
  const inp = G && G.input;
  if (!inp) return false;
  if (typeof inp.consumeKey === 'function') { try { if (inp.consumeKey('KeyE')) return true; } catch (e) {} }
  if (typeof inp.pressed === 'function') { try { if (inp.pressed('KeyE')) return true; } catch (e) {} }
  if (typeof inp.ePressed === 'boolean' && inp.ePressed) return true;
  if (inp.keys) {
    const has = typeof inp.keys.has === 'function' ? inp.keys.has('KeyE') : !!inp.keys['KeyE'];
    const edge = has && !prevE;
    prevE = has;
    if (edge) return true;
  }
  return false;
}
function allVehicles(G) {
  const out = [];
  const push = (arr) => { if (Array.isArray(arr)) for (const v of arr) if (v && typeof v.x === 'number') out.push(v); };
  if (!G) return out;
  push(G.vehicles && (G.vehicles.list || G.vehicles.cars || G.vehicles));
  push(G.traffic && (G.traffic.cars || G.traffic.list));
  push(G.world && G.world.parkedCars);
  return out;
}

// ---------------------------------------------------------------- state
let S = null;

function freshState() {
  return {
    index: 0,                 // next mission to offer (0..11)
    active: null,             // active mission def
    stage: 0,
    timeLeft: 0,
    status: 'idle',           // idle | dialog | active | done
    dialog: null,             // { fixer, name, text, missionId } or null
    objective: null,          // { x, y, label, kind } or null
    offerTimer: 0.8,          // delay before offering m1
    completed: [],            // mission ids completed
    progress: {},             // per-mission live counters
    enemies: [],              // shootout enemies { x,y,hp,maxHp,alive }
    pickups: [],              // { x,y,kind:'ammo'|'health',amount,taken }
    crates: [],               // { x,y,weapon:'smg'|'shotgun',taken }
    drops: [],                // m6 money drops { x,y,taken }
    checkpoints: [],          // { x,y,hit,label }
    courier: null,            // m2 courier car object
    fallbackWalkTarget: null, // m2 anti-freeze: walk here when no car
    heliWanted: false,        // mission wants the helicopter overhead
    night: false,             // m5 night flag
    banner: null,             // { text, t } transient message
    bannerT: 0,
    purchasesAtStart: 0,
  };
}

function expose(G) {
  G.missions = {
    list: MISSION_DEFS,
    get index() { return S.index; },
    set index(v) { if (typeof v === 'number' && v >= 0 && v < MISSION_DEFS.length) S.index = v; },
    get active() { return S.active; },
    get stage() { return S.stage; },
    get status() { return S.status; },
    get dialog() { return S.dialog; },
    get dialogOpen() { return !!S.dialog; },
    get objective() { return S.objective; },
    get timeLeft() { return S.timeLeft; },
    get completed() { return S.completed.slice(); },
    get progress() { return S.progress; },
    get enemies() { return S.enemies; },
    get pickups() { return S.pickups; },
    get crates() { return S.crates; },
    get drops() { return S.drops; },
    get checkpoints() { return S.checkpoints; },
    get courier() { return S.courier; },
    get fallbackWalkTarget() { return S.fallbackWalkTarget; },
    get heliWanted() { return S.heliWanted; },
    get night() { return S.night; },
    get banner() { return S.banner; },
    startMission,
    offerNext,
    acceptDialog,
    failMission,
    completeMission,
    damageEnemy,
    shootHit,
    nearestEnemy,
    onGaragePurchase,
    setObjective,
  };
}

// ---------------------------------------------------------------- dialog
function offerNext(G) {
  if (S.index >= MISSION_DEFS.length) { S.status = 'done'; S.dialog = null; return; }
  const def = MISSION_DEFS[S.index];
  S.dialog = { fixer: def.fixer, name: def.name, text: def.hook, missionId: def.id };
  S.status = 'dialog';
  if (G) G.missions = G.missions || null;
}

function acceptDialog(G) {
  if (!S.dialog) return false;
  const def = MISSION_DEFS.find((m) => m.id === S.dialog.missionId);
  S.dialog = null;
  if (!def) return false;
  startMission(G, S.index, { skipDialog: true });
  return true;
}

// ---------------------------------------------------------------- start / setup
function startMission(G, index, opts) {
  opts = opts || {};
  const def = MISSION_DEFS[index];
  if (!def) return false;
  S.index = index;
  S.active = def;
  S.stage = 0;
  S.timeLeft = def.timeLimit;
  S.status = 'active';
  S.dialog = null;
  S.enemies = [];
  S.pickups = [];
  S.crates = [];
  S.drops = [];
  S.checkpoints = [];
  S.courier = null;
  S.fallbackWalkTarget = null;
  S.heliWanted = false;
  S.night = !!def.night;
  S.progress = { hits: 0, checkpointsHit: 0, dropsCollected: 0, enemiesLeft: 0, purchased: false };
  S.purchasesAtStart = (G && G.garage && typeof G.garage.purchases === 'number') ? G.garage.purchases : 0;
  if (def.night) setHour(G, 22);
  setupStage(G, 0);
  return true;
}

function setObjective(x, y, label, kind) {
  S.objective = { x, y, label, kind: kind || 'marker' };
}

function spawnEnemies(list) {
  S.enemies = list.map((e) => ({ x: e.x, y: e.y, hp: 36, maxHp: 36, alive: true, shootCd: 1 + Math.random() }));
  S.progress.enemiesLeft = S.enemies.length;
}

function spawnArenaPickups(cx, cy) {
  S.pickups = [
    { x: cx - 90, y: cy + 60, kind: 'health', amount: 40, taken: false },
    { x: cx + 90, y: cy - 60, kind: 'health', amount: 40, taken: false },
    { x: cx - 60, y: cy - 90, kind: 'ammo', amount: 48, taken: false },
    { x: cx + 60, y: cy + 90, kind: 'ammo', amount: 48, taken: false },
  ];
}

function requestHeli(G, on) {
  S.heliWanted = on;
  if (!G) return;
  try {
    if (G.heli) {
      if (typeof G.heli.spawn === 'function' && on) G.heli.spawn();
      if (typeof G.heli === 'object') {
        G.heli.active = on;
        if (on) G.heli.mode = 'shadow';
      }
    }
  } catch (e) {}
}

function setupStage(G, stage) {
  const def = S.active;
  if (!def) return;
  S.stage = stage;
  const P = getPlayerPos(G);
  switch (def.id) {
    case 'm1':
      if (stage === 0) setObjective(PLACE.market.x, PLACE.market.y, 'Pick up the package at the market', 'pickup');
      else setObjective(PLACE.downtown.x, PLACE.downtown.y, 'Deliver the package downtown', 'deliver');
      break;
    case 'm2': {
      // Courier spawns on the road ahead of the player, driving away.
      const start = nearestRoadPoint(P.x + 500, P.y);
      S.courier = {
        x: start.x, y: start.y, angle: 0, speed: 0, cruise: 380,
        route: [], routeDest: null, destX: 0, destY: 0, hits: 0, hitCd: 0,
      };
      pickCourierDest(G);
      setObjective(S.courier.x, S.courier.y, 'Ram the courier car 4 times', 'chase');
      break;
    }
    case 'm3':
      S.checkpoints = [
        { x: PLACE.club.x, y: PLACE.club.y, hit: false, label: 'Club' },
        { x: PLACE.marina.x, y: PLACE.marina.y, hit: false, label: 'Marina' },
        { x: PLACE.airport.x, y: PLACE.airport.y, hit: false, label: 'Airport' },
      ];
      setObjective(S.checkpoints[0].x, S.checkpoints[0].y, 'Hit the checkpoints: club, marina, airport', 'checkpoint');
      break;
    case 'm4':
      if (stage === 0) setObjective(PLACE.marina.x, PLACE.marina.y, 'Pick up the crate at the marina', 'pickup');
      else setObjective(PLACE.hideout.x, PLACE.hideout.y, 'Deliver the crate to the hideout', 'deliver');
      break;
    case 'm5':
      if (stage === 0) setObjective(PLACE.club.x, PLACE.club.y, 'Pick up at the club', 'pickup');
      else setObjective(PLACE.docks.x, PLACE.docks.y, 'Drop at the docks', 'deliver');
      break;
    case 'm6':
      S.drops = [
        { x: 600, y: 600, taken: false },
        { x: 2600, y: 600, taken: false },
        { x: 600, y: 2200, taken: false },
        { x: 2600, y: 1400, taken: false },
        { x: 1800, y: 1800, taken: false },
      ];
      if (stage === 0) setObjective(S.drops[0].x, S.drops[0].y, 'Collect 5 money drops around the city', 'collect');
      else setObjective(PLACE.hideout.x, PLACE.hideout.y, 'Return to the hideout', 'deliver');
      break;
    case 'm7':
      if (stage === 0) {
        // Wanted cover starts at 3 stars (heat 58) once the mission
        // starts — set AFTER the mission start, because starting the
        // mission itself adds heat.
        setHeat(G, Math.max(getHeat(G), 58));
        setObjective(PLACE.airport.x, PLACE.airport.y, 'Drive to the airport', 'drive');
      } else {
        setObjective(PLACE.hideout.x, PLACE.hideout.y, 'Escape the police — reach the hideout', 'escape');
      }
      break;
    case 'm8':
      if (stage === 0) {
        spawnEnemies([
          { x: 1700, y: 1300 }, { x: 1900, y: 1400 }, { x: 1800, y: 1600 },
        ]);
        spawnArenaPickups(1800, 1400);
        setObjective(1800, 1400, 'Clear the plaza — 3 enemies', 'shootout');
      } else {
        setObjective(PLACE.hideout.x, PLACE.hideout.y, 'Escape — reach the hideout', 'escape');
      }
      break;
    case 'm9':
      setHeat(G, Math.max(getHeat(G), 58));
      requestHeli(G, true);
      setObjective(PLACE.hideout.x, PLACE.hideout.y, 'Reach the hideout while the helicopter watches', 'escape');
      break;
    case 'm10':
      if (stage === 0) {
        spawnEnemies([
          { x: 2600, y: 2100 }, { x: 2700, y: 2200 }, { x: 2600, y: 2300 },
          { x: 2400, y: 2300 }, { x: 2700, y: 1800 },
        ]);
        S.crates = [
          { x: 2500, y: 2200, weapon: 'smg', taken: false },
          { x: 2700, y: 2200, weapon: 'shotgun', taken: false },
        ];
        spawnArenaPickups(2600, 2200);
        setObjective(2600, 2200, 'Clear the docks — 5 enemies. Grab a better weapon.', 'shootout');
      } else {
        setObjective(2200, 2200, 'Reach the exit marker', 'escape');
      }
      break;
    case 'm11':
      if (stage === 0) {
        setObjective(PLACE.garage.x, PLACE.garage.y, 'Go to the Fixer Garage and buy an upgrade', 'garage');
      } else {
        S.checkpoints = [
          { x: 2200, y: 600, hit: false, label: 'North' },
          { x: 600, y: 1400, hit: false, label: 'West' },
          { x: 2600, y: 1800, hit: false, label: 'South' },
        ];
        setObjective(S.checkpoints[0].x, S.checkpoints[0].y, 'Timed delivery: 3 checkpoints in the upgraded car', 'checkpoint');
      }
      break;
    case 'm12':
      if (stage === 0) {
        setHeat(G, Math.max(getHeat(G), 74));
        requestHeli(G, true);
        spawnEnemies([
          { x: 1800, y: 900 }, { x: 1900, y: 1000 }, { x: 1700, y: 1100 }, { x: 1800, y: 1100 },
        ]);
        spawnArenaPickups(1800, 1000);
        setObjective(1800, 1000, 'Clear the bank — 4 enemies', 'shootout');
      } else if (stage === 1) {
        setObjective(1800, 1000, 'Grab the loot at the bank', 'pickup');
      } else if (stage === 2) {
        setObjective(PLACE.airport.x, PLACE.airport.y, 'Escape to the airport', 'escape');
      } else {
        setObjective(PLACE.plane.x, PLACE.plane.y, 'Reach the plane', 'deliver');
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- courier (m2)
// The courier only rebuilds its route when its recorded destination has
// moved >100 from the target (§9.1c) — never every frame.
function pickCourierDest(G) {
  const c = S.courier;
  if (!c) return;
  const P = getPlayerPos(G);
  // Pick a far junction away from the player as the courier's target.
  // Never the corner the courier is already standing on: when the
  // player sits far from that corner it stays the "farthest" pick, the
  // courier's route becomes a single waypoint it accepts instantly,
  // and it parks at the corner forever instead of running its route.
  const far = [
    { x: 3000, y: 3000 }, { x: 200, y: 3000 }, { x: 3000, y: 200 }, { x: 200, y: 200 },
    { x: 2600, y: 600 }, { x: 600, y: 2600 },
  ];
  let best = null, bd = -1;
  for (const f of far) {
    if (dist(f.x, f.y, c.x, c.y) < 800) continue; // too close to run to
    const d = dist(f.x, f.y, P.x, P.y);
    if (d > bd) { bd = d; best = f; }
  }
  if (!best) best = far[0];
  c.destX = best.x; c.destY = best.y;
  c.routeDest = { x: best.x, y: best.y };
  c.route = findRoute(c.x, c.y, best.x, best.y);
}

function updateCourier(G, dt) {
  const c = S.courier;
  if (!c) return;
  c.hitCd = Math.max(0, c.hitCd - dt);
  // Route rebuild only when the destination moved >100 from recorded.
  if (!c.routeDest || dist(c.destX, c.destY, c.routeDest.x, c.routeDest.y) > 100 || c.route.length === 0) {
    c.route = findRoute(c.x, c.y, c.destX, c.destY);
    c.routeDest = { x: c.destX, y: c.destY };
  }
  const wp = c.route[0];
  if (wp) {
    const d = dist(c.x, c.y, wp.x, wp.y);
    // Accept the waypoint once inside a radius that grows with speed,
    // or once the courier has driven past it at close range: the
    // past-plane test must ALSO be close (d < 150) — a waypoint 400
    // units away on the next leg sits behind the courier's nose while
    // it is still turning toward it, and accepting it there burns the
    // whole route without moving (the courier parked at a corner for
    // 100+ seconds in the probe while its route cycled 1..14).
    const ahead = (wp.x - c.x) * Math.cos(c.angle) + (wp.y - c.y) * Math.sin(c.angle);
    if (d < Math.max(40, c.speed * 0.15) || (ahead < -20 && d < 150)) {
      c.route.shift();
    } else {
      const want = Math.atan2(wp.y - c.y, wp.x - c.x);
      let diff = want - c.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // The courier follows the same rule as every other car in the
      // city: slow down before a sharp junction turn. At a flat 380
      // it turns on a ~170-unit radius, cuts the corner through the
      // block, and never gives the player a closing window; easing to
      // 250 (sharp) / 170 (hairpin) ahead of the turn keeps it on the
      // road and opens a window at every junction, without touching
      // its 380 cruise on the straights or the 55% cut per ram hit.
      let cap = c.cruise;
      const absDiff = Math.abs(diff);
      if (absDiff > 1.5) cap = Math.min(cap, 170);
      else if (absDiff > 0.9) cap = Math.min(cap, 250);
      const next = c.route[1];
      if (next) {
        const outAngle = Math.atan2(next.y - wp.y, next.x - wp.x);
        let turnAhead = outAngle - want;
        while (turnAhead > Math.PI) turnAhead -= Math.PI * 2;
        while (turnAhead < -Math.PI) turnAhead += Math.PI * 2;
        if (Math.abs(turnAhead) > 0.9 && d < 320) cap = Math.min(cap, 260);
      }
      c.angle += clamp(diff, -2.2 * dt, 2.2 * dt);
      c.speed += (cap - c.speed) * Math.min(1, dt * 1.2);
      if (c.speed < 0) c.speed = 0;
      c.x += Math.cos(c.angle) * c.speed * dt;
      c.y += Math.sin(c.angle) * c.speed * dt;
      // Safety net: never leave the world. A courier outside the map
      // hands the autopilot a target no road route can reach.
      c.x = clamp(c.x, 0, WORLD);
      c.y = clamp(c.y, 0, WORLD);
    }
  }
  if (c.route.length === 0) pickCourierDest(G);
  // Ram detection: player car within 70 while speed > 120.
  const car = getPlayerCar(G);
  const P = getPlayerPos(G);
  if (car && c.hitCd <= 0 && getPlayerSpeed(G) > 120 && dist(P.x, P.y, c.x, c.y) < 70) {
    c.hits += 1;
    S.progress.hits = c.hits;
    c.cruise *= 0.55; // each hit cuts the courier's cruise to 55%
    c.hitCd = 1.0;
    S.banner = { text: 'Hit ' + c.hits + ' / 4 — the courier is slowing down!', t: 0 };
    S.bannerT = 2;
    if (c.hits >= 4) completeMission(G);
  }
  setObjective(c.x, c.y, 'Ram the courier car — hits ' + c.hits + ' / 4', 'chase');
}

// ---------------------------------------------------------------- combat hooks
// Called by the combat module when a shot lands, or by the fallback
// bullet scan in update(). Returns true if an enemy was hit.
function damageEnemy(enemy, dmg) {
  if (!enemy || !enemy.alive) return false;
  enemy.hp -= dmg;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.alive = false;
    enemy.dead = true; // combat.js reads .dead; keep both flags in sync
    S.progress.enemiesLeft = S.enemies.filter((e) => e.alive).length;
  }
  return true;
}
// Point-impact helper for hitscan weapons: damage the nearest living
// enemy within radius of (x, y).
function shootHit(x, y, dmg, radius) {
  const r = radius || 30;
  const e = nearestEnemy(x, y, r);
  if (!e) return false;
  return damageEnemy(e, dmg);
}
function nearestEnemy(x, y, maxDist) {
  let best = null, bd = maxDist || Infinity;
  for (const e of S.enemies) {
    if (!e.alive) continue;
    const d = dist(x, y, e.x, e.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
// Fallback: if bullets live in a shared array the combat module did not
// already resolve, resolve them here against mission enemies.
function scanBullets(G) {
  if (S.enemies.length === 0) return;
  const lists = [];
  if (G) {
    if (Array.isArray(G.bullets)) lists.push(G.bullets);
    if (G.combat && Array.isArray(G.combat.bullets)) lists.push(G.combat.bullets);
    if (G.player && Array.isArray(G.player.bullets)) lists.push(G.player.bullets);
    if (G.weapons && Array.isArray(G.weapons.bullets)) lists.push(G.weapons.bullets);
  }
  for (const list of lists) {
    for (const b of list) {
      if (!b || b.dead || b.hit || typeof b.x !== 'number') continue;
      const dmg = typeof b.damage === 'number' ? b.damage : 18;
      const e = nearestEnemy(b.x, b.y, 26);
      if (e) {
        damageEnemy(e, dmg);
        b.dead = true; b.hit = true;
      }
    }
  }
}

// ---------------------------------------------------------------- pickups
function giveAmmo(G, amount) {
  if (!G) return;
  try {
    if (G.weapons && typeof G.weapons.addAmmo === 'function') { G.weapons.addAmmo(amount); return; }
    if (G.player && typeof G.player.ammo === 'number') { G.player.ammo += amount; return; }
    if (G.player && G.player.weapons && typeof G.player.weapons.ammo === 'number') G.player.weapons.ammo += amount;
  } catch (e) {}
}
function giveHealth(G, amount) {
  if (!G) return;
  try {
    const p = G.player;
    if (p && typeof p.hp === 'number' && typeof p.maxHp === 'number') p.hp = Math.min(p.maxHp, p.hp + amount);
    else if (p && typeof p.hp === 'number') p.hp = Math.min(100, p.hp + amount);
    else if (p && typeof p.health === 'number') p.health = Math.min(100, p.health + amount);
  } catch (e) {}
}
function giveWeapon(G, weapon) {
  if (!G) return;
  try {
    if (G.weapons && typeof G.weapons.give === 'function') { G.weapons.give(weapon); return; }
    if (G.weapons && typeof G.weapons.unlock === 'function') { G.weapons.unlock(weapon); return; }
    const p = G.player;
    if (p) {
      p.weapons = p.weapons || {};
      p.weapons[weapon] = true;
      p.ownedWeapons = p.ownedWeapons || [];
      if (p.ownedWeapons.indexOf(weapon) === -1) p.ownedWeapons.push(weapon);
      p.currentWeapon = weapon;
    }
  } catch (e) {}
}
function updatePickups(G) {
  const P = getPlayerPos(G);
  for (const pk of S.pickups) {
    if (pk.taken) continue;
    if (dist(P.x, P.y, pk.x, pk.y) < 42) {
      pk.taken = true;
      if (pk.kind === 'ammo') giveAmmo(G, pk.amount);
      else giveHealth(G, pk.amount);
    }
  }
  for (const cr of S.crates) {
    if (cr.taken) continue;
    if (dist(P.x, P.y, cr.x, cr.y) < 46) {
      cr.taken = true;
      giveWeapon(G, cr.weapon);
      giveAmmo(G, 60);
      S.banner = { text: 'Picked up the ' + cr.weapon.toUpperCase(), t: 0 };
      S.bannerT = 2;
    }
  }
}

// ---------------------------------------------------------------- fail / complete
function failMission(G, reason) {
  const def = S.active;
  if (!def) return;
  S.banner = { text: 'Mission failed (' + (reason || 'try again') + ') — restarting from the beginning', t: 0 };
  S.bannerT = 3;
  // Restart from checkpoint (stage 0): full time, fresh objectives.
  S.timeLeft = def.timeLimit;
  S.stage = 0;
  S.enemies = [];
  S.pickups = [];
  S.crates = [];
  S.drops = [];
  S.checkpoints = [];
  S.courier = null;
  S.fallbackWalkTarget = null;
  S.progress = { hits: 0, checkpointsHit: 0, dropsCollected: 0, enemiesLeft: 0, purchased: false };
  S.purchasesAtStart = (G && G.garage && typeof G.garage.purchases === 'number') ? G.garage.purchases : 0;
  if (def.id === 'm9' || def.id === 'm12') requestHeli(G, false);
  setupStage(G, 0);
}

function completeMission(G) {
  const def = S.active;
  if (!def) return;
  setCash(G, getCash(G) + def.reward);
  if (S.completed.indexOf(def.id) === -1) S.completed.push(def.id);
  S.banner = { text: def.name + ' complete — $' + def.reward, t: 0 };
  S.bannerT = 3;
  S.active = null;
  S.objective = null;
  S.enemies = [];
  S.pickups = [];
  S.crates = [];
  S.drops = [];
  S.checkpoints = [];
  S.courier = null;
  S.fallbackWalkTarget = null;
  S.night = false;
  if (def.night) setHour(G, 12);
  if (def.id === 'm9' || def.id === 'm12') requestHeli(G, false);
  S.index += 1;
  S.status = 'idle';
  // Autosave after each mission completes (via save.js when present).
  try {
    if (G && G.save) {
      if (typeof G.save.autosave === 'function') G.save.autosave(G);
      else if (typeof G.save.save === 'function') G.save.save(G);
    }
  } catch (e) {}
  // Offer the next mission after a short breather.
  S.offerTimer = 1.2;
}

function onGaragePurchase(G) {
  S.progress.purchased = true;
  if (S.active && S.active.id === 'm11' && S.stage === 0) {
    setupStage(G, 1);
    S.banner = { text: 'Upgrade installed — now the timed delivery!', t: 0 };
    S.bannerT = 2.5;
  }
}

// ---------------------------------------------------------------- update
export function init(G) {
  S = freshState();
  expose(G);
  if (G) {
    G.missions = G.missions || null;
    // Re-expose after assignment so getters bind to the live state.
    expose(G);
  }
}

export function update(G, dt) {
  if (!S) init(G);
  if (!G || G.paused) return;
  if (S.bannerT > 0) {
    S.bannerT -= dt;
    if (S.bannerT <= 0) S.banner = null;
  }

  // DIALOG FIRST (§9.1a): the dialog-accept path runs before any
  // autopilot car search, so the autopilot can press E to accept.
  if (S.dialog) {
    if (pressedE(G)) acceptDialog(G);
    return;
  }

  if (S.status === 'idle' && !S.active) {
    S.offerTimer -= dt;
    if (S.offerTimer <= 0) offerNext(G);
    return;
  }
  if (!S.active) return;

  const def = S.active;
  const P = getPlayerPos(G);

  // Timer.
  S.timeLeft -= dt;
  if (S.timeLeft <= 0) { failMission(G, 'time up'); return; }

  // Death / caught restarts the mission from stage 0.
  const pl = G.player;
  if (pl && (pl.dead === true || (typeof pl.hp === 'number' && pl.hp <= 0) || pl.caught === true)) {
    failMission(G, pl.caught ? 'caught' : 'down');
    return;
  }

  scanBullets(G);
  updatePickups(G);

  // Sync with combat.js kills: combat resolves player bullets first
  // (it runs earlier in the module order) and marks its kills with
  // dead=true / hp=0, but this module counts enemiesLeft from .alive —
  // so a combat kill never advanced a shootout stage until now.
  if (S.enemies.length > 0) {
    let changed = false;
    for (const e of S.enemies) {
      if (e.alive && (e.dead === true || (typeof e.hp === 'number' && e.hp <= 0))) {
        e.alive = false;
        changed = true;
      }
    }
    if (changed) S.progress.enemiesLeft = S.enemies.filter((e) => e.alive).length;
  }

  // m2 anti-freeze (§9.1b): on foot with no car in range, fall back to
  // walking to the courier's nearest road point — never chase the
  // moving target forever.
  if (def.id === 'm2') {
    if (!getPlayerCar(G)) {
      const cars = allVehicles(G);
      let near = null;
      for (const v of cars) {
        if (v === getPlayerCar(G)) continue;
        if (dist(P.x, P.y, v.x, v.y) < 300) { near = v; break; }
      }
      S.fallbackWalkTarget = near ? null : (S.courier ? nearestRoadPoint(S.courier.x, S.courier.y) : null);
    } else {
      S.fallbackWalkTarget = null;
    }
    updateCourier(G, dt);
    return;
  }

  const nearObjective = S.objective ? dist(P.x, P.y, S.objective.x, S.objective.y) < 60 : false;

  switch (def.id) {
    case 'm1':
    case 'm4':
    case 'm5':
      if (nearObjective) {
        if (S.stage === 0) setupStage(G, 1);
        else completeMission(G);
      }
      break;
    case 'm3': {
      let next = null;
      for (const cp of S.checkpoints) {
        if (!cp.hit && dist(P.x, P.y, cp.x, cp.y) < 70) {
          cp.hit = true;
          S.progress.checkpointsHit += 1;
          S.banner = { text: 'Checkpoint ' + S.progress.checkpointsHit + ' / 3 — ' + cp.label, t: 0 };
          S.bannerT = 2;
        }
        if (!cp.hit && !next) next = cp;
      }
      if (S.progress.checkpointsHit >= 3) { completeMission(G); break; }
      if (next) setObjective(next.x, next.y, 'Checkpoint ' + (S.progress.checkpointsHit + 1) + ' / 3 — ' + next.label, 'checkpoint');
      break;
    }
    case 'm6': {
      if (S.stage === 0) {
        let next = null;
        for (const d of S.drops) {
          if (!d.taken && dist(P.x, P.y, d.x, d.y) < 60) {
            d.taken = true;
            S.progress.dropsCollected += 1;
            setCash(G, getCash(G) + 100);
          }
          if (!d.taken && !next) next = d;
        }
        if (S.progress.dropsCollected >= 5) { setupStage(G, 1); break; }
        if (next) setObjective(next.x, next.y, 'Money drops ' + S.progress.dropsCollected + ' / 5', 'collect');
      } else if (nearObjective) {
        completeMission(G);
      }
      break;
    }
    case 'm7':
      if (S.stage === 0) {
        if (nearObjective) setupStage(G, 1);
      } else if (getHeat(G) < 12) {
        // Escaped: heat decayed below 1 star while heading to hideout.
        completeMission(G);
      } else if (nearObjective && getHeat(G) < 30) {
        completeMission(G);
      }
      break;
    case 'm8':
      if (S.stage === 0) {
        if (S.progress.enemiesLeft === 0) setupStage(G, 1);
      } else if (nearObjective) {
        completeMission(G);
      }
      break;
    case 'm9':
      if (nearObjective) completeMission(G);
      break;
    case 'm10':
      if (S.stage === 0) {
        if (S.progress.enemiesLeft === 0) setupStage(G, 1);
      } else if (nearObjective) {
        completeMission(G);
      }
      break;
    case 'm11': {
      // Purchase check (also fires via onGaragePurchase from garage.js).
      if (S.stage === 0) {
        const bought = S.progress.purchased ||
          (G && G.garage && typeof G.garage.purchases === 'number' && G.garage.purchases > S.purchasesAtStart);
        if (bought) { S.progress.purchased = true; setupStage(G, 1); break; }
        // Standing in the garage zone is the prompt to open the menu;
        // the garage module itself opens on E.
        if (nearObjective && G && G.garage && typeof G.garage.openMenu === 'function' && !G.garage.open) {
          // Do not force-open: the autopilot presses E / calls openMenu.
        }
      } else {
        let next = null;
        for (const cp of S.checkpoints) {
          if (!cp.hit && dist(P.x, P.y, cp.x, cp.y) < 70) {
            cp.hit = true;
            S.progress.checkpointsHit += 1;
          }
          if (!cp.hit && !next) next = cp;
        }
        if (S.progress.checkpointsHit >= 3) { completeMission(G); break; }
        if (next) setObjective(next.x, next.y, 'Delivery ' + (S.progress.checkpointsHit + 1) + ' / 3 — ' + next.label, 'checkpoint');
      }
      break;
    }
    case 'm12':
      if (S.stage === 0) {
        if (S.progress.enemiesLeft === 0) setupStage(G, 1);
      } else if (S.stage === 1) {
        if (nearObjective) setupStage(G, 2);
      } else if (S.stage === 2) {
        if (nearObjective) setupStage(G, 3);
      } else if (nearObjective) {
        completeMission(G);
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- draw
export function draw(G, ctx) {
  if (!S || !ctx) return;
  const t = (G && G.time && typeof G.time.now === 'number') ? G.time.now : Date.now() / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 4);

  // Objective marker: pulsing ring + beam + label.
  if (S.objective && S.status === 'active') {
    const o = S.objective;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 210, 63, ' + (0.55 + 0.45 * pulse) + ')';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(o.x, o.y, 26 + pulse * 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 210, 63, 0.18)';
    ctx.beginPath();
    ctx.arc(o.x, o.y, 26 + pulse * 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 210, 63, 0.9)';
    ctx.beginPath();
    ctx.arc(o.x, o.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Courier car (m2): orange, distinct from traffic.
  if (S.courier) {
    const c = S.courier;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#ff7a1a';
    ctx.fillRect(-22, -11, 44, 22);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(8, -9, 10, 18);
    ctx.fillStyle = '#222';
    ctx.fillRect(-16, -12, 8, 4);
    ctx.fillRect(-16, 8, 8, 4);
    ctx.fillRect(10, -12, 8, 4);
    ctx.fillRect(10, 8, 8, 4);
    ctx.restore();
  }

  // Enemies: red figures with a health bar.
  for (const e of S.enemies) {
    if (!e.alive) continue;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a1f22';
    ctx.fillRect(-8, -4, 16, 8);
    ctx.fillStyle = '#111';
    ctx.fillRect(8, -2, 12, 4);
    ctx.restore();
    ctx.fillStyle = '#111';
    ctx.fillRect(e.x - 16, e.y - 26, 32, 5);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(e.x - 16, e.y - 26, 32 * (e.hp / e.maxHp), 5);
  }

  // Pickups: ammo (yellow box) / health (green cross).
  for (const pk of S.pickups) {
    if (pk.taken) continue;
    ctx.save();
    ctx.translate(pk.x, pk.y);
    if (pk.kind === 'ammo') {
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(-9, -7, 18, 14);
      ctx.fillStyle = '#111';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('AMMO', 0, 4);
    } else {
      ctx.fillStyle = '#2fbf71';
      ctx.fillRect(-9, -9, 18, 18);
      ctx.fillStyle = '#fff';
      ctx.fillRect(-2, -6, 4, 12);
      ctx.fillRect(-6, -2, 12, 4);
    }
    ctx.restore();
  }

  // Weapon crates (m10): labelled boxes.
  for (const cr of S.crates) {
    if (cr.taken) continue;
    ctx.save();
    ctx.translate(cr.x, cr.y);
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(-14, -11, 28, 22);
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2;
    ctx.strokeRect(-14, -11, 28, 22);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cr.weapon.toUpperCase(), 0, 3);
    ctx.restore();
  }

  // Money drops (m6): green cash piles.
  for (const d of S.drops) {
    if (d.taken) continue;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.fillStyle = '#2fbf71';
    ctx.beginPath();
    ctx.arc(0, 0, 12 + pulse * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('$', 0, 4);
    ctx.restore();
  }

  // Checkpoints: numbered rings.
  S.checkpoints.forEach((cp, i) => {
    if (cp.hit) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(80, 200, 255, ' + (0.6 + 0.4 * pulse) + ')';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#50c8ff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), cp.x, cp.y + 5);
    ctx.restore();
  });
}
