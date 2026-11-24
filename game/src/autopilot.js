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
  // G.vehicles is an array carrying a .list (see vehicles.js init):
  // the live cars are in .list, the array itself is always empty.
  if (v && Array.isArray(v.list)) return v.list;
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.all)) return v.all;
  if (v && Array.isArray(v.parked)) return v.parked;
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

// The objective target: a marker, checkpoint, drop, courier, enemy, or any
// point the mission wants Rook to reach. Several shapes are accepted.
function objectiveTarget(G, mission) {
  // The LIVE objective lives on the exposed missions object
  // (G.missions.objective = {x, y, label, kind}, set by setupStage).
  // The mission DEF has no target/marker/objective fields, so reading
  // only the def always returned null here and the autopilot fell
  // through to roam instead of driving to the marker — m1 stalled
  // forever at stage 0 (arc progress: roam, ~250,370, never moving
  // toward the market at 600,600).
  const live = G && G.missions;
  if (live && live.objective) {
    const point = posOf(live.objective);
    if (point) return { x: point.x, y: point.y, ref: live.objective };
    if (typeof live.objective.x === 'number' && typeof live.objective.y === 'number') {
      return { x: live.objective.x, y: live.objective.y, ref: live.objective };
    }
  }
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
  // Checkpoints are a list; take the first unvisited one.
  const list = mission.checkpoints || mission.markers || mission.drops
    || (live && (live.checkpoints || live.drops));
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
  // dialog flag. The old code only asked currentMission() — which falls
  // back to the m1 DEF (no dialogOpen field) while the offer is still
  // unaccepted — and the DOM fallback below, so the autopilot never saw
  // the dialog and the arc stalled at m1 forever (roam mode, frozen).
  if (G && G.state === 'dialog') return true;
  if (G && G.missions && G.missions.dialogOpen === true) return true;
  if (G.ui && (G.ui.dialogOpen === true || G.ui.dialog === true)) return true;
  if (G.dialog && G.dialog.open === true) return true;
  const mission = currentMission(G);
  if (mission && mission.dialogOpen === true) return true;
  if (typeof document !== 'undefined') {
    const el = document.getElementById('mission-dialog');
    if (el && !el.hidden) return true;
  }
  return false;
}

function garageMenuOpen(G) {
  if (G.garage && (G.garage.open === true || G.garage.menuOpen === true)) return true;
  if (G.ui && (G.ui.garageOpen === true || G.ui.garage === true)) return true;
  if (typeof document !== 'undefined') {
    const el = document.getElementById('garage-menu') || document.getElementById('garage-overlay');
    if (el && !el.hidden) return true;
  }
  return false;
}

function gameOverShown(G) {
  if (G.gameOver === true || G.state === 'gameover' || G.screen === 'gameover') return true;
  if (typeof document !== 'undefined') {
    const el = document.getElementById('game-over-screen');
    if (el && !el.hidden) return true;
  }
  return false;
}

function titleShown(G) {
  if (G.screen === 'title' || G.state === 'title') return true;
  if (typeof document !== 'undefined') {
    const el = document.getElementById('title-screen');
    if (el && !el.hidden) return true;
  }
  return false;
}

function sprayShopPos(G) {
  const w = G.world || {};
  return posOf(w.places && w.places.sprayShop) || posOf(w.sprayShop) || posOf(w.spray) || posOf(w.spray_shop)
    || posOf(G.sprayShop) || { x: 600, y: 600 };
}

function garagePos(G) {
  const w = G.world || {};
  return posOf(w.places && w.places.garage) || posOf(w.garage) || posOf(w.fixerGarage) || posOf(w.fixer_garage)
    || posOf(G.garage) || posOf(G.garage && G.garage.position) || { x: 1000, y: 1000 };
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
    // The world's findRoute takes FOUR NUMBERS (sx, sy, tx, ty). The
    // old call passed two point OBJECTS, which threw inside the router
    // (nearestRoadPoint got an object and returned null), so every
    // route silently fell to the midpoint fallback below: one road
    // point + the target, i.e. a straight diagonal across a building
    // block. The car wedged itself inside the block and crawled at
    // ~5 u/s along the walls (m1 stalled, t=105s at 518,16). Try the
    // numeric form first, then the object form, then fall back.
    for (const args of [[from.x, from.y, to.x, to.y], [from, to]]) {
      try {
        const raw = finder.call(world, ...args);
        if (Array.isArray(raw) && raw.length > 0) {
          return raw.map((p) => posOf(p)).filter(Boolean);
        }
      } catch {
        // Try the next calling shape.
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

// Drive toward a point. Returns true when the autopilot drove this frame
// (so the caller must skip manual driving and set the flag).
// opts.ram: ramming run — hold full throttle straight at the target and
// never brake for arrival: a ram only registers above 120 u/s, and the
// closeIn brake (<= 60 within 140) made m2 hits impossible — the car
// always arrived at the courier too slow to count.
function driveToward(G, state, target, cruise, opts) {
  const ram = !!(opts && opts.ram);
  const p = playerPos(G);
  const vehicle = playerVehicle(G);
  const heading = headingOf(vehicle || G.player);
  const speed = speedOf(vehicle || G.player);
  const keys = state.keys;

  // Route handling: recompute when the target moved, or when we ran out.
  const targetMoved = !state.routeTarget
    || dist(target.x, target.y, state.routeTarget.x, state.routeTarget.y) > 120;
  if (targetMoved || state.route.length === 0) {
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
  // Release the OPPOSITE steer key too: without it, a steer key left
  // held from walking (or from a previous turn the other way) stays down
  // alongside the new one, A and D cancel to steer 0, the car never
  // turns, and it crawls straight into the nearest wall forever (m1
  // stalled at y=16, angle frozen at -1.45, keys A+D held together).
  if (Math.abs(diff) > 0.9 && speed < 140) {
    keys.release('KeyW');
    keys.release('KeyS');
    if (diff > 0) { keys.hold('KeyD'); keys.release('KeyA'); }
    else { keys.hold('KeyA'); keys.release('KeyD'); }
    // Crawl forward while rotating so the car keeps a little authority.
    if (speed < 25) keys.hold('KeyW');
    return true;
  }

  // Steering follows the sign of the angle difference.
  if (diff > 0.12) { keys.hold('KeyD'); keys.release('KeyA'); }
  else if (diff < -0.12) { keys.hold('KeyA'); keys.release('KeyD'); }
  else { keys.release('KeyA'); keys.release('KeyD'); }

  // Brake ahead of a sharp turn, otherwise throttle toward cruise speed.
  // Two gaps the old check had (m1 stage 1 stalled in a loop at the
  // market junction, hp 46 -> 2 grinding a building): it only braked
  // when already facing the turn (|diff| > 0.55) at speed > 180, and it
  // never looked at the turn AFTER the current waypoint. A car arriving
  // at a 90-degree junction at ~178 u/s faced the turn too late, in the
  // dead zone where it was too fast for the stop-and-rotate branch
  // (> 140) but under the brake threshold, so it held full throttle
  // through the turn, overshot the junction north into the building,
  // wedged, and the stuck-handler recompute sent it back west to retry
  // the same trap forever. Brake early for a sharp turn AT the waypoint
  // (incoming leg vs outgoing leg), and brake for any sharp facing turn
  // above 120 so speed is under 140 when the rotate branch takes over.
  const nextWp = state.route[1] || target;
  const inAngle = Math.atan2(waypoint.y - p.y, waypoint.x - p.x);
  const outAngle = Math.atan2(nextWp.y - waypoint.y, nextWp.x - waypoint.x);
  const turnAtWp = Math.abs(angleDiff(outAngle, inAngle));
  const wpDist = dist(p.x, p.y, waypoint.x, waypoint.y);
  const needBrake = ram ? false : ((Math.abs(diff) > 0.55 && speed > 120)
    || (turnAtWp > 0.9 && wpDist < 260 && speed > 60));
  const closeIn = !ram && distance < 140;
  if (needBrake || closeIn) {
    keys.release('KeyW');
    if (speed > 60) keys.hold('KeyS');
    else keys.release('KeyS');
  } else if (speed < cruise) {
    keys.hold('KeyW');
    keys.release('KeyS');
  } else {
    keys.release('KeyW');
    keys.release('KeyS');
  }
  return true;
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
  // reach something, clear the cached route and walk target.
  if (!state.lastPos || now - state.lastPosAt > 0.5) {
    if (state.lastPos && dist(p.x, p.y, state.lastPos.x, state.lastPos.y) < 6 && now - state.stuckSince > 4) {
      state.route = [];
      state.walkTarget = null;
      state.walkTargetPos = null;
      state.stuckSince = now;
    }
    if (!state.lastPos || dist(p.x, p.y, state.lastPos.x, state.lastPos.y) >= 6) {
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
  const courier = (mission && (mission.courier || mission.targetVehicle || mission.targetCar))
    || (G.missions && G.missions.courier);
  const isChase = /m2|tail|chase/.test(id) || !!courier;
  if (isChase && courier) {
    const courierPos = posOf(courier);
    if (courierPos) {
      setMode(G, 'chase');
      // Leave a slow car for a much faster parked car nearby.
      if (driving && now - state.lastSwapCheckAt > 1) {
        state.lastSwapCheckAt = now;
        const swap = findSwapCandidate(G, true);
        if (swap) {
          const swapPos = posOf(swap);
          if (swapPos) {
            driveToward(G, state, swapPos, 300);
            G.autopilotDrove = true;
            G.autopilot_drove = true;
            if (dist(p.x, p.y, swapPos.x, swapPos.y) < 50) keys.tap('KeyE');
            return;
          }
        }
      }
      if (!driving) {
        // On foot: find any car, else walk to the courier's nearest road
        // point — never walk at a moving target forever.
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
      // Driving: cruise 520, ram inside 70 while faster than 120.
      // Inside 260, hold full throttle straight at the courier (ram
      // mode): driveToward's arrival brake would slow the car below
      // the 120 a hit needs to register, so m2 could never land one.
      const d = dist(p.x, p.y, courierPos.x, courierPos.y);
      driveToward(G, state, courierPos, CHASE_CRUISE, { ram: d < 260 });
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
