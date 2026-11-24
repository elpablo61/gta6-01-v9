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
    // Crawl forward while rotating so the car keeps a little authority —
    // but only into open space. With the nose against a building the
    // forward creep grinds the car against the wall and the nose barely
    // turns (B13 probe: 22s at v=8-15, angle +0.23 rad, four beaching
    // episodes of 3-20s in recovery). Back out instead: reversing while
    // steering turns the nose the same way, so the car backs out of the
    // block while still rotating toward the target. Same rule the
    // steerAndThrottle rotate branch already uses.
    if (speed < 25) {
      if (noseClear(G, p, heading)) keys.hold('KeyW');
      else keys.hold('KeyS');
    }
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
    // DRAG-BRAKE (B14): S is not a brake in this car — the probe
    // watched a full second of held S at v=355 lose zero speed, so
    // braking with S arrives at the turn too fast, overshoots the
    // junction off-road, and pays for it in recovery. Release
    // everything and let drag (260/s^2) do the slowing, as
    // steerAndThrottle's brake-cap already does.
    keys.release('KeyW');
    keys.release('KeyS');
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
// the driving itself never stops to rotate above 70 u/s and never
// brakes to a stop for a turn — it brakes only to a cap speed, and
// inside 200 units it steers straight at the courier's predicted
// position with the throttle flat, because a ram only counts above
// 120 u/s and any brake there throws the hit away. B12: S is not a
// brake in this car (drag is), so every brake in the chase driver
// releases all keys instead of holding S.

function chaseReset(state) {
  // Fresh ambush cache: the old intercept belongs to the old courier leg.
  const fresh = {
    chaseRoute: [],
    chaseRouteDest: null,
    chaseRouteAt: 0,
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

// NOTE: the block-reverse recovery (recoverToRoad) is gone: the v12
// recovery drives back to the road with the m1 driver instead of
// reversing in the block. The junction-scan intercept (pickIntercept)
// is back in B12 form: the nearest reachable junction on the courier's
// own route, sticky while the leg lasts — the v11 far-corner ambush
// raced a ~13s courier leg with a 30-60s drive and never met it.

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

  // Facing the wrong way at speed: brake in a straight line first.
  // Steering while braking at 300+ arcs the car off the road into a
  // block. No steering while the speed is high; once slow, the
  // rotate-in-place branch below takes over.
  // DRAG-BRAKE (B12): S is NOT a brake in this car. player.js
  // overwrites car.brake with a boolean every frame, so
  // effectiveBrake() returns 0/1 and holding S while moving just
  // coasts with no deceleration. The only deceleration is the
  // 260/s^2 drag when NO key is held — so release everything and let
  // drag slow the car in a straight line.
  if (Math.abs(diff) > 1.5 && Math.abs(speed) > 60) {
    keys.releaseAll();
    state.dbgDrive = 'brake-straight';
    return;
  }

  // Rotate in place when slow and the nose is well off the aim
  // (> ~52 degrees): arcing at low speed just grinds the car
  // sideways, and going full throttle from here drove it off the
  // road in probe #2. At speed the turn-coast branch below takes
  // over instead, so this never stops a fast car.
  if (Math.abs(diff) > 0.9 && Math.abs(speed) < 70) {
    keys.release('KeyW');
    keys.release('KeyS');
    steerToward(keys, diff);
    // Creep only into open space. When the nose is blocked, back out
    // instead: reversing while steering turns the nose the same way,
    // so the car backs out of the block while still rotating toward
    // the target, instead of grinding against the wall forever.
    // Face mode creeps too, with W only: steering with no throttle
    // does NOT rotate this car at a standstill — probes #1 and #2
    // both watched a parked car hold its steer key for 5s with the
    // angle frozen, facing the wrong way while the courier drove
    // past. The W creep is what turns the nose; it stops the moment
    // the car faces the aim (face-hold below), so the car stays on
    // the ambush. Never reverse in face mode: backing out would
    // leave the corner.
    if (Math.abs(speed) < 25) {
      if (noseClear(G, p, heading)) keys.hold('KeyW');
      else if (!faceOnly) keys.hold('KeyS');
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
    // B14: the old fixed windows (350/400) were shorter than the
    // braking distance at chase speed — drag is 260/s^2, so 420 -> 180
    // needs ~277 units, and the car still arrived at the junction at
    // ~180 (radius ~81, wider than the road), plowed through the
    // corner into the block, and stopped off-road (B13 probe t=140
    // and t=159: brake-cap at v=372-381, v=10 off-road a second
    // later, then a 4s recovery grind). The window is now the braking
    // distance from the current speed down to the cap plus a 150-unit
    // margin, and the 90-degree cap drops 180 -> 140 (radius ~63,
    // inside the junction box with the lookahead steering).
    const brakeDist = (from, to) => (from > to ? (from * from - to * to) / 520 : 0);
    let turnCap = cruise;
    if (turn > 1.5) turnCap = 110;
    else if (turn > 0.9) turnCap = 140;
    if (turnCap < cruise && wpDist < brakeDist(mag, turnCap) + 150) cap = turnCap;
  }
  if (mag > cap) {
    // DRAG-BRAKE (B12): release the throttle AND the S key. S does
    // not brake this car — it only coasts — while drag does the
    // slowing. Steering stays as steerToward set it above.
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'brake-cap';
  } else if (Math.abs(diff) > 0.9) {
    // Don't accelerate off-course: leaving the rotate branch ~54
    // degrees off the aim and going full throttle drove the car off
    // the road in probe #2 (t=10-11: 0 to 102 u/s heading
    // north-west, off the road in a second). Coast on drag while
    // the steering brings the nose around; throttle resumes once
    // roughly aligned. Only reachable at speed now — below 70 the
    // rotate branch above already took the frame.
    keys.release('KeyW');
    keys.release('KeyS');
    state.dbgDrive = 'turn-coast';
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

// B12: brakeStraight() is deleted with the align-brake gate, its
// only caller. It held S — which is not a brake in this car — and
// the drag-brake guard inside steerAndThrottle now covers its job.

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

// --- B12 intercept: nearest reachable junction, sticky pick. --------
//
// B10 proved racing the courier to its FAR corner cannot work: one
// leg takes the courier ~13s and the player 30-60s. The fix is to
// meet the courier at the NEAREST junction on its own route that the
// player can still reach first, and park 90 units BEFORE that
// junction on the courier's arrival leg so the lunge is head-on.
//
// ETAs: playerETA = 1.3 x straight-line distance / 300 (the 1.3
// covers road detours, 300 is the sustained road speed); courierETA
// = road distance along its route / (cruise x 1.15) (the 1.15 covers
// the courier cutting corners — it never collides). A junction is
// winnable when courierETA - playerETA >= 3s; among winnable
// junctions the nearest wins, otherwise the widest margin wins. The
// pick is STICKY: it survives while the junction is still ahead of
// the courier and the player is not more than 5s late (or is already
// parked), for at most 20s — so the car commits to one ambush
// instead of chasing a new junction every frame. The 5s late
// tolerance is the point: arriving just behind the courier on its
// own route is a tail position, while abandoning a pick the moment
// its margin goes negative made the car oscillate between the ends
// of one road for the whole arc (m2 never completed). Picks are
// recomputed at most once every 2s.

function courierLegKey(courier) {
  if (typeof courier.destX === 'number' && typeof courier.destY === 'number') {
    return courier.destX + ',' + courier.destY;
  }
  return '';
}

function courierCruise(courier) {
  if (typeof courier.cruise === 'number' && courier.cruise > 0) return courier.cruise;
  const s = speedOf(courier);
  return s > 0 ? s : 380;
}

// Road distance from the courier to a junction along the courier's
// own route, or -1 when the junction is already behind it (or the
// route is missing). The courier sits mid-segment, so measure from
// the nearer of the two route points closest to it.
function roadDistToJunction(courierPos, route, junction) {
  if (!Array.isArray(route) || route.length === 0) return -1;
  const pts = route.map(posOf).filter(Boolean);
  if (pts.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < pts.length; i += 1) {
    if (dist(pts[i].x, pts[i].y, junction.x, junction.y) < 2) { idx = i; break; }
  }
  // The two route points nearest the courier: the courier is between
  // them (or just past one of them).
  const order = pts.map((pt, i) => ({ i, d: dist(courierPos.x, courierPos.y, pt.x, pt.y) }))
    .sort((a, b) => a.d - b.d);
  let extra = 0;
  if (idx < 0) {
    idx = pts.length - 1;
    extra = dist(pts[idx].x, pts[idx].y, junction.x, junction.y);
  }
  let best = -1;
  for (const cand of order.slice(0, 2)) {
    const s = cand.i;
    if (s > idx) continue;
    let d = cand.d;
    for (let i = s; i < idx; i += 1) d += dist(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (best < 0 || d < best) best = d;
  }
  return best < 0 ? -1 : best + extra;
}

// 90 units before the junction on the courier's arrival leg: the leg
// into the junction, from the previous route point (or from the
// courier itself when the junction is first on the route).
function parkPointFor(courierPos, route, junction) {
  const pts = (Array.isArray(route) ? route : []).map(posOf).filter(Boolean);
  let prev = null;
  for (let i = 0; i < pts.length; i += 1) {
    if (dist(pts[i].x, pts[i].y, junction.x, junction.y) < 2) {
      prev = i > 0 ? pts[i - 1] : null;
      break;
    }
  }
  const from = prev || courierPos;
  const dx = junction.x - from.x;
  const dy = junction.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: junction.x - (dx / len) * 90, y: junction.y - (dy / len) * 90 };
}

function pickIntercept(G, state, courier, courierPos, p) {
  const now = state.now;
  const legKey = courierLegKey(courier);
  const cruise = courierCruise(courier);
  const cached = state.chaseIntercept;
  const route = Array.isArray(courier.route) ? courier.route : [];
  const pts = route.map(posOf).filter(Boolean);
  // Sticky: keep the pick while the junction is still ahead of the
  // courier and the player is not more than 5s late (or is parked),
  // max 20s. Keyed by the junction, not the leg: a leg change must
  // not break the stick while the courier is still heading for the
  // same junction — only a junction the courier already passed
  // breaks it. Committing matters more than winning by seconds:
  // abandoning a pick the moment its margin went negative made the
  // car oscillate between the ends of one road for the whole arc.
  if (cached && now - cached.pickedAt < 20) {
    const junction = { x: cached.x, y: cached.y };
    const roadD = roadDistToJunction(courierPos, route, junction);
    // Junction behind the courier (route known) breaks the stick.
    if (pts.length === 0 || roadD >= 0) {
      const cDist = roadD >= 0 ? roadD : dist(courierPos.x, courierPos.y, junction.x, junction.y);
      const cETA = cDist / (cruise * 1.15);
      const pETA = 1.3 * dist(p.x, p.y, junction.x, junction.y) / 300;
      const parked = dist(p.x, p.y, cached.parkX, cached.parkY) < 70;
      if (cETA > 0.5 && (parked || pETA < cETA + 5)) return cached;
    }
  }
  // Recompute at most once every 2s.
  if (cached && now - (state.chaseInterceptAt || 0) < 2) return cached;
  const candidates = pts.slice();
  if (typeof courier.destX === 'number' && typeof courier.destY === 'number') {
    const dest = { x: courier.destX, y: courier.destY };
    if (!candidates.some((q) => dist(q.x, q.y, dest.x, dest.y) < 2)) candidates.push(dest);
  }
  let best = null;
  let bestPlayerETA = Infinity;
  let widest = null;
  let widestMargin = -Infinity;
  for (const junction of candidates) {
    const roadD = roadDistToJunction(courierPos, route, junction);
    // A junction the courier already passed can never be an ambush
    // — skip it when the route is known. With no route at all, fall
    // back to the straight-line distance.
    if (roadD < 0 && pts.length > 0) continue;
    const cDist = roadD >= 0 ? roadD : dist(courierPos.x, courierPos.y, junction.x, junction.y);
    const cETA = cDist / (cruise * 1.15);
    const pETA = 1.3 * dist(p.x, p.y, junction.x, junction.y) / 300;
    const margin = cETA - pETA;
    if (margin > widestMargin) {
      widestMargin = margin;
      widest = { junction, cETA, pETA, margin };
    }
    if (margin >= 3 && pETA < bestPlayerETA) {
      bestPlayerETA = pETA;
      best = { junction, cETA, pETA, margin };
    }
  }
  const sel = best || widest;
  if (!sel) return cached || null;
  const park = parkPointFor(courierPos, route, sel.junction);
  const pick = {
    x: sel.junction.x, y: sel.junction.y,
    parkX: park.x, parkY: park.y,
    legKey, pickedAt: now,
    margin: sel.margin, courierETA: sel.cETA, playerETA: sel.pETA,
  };
  state.chaseIntercept = pick;
  state.chaseInterceptAt = now;
  return pick;
}

// A waypoint is only dropped when the car has PROVEN it passed it:
// beyond the waypoint along the OUTGOING leg, close to that leg's
// line, and heading along it. The old incoming-leg test never fired
// for the first waypoint when it sat behind the car (the router's
// nearest junction is often the one just left), so the car aimed
// backwards and stop-and-rotated forever. The outgoing test fires
// immediately in exactly that case: the car is already past the
// junction on the way out.
function waypointPassed(p, wp, next, heading) {
  const ox = next.x - wp.x;
  const oy = next.y - wp.y;
  const len = Math.hypot(ox, oy) || 1;
  const ux = ox / len;
  const uy = oy / len;
  const along = (p.x - wp.x) * ux + (p.y - wp.y) * uy;
  if (along <= 0) return false;
  const perp = Math.abs(-(p.y - wp.y) * ux + (p.x - wp.x) * uy);
  if (perp > 90) return false;
  const outAngle = Math.atan2(uy, ux);
  return Math.abs(angleDiff(outAngle, heading)) < 1.0;
}

// The point on the road route `lookahead` units ahead of the car's
// projection onto it. The aim MUST lie on the polyline: aiming at
// the next waypoint beyond the lookahead (the first version of this
// driver) points the car straight at a junction a full block past
// the one it still has to turn at, so the car cuts diagonally across
// the building block instead of driving up to the junction and
// turning — probe #1 went off-road 76s in 22 episodes, nearly all
// starting just past a junction. Walking the polyline keeps the aim
// on the asphalt: up the road the car is on, then around the corner
// on the outgoing leg, so the chord to the aim always passes through
// the junction box instead of through the block.
function lookaheadPoint(p, route, lookahead) {
  if (route.length < 2) return route[route.length - 1];
  let bestSeg = 0;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.length - 1; i += 1) {
    const a = route[i];
    const b = route[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const d = dist(p.x, p.y, a.x + dx * t, a.y + dy * t);
    if (d < bestD) { bestD = d; bestSeg = i; bestT = t; }
  }
  let remaining = lookahead;
  const segA = route[bestSeg];
  const segB = route[bestSeg + 1];
  const segLen = dist(segA.x, segA.y, segB.x, segB.y) || 1;
  const leftInSeg = (1 - bestT) * segLen;
  if (remaining <= leftInSeg) {
    const px = segA.x + (segB.x - segA.x) * bestT;
    const py = segA.y + (segB.y - segA.y) * bestT;
    return {
      x: px + ((segB.x - segA.x) / segLen) * remaining,
      y: py + ((segB.y - segA.y) / segLen) * remaining,
    };
  }
  remaining -= leftInSeg;
  for (let i = bestSeg + 1; i < route.length - 1; i += 1) {
    const a = route[i];
    const b = route[i + 1];
    const len = dist(a.x, a.y, b.x, b.y) || 1;
    if (remaining <= len) {
      return { x: a.x + ((b.x - a.x) / len) * remaining, y: a.y + ((b.y - a.y) / len) * remaining };
    }
    remaining -= len;
  }
  return route[route.length - 1];
}

// Fast chase driver: pure pursuit along the cached road route to a
// fixed point (the intercept park point). The aim is the point on
// the road polyline at a speed-scaled lookahead (90-220 units) from
// the car's projection onto it, so the car starts its turn before
// the junction and arcs through it instead of stopping to rotate —
// the road-mode caps in steerAndThrottle (140 for a 90-degree turn,
// 110 for a hairpin) keep the speed inside the turning radius.
// No stop-and-rotate while moving on this path.
function driveChaseFast(G, state, target, cruise) {
  const p = playerPos(G);
  const vehicle = playerVehicle(G);
  const heading = headingOf(vehicle || G.player);
  const speed = speedOf(vehicle || G.player);
  const targetMoved = !state.chaseRouteDest
    || dist(target.x, target.y, state.chaseRouteDest.x, state.chaseRouteDest.y) > 120;
  if (targetMoved || !Array.isArray(state.chaseRoute) || state.chaseRoute.length === 0) {
    state.chaseRoute = computeRoute(G, p, target);
    state.chaseRouteDest = { x: target.x, y: target.y };
    state.chaseRouteAt = state.now;
  }
  const route = state.chaseRoute;
  while (route.length > 1) {
    if (waypointPassed(p, route[0], route[1], heading)) route.shift();
    else break;
  }
  while (route.length > 0) {
    const wp = route[0];
    const radius = route.length === 1 ? FINAL_RADIUS : WAYPOINT_RADIUS;
    if (dist(p.x, p.y, wp.x, wp.y) < radius) route.shift();
    else break;
  }
  if (route.length === 0) {
    // At the target: coast to a stop, wheels still.
    state.keys.release('KeyW');
    state.keys.release('KeyS');
    state.dbgDrive = 'arrived';
    return true;
  }
  const lookahead = clamp(Math.abs(speed) * 0.45, 90, 220);
  const aim = lookaheadPoint(p, route, lookahead);
  const wpDist = dist(p.x, p.y, route[0].x, route[0].y);
  steerAndThrottle(G, state, aim, cruise, speed, heading, { route, waypointDist: wpDist });
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

  // B12: the global align-brake gate is DELETED. It read
  // state.route[0], which belongs to the m1 driver and goes stale
  // the moment the chase route changes (B10: the car braked 3s on a
  // stale east route while already facing west). The turn-ahead
  // protection now lives inside steerAndThrottle's road-mode caps,
  // which read the chase route the fast driver is actually using.

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

  // B12 intercept: meet the courier at the nearest junction on its
  // own route the player can still reach first (pickIntercept,
  // sticky per leg), park 90 units before that junction on the
  // arrival leg, and lunge head-on as the courier comes in. The old
  // far-corner ambush raced a 13-second courier leg with a 30-60s
  // drive and never met it; the fast driver below (driveChaseFast)
  // turns through junctions instead of stopping to rotate.
  const pick = pickIntercept(G, state, courier, courierPos, p);
  const junction = pick ? { x: pick.x, y: pick.y }
    : ((typeof courier.destX === 'number' && typeof courier.destY === 'number')
      ? { x: courier.destX, y: courier.destY }
      : (nearestRouteJunction(courier, p) || leadPoint(courier, courierPos, p, playerTop)));
  const park = pick ? { x: pick.parkX, y: pick.parkY } : junction;
  const dPark = dist(p.x, p.y, park.x, park.y);
  const parked = pick !== null && dPark < 70;

  // Lunge: parked at the ambush and the courier is close, or the
  // courier is close and roughly ahead — steer straight at where it
  // will be, foot flat. Earlier than before (650, was 500): the
  // courier slows to ~170 for the junction turn, so a parked car
  // that lunges as it arrives meets it head-on. In escape mode the
  // watchdog has already decided waiting is the problem, so lunge
  // from anywhere under 800.
  const aimClose = leadPoint(courier, courierPos, p, playerTop);
  const diffClose = angleDiff(Math.atan2(aimClose.y - p.y, aimClose.x - p.x), heading);
  if (((parked && dCourier < 650)
    || (dCourier < 200 && Math.abs(diffClose) < 1.2)
    || (escaping && dCourier < 800))
    && !segmentBlocked(G, p, aimClose)) {
    mark(state, 'lunge', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { direct: true });
    return true;
  }

  // Tail: the courier is near, lined up and the line is open — chase
  // it down directly instead of driving to a junction. No ambush
  // earns its keep when the target is already straight ahead.
  if (dCourier < 600 && Math.abs(diffClose) < 0.9 && !segmentBlocked(G, p, aimClose)) {
    mark(state, 'tail', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { direct: true });
    return true;
  }

  // Parked at the ambush with the courier still far off: face its
  // approach so the lunge starts with the nose already right. Rotate
  // in place, never drive — driving now would leave the ambush.
  // Escape mode skips the wait: the watchdog only fires after 30s
  // of no progress in face (a courier leg is 15-20s), so by then the
  // wait itself is the problem and the car drives at the ambush.
  if (parked && dCourier >= 650 && !escaping) {
    mark(state, 'face', null);
    steerAndThrottle(G, state, aimClose, playerTop, speed, heading, { face: true });
    return true;
  }

  // Otherwise drive the road to the park point with the fast driver:
  // pure pursuit, turning through junctions, never stopping to rotate.
  mark(state, 'intercept', null);
  return driveChaseFast(G, state, park, playerTop);
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
      intercept: state.chaseIntercept ? `${Math.round(state.chaseIntercept.x)},${Math.round(state.chaseIntercept.y)}` : null,
      park: state.chaseIntercept ? `${Math.round(state.chaseIntercept.parkX)},${Math.round(state.chaseIntercept.parkY)}` : null,
      interceptMargin: state.chaseIntercept && typeof state.chaseIntercept.margin === 'number' ? +state.chaseIntercept.margin.toFixed(1) : null,
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
    // Release every key: a W left held from the previous drive keeps
    // the car rolling through the whole dialog (B10 cause #3 — the
    // car left the road before m2 even started). Never hold S here:
    // S is not a brake, and at low speed it reverses the car.
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
      // B14: driveChaseFast, not driveToward. driveToward stops and
      // rotates in place at every sharp junction turn, which cost
      // ~40-45s per leg (m3 116s, m4 85s, m5 96s, m6 270s in arc #1)
      // and left no time for m8-m12. The fast driver turns through
      // junctions at speed on the cached road route (proven at 420
      // in the m2 probe) and its 60-unit arrival radius matches the
      // missions' own nearObjective radius (60).
      driveChaseFast(G, state, target, cruise);
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
