// Autopilot for Crescent Bay — drives the playtest suites and the screenshot
// poses. It plays the whole game the way a careful human would: it walks the
// road graph on foot, steals a much faster parked car when the one it has is
// slow, chases the courier by ramming, escapes to the Spray Shop, fights
// shootouts in aimed bursts, buys the cheapest garage upgrade, and never
// stops under the police helicopter's spotlight.
//
// The autopilot never touches game rules. It only presses the same keys a
// player would (WASD to move, E to interact, mouse to aim and shoot, number
// keys to change weapon) and it only reads public state off the shared
// object G. Every lookup below is defensive: fields are optional, several
// shapes are accepted, and a missing system simply makes that behaviour
// fall back to the next best thing instead of throwing.
//
// One hard rule from the v4 rebuild: on any frame the autopilot drives,
// it sets G.autopilotDrove (and the snake_case twin) so the manual driving
// branch skips that frame. Without that flag the two drivers fight and the
// car freezes.

const TAU = Math.PI * 2;

// How far a walk target must move before the autopilot recomputes its route.
const WALK_RETARGET = 120;
// A parked car only wins a swap when it is much faster; stealing adds heat,
// so a marginal gain is never worth it.
const SWAP_GO_TO_SPEED = 350;
const SWAP_CHASE_SPEED = 430;
const SWAP_GO_TO_RANGE = 200;
const SWAP_CHASE_RANGE = 320;
// Chase tuning: the courier cruises at 380, we cruise at 520.
const CHASE_CRUISE = 520;
// A ram only counts close in and fast.
const RAM_RANGE = 70;
const RAM_MIN_SPEED = 120;
// Shootout tuning: aimed bursts, never spray.
const BURST_INTERVAL = 0.45;
const AMMO_LOW = 6;
// Waypoint acceptance radii.
const WAYPOINT_RADIUS = 42;
const FINAL_RADIUS = 60;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Defensive state access. Every helper accepts the shapes the game may use
// and returns a sane default when the field is absent.
// ---------------------------------------------------------------------------

function posOf(entity) {
  if (!entity) return null;
  if (typeof entity.x === 'number' && typeof entity.y === 'number') {
    return { x: entity.x, y: entity.y };
  }
  if (entity.pos && typeof entity.pos.x === 'number') return { x: entity.pos.x, y: entity.pos.y };
  if (entity.position && typeof entity.position.x === 'number') {
    return { x: entity.position.x, y: entity.position.y };
  }
  return null;
}

function headingOf(entity) {
  if (!entity) return 0;
  for (const key of ['angle', 'heading', 'dir', 'rotation']) {
    if (typeof entity[key] === 'number') return entity[key];
  }
  return 0;
}

function speedOf(entity) {
  if (!entity) return 0;
  for (const key of ['speed', 'velocity', 'vel']) {
    if (typeof entity[key] === 'number') return entity[key];
    if (entity[key] && typeof entity[key].x === 'number') {
      return Math.hypot(entity[key].x, entity[key].y);
    }
  }
  return 0;
}

function topSpeedOf(vehicle) {
  if (!vehicle) return 0;
  for (const key of ['topSpeed', 'maxSpeed', 'top_speed', 'max_speed']) {
    if (typeof vehicle[key] === 'number') return vehicle[key];
  }
  // Fall back to the type table when the vehicle carries no number.
  const type = String(vehicle.type || vehicle.kind || '').toLowerCase();
  if (type.includes('sport')) return 520;
  if (type.includes('police')) return 480;
  if (type.includes('taxi')) return 400;
  if (type.includes('truck')) return 300;
  return 380; // sedan default
}

function playerPos(G) {
  return posOf(G.player) || { x: 1600, y: 1600 };
}

function playerVehicle(G) {
  const p = G.player || {};
  return p.vehicle || p.car || p.currentCar || p.inVehicle || null;
}

function isDriving(G) {
  const p = G.player || {};
  if (p.inCar === true || p.driving === true || p.onFoot === false) return true;
  if (p.inCar === false || p.onFoot === true) return false;
  return !!playerVehicle(G);
}

function allVehicles(G) {
  const v = G.vehicles;
  // The live cars live in .list: G.vehicles is an array carrying that
  // property (see vehicles.js init), and the array itself is always
  // empty — checking Array.isArray(v) first returned nothing forever.
  const shapes = [v && v.list, v, v && v.all, v && v.parked];
  for (const shape of shapes) {
    if (Array.isArray(shape)) return shape;
  }
  return [];
}

function currentMission(G) {
  const m = G.missions;
  if (!m) return null;
  if (m.current) return m.current;
  if (m.active) return m.active;
  if (Array.isArray(m.list)) {
    const found = m.list.find((entry) => entry && (entry.active || entry.current));
    if (found) return found;
    if (typeof m.index === 'number') return m.list[m.index] || null;
  }
  if (typeof m.id === 'string') return m;
  return null;
}

function missionId(mission) {
  if (!mission) return '';
  return String(mission.id || mission.name || mission.key || '').toLowerCase();
}

function missionStage(mission) {
  if (!mission) return 0;
  if (typeof mission.stage === 'number') return mission.stage;
  if (typeof mission.stageIndex === 'number') return mission.stageIndex;
  if (typeof mission.step === 'number') return mission.step;
  return 0;
}

function missionFailed(G, mission) {
  if (!mission) return false;
  if (mission.failed === true || mission.status === 'failed' || mission.state === 'failed') return true;
  if (G.missions && (G.missions.failed === true || G.missions.status === 'failed')) return true;
  return false;
}

function missionComplete(G, mission) {
  if (!mission) return false;
  return mission.complete === true || mission.completed === true
    || mission.status === 'complete' || mission.status === 'completed'
    || mission.state === 'complete';
}

// Whether a DOM overlay with this id is currently shown. The hidden
// attribute is the authority: offsetParent is null for a hidden
// element AND for a visible one inside a hidden ancestor, so it cannot
// tell the two apart and used to report open dialogs as closed.
function overlayShown(id) {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(id);
  return !!(el && !el.hidden);
}

// The objective target: a marker, checkpoint, drop, courier, enemy, or any
// point the mission wants Rook to reach. Several shapes are accepted.
// The LIVE objective wins over the mission def: it lives on the exposed
// missions object (G.missions.objective = {x, y, label, kind}, set by
// setupStage), while the mission DEF carries no target/marker/objective
// fields at all — reading only the def always returned null here and
// the autopilot fell through to roam instead of driving to the marker.
function liveObjective(G) {
  const live = G && G.missions;
  if (!live || !live.objective) return null;
  const point = posOf(live.objective);
  if (point) return { x: point.x, y: point.y, ref: live.objective };
  if (typeof live.objective.x === 'number' && typeof live.objective.y === 'number') {
    return { x: live.objective.x, y: live.objective.y, ref: live.objective };
  }
  return null;
}

function objectiveTarget(G, mission) {
  const live = liveObjective(G);
  if (live) return live;
  if (!mission) return null;
  const candidates = [
    mission.target, mission.marker, mission.checkpoint, mission.destination,
    mission.objective && mission.objective.target,
    mission.objective && mission.objective.marker,
    mission.objective && mission.objective.position,
    mission.objectivePos, mission.goal,
  ];
  for (const candidate of candidates) {
    const point = posOf(candidate);
    if (point) return { x: point.x, y: point.y, ref: candidate };
    if (candidate && typeof candidate.x === 'number') return { x: candidate.x, y: candidate.y, ref: candidate };
  }
  // Checkpoints are a list; take the first unvisited one. The live
  // lists on G.missions count too, and a hit checkpoint is done.
  const liveLists = G && G.missions;
  const list = mission.checkpoints || mission.markers || mission.drops
    || (liveLists && (liveLists.checkpoints || liveLists.drops));
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && (entry.visited || entry.done || entry.collected || entry.hit)) continue;
      const point = posOf(entry);
      if (point) return { x: point.x, y: point.y, ref: entry };
    }
  }
  return null;
}

function missionEnemies(G, mission) {
  const pools = [
    mission && mission.enemies,
    G.combat && G.combat.enemies,
    G.enemies,
    G.missions && G.missions.enemies,
  ];
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length > 0) {
      return pool.filter((e) => e && (e.health === undefined || e.health > 0) && e.dead !== true);
    }
  }
  return [];
}

function dialogOpen(G) {
  // Authoritative first: the game state and the missions module's own
  // dialog flag. Asking only the current mission falls back to the m1
  // DEF (which has no dialogOpen field) while the offer is still
  // unaccepted, so the autopilot never saw the dialog and the arc
  // stalled at m1 in roam, frozen.
  if (G && G.state === 'dialog') return true;
  if (G && G.missions && G.missions.dialogOpen === true) return true;
  if (G.ui && (G.ui.dialogOpen === true || G.ui.dialog === true)) return true;
  if (G.dialog && G.dialog.open === true) return true;
  const mission = currentMission(G);
  if (mission && mission.dialogOpen === true) return true;
  return overlayShown('mission-dialog');
}

function garageMenuOpen(G) {
  if (G.garage && (G.garage.open === true || G.garage.menuOpen === true)) return true;
  if (G.ui && (G.ui.garageOpen === true || G.ui.garage === true)) return true;
  return overlayShown('garage-menu') || overlayShown('garage-overlay');
}

function gameOverShown(G) {
  if (G.gameOver === true || G.state === 'gameover' || G.screen === 'gameover') return true;
  return overlayShown('game-over-screen');
}

function titleShown(G) {
  if (G.screen === 'title' || G.state === 'title') return true;
  return overlayShown('title-screen');
}

// A named place from the world's places map first, then the older flat
// fields, then a caller-supplied fallback. The places map is the one
// source of truth for where things are.
function placePos(G, name, fallback) {
  const w = G.world || {};
  return posOf(w.places && w.places[name])
    || posOf(w[name]) || posOf(G[name]) || fallback;
}

function sprayShopPos(G) {
  const w = G.world || {};
  return placePos(G, 'sprayShop', null)
    || posOf(w.spray) || posOf(w.spray_shop) || { x: 600, y: 600 };
}

function garagePos(G) {
  const w = G.world || {};
  return placePos(G, 'garage', null)
    || posOf(w.fixerGarage) || posOf(w.fixer_garage)
    || posOf(G.garage && G.garage.position) || { x: 1000, y: 1000 };
}

function hideoutPos(G) {
  const w = G.world || {};
  return posOf(w.hideout) || posOf(G.hideout) || { x: 1600, y: 1600 };
}

function ammoPickups(G) {
  const pools = [G.combat && G.combat.ammoPickups, G.pickups, G.world && G.world.pickups];
  for (const pool of pools) {
    if (Array.isArray(pool)) return pool.filter((p) => p && p.kind !== 'weapon' && p.type !== 'weapon');
  }
  return [];
}

function weaponCrates(G) {
  const pools = [
    G.combat && G.combat.weaponCrates,
    G.world && G.world.weaponCrates,
    G.pickups,
    G.crates,
  ];
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      return pool.filter((c) => c && (c.kind === 'weapon' || c.type === 'weapon'
        || c.weapon || /smg|shotgun/i.test(String(c.name || ''))));
    }
  }
  return [];
}

function currentAmmo(G) {
  const p = G.player || {};
  if (typeof p.ammo === 'number') return p.ammo;
  if (p.weapons && p.weapon) {
    const w = p.weapons[p.weapon] || p.weapons[p.currentWeapon];
    if (w && typeof w.ammo === 'number') return w.ammo;
  }
  if (p.weapon && typeof p.weapon.ammo === 'number') return p.weapon.ammo;
  if (G.combat && typeof G.combat.ammo === 'number') return G.combat.ammo;
  return 48; // assume stocked when the game does not expose ammo
}

function currentWeaponName(G) {
  const p = G.player || {};
  if (typeof p.weapon === 'string') return p.weapon;
  if (p.weapon && typeof p.weapon.name === 'string') return p.weapon.name;
  if (typeof p.currentWeapon === 'string') return p.currentWeapon;
  return 'pistol';
}

function weaponRank(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('shotgun')) return 3;
  if (n.includes('smg')) return 2;
  return 1; // pistol
}

function heliOverhead(G) {
  const heli = G.heli || G.helicopter || (G.police && G.police.heli) || (G.police && G.police.helicopter);
  if (!heli) return false;
  if (heli.active === false || heli.present === false) return false;
  if (typeof heli.x === 'number') {
    const p = playerPos(G);
    return dist(heli.x, heli.y, p.x, p.y) < 500 || heli.spotlight === true || heli.overhead === true;
  }
  return heli.active === true || heli.present === true || heli.overhead === true;
}

// ---------------------------------------------------------------------------
// Input. The autopilot presses keys two ways: it writes into the shared
// input object (whatever shape it has) and it dispatches real DOM key
// events, so an input module listening on window still hears it. Held keys
// are tracked so each keydown fires once per press, not once per frame.
// ---------------------------------------------------------------------------

function createKeyDriver(G) {
  const held = new Set();
  const input = G.input || {};

  function setVirtual(code, down) {
    try {
      if (input.keys instanceof Set) {
        if (down) input.keys.add(code); else input.keys.delete(code);
      } else if (input.keys && typeof input.keys === 'object') {
        input.keys[code] = down;
      }
      if (down) {
        if (input.pressed) input.pressed[code] = true;
        if (typeof input.press === 'function') input.press(code);
      }
      // Direction aliases the player module may read directly.
      const dir = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
      if (dir[code]) input[dir[code]] = down;
      if (code === 'ShiftLeft' || code === 'ShiftRight') input.sprint = down;
      if (code === 'KeyE') input.interact = down;
    } catch {
      // Input is best-effort; a throw here must never stall the autopilot.
    }
  }

  function dispatch(code, down) {
    try {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      const event = new window.KeyboardEvent(down ? 'keydown' : 'keyup', {
        code, key: code.replace(/^Key/, '').toLowerCase(), bubbles: true, cancelable: true,
      });
      window.dispatchEvent(event);
      if (typeof document !== 'undefined' && document.activeElement) {
        document.activeElement.dispatchEvent(event);
      }
    } catch {
      // DOM events are a fallback; silence is fine.
    }
  }

  return {
    hold(code) {
      if (!held.has(code)) {
        held.add(code);
        setVirtual(code, true);
        dispatch(code, true);
      }
    },
    release(code) {
      if (held.has(code)) {
        held.delete(code);
        setVirtual(code, false);
        dispatch(code, false);
      }
    },
    tap(code) {
      this.hold(code);
      // Release on the next frame through releaseAllStale; a tap is queued.
      this._taps = this._taps || new Set();
      this._taps.add(code);
    },
    releaseTaps() {
      if (!this._taps) return;
      for (const code of this._taps) this.release(code);
      this._taps.clear();
    },
    releaseAll(except) {
      for (const code of [...held]) {
        if (!except || !except.has(code)) this.release(code);
      }
    },
    get held() { return held; },
  };
}

function setAim(G, target) {
  if (!target) return;
  const input = G.input || {};
  try {
    input.aim = { x: target.x, y: target.y };
    input.aimX = target.x;
    input.aimY = target.y;
    const camera = G.camera || {};
    const cx = typeof camera.x === 'number' ? camera.x : 0;
    const cy = typeof camera.y === 'number' ? camera.y : 0;
    input.mouseX = target.x - cx;
    input.mouseY = target.y - cy;
    input.mouse = { x: target.x - cx, y: target.y - cy };
  } catch {
    // Aim is best-effort.
  }
}

function setFiring(G, firing) {
  const input = G.input || {};
  try {
    input.mouseDown = firing;
    input.attack = firing;
    input.firing = firing;
    if (firing && typeof input.press === 'function') input.press('Mouse0');
  } catch {
    // Best-effort.
  }
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.getElementById('game-canvas') || document.getElementById('game');
      if (canvas && typeof window !== 'undefined') {
        const type = firing ? 'mousedown' : 'mouseup';
        canvas.dispatchEvent(new window.MouseEvent(type, { button: 0, bubbles: true, cancelable: true }));
      }
    }
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Routing. Prefer the world's own route finder (BFS on the junction graph);
// fall back to a straight line. The route is a list of {x, y} waypoints.
// ---------------------------------------------------------------------------

function computeRoute(G, from, to) {
  const world = G.world || {};
  const finder = world.findRoute || world.route || world.findPath || world.bfsRoute || G.findRoute;
  if (typeof finder === 'function') {
    // The world's findRoute takes FOUR NUMBERS (sx, sy, tx, ty). Calling
    // it with two point OBJECTS threw inside the router (nearestRoadPoint
    // got an object and returned null), so every route silently fell to
    // the midpoint fallback below: one road point + the target, a straight
    // diagonal across a building block. The car wedged inside the block
    // and crawled at ~5 u/s along the walls. Try the numeric form first,
    // then the object form, then fall back.
    const shapes = [[from.x, from.y, to.x, to.y], [from, to]];
    for (const args of shapes) {
      let raw = null;
      try { raw = finder.call(world, ...args); } catch (e) { raw = null; }
      if (Array.isArray(raw) && raw.length > 0) {
        return raw.map((p) => posOf(p)).filter(Boolean);
      }
    }
  }
  // Straight line, with the midpoint snapped to the nearest road when the
  // world can tell us where the road is.
  const nearest = world.nearestRoadPoint || world.nearestRoad || world.snapToRoad;
  if (typeof nearest === 'function') {
    try {
      const mid = nearest.call(world, (from.x + to.x) / 2, (from.y + to.y) / 2);
      const point = posOf(mid) || (Array.isArray(mid) ? { x: mid[0], y: mid[1] } : null);
      if (point) return [point, { x: to.x, y: to.y }];
    } catch {
      // Fall through.
    }
  }
  return [{ x: to.x, y: to.y }];
}

// ---------------------------------------------------------------------------
// The autopilot itself.
// ---------------------------------------------------------------------------

export function init(G) {
  const state = {
    keys: createKeyDriver(G),
    mode: 'idle',
    route: [],
    routeTarget: null,
    walkTarget: null,
    walkTargetPos: null,
    lastShotAt: 0,
    lastSwapCheckAt: 0,
    lastRouteAt: 0,
    burstUntil: 0,
    garageTries: 0,
    lastDialogAt: 0,
    stuckSince: 0,
    lastPos: null,
    lastPosAt: 0,
    now: 0,
    // Chase (m2) interception state, cached: a road route to a fixed
    // ambush junction, refreshed only when the ambush moves or goes
    // stale — never rebuilt because the courier inched forward.
    chaseRoute: [],
    chaseRouteDest: null,
    chaseRouteAt: 0,
    chaseRouteFrom: null,
    chaseRoutePrev: null,
    chaseIntercept: null,
    chaseInterceptAt: 0,
    chaseStartAt: 0,
    chaseKey: '',
    // B9 chase telemetry: the branch the driver took last frame and
    // what it did with the throttle. publishDebug() copies these plus
    // the raw car / input / courier state into G.chaseDebug every
    // frame, so a probe can name the exact branch of a freeze instead
    // of guessing from position alone.
    dbgBranch: 'init',
    dbgDrive: 'none',
    // B9 Fase 3 no-progress watchdog: escapeUntil is the game-time
    // end of a forced direct drive (set by update() after 10s with no
    // position progress); noProgressSince is when the current
    // standstill started; lastBranch is the last driveChase branch,
    // kept across update()'s per-frame dbgBranch reset so the
    // watchdog can tell a deliberate wait (face) from a stuck drive.
    escapeUntil: 0,
    noProgressSince: 0,
    lastBranch: 'init',
  };
  G.autopilot = state;
  G.autopilotEnabled = false;
  return state;
}

function setMode(G, mode) {
  const state = G.autopilot;
  if (state && state.mode !== mode) state.mode = mode;
  if (G.autopilot) G.autopilot.mode = mode;
}

// Hold exactly one steer key for the signed angle difference, releasing
// the other — never both at once. A dead zone of ~0.12 rad keeps the car
// from weaving on a straight road.
function steerToward(keys, diff) {
  if (diff > 0.12) { keys.hold('KeyD'); keys.release('KeyA'); }
  else if (diff < -0.12) { keys.hold('KeyA'); keys.release('KeyD'); }
  else { keys.release('KeyA'); keys.release('KeyD'); }
}

// Drive toward a point. Returns true when the autopilot drove this frame
// (so the caller must skip manual driving and set the flag).
// opts.ram: a ramming run — hold full throttle straight at the target
// and never brake for arrival. A ram only registers above 120 u/s, and
// the close-in brake (<= 60 within 140) made m2 hits impossible: the
// car always arrived at the courier too slow to count.
function driveToward(G, state, target, cruise, opts) {
  const ram = !!(opts && opts.ram);
  const p = playerPos(G);
  const vehicle = playerVehicle(G);
  const heading = headingOf(vehicle || G.player);
  const speed = speedOf(vehicle || G.player);
  const keys = state.keys;

  // Route handling: recompute when the target moved, or when we ran out.
  // Escape mode (B9 Fase 3 watchdog): after 10s with no position
  // progress the normal plan has already failed, so drive straight at
  // the target — no router, no close-in brake — for a few seconds.
  const escaping = (state.escapeUntil || 0) > (state.now || 0);
  const targetMoved = !state.routeTarget
    || dist(target.x, target.y, state.routeTarget.x, state.routeTarget.y) > 120;
  if (escaping) {
    state.route = [{ x: target.x, y: target.y }];
    state.routeTarget = { x: target.x, y: target.y };
  } else if (targetMoved || state.route.length === 0) {
    state.route = computeRoute(G, p, target);
    state.routeTarget = { x: target.x, y: target.y };
  }

  // Drop reached waypoints.
  while (state.route.length > 0) {
    const wp = state.route[0];
    const radius = state.route.length === 1 ? FINAL_RADIUS : WAYPOINT_RADIUS;
    if (dist(p.x, p.y, wp.x, wp.y) < radius) state.route.shift();
    else break;
  }
  const waypoint = state.route[0] || target;
  const desired = Math.atan2(waypoint.y - p.y, waypoint.x - p.x);
  const diff = angleDiff(desired, heading);
  const distance = dist(p.x, p.y, target.x, target.y);

  // A turn sharper than ~52 degrees: stop fully, rotate in place, then go
  // straight. A moving turning circle is wider than the 64-wide road.
  // steerToward holds exactly ONE steer key: a steer key left held from
  // walking (or from a previous turn the other way) used to stay down
  // alongside the new one, A and D cancelled to steer 0, the car never
  // turned, and it crawled straight into the nearest wall forever.
  if (Math.abs(diff) > 0.9 && speed < 140) {
    keys.release('KeyW');
    keys.release('KeyS');
    steerToward(keys, diff);
    // Crawl forward while rotating so the car keeps a little authority.
    if (speed < 25) keys.hold('KeyW');
    state.dbgDrive = speed < 25 ? 'rotate-creep' : 'rotate';
    return true;
  }

  // Steering follows the sign of the angle difference.
  steerToward(keys, diff);

  // Brake ahead of a sharp turn, otherwise throttle toward cruise speed.
  // The old check only braked when already facing the turn (|diff| >
  // 0.55) at speed > 180, and never looked at the turn AFTER the current
  // waypoint. A car arriving at a 90-degree junction at ~178 u/s faced
  // the turn too late, in the dead zone where it was too fast for the
  // stop-and-rotate branch (> 140) but under the brake threshold, so it
  // held full throttle through the turn, overshot the junction north
  // into the building, wedged, and the stuck-handler recompute sent it
  // back west to retry the same trap forever. Brake early for a sharp
  // turn AT the waypoint (incoming leg vs outgoing leg), and brake for
  // any sharp facing turn above 120 so speed is under 140 when the
  // rotate branch takes over.
  const nextWp = state.route[1] || target;
  const inAngle = Math.atan2(waypoint.y - p.y, waypoint.x - p.x);
  const outAngle = Math.atan2(nextWp.y - waypoint.y, nextWp.x - waypoint.x);
  const turnAtWp = Math.abs(angleDiff(outAngle, inAngle));
  const wpDist = dist(p.x, p.y, waypoint.x, waypoint.y);
  const needBrake = ram ? false : ((Math.abs(diff) > 0.55 && speed > 120)
    || (turnAtWp > 0.9 && wpDist < 260 && speed > 60));
  // Close-in brake is for ARRIVAL AT SPEED. It must never park a
  // stationary car whose next waypoint is still far away: probe #1
  // froze 142s in recovery at (2096,1434) because the final target
  // was 34 units away (closeIn fired, throttle released at speed 0)
  // while the first waypoint sat 109 units away behind a 42-unit
  // radius — a deadlock no route clear can break, since the same
  // target recomputes the same route. Below 60 u/s the car throttles
  // toward the waypoint instead; above 60 it still brakes to arrive.
  // Escape mode never brakes for arrival at all.
  const closeIn = !ram && !escaping && distance < 140 && speed > 60;
  if (needBrake || closeIn) {
    keys.release('KeyW');
    if (speed > 60) keys.hold('KeyS');
    else keys.release('KeyS');
    state.dbgDrive = 'brake';
  } else if (speed < cruise) {
    keys.hold('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'throttle';
  } else {
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'coast';
  }
  return true;
}

// The courier: first the mission def's own car fields, then the live
// courier on the exposed missions state (G.missions.courier).
function readCourier(G, mission) {
  const fromDef = mission && (mission.courier || mission.targetVehicle || mission.targetCar);
  if (fromDef) return fromDef;
  return (G && G.missions && G.missions.courier) || null;
}

// --- Chase driving (m2): intercept, don't tail-chase. ---------------------
//
// What the 300-second probe proved about the old chase: the player
// averaged 79 u/s, was under 60 u/s in 208 of 298 samples, never got
// closer than 125 units, and the courier lapped between far corners
// while the player oscillated around (2100,1400) and (1000,1400).
// Three separate traps fed that:
//
// 1. The road route was rebuilt whenever the courier moved 120 units —
//    about every 0.3s at 380 u/s — and the router's first waypoint is
//    the nearest junction, which mid-leg is often the junction the car
//    just left, i.e. BEHIND it. Aiming behind the car triggers the
//    stop-and-rotate branch, so the car spent the chase stopping and
//    turning in place instead of driving.
// 2. Tail-chasing a target that is faster through every turn cannot
//    work with a 420-top car against a 380 cruise: the courier turns
//    at full speed and the player must slow for the same junction.
// 3. The courier's route reverses at far corners, so a tail-chaser
//    that is a straight behind suddenly faces a target coming back
//    past it, and must U-turn from a standstill.
//
// The fix has three parts. First, the ambush: read the courier's own
// route (it is stable for a whole leg — its destination only changes
// when the leg ends) and pick a junction ahead on it that the player
// can reach about when the courier gets there; drive to that fixed
// point and meet the courier there instead of following its tail.
// Second, the road route to that fixed point is cached and rebuilt
// only when the ambush moved a long way or the cache is old. Third,
// the driving itself never stops to rotate above 50 u/s and never
// brakes to a stop for a turn — it brakes only to a cap speed, and
// inside 200 units it steers straight at the courier's predicted
// position with the throttle flat, because a ram only counts above
// 120 u/s and any brake there throws the hit away.

function chaseReset(state) {
  // Fresh ambush cache: the old intercept belongs to the old courier leg.
  const fresh = {
    chaseRoute: [],
    chaseRouteDest: null,
    chaseRouteAt: 0,
    chaseRouteFrom: null,
    chaseRoutePrev: null,
    chaseIntercept: null,
    chaseInterceptAt: 0,
    chaseStartAt: 0,
    chaseKey: '',
  };
  Object.assign(state, fresh);
}

// Where the courier will be when we could reach it: lead by the
// closing time, clamped so a slow car does not aim absurdly far ahead.
function leadPoint(courier, courierPos, playerPos, playerTop) {
  const speed = speedOf(courier);
  const heading = headingOf(courier);
  const vx = Math.cos(heading) * speed;
  const vy = Math.sin(heading) * speed;
  const d = dist(playerPos.x, playerPos.y, courierPos.x, courierPos.y);
  const closing = Math.max(60, playerTop - speed);
  const lead = clamp(d / closing, 0.4, 2.5);
  return {
    x: clamp(courierPos.x + vx * lead, 20, 3180),
    y: clamp(courierPos.y + vy * lead, 20, 3180),
  };
}

// NOTE: the near-junction intercept (pickIntercept, B11) and the
// fast chase driver (driveChaseFast) live just above driveChase; the
// block-reverse recovery (recoverToRoad) is gone — the v12 recovery
// drives back to the road with the m1 driver instead of reversing
// in the block.

// Is the point 55 units ahead of the car open ground? The m2 start
// often leaves the car off-road inside a block, and creeping forward
// while rotating grinds it against the nearest building. Ask the world
// when it can answer; without a query, assume open.
function noseClear(G, p, heading) {
  const world = G.world || {};
  const ahead = { x: p.x + Math.cos(heading) * 55, y: p.y + Math.sin(heading) * 55 };
  const queries = [
    () => world.pointInBuilding(ahead.x, ahead.y, 0),
    () => world.isBlocked(ahead.x, ahead.y),
    () => world.isSolid(ahead.x, ahead.y),
  ];
  for (const q of queries) {
    try {
      const blocked = q();
      if (typeof blocked === 'boolean') return !blocked;
    } catch (e) { /* fall through to the next query shape */ }
  }
  return true;
}

// Steer toward an aim point and work the throttle. Direct mode (closing
// on the courier) never brakes. Road mode eases off only to a cap speed
// ahead of a sharp junction turn — a cap, not a stop — and rotates in
// place only when nearly stopped: at speed the radius steering turns
// the car, and every full stop hands the courier another straight.
function steerAndThrottle(G, state, aim, cruise, speed, heading, opts) {
  const keys = state.keys;
  const p = playerPos(G);
  const desired = Math.atan2(aim.y - p.y, aim.x - p.x);
  const diff = angleDiff(desired, heading);
  const faceOnly = !!(opts && opts.face);
  const direct = !!(opts && opts.direct);

  // Facing the wrong way at speed: slow down in a straight line
  // first. Steering while braking at 300+ arcs the car off the road
  // into a block. No steering while the speed is high; once slow,
  // the rotate-in-place branch below takes over.
  // BRAKING IS DRAG-ONLY on this car: player.js overwrites car.brake
  // (the 520 brake stat) with a boolean every frame, so
  // effectiveBrake() returns 0/1 and the S key at speed does NOT
  // slow the car at all — it coasts (probe #1: v=420 held for 2s
  // under brake-cap, v=69 constant for 4s under brake-straight).
  // The only decel is the 260/s^2 drag with NO keys held, so a
  // slow-down releases everything instead of holding S.
  if (Math.abs(diff) > 1.5 && Math.abs(speed) > 60) {
    keys.release('KeyA');
    keys.release('KeyD');
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'brake-straight';
    return;
  }

  if (Math.abs(diff) > 1.2 && Math.abs(speed) < 50) {
    keys.release('KeyW');
    keys.release('KeyS');
    steerToward(keys, diff);
    // Creep only into open space. When the nose is blocked, back out
    // instead: reversing while steering turns the nose the same way,
    // so the car backs out of the block while still rotating toward
    // the target, instead of grinding against the wall forever.
    // Face mode (parked at an ambush corner) never creeps: the car
    // must stay on the corner, nose turning, wheels still.
    if (Math.abs(speed) < 25 && !faceOnly) {
      if (noseClear(G, p, heading)) keys.hold('KeyW');
      else keys.hold('KeyS');
    }
    state.dbgDrive = faceOnly ? 'face-rotate' : 'rotate';
    return;
  }
  // Face mode: rotate in place toward the aim, never drive. The
  // rotate branch above handles the turn; once roughly facing, hold
  // still — the car is parked where the courier is coming.
  if (faceOnly) {
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'face-hold';
    return;
  }
  steerToward(keys, diff);

  if (direct) {
    keys.hold('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'direct';
    return;
  }
  // Road mode: brake only to a cap speed ahead of a sharp turn.
  // Speed here is a magnitude: a reversing car must not read as slow.
  const mag = Math.abs(speed);
  let cap = cruise;
  const route = (opts && opts.route) || [];
  if (route.length > 1) {
    const wp = route[0];
    const next = route[1];
    const inAngle = Math.atan2(wp.y - p.y, wp.x - p.x);
    const outAngle = Math.atan2(next.y - wp.y, next.x - wp.x);
    const turn = Math.abs(angleDiff(outAngle, inAngle));
    const wpDist = (opts && opts.waypointDist) || 0;
    // Brake early and hard for sharp junction turns: the turning
    // radius at 200 u/s is ~91 units, wider than the 64-wide road,
    // so the car overshoots the junction, grinds a building face and
    // drops to ~7 u/s. At 110 the radius is ~46 and the car turns
    // inside the junction instead of past it; the courier is capped
    // the same way, so the chase loses seconds at a turn rather than ten.
    if (turn > 1.5 && wpDist < 400) cap = Math.min(cap, 110);
    else if (turn > 0.9 && wpDist < 350) cap = Math.min(cap, 180);
  }
  if (mag > cap) {
    // Drag-brake: release everything (see the brake-straight guard
    // above — holding S coasts instead of slowing this car). Drag
    // is 260/s^2, so 420 -> 180 needs ~280 units and the caps above
    // engage 350-400 out; the feedback loop coasts above the cap
    // and throttles below it, so the car arrives at the turn near
    // the cap instead of sailing past it at 420.
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'brake-cap';
  } else {
    keys.hold('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'throttle';
  }
}

// The junction on the courier's own route nearest the player: the
// place to join the route when no ambush is reachable in time. Every
// point still on the courier's route lies ahead of it, so the join
// point is always on the asphalt the courier is about to use.
function nearestRouteJunction(courier, playerPos) {
  const route = courier && Array.isArray(courier.route) ? courier.route : null;
  if (!route || route.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const wp of route) {
    const point = posOf(wp);
    if (!point) continue;
    const d = dist(playerPos.x, playerPos.y, point.x, point.y);
    if (d >= bestDist) continue;
    bestDist = d;
    best = point;
  }
  return best ? { x: best.x, y: best.y } : null;
}

// Is the straight segment from A to B drivable, or does it cut through
// a building block? Sample the segment every ~50 units and ask the world
// whether each sample sits inside a building. A chase that steers
// straight at the courier across a block ends pressed against a wall —
// the two passing probes and the failed arc all showed the same thing:
// the car leaves the road at full speed, slides along the world edge,
// and never gets back. Direct pursuit is only safe when the line is open.
function segmentBlocked(G, from, to) {
  const world = G.world || {};
  if (typeof world.pointInBuilding !== 'function') return false;
  const steps = Math.max(1, Math.ceil(dist(from.x, from.y, to.x, to.y) / 50));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    try {
      if (world.pointInBuilding(x, y, 20)) return true;
    } catch { return false; }
  }
  return false;
}

// Brake in a straight line: no steering, no throttle, brake key only.
// Steering while braking at speed arcs the car off the road into a
// block; the turn comes after the car is slow, from the rotate-in-place
// branch. Returns true (the autopilot drove this frame).
function brakeStraight(G, state) {
  const keys = state.keys;
  keys.release('KeyA');
  keys.release('KeyD');
  keys.release('KeyW');
  keys.hold('KeyS');
  state.dbgDrive = 'brake-straight';
  return true;
}

// The nearest on-road point to the player, or null when the world
// cannot answer. The road point is always legal asphalt, never outside
// the world edge.
function nearestRoadPointOf(G, p) {
  const world = G.world || {};
  const nearest = world.nearestRoadPoint || world.nearestRoad || world.snapToRoad;
  if (typeof nearest !== 'function') return null;
  try {
    const raw = nearest.call(world, p.x, p.y);
    return posOf(raw) || (Array.isArray(raw) ? { x: raw[0], y: raw[1] } : null);
  } catch { return null; }
}

// --- Near-junction intercept (B11). ---------------------------------------
//
// The B10 probe proved the far-corner ambush cannot win: the courier
// runs one leg in ~13s while the player needs 30-60s to the same far
// corner, so the player always arrives after the courier turned away.
// The fix races the courier to the NEAREST junction on its own route
// where the player can still get there first:
//
//   playerETA  = 1.3 x straight-line distance / 300 u/s (road distance
//                is ~1.3x the straight line; 300 u/s is the effective
//                average with junction turns, not the 520 top speed)
//   courierETA = road distance along the courier's own route /
//                (courier.cruise x 1.15) — the cruise is read live, so
//                each ram hit (cruise x 0.55) opens more junctions
//
// Ambush = the junction nearest the player with playerETA + 1s <
// courierETA. Fallback when none qualifies: race the nearest junction
// by playerETA anyway — a race the player might win beats a far
// corner it cannot. The car parks 90 units BEFORE the junction on
// the arrival leg, nose toward the incoming courier, for a head-on
// lunge on a straight road instead of a turn at the junction itself.
//
// The pick is cached 2s and recomputed when the courier's destination,
// its next route waypoint, or its hit count changes — never because
// the courier merely moved along its leg.

// Road distance along the courier's route from its current position
// to the route waypoint at index `upto` (inclusive).
function courierRoadDist(courier, courierPos, upto) {
  const route = courier.route;
  let road = dist(courierPos.x, courierPos.y, route[0].x, route[0].y);
  for (let j = 0; j < upto; j += 1) {
    road += dist(route[j].x, route[j].y, route[j + 1].x, route[j + 1].y);
  }
  return road;
}

function pickIntercept(G, state, courier, courierPos, p, playerTop) {
  const route = Array.isArray(courier.route) ? courier.route : [];
  const destKey = `${courier.destX || 0},${courier.destY || 0}`
    + `#${courier.hits || 0}`
    + `#${route.length > 0 ? `${route[0].x},${route[0].y}` : 'none'}`;
  if (state.chaseIntercept && state.chaseIntercept.key === destKey
    && (state.now - (state.chaseInterceptAt || 0)) < 2) {
    return state.chaseIntercept;
  }
  // No route (between legs): aim at where the courier will be.
  if (route.length === 0) {
    const park = leadPoint(courier, courierPos, p, playerTop);
    const picked = { junction: null, park, approach: { x: courierPos.x, y: courierPos.y }, key: destKey };
    state.chaseIntercept = picked;
    state.chaseInterceptAt = state.now;
    return picked;
  }
  const cruise = (typeof courier.cruise === 'number' && courier.cruise > 0) ? courier.cruise : 380;
  const courierSpeed = cruise * 1.15;
  let best = null; // nearest winnable junction, by player ETA
  let bestPlayerEta = Infinity;
  let nearest = null; // fallback: nearest junction by player ETA
  let nearestPlayerEta = Infinity;
  for (let i = 0; i < route.length; i += 1) {
    const junction = posOf(route[i]);
    if (!junction) continue;
    const playerEta = (1.3 * dist(p.x, p.y, junction.x, junction.y)) / 300;
    if (playerEta < nearestPlayerEta) {
      nearestPlayerEta = playerEta;
      nearest = { junction, playerEta, index: i };
    }
    const road = courierRoadDist(courier, courierPos, i);
    const courierEta = road / courierSpeed;
    if (playerEta + 1 < courierEta && playerEta < bestPlayerEta) {
      bestPlayerEta = playerEta;
      best = { junction, playerEta, courierEta, index: i };
    }
  }
  const chosen = best || nearest;
  if (!chosen) return null;
  const junction = chosen.junction;
  // Park 90 units before the junction on the arrival leg. The leg
  // runs from the previous route waypoint (or the courier itself for
  // the first waypoint) into the junction; on a short leg park at
  // mid-leg so the car never sits past the leg start.
  const prev = chosen.index === 0 ? courierPos : posOf(route[chosen.index - 1]);
  let park = { x: junction.x, y: junction.y };
  let approach = prev || { x: courierPos.x, y: courierPos.y };
  if (prev) {
    const legLen = dist(prev.x, prev.y, junction.x, junction.y);
    if (legLen > 1) {
      const along = Math.max(legLen * 0.5, legLen - 90);
      const ux = (junction.x - prev.x) / legLen;
      const uy = (junction.y - prev.y) / legLen;
      park = { x: prev.x + ux * along, y: prev.y + uy * along };
    }
  }
  const picked = { junction, park, approach, key: destKey };
  state.chaseIntercept = picked;
  state.chaseInterceptAt = state.now;
  return picked;
}

// Fast chase driver: pure pursuit along the cached road route to a
// fixed park point. It never stops to rotate: a lookahead point
// 90-220 units ahead on the route (further the faster the car) keeps
// the nose turning through junctions while the road-mode caps inside
// steerAndThrottle (180 for a 90-degree turn, 110 for a hairpin)
// bleed speed to a radius the 64-wide road can hold — the car turns
// while moving instead of braking to a standstill at every junction.
//
// Waypoints drop only when proven passed: within the 42-unit radius,
// or past the waypoint along its leg (on the leg line, heading
// roughly along it, and still near it) — never merely because the
// car is close to the NEXT waypoint, which is what used to cut the
// diagonal across a building block.
function driveChaseFast(G, state, target) {
  const p = playerPos(G);
  const vehicle = playerVehicle(G);
  const heading = headingOf(vehicle || G.player);
  const speed = speedOf(vehicle || G.player);
  const playerTop = Math.max(200, topSpeedOf(vehicle));

  // Road route to the fixed park point, cached: rebuilt only when the
  // park point moved or the route ran out — never because the target
  // (the courier) moved, since the park point does not move with it.
  const targetMoved = !state.chaseRouteDest
    || dist(target.x, target.y, state.chaseRouteDest.x, state.chaseRouteDest.y) > 60;
  if (targetMoved || state.chaseRoute.length === 0) {
    state.chaseRoute = computeRoute(G, p, target);
    state.chaseRouteDest = { x: target.x, y: target.y };
    state.chaseRouteAt = state.now;
    state.chaseRouteFrom = { x: p.x, y: p.y };
    state.chaseRoutePrev = { x: p.x, y: p.y };
  }
  const route = state.chaseRoute;

  // Drop waypoints proven passed.
  while (route.length > 0) {
    const wp = route[0];
    if (dist(p.x, p.y, wp.x, wp.y) < WAYPOINT_RADIUS) {
      state.chaseRoutePrev = { x: wp.x, y: wp.y };
      route.shift();
      continue;
    }
    const prev = state.chaseRoutePrev || state.chaseRouteFrom || p;
    const legDx = wp.x - prev.x;
    const legDy = wp.y - prev.y;
    const legLen = Math.hypot(legDx, legDy);
    if (legLen < 1) {
      state.chaseRoutePrev = { x: wp.x, y: wp.y };
      route.shift();
      continue;
    }
    const ux = legDx / legLen;
    const uy = legDy / legLen;
    const relX = p.x - wp.x;
    const relY = p.y - wp.y;
    const along = relX * ux + relY * uy;
    const lateral = Math.abs(relX * uy - relY * ux);
    const legAngle = Math.atan2(legDy, legDx);
    const passed = along > 10 && lateral < 120
      && Math.abs(angleDiff(heading, legAngle)) < 1.0
      && dist(p.x, p.y, wp.x, wp.y) < 250;
    if (!passed) break;
    state.chaseRoutePrev = { x: wp.x, y: wp.y };
    route.shift();
  }

  // Pure-pursuit lookahead along the route polyline: the aim point
  // sits `look` units ahead of the car measured along the road, so
  // the car steers into the turn before it arrives instead of at it.
  const look = clamp(Math.abs(speed) * 0.5, 90, 220);
  let aim = { x: target.x, y: target.y };
  if (route.length > 0) {
    let acc = dist(p.x, p.y, route[0].x, route[0].y);
    if (acc >= look) {
      aim = { x: route[0].x, y: route[0].y };
    } else {
      for (let i = 0; i < route.length - 1; i += 1) {
        const seg = dist(route[i].x, route[i].y, route[i + 1].x, route[i + 1].y);
        if (acc + seg >= look) {
          const t = seg > 0 ? (look - acc) / seg : 0;
          aim = {
            x: route[i].x + (route[i + 1].x - route[i].x) * t,
            y: route[i].y + (route[i + 1].y - route[i].y) * t,
          };
          break;
        }
        acc += seg;
      }
      if (aim.x === target.x && aim.y === target.y && acc < look) {
        aim = { x: route[route.length - 1].x, y: route[route.length - 1].y };
      }
    }
  }
  const wpDist = route.length > 0 ? dist(p.x, p.y, route[0].x, route[0].y) : 0;
  steerAndThrottle(G, state, aim, playerTop, speed, heading,
    { route, waypointDist: wpDist });
  return true;
}

function driveChase(G, state, courier, courierPos) {
  const p = playerPos(G);
  const vehicle = playerVehicle(G);
  const heading = headingOf(vehicle || G.player);
  const speed = speedOf(vehicle || G.player);
  const playerTop = Math.max(200, topSpeedOf(vehicle));
  const now = state.now;
  const dCourier = dist(p.x, p.y, courierPos.x, courierPos.y);
  // Escape mode (B9 Fase 3 watchdog): set by update() after 10s with
  // no position progress. A waiting car is not a stuck car, but no
  // wait is unbounded — escape skips the face-hold below and drives
  // straight at the corner instead.
  const escaping = (state.escapeUntil || 0) > now;

  // Off-road recovery first, and it is NOT optional any more. The
  // failed arc run proved why: the car left the road at 420, slid
  // along the west wall and then the south wall for 600 seconds, and
  // the old gate (skip recovery while the courier is within 250) kept
  // it there — the courier drives one road over, about 180 units away
  // across a building row, so the gate never opened and the direct
  // branches kept aiming at a target no road can reach. A ram cannot
  // happen through a building, so recovery only yields when the
  // courier is inside genuine ram range (<90). Keep a breadcrumb trail
  // of on-road points (one every half second, eight deep): the exit
  // the car actually used is open by construction, so it wins while
  // it is fresh (within 400); further back than that, or with no
  // trail at all, the nearest road point is the target. Drive there
  // with the m1 road driver at cruise 120 — slow enough that its
  // stop-and-rotate branch can engage — instead of reversing blindly
  // along a wall, which only grinds the car further down the edge.
  {
    const world = G.world || {};
    if (typeof world.isOnRoad === 'function') {
      let onRoad = true;
      try { onRoad = world.isOnRoad(p.x, p.y); } catch { onRoad = true; }
      if (onRoad) {
        if (!state.roadTrail) state.roadTrail = [];
        const last = state.roadTrail[state.roadTrail.length - 1];
        if (!last || now - (last.t || 0) >= 0.5) {
          state.roadTrail.push({ x: p.x, y: p.y, t: now });
          if (state.roadTrail.length > 8) state.roadTrail.shift();
        }
      } else if (dCourier > 90) {
        const trail = state.roadTrail || [];
        const exit = trail.length > 0 ? trail[trail.length - 1] : null;
        let target = null;
        if (exit && dist(p.x, p.y, exit.x, exit.y) > 40 && dist(p.x, p.y, exit.x, exit.y) <= 400) {
          target = exit;
        } else {
          target = nearestRoadPointOf(G, p);
        }
        if (target) { mark(state, 'recovery', null); return driveToward(G, state, target, 120); }
      }
    }
  }

  // Opening sprint: in the first seconds the courier is still
  // accelerating from a standstill (it spawns 500 away), so the player
  // is genuinely faster and the meeting is right there. Drive straight
  // at it — the intercept logic would send the car the other way
  // toward a far junction while the free hit drives past (the probe
  // watched the player turn west to an ambush while the courier, at
  // 160 u/s and 500 away, came east through the player's position).
  if (now - state.chaseStartAt < 5 && dCourier < 700) {
    const aimOpen = leadPoint(courier, courierPos, p, playerTop);
    // Sprint only down an open line: a straight charge across a block
    // corner is what put the car into the west wall in the arc run.
    // When the line is blocked, fall through to the road-route ambush.
    if (!segmentBlocked(G, p, aimOpen)) {
      mark(state, 'sprint', null);
      steerAndThrottle(G, state, aimOpen, playerTop, speed, heading, { direct: true });
      return true;
    }
  }

  // A courier slowed by two or more hits crawls (under ~150 u/s): no
  // ambush is needed — the player is many times faster, so steer
  // straight at it and drive it down. But only once it is close (under
  // 400 units): at long range the straight line to it cuts diagonally
  // across building blocks, and the car ends up wedged off-road
  // instead of driving the road route to it. The intercept machinery
  // only earns its keep while the courier is fast; against a crawling
  // courier at long range the road route still catches it easily.
  if (speedOf(courier) < 150 && dCourier < 400) {
    const aimSlow = leadPoint(courier, courierPos, p, playerTop);
    // Same open-line rule as the sprint: a crawling courier one road
    // over is not worth a charge through a building row.
    if (!segmentBlocked(G, p, aimSlow)) {
      mark(state, 'slow-direct', null);
      steerAndThrottle(G, state, aimSlow, playerTop, speed, heading, { direct: true });
      return true;
    }
  }

  // Near-junction intercept (B11): race the courier to the nearest
  // junction on its own route where the player can still arrive
  // first, and park 90 units before it on the arrival leg — a
  // head-on meeting on a straight road, not a turn at a far corner
  // the courier left 30 seconds ago. The pick is cached (see
  // pickIntercept); the road route to the fixed park point is
  // cached inside driveChaseFast.
  const intercept = pickIntercept(G, state, courier, courierPos, p, playerTop)
    || { junction: null, park: leadPoint(courier, courierPos, p, playerTop), approach: courierPos };
  const park = intercept.park;
  const dPark = dist(p.x, p.y, park.x, park.y);

  // Lunge: parked at the ambush point with the courier closing, or
  // the courier close and roughly ahead, or — in escape mode — the
  // courier anywhere within 800: the watchdog only fires after the
  // plan has already failed, so a stalled wait is worse than a
  // long direct charge. Steer straight at where it will be, foot
  // flat. The courier slows to ~170 for the junction turn, so a
  // parked car that lunges as it arrives meets it head-on — and
  // lunging from 650 instead of 500 buys the closing distance the
  // old range threw away.
  const aimClose = leadPoint(courier, courierPos, p, playerTop);
  const diffClose = angleDiff(Math.atan2(aimClose.y - p.y, aimClose.x - p.x), heading);
  if (((dPark < 90 && dCourier < 650)
    || (dCourier < 200 && Math.abs(diffClose) < 1.2)
    || (escaping && dCourier < 800))
    && !segmentBlocked(G, p, aimClose)) {
    mark(state, 'lunge', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { direct: true });
    return true;
  }

  // Tail: the courier is near, roughly ahead, and the line is open —
  // no ambush is needed, chase it straight down. This is the branch
  // the old chase never had: a courier one road over at 500 units
  // with the nose already on it used to send the car the other way
  // toward a far corner instead of down the open road at it.
  if (dCourier < 600 && Math.abs(diffClose) < 0.9 && !segmentBlocked(G, p, aimClose)) {
    mark(state, 'tail', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { direct: true });
    return true;
  }

  // Parked at the ambush point with the courier still far off: face
  // its approach so the lunge starts with the nose already right.
  // Rotate in place, never drive — driving now would leave the
  // ambush point. Escape mode skips the wait: the watchdog only
  // fires after 30s of no progress in face (a courier leg is
  // 15-20s), so by then the wait itself is the problem and the car
  // drives at the ambush point instead.
  if (dPark < 90 && dCourier >= 650 && !escaping) {
    mark(state, 'face', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { face: true });
    return true;
  }

  // Otherwise drive the road to the ambush point with the fast chase
  // driver: pure pursuit with a speed-scaled lookahead and capped
  // turn speeds, turning while moving instead of stopping to rotate
  // at every junction the way the m1 driver does.
  mark(state, 'intercept-drive', null);
  return driveChaseFast(G, state, park);
}

// Walk toward a point on foot, following the road graph to the nearest
// road point first and the last leg on foot. The walk target is memoized:
// it is only recomputed when the target moves more than 120 units.
function walkToward(G, state, target) {
  const p = playerPos(G);
  const keys = state.keys;

  if (!state.walkTargetPos
    || dist(target.x, target.y, state.walkTargetPos.x, state.walkTargetPos.y) > WALK_RETARGET) {
    const world = G.world || {};
    const nearest = world.nearestRoadPoint || world.nearestRoad || world.snapToRoad;
    let roadPoint = null;
    if (typeof nearest === 'function') {
      try {
        const raw = nearest.call(world, p.x, p.y);
        roadPoint = posOf(raw) || (Array.isArray(raw) ? { x: raw[0], y: raw[1] } : null);
      } catch {
        roadPoint = null;
      }
    }
    state.walkTarget = roadPoint ? { x: roadPoint.x, y: roadPoint.y, then: { x: target.x, y: target.y } } : { x: target.x, y: target.y };
    state.walkTargetPos = { x: target.x, y: target.y };
  }

  let leg = state.walkTarget;
  if (leg && leg.then && dist(p.x, p.y, leg.x, leg.y) < 50) leg = leg.then;
  const goal = leg ? { x: leg.x, y: leg.y } : { x: target.x, y: target.y };
  const dx = goal.x - p.x;
  const dy = goal.y - p.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 24) {
    keys.release('KeyW'); keys.release('KeyA'); keys.release('KeyS'); keys.release('KeyD');
    keys.release('ShiftLeft');
    return dist(p.x, p.y, target.x, target.y) < 40;
  }
  // Move along the dominant axis; diagonals come from holding two keys.
  if (dx > 12) keys.hold('KeyD'); else keys.release('KeyD');
  if (dx < -12) keys.hold('KeyA'); else keys.release('KeyA');
  if (dy > 12) keys.hold('KeyS'); else keys.release('KeyS');
  if (dy < -12) keys.hold('KeyW'); else keys.release('KeyW');
  if (distance > 220) keys.hold('ShiftLeft'); else keys.release('ShiftLeft');
  return false;
}

// Find the nearest parked car that is much faster than the current one.
// Returns null when no swap is worth the heat of a theft.
function findSwapCandidate(G, chase) {
  const p = playerPos(G);
  const current = playerVehicle(G);
  const currentTop = current ? topSpeedOf(current) : 0;
  const threshold = chase ? SWAP_CHASE_SPEED : SWAP_GO_TO_SPEED;
  if (currentTop >= threshold) return null;
  const range = chase ? SWAP_CHASE_RANGE : SWAP_GO_TO_RANGE;
  let best = null;
  let bestTop = currentTop;
  for (const vehicle of allVehicles(G)) {
    if (!vehicle || vehicle === current) continue;
    if (vehicle.occupied === true || vehicle.driver) continue;
    if (vehicle.parked !== true && vehicle.parked !== undefined && vehicle.stolen === true) continue;
    const top = topSpeedOf(vehicle);
    if (top <= Math.max(bestTop, currentTop) + 30) continue;
    const pos = posOf(vehicle);
    if (!pos) continue;
    if (dist(p.x, p.y, pos.x, pos.y) > range) continue;
    best = vehicle;
    bestTop = top;
  }
  return best;
}

function nearestEnemy(G, mission) {
  const p = playerPos(G);
  const enemies = missionEnemies(G, mission);
  let best = null;
  let bestDist = Infinity;
  for (const enemy of enemies) {
    const pos = posOf(enemy);
    if (!pos) continue;
    const d = dist(p.x, p.y, pos.x, pos.y);
    if (d < bestDist) { bestDist = d; best = enemy; }
  }
  return best ? { enemy: best, pos: posOf(best), distance: bestDist } : null;
}

function nearestPickup(G, list, p) {
  let best = null;
  let bestDist = Infinity;
  for (const pickup of list || []) {
    const pos = posOf(pickup);
    if (!pos) continue;
    const d = dist(p.x, p.y, pos.x, pos.y);
    if (d < bestDist) { bestDist = d; best = pickup; }
  }
  return best ? { pickup: best, pos: posOf(best), distance: bestDist } : null;
}

// Buy the cheapest available garage upgrade through whatever interface the
// garage exposes (a method, a DOM menu, or a purchase list on G).
function tryGaragePurchase(G) {
  const garage = G.garage || {};
  // Preferred: the garage exposes a buy function.
  if (typeof garage.buyCheapest === 'function') {
    try { return garage.buyCheapest() === true || garage.buyCheapest() !== false; } catch { return false; }
  }
  if (typeof garage.buy === 'function') {
    try {
      const upgrades = garage.upgrades || garage.items || [];
      if (Array.isArray(upgrades) && upgrades.length > 0) {
        let cheapest = null;
        for (const up of upgrades) {
          if (up && (up.owned || up.level >= (up.maxLevel || 99))) continue;
          const price = typeof up.price === 'number' ? up.price : Infinity;
          if (!cheapest || price < cheapest.price) cheapest = { up, price };
        }
        if (cheapest) { garage.buy(cheapest.up.id || cheapest.up.name || cheapest.up); return true; }
      }
    } catch { return false; }
  }
  // DOM fallback: click the cheapest enabled buy button in the garage menu.
  try {
    if (typeof document !== 'undefined') {
      const menu = document.getElementById('garage-menu') || document.getElementById('garage-overlay');
      if (menu) {
        const buttons = [...menu.querySelectorAll('button')].filter((b) => !b.disabled
          && /buy|beli|upgrade|engine|armor|tires|brakes|paint/i.test(b.textContent || ''));
        if (buttons.length > 0) {
          // Buttons are listed cheapest-first by the menu; take the first.
          buttons[0].click();
          return true;
        }
      }
    }
  } catch {
    // Best-effort.
  }
  return false;
}

function closeGarageMenu(G) {
  const garage = G.garage || {};
  if (typeof garage.close === 'function') {
    try { garage.close(); return; } catch { /* fall through */ }
  }
  if (typeof document !== 'undefined') {
    const btn = document.getElementById('garage-close') || document.querySelector('#garage-menu [data-close]');
    if (btn) { btn.click(); return; }
  }
  // Escape closes most overlays.
  if (G.autopilot) G.autopilot.keys.tap('Escape');
}

// ---------------------------------------------------------------------------
// B9 chase telemetry. mark() records which driveChase branch ran and
// what it did with the throttle; publishDebug() copies those plus the
// raw car / input / courier state into G.chaseDebug every frame, so a
// probe sampling once a second can name the exact branch of a freeze:
// the branch, the throttle/steer the car actually got, the keys the
// autopilot thinks it holds vs the keys the input module sees (a
// blur/desync leaves the autopilot holding keys the game never sees),
// the courier's destination, and the mission timer. All reads are
// defensive and the whole publish is wrapped, so telemetry can never
// break the autopilot.
// ---------------------------------------------------------------------------

function mark(state, branch, drive) {
  if (branch) { state.dbgBranch = branch; state.lastBranch = branch; }
  if (drive) state.dbgDrive = drive;
}

function publishDebug(G, state) {
  try {
    const p = playerPos(G);
    const vehicle = playerVehicle(G);
    const mission = currentMission(G);
    const courier = readCourier(G, mission);
    const cPos = courier ? posOf(courier) : null;
    const world = G.world || {};
    let onRoad = null;
    try { onRoad = typeof world.isOnRoad === 'function' ? !!world.isOnRoad(p.x, p.y) : null; } catch { onRoad = null; }
    const input = G.input || {};
    let inputKeys = [];
    try {
      if (input.keys instanceof Set) inputKeys = [...input.keys];
      else if (input.keys && typeof input.keys === 'object') {
        inputKeys = Object.keys(input.keys).filter((k) => input.keys[k]);
      }
    } catch { inputKeys = []; }
    const route0 = Array.isArray(state.route) && state.route.length > 0 ? state.route[0] : null;
    const corner = cPos && typeof courier.destX === 'number' && typeof courier.destY === 'number'
      ? { x: courier.destX, y: courier.destY } : null;
    const live = liveObjective(G);
    G.chaseDebug = {
      t: +state.now.toFixed(1),
      mode: state.mode || null,
      branch: state.dbgBranch || state.mode || null,
      drive: state.dbgDrive || null,
      gameState: G.state || null,
      enabled: !!G.autopilotEnabled,
      px: Math.round(p.x), py: Math.round(p.y),
      angle: +(headingOf(vehicle || G.player)).toFixed(2),
      speed: Math.round(speedOf(vehicle || G.player)),
      inCar: isDriving(G),
      carTop: vehicle ? topSpeedOf(vehicle) : null,
      carThrottle: vehicle ? (typeof vehicle.throttle === 'number' ? vehicle.throttle : null) : null,
      carSteer: vehicle ? (typeof vehicle.steer === 'number' ? vehicle.steer : null) : null,
      carBrake: vehicle ? !!vehicle.brake : null,
      carReverseTimer: vehicle ? +(vehicle.reverseTimer || 0).toFixed(2) : null,
      carStuckTimer: vehicle ? +(vehicle.stuckTimer || 0).toFixed(2) : null,
      heldKeys: state.keys ? [...state.keys.held] : [],
      inputKeys,
      mission: missionId(mission) || null,
      timeLeft: (G.missions && typeof G.missions.timeLeft === 'number') ? Math.round(G.missions.timeLeft) : null,
      hits: (G.missions && G.missions.progress && typeof G.missions.progress.hits === 'number') ? G.missions.progress.hits : null,
      dialogOpen: dialogOpen(G),
      onRoad,
      route0: route0 ? `${Math.round(route0.x)},${Math.round(route0.y)}` : null,
      routeLen: Array.isArray(state.route) ? state.route.length : null,
      routeTarget: state.routeTarget ? `${Math.round(state.routeTarget.x)},${Math.round(state.routeTarget.y)}` : null,
      dCourier: cPos ? Math.round(dist(p.x, p.y, cPos.x, cPos.y)) : null,
      dCorner: corner ? Math.round(dist(p.x, p.y, corner.x, corner.y)) : null,
      corner: corner ? `${Math.round(corner.x)},${Math.round(corner.y)}` : null,
      courier: cPos ? {
        x: Math.round(cPos.x), y: Math.round(cPos.y),
        speed: Math.round(speedOf(courier)), cruise: Math.round(courier.cruise || 0),
        dest: (typeof courier.destX === 'number') ? `${Math.round(courier.destX)},${Math.round(courier.destY)}` : null,
        routeLen: Array.isArray(courier.route) ? courier.route.length : null,
      } : null,
      stuckFor: +(state.now - (state.stuckSince || 0)).toFixed(1),
      escaping: (state.escapeUntil || 0) > (state.now || 0),
      noProgress: state.noProgressSince ? +(state.now - state.noProgressSince).toFixed(1) : 0,
      lastBranch: state.lastBranch || null,
      chaseStartAt: +(state.chaseStartAt || 0).toFixed(1),
      objective: live ? `${Math.round(live.x)},${Math.round(live.y)}` : null,
    };
  } catch {
    // Telemetry must never break the autopilot.
  }
}

// ---------------------------------------------------------------------------
// update(G, dt) — one frame of autopilot. Runs BEFORE the dialog branch so
// it can always press E to accept a mission, and before manual driving so
// the autopilotDrove flag is set in time.
// ---------------------------------------------------------------------------

export function update(G, dt) {
  const state = G.autopilot || init(G);
  state.now += dt || 1 / 60;
  const now = state.now;
  const keys = state.keys;
  keys.releaseTaps();

  // B9 telemetry: publish last frame's branch + the current raw state
  // before this frame's logic runs, then default the branch to the
  // current mode — the drive functions below overwrite it with the
  // exact branch when they run. Publishing first means the debug
  // object always reflects a completed frame, even when update()
  // returns early (dialog / disabled / game over).
  publishDebug(G, state);
  state.dbgBranch = state.mode;
  state.dbgDrive = 'none';

  // The flag starts cleared every frame; it is set again below only on
  // frames where the autopilot actually drives.
  G.autopilotDrove = false;
  G.autopilot_drove = false;

  if (!G.autopilotEnabled) return;

  const p = playerPos(G);
  const mission = currentMission(G);
  const id = missionId(mission);
  const driving = isDriving(G);

  // Track stuckness: if we have not moved in 4 seconds while trying to
  // reach something, clear the cached route, the ambush cache and the
  // walk target — a stale plan is what keeps the car grinding one wall.
  // B9 Fase 3 no-progress watchdog: the 4s clear alone cannot save a
  // car parked by its own brake logic — probe #1 froze 142s in
  // recovery at (2096,1434) while the 4s clear fired every cycle,
  // because the same target recomputes the same route. Ten seconds
  // with no position progress (30s in the deliberate face wait, whose
  // courier leg is 15-20s) forces escape mode: a fresh direct drive
  // at the target, no router, no close-in brake, for 5 seconds. It
  // re-fires every 10s/30s while still stuck, so the car can never
  // sit in one state without progress again.
  if (!state.lastPos || now - state.lastPosAt > 0.5) {
    const moved = !state.lastPos || dist(p.x, p.y, state.lastPos.x, state.lastPos.y) >= 6;
    if (moved) {
      state.noProgressSince = 0;
    } else if (!state.noProgressSince) {
      state.noProgressSince = now;
    }
    if (state.lastPos && !moved && now - state.stuckSince > 4) {
      state.route = [];
      chaseReset(state);
      state.walkTarget = null;
      state.walkTargetPos = null;
      state.stuckSince = now;
    }
    const waitLimit = state.lastBranch === 'face' ? 30 : 10;
    if (state.noProgressSince && now - state.noProgressSince > waitLimit) {
      state.escapeUntil = now + 5;
      state.route = [];
      state.routeTarget = null;
      chaseReset(state);
      state.walkTarget = null;
      state.walkTargetPos = null;
      state.noProgressSince = now;
    }
    if (moved) {
      state.stuckSince = now;
    }
    state.lastPos = { x: p.x, y: p.y };
    state.lastPosAt = now;
  }

  // --- Game over / title: retry or start. --------------------------------
  if (gameOverShown(G)) {
    setMode(G, 'retry');
    if (typeof document !== 'undefined') {
      const retry = document.getElementById('retry-btn');
      if (retry) { retry.click(); return; }
    }
    keys.tap('Enter');
    return;
  }
  if (titleShown(G)) {
    setMode(G, 'start');
    if (typeof document !== 'undefined') {
      const start = document.getElementById('new-game-btn') || document.getElementById('continue-btn');
      if (start) { start.click(); return; }
    }
    keys.tap('Enter');
    return;
  }

  // --- Mission failed: restart from stage 0. ------------------------------
  if (missionFailed(G, mission)) {
    setMode(G, 'restart');
    const missions = G.missions || {};
    if (typeof missions.restart === 'function') {
      try { missions.restart(); } catch { /* fall through to key press */ }
    } else if (typeof G.restartMission === 'function') {
      try { G.restartMission(); } catch { /* fall through */ }
    }
    keys.tap('Enter');
    return;
  }

  // --- Dialog accept runs BEFORE any car search (v4 lesson). --------------
  if (dialogOpen(G)) {
    setMode(G, 'dialog');
    // Stop the car sliding through the dialog: the m1 drive holds W
    // when the mission completes, and the old branch never released
    // it — the car coasted ~500 units off-road during the m2 dialog
    // while the player was still "talking". Release every key so the
    // car drag-brakes to a stop. Do NOT hold S here: on this car S
    // at speed is a coast (no decel — see steerAndThrottle) and at
    // low speed it reverses, so it would roll the car backwards
    // through the dialog instead of stopping it.
    keys.releaseAll();
    if (now - state.lastDialogAt > 0.3) {
      state.lastDialogAt = now;
      if (typeof document !== 'undefined') {
        const accept = document.getElementById('accept-btn');
        if (accept) { accept.click(); return; }
      }
      keys.tap('KeyE');
    }
    return;
  }

  // --- Garage menu: buy the cheapest upgrade, then close. -----------------
  if (garageMenuOpen(G)) {
    setMode(G, 'garage-buy');
    if (tryGaragePurchase(G)) {
      if (mission) mission.garageBought = true;
      if (G.missions) G.missions.garageBought = true;
    }
    state.garageTries += 1;
    if (state.garageTries > 3) {
      closeGarageMenu(G);
      state.garageTries = 0;
    }
    return;
  }

  // --- Shootout: nearest enemy, aimed bursts, ammo and weapon crates. -----
  const enemies = missionEnemies(G, mission);
  const isShootout = /m8|m10|m12|shootout|finale|bank/.test(id)
    || (mission && (mission.type === 'shootout' || mission.kind === 'shootout'))
    || enemies.length > 0;
  if (isShootout && enemies.length > 0) {
    // Low ammo: go fetch arena ammo first.
    if (currentAmmo(G) <= AMMO_LOW) {
      const ammo = nearestPickup(G, ammoPickups(G), p);
      if (ammo && ammo.distance < 600) {
        setMode(G, 'ammo');
        if (driving) { keys.releaseAll(); }
        else walkToward(G, state, ammo.pos);
        return;
      }
    }
    // A better weapon crate in the arena beats the pistol.
    const crates = weaponCrates(G);
    const myRank = weaponRank(currentWeaponName(G));
    const crate = nearestPickup(G, crates, p);
    if (crate && crate.distance < 500) {
      const crateRank = weaponRank(crate.pickup.weapon || crate.pickup.name || '');
      if (crateRank > myRank) {
        setMode(G, 'weapon-crate');
        if (!driving) walkToward(G, state, crate.pos);
        else driveToward(G, state, crate.pos, 300);
        return;
      }
    }
    const nearest = nearestEnemy(G, mission);
    if (nearest) {
      setMode(G, 'shootout');
      if (driving) {
        // Get out of the car to fight on foot.
        keys.tap('KeyE');
        return;
      }
      // Walk straight to the nearest enemy until in range.
      const range = currentWeaponName(G).toLowerCase().includes('shotgun') ? 260 : 420;
      if (nearest.distance > range) {
        walkToward(G, state, nearest.pos);
        setFiring(G, false);
      } else {
        keys.release('KeyW'); keys.release('KeyA'); keys.release('KeyS'); keys.release('KeyD');
        keys.release('ShiftLeft');
        setAim(G, nearest.pos);
        // Aimed bursts every 0.45s: fire briefly, then stop. Never spray.
        if (now - state.lastShotAt >= BURST_INTERVAL) {
          state.lastShotAt = now;
          state.burstUntil = now + 0.12;
        }
        setFiring(G, now < state.burstUntil);
      }
      return;
    }
  }

  // After a shootout clears, the mission wants an exit / loot marker.
  const target = objectiveTarget(G, mission);

  // --- Chase (m2): ram the courier. ---------------------------------------
  // The courier object lives on the exposed missions state
  // (G.missions.courier), not on the mission DEF — reading only the def
  // skipped this whole branch and the autopilot chased a stale objective
  // point instead of the moving car.
  const courier = readCourier(G, mission);
  const isChase = /m2|tail|chase/.test(id) || !!courier;
  if (isChase && courier) {
    const courierPos = posOf(courier);
    if (courierPos) {
      setMode(G, 'chase');
      // A new chase (or a restart after a timeout) resets the ambush
      // cache: the old intercept belongs to the old courier leg.
      const chaseKey = id + '#' + missionStage(mission);
      if (state.chaseKey !== chaseKey) {
        chaseReset(state);
        state.chaseKey = chaseKey;
        state.chaseStartAt = now;
      }
      // Swap cars only in the opening seconds, and only when the car
      // we have cannot catch the courier at all. Once the chase is on,
      // every detour to a parked car is distance the courier never
      // gives back.
      if (driving && now - state.lastSwapCheckAt > 1) {
        state.lastSwapCheckAt = now;
        const current = playerVehicle(G);
        if (current && topSpeedOf(current) < 430 && now - state.chaseStartAt < 20) {
          const swap = findSwapCandidate(G, true);
          if (swap) {
            const swapPos = posOf(swap);
            if (swapPos) {
              mark(state, 'chase-swap', null);
              driveToward(G, state, swapPos, 300);
              G.autopilotDrove = true;
              G.autopilot_drove = true;
              if (dist(p.x, p.y, swapPos.x, swapPos.y) < 50) keys.tap('KeyE');
              return;
            }
          }
        }
      }
      if (!driving) {
        // On foot: find any car, else walk to the courier's nearest road
        // point — never walk at a moving target forever.
        mark(state, 'chase-onfoot', 'walk');
        const swap = findSwapCandidate(G, true);
        if (swap) {
          const swapPos = posOf(swap);
          if (swapPos && dist(p.x, p.y, swapPos.x, swapPos.y) < 60) { keys.tap('KeyE'); return; }
          walkToward(G, state, swapPos);
          return;
        }
        const world = G.world || {};
        const nearest = world.nearestRoadPoint || world.nearestRoad;
        if (typeof nearest === 'function') {
          try {
            const raw = nearest.call(world, courierPos.x, courierPos.y);
            const roadPoint = posOf(raw);
            if (roadPoint) { walkToward(G, state, roadPoint); return; }
          } catch { /* fall through */ }
        }
        walkToward(G, state, courierPos);
        return;
      }
      // Driving: intercept the courier, don't tail-chase it (see
      // driveChase — cached route to an ambush junction on the
      // courier's own route, direct predicted pursuit when close).
      driveChase(G, state, courier, courierPos);
      G.autopilotDrove = true;
      G.autopilot_drove = true;
      return;
    }
  }

  // --- Escape (m7/m9/m12 and any wanted objective): Spray Shop. -----------
  const wanted = typeof G.wanted === 'number' ? G.wanted
    : (typeof G.heat === 'number' ? Math.floor(G.heat / 20) : 0);
  const isEscape = /m7|m9|escape|highway|sky/.test(id)
    || (mission && (mission.type === 'escape' || mission.kind === 'escape'))
    || (target && /escape|spray|hideout/i.test(String(target.ref && (target.ref.name || target.ref.kind || ''))));
  if (isEscape && wanted >= 1) {
    setMode(G, 'escape');
    const shop = sprayShopPos(G);
    if (!driving) {
      const swap = findSwapCandidate(G, false);
      if (swap) {
        const swapPos = posOf(swap);
        if (swapPos && dist(p.x, p.y, swapPos.x, swapPos.y) < 60) { keys.tap('KeyE'); return; }
        walkToward(G, state, swapPos);
        return;
      }
      walkToward(G, state, shop);
      return;
    }
    driveToward(G, state, shop, 480);
    G.autopilotDrove = true;
    G.autopilot_drove = true;
    return;
  }

  // --- Garage step (m11): drive to the Fixer Garage, open, buy. -----------
  const needsGarage = /m11|tune/.test(id)
    || (mission && mission.needsGarage === true)
    || (mission && mission.garageBought !== true && missionStage(mission) === 0 && /m11/.test(id));
  if (needsGarage && !(mission && mission.garageBought)) {
    setMode(G, 'garage-drive');
    const garage = garagePos(G);
    if (!driving) {
      const swap = findSwapCandidate(G, false);
      if (swap) {
        const swapPos = posOf(swap);
        if (swapPos && dist(p.x, p.y, swapPos.x, swapPos.y) < 60) { keys.tap('KeyE'); return; }
        walkToward(G, state, swapPos);
        return;
      }
      walkToward(G, state, garage);
      return;
    }
    if (dist(p.x, p.y, garage.x, garage.y) < 90) {
      keys.release('KeyW'); keys.release('KeyS');
      keys.tap('KeyE');
      state.garageTries = 0;
      return;
    }
    driveToward(G, state, garage, 420);
    G.autopilotDrove = true;
    G.autopilot_drove = true;
    return;
  }

  // --- General go-to: drive if far, walk if close or on foot. -------------
  if (target) {
    const d = dist(p.x, p.y, target.x, target.y);
    const cruise = isChase ? CHASE_CRUISE : 460;
    if (driving) {
      // A much faster parked car nearby beats a slow current car.
      if (now - state.lastSwapCheckAt > 1) {
        state.lastSwapCheckAt = now;
        const swap = findSwapCandidate(G, isChase);
        if (swap) {
          const swapPos = posOf(swap);
          if (swapPos) {
            setMode(G, 'swap-car');
            driveToward(G, state, swapPos, 300);
            G.autopilotDrove = true;
            G.autopilot_drove = true;
            if (dist(p.x, p.y, swapPos.x, swapPos.y) < 50) keys.tap('KeyE');
            return;
          }
        }
      }
      setMode(G, 'drive');
      driveToward(G, state, target, cruise);
      G.autopilotDrove = true;
      G.autopilot_drove = true;
      return;
    }
    // On foot: take a nearby car when the target is far, else walk.
    if (d > 320) {
      const swap = findSwapCandidate(G, isChase);
      if (swap) {
        const swapPos = posOf(swap);
        if (swapPos) {
          if (dist(p.x, p.y, swapPos.x, swapPos.y) < 60) { keys.tap('KeyE'); return; }
          setMode(G, 'walk-to-car');
          walkToward(G, state, swapPos);
          return;
        }
      }
      // Any drivable car nearby will do when the target is far.
      const vehicles = allVehicles(G);
      let nearestCar = null;
      let nearestDist = 260;
      for (const vehicle of vehicles) {
        if (!vehicle) continue;
        const pos = posOf(vehicle);
        if (!pos) continue;
        const dd = dist(p.x, p.y, pos.x, pos.y);
        if (dd < nearestDist) { nearestDist = dd; nearestCar = vehicle; }
      }
      if (nearestCar) {
        const carPos = posOf(nearestCar);
        if (nearestDist < 60) { keys.tap('KeyE'); return; }
        setMode(G, 'walk-to-car');
        walkToward(G, state, carPos);
        return;
      }
    }
    setMode(G, 'walk');
    walkToward(G, state, target);
    return;
  }

  // No mission and no target: free roam — keep the city alive for shots.
  setMode(G, 'roam');
  if (driving) {
    const roamTarget = { x: 1600 + 900 * Math.sin(now * 0.05), y: 1600 + 900 * Math.cos(now * 0.037) };
    driveToward(G, state, roamTarget, 380);
    G.autopilotDrove = true;
    G.autopilot_drove = true;
  } else {
    walkToward(G, state, { x: 1600, y: 1600 });
  }
}

// The autopilot draws nothing on the canvas; the HUD may read G.autopilot.mode.
export function draw(G, ctx) {
  // Intentionally empty: the autopilot is a driver, not a renderer.
}

export function enable(G) {
  if (!G.autopilot) init(G);
  G.autopilotEnabled = true;
}

export function disable(G) {
  if (G.autopilot) G.autopilotEnabled = false;
  if (G.autopilot) G.autopilot.keys.releaseAll();
}
