// vehicles.js — Crescent Bay cars.
// Written fresh in-session from the prose spec. No prior game code read.
//
// Car types with different top speed / acceleration:
// sedan, taxi, truck, sports, police.
// Steering rules (all proven in v3, built in from the start):
// - radius-based steering so cars turn inside narrow 64-wide roads
// - slow down before sharp junction turns
// - when stuck, reverse straight to unwedge
// - on wall collision slide along the wall instead of sticking
//   (moveWithCollision from world.js does the axis-separated slide)
// - guaranteed minimum turn authority even at low speed + crawl-forward turns
// - a car that must turn sharper than ~52 deg (|angle diff| > 0.9)
//   STOPS fully and rotates in place, then drives straight
// - brake ahead of sharp turns; U-turns crawl at speed 60
// - wall damage ticks at most once per 0.5s

import { moveWithCollision, clamp, findRoute } from './world.js';

export const CAR_TYPES = {
  sedan: { topSpeed: 420, accel: 300, brake: 520, turnRadius: 90, color: '#c94f42' },
  taxi: { topSpeed: 440, accel: 320, brake: 520, turnRadius: 90, color: '#e8c832' },
  truck: { topSpeed: 320, accel: 200, brake: 420, turnRadius: 130, color: '#5a7a4a' },
  sports: { topSpeed: 560, accel: 420, brake: 620, turnRadius: 80, color: '#3f6fd1' },
  police: { topSpeed: 500, accel: 380, brake: 600, turnRadius: 85, color: '#20242c' },
};

const CAR_COLORS = ['#c94f42', '#3f6fd1', '#5a7a4a', '#d8d8d8', '#8a5a9e', '#c97b2d', '#2d8a7a', '#b03a5a'];

export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function createCar(G, type, x, y, angle) {
  const t = CAR_TYPES[type] || CAR_TYPES.sedan;
  const rng = G.rng || { next: () => Math.random() };
  const car = {
    type,
    x, y,
    angle: angle || 0,
    speed: 0,
    topSpeed: t.topSpeed,
    accel: t.accel,
    brake: t.brake,
    turnRadius: t.turnRadius,
    color: type === 'taxi' ? '#e8c832' : CAR_COLORS[Math.floor(rng.next() * CAR_COLORS.length)],
    // Garage upgrades (per car, applied by the garage module).
    upgrades: { engine: 0, armor: 0, tires: 0, brakes: 0 },
    paint: null,
    hp: 100,
    route: null,        // [{x,y}...] waypoints
    routeIndex: 0,
    routeDest: null,    // recorded destination for rebuild checks
    cruise: t.topSpeed, // desired cruise speed (missions may lower it)
    stuckTimer: 0,
    reverseTimer: 0,
    lastX: x, lastY: y,
    lastDamageTick: 0,
    damage: 0,
    driver: null,       // 'traffic' | 'player' | 'courier' | null (parked)
    parked: false,
  };
  return car;
}

export function effectiveTopSpeed(car) {
  // Engine upgrades: +8% top speed per level.
  const lvl = (car.upgrades && car.upgrades.engine) || 0;
  return car.topSpeed * (1 + 0.08 * lvl);
}

export function effectiveTurnRadius(car) {
  // Tires upgrades: tighter turning per level.
  const lvl = (car.upgrades && car.upgrades.tires) || 0;
  return car.turnRadius * (1 - 0.12 * lvl);
}

export function effectiveBrake(car) {
  const lvl = (car.upgrades && car.upgrades.brakes) || 0;
  return car.brake * (1 + 0.15 * lvl);
}

// Set a route for a car. The route's first waypoint is the FIRST
// junction (never a diagonal cut across a block) — findRoute guarantees it.
export function setRoute(car, G, tx, ty) {
  if (!G.world) return;
  car.route = findRoute(G.world, car.x, car.y, tx, ty);
  car.routeIndex = 0;
  car.routeDest = { x: tx, y: ty };
}

// Rebuild only when the target moved >100 from the recorded destination.
export function maybeRebuildRoute(car, G, tx, ty) {
  if (!car.routeDest) { setRoute(car, G, tx, ty); return true; }
  const dx = tx - car.routeDest.x;
  const dy = ty - car.routeDest.y;
  if (dx * dx + dy * dy > 100 * 100) {
    setRoute(car, G, tx, ty);
    return true;
  }
  return false;
}

// Drive one car toward its current route waypoint (or a raw target).
// Returns nothing; mutates the car. `targetSpeed` caps the speed.
export function driveToward(car, G, dt, targetSpeed) {
  const world = G.world;
  car._wallDamageCd = Math.max(0, (car._wallDamageCd || 0) - dt);
  let tx;
  let ty;
  if (car.route && car.routeIndex < car.route.length) {
    // Advance past reached waypoints.
    while (car.routeIndex < car.route.length) {
      const wp = car.route[car.routeIndex];
      const dx = wp.x - car.x;
      const dy = wp.y - car.y;
      if (dx * dx + dy * dy < 16 * 16) car.routeIndex++;
      else break;
    }
    if (car.routeIndex >= car.route.length) {
      // Route done: coast to a stop.
      car.speed = Math.max(0, car.speed - effectiveBrake(car) * dt);
      return;
    }
    tx = car.route[car.routeIndex].x;
    ty = car.route[car.routeIndex].y;
    // Centreline aim: on an axis-aligned leg (junction to junction),
    // aim at a lookahead point ON the leg's centreline instead of at
    // the raw waypoint. Aiming at the waypoint alone lets a small
    // heading error leave a persistent lateral offset that drifts the
    // car off the 64-wide road (seen in Node test: truck 41+ units off
    // the y=2600 centreline). Projecting onto the leg pulls the car
    // back to the centreline.
    if (car.routeIndex > 0) {
      const prev = car.route[car.routeIndex - 1];
      const cur = car.route[car.routeIndex];
      const look = Math.max(60, Math.abs(car.speed) * 0.4);
      if (prev.x === cur.x) {
        const dir = Math.sign(cur.y - prev.y) || 1;
        const aheadY = car.y + dir * look;
        ty = dir > 0 ? Math.min(aheadY, cur.y) : Math.max(aheadY, cur.y);
        tx = cur.x;
      } else if (prev.y === cur.y) {
        const dir = Math.sign(cur.x - prev.x) || 1;
        const aheadX = car.x + dir * look;
        tx = dir > 0 ? Math.min(aheadX, cur.x) : Math.max(aheadX, cur.x);
        ty = cur.y;
      }
    } else if (car.route.length > 1) {
      // First leg: car position -> first junction. The leg runs along
      // the road the car is already on; aim at the junction's line
      // (not the raw diagonal) so a car that finished its last route
      // slightly off-centre steers back onto the centreline instead
      // of cutting across the block corner.
      const wp0 = car.route[0];
      const look = Math.max(60, Math.abs(car.speed) * 0.4);
      if (Math.abs(car.x - wp0.x) <= Math.abs(car.y - wp0.y)) {
        const dir = Math.sign(wp0.y - car.y) || 1;
        const aheadY = car.y + dir * look;
        ty = dir > 0 ? Math.min(aheadY, wp0.y) : Math.max(aheadY, wp0.y);
        tx = wp0.x;
      } else {
        const dir = Math.sign(wp0.x - car.x) || 1;
        const aheadX = car.x + dir * look;
        tx = dir > 0 ? Math.min(aheadX, wp0.x) : Math.max(aheadX, wp0.x);
        ty = wp0.y;
      }
    }
  } else if (car.target) {
    tx = car.target.x;
    ty = car.target.y;
  } else {
    car.speed = Math.max(0, car.speed - effectiveBrake(car) * dt);
    return;
  }

  const dx = tx - car.x;
  const dy = ty - car.y;
  const dist = Math.hypot(dx, dy);
  const wantAngle = Math.atan2(dy, dx);
  const diff = angleDiff(car.angle, wantAngle);
  const absDiff = Math.abs(diff);

  // Look ahead: angle to the NEXT waypoint after this one, so the car
  // brakes before a sharp junction turn instead of overshooting it.
  let nextDiff = 0;
  if (car.route && car.routeIndex + 1 < car.route.length) {
    const nwp = car.route[car.routeIndex + 1];
    nextDiff = Math.abs(angleDiff(wantAngle, Math.atan2(nwp.y - ty, nwp.x - tx)));
  }

  // Sharp turn (> ~52 deg): STOP fully and rotate in place, then drive
  // straight. A moving turning circle is wider than the 64-wide road.
  if (absDiff > 0.9 && car.reverseTimer <= 0) {
    car.speed = 0;
    const rot = 2.6 * dt;
    car.angle += Math.sign(diff) * Math.min(rot, absDiff);
    return;
  }

  // U-turns crawl at speed 60.
  let cap = typeof targetSpeed === 'number' ? targetSpeed : car.cruise || effectiveTopSpeed(car);
  cap = Math.min(cap, effectiveTopSpeed(car));
  if (absDiff > 2.4) cap = Math.min(cap, 60);
  else if (absDiff > 1.2) cap = Math.min(cap, 140);
  else if (absDiff > 0.6) cap = Math.min(cap, 220);
  if (nextDiff > 0.9) cap = Math.min(cap, 200);
  if (nextDiff > 1.5) cap = Math.min(cap, 120);

  // Accelerate / brake toward the capped speed.
  if (car.speed < cap) {
    car.speed = Math.min(cap, car.speed + car.accel * dt);
  } else if (car.speed > cap) {
    car.speed = Math.max(cap, car.speed - effectiveBrake(car) * dt);
  }

  // Radius-based steering with guaranteed minimum turn authority even
  // at low speed, plus crawl-forward turns: the car always turns at
  // least a little while moving, and can creep forward while turning.
  const radius = effectiveTurnRadius(car);
  const moving = Math.max(Math.abs(car.speed), 60); // min authority
  let turnRate = moving / radius;
  // Cap the turn rate so high-speed turns stay inside the road.
  turnRate = Math.min(turnRate, 2.4);
  const maxTurn = turnRate * dt;
  const applied = Math.sign(diff) * Math.min(maxTurn, absDiff);
  car.angle += applied;
  // Crawl-forward: if barely moving but still needs to turn, creep.
  if (Math.abs(car.speed) < 24 && absDiff > 0.15) {
    car.speed = Math.min(car.speed + 40 * dt, 24);
  }

  // Reversing to unwedge.
  if (car.reverseTimer > 0) {
    car.reverseTimer -= dt;
    const back = -90 * dt;
    const res = moveWithCollision(world, car.x, car.y, Math.cos(car.angle) * back, Math.sin(car.angle) * back, 16);
    car.x = res.x;
    car.y = res.y;
    car.speed = -90;
    return;
  }

  // Move forward with wall sliding.
  const step = car.speed * dt;
  const res = moveWithCollision(world, car.x, car.y, Math.cos(car.angle) * step, Math.sin(car.angle) * step, 16);
  const moved = Math.hypot(res.x - car.x, res.y - car.y);
  car.x = res.x;
  car.y = res.y;
  if (res.hitX || res.hitY) {
    car.speed *= 0.6; // scrub speed on a wall hit
    // Wall damage ticks at most once per 0.5s. The old clock read
    // G.time.now, which nothing ever sets, so the throttle never
    // engaged (a 0 timestamp is falsy and re-armed every frame).
    if ((car._wallDamageCd || 0) <= 0) {
      car._wallDamageCd = 0.5;
      car.damage += 1;
      car.hp = Math.max(0, car.hp - 1);
    }
  }
  // Stuck detection: intended to move but barely displaced.
  if (Math.abs(car.speed) > 40 && moved < Math.abs(step) * 0.25) {
    car.stuckTimer += dt;
    if (car.stuckTimer > 1.5) {
      car.stuckTimer = 0;
      car.reverseTimer = 0.8; // reverse straight to unwedge
    }
  } else {
    car.stuckTimer = Math.max(0, car.stuckTimer - dt * 2);
  }
  car.lastX = car.x;
  car.lastY = car.y;
}

export function init(G) {
  G.vehicles = G.vehicles || {};
  if (!Array.isArray(G.vehicles.list)) G.vehicles.list = [];
  return G.vehicles;
}

function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

// Manual driving: integrate the intent player.js wrote on the car
// (car.throttle -1..1, car.steer -1..1, car.brake bool). This is the
// ONLY place a player-driven car moves. Negative throttle brakes while
// moving forward and reverses only from (near-)standstill, so the
// autopilot's S-key braking and a human's S-key reversing both behave.
// Steering is radius-based like driveToward, with the same minimum
// turn authority at low speed.
function driveManual(car, G, dt) {
  const world = G.world;
  const step = typeof dt === 'number' && dt > 0 ? dt : 0.016;
  car._wallDamageCd = Math.max(0, (car._wallDamageCd || 0) - step);

  // Unwedge: while the car is reversing out of a jam, nothing else
  // drives it — it backs straight along its own heading for the
  // duration, then normal intent resumes.
  if ((car.reverseTimer || 0) > 0) {
    car.reverseTimer -= step;
    const back = -90 * step;
    const res = moveWithCollision(world, car.x, car.y, Math.cos(car.angle) * back, Math.sin(car.angle) * back, 16);
    car.x = res.x;
    car.y = res.y;
    car.speed = -90;
    car.lastX = car.x;
    car.lastY = car.y;
    return;
  }
  const throttle = num(car.throttle !== undefined ? car.throttle : car.inputThrottle, 0);
  const steer = num(car.steer !== undefined ? car.steer : car.inputSteer, 0);
  const brake = !!(car.brake || car.inputBrake);
  const top = effectiveTopSpeed(car);

  if (brake) {
    // Strong deceleration toward a stop.
    const dec = effectiveBrake(car) * step;
    car.speed = car.speed > 0 ? Math.max(0, car.speed - dec)
      : car.speed < 0 ? Math.min(0, car.speed + dec) : 0;
  } else if (throttle > 0) {
    car.speed = Math.min(top, car.speed + car.accel * step);
  } else if (throttle < 0) {
    if (car.speed > 30) car.speed = Math.max(0, car.speed - effectiveBrake(car) * step);
    else car.speed = Math.max(-140, car.speed - car.accel * step);
  } else {
    // No input: coast down with drag.
    const drag = 260 * step;
    car.speed = car.speed > 0 ? Math.max(0, car.speed - drag)
      : car.speed < 0 ? Math.min(0, car.speed + drag) : 0;
  }

  // Radius-based steering with minimum turn authority at low speed.
  if (steer !== 0 && Math.abs(car.speed) > 1) {
    const radius = effectiveTurnRadius(car);
    const moving = Math.max(Math.abs(car.speed), 60);
    const turnRate = Math.min(moving / radius, 2.4);
    car.angle += steer * turnRate * step;
  }

  const wantStep = car.speed * step;
  const prevX = car.x;
  const prevY = car.y;
  const res = moveWithCollision(world, car.x, car.y, Math.cos(car.angle) * wantStep, Math.sin(car.angle) * wantStep, 16);
  car.x = res.x;
  car.y = res.y;
  if (res.hitX || res.hitY) {
    car.speed *= 0.6; // scrub speed on a wall hit
    if (car._wallDamageCd <= 0) {
      car._wallDamageCd = 0.5;
      car.damage = (car.damage || 0) + 1;
      car.hp = Math.max(0, (car.hp || 100) - 1);
    }
  }
  // Stuck detection (the same rule the road-following driver uses):
  // trying to move fast but barely displaced means wedged — back
  // straight out. Without this, a car grinding a building wall under
  // throttle stays there forever: the probe watched one sit at 7 u/s
  // for 40+ seconds at the m2 start.
  const moved = Math.hypot(car.x - prevX, car.y - prevY);
  if (Math.abs(car.speed) > 40 && moved < Math.abs(wantStep) * 0.25) {
    car.stuckTimer = (car.stuckTimer || 0) + step;
    if (car.stuckTimer > 1.5) {
      car.stuckTimer = 0;
      car.reverseTimer = 0.8;
    }
  } else {
    car.stuckTimer = Math.max(0, (car.stuckTimer || 0) - step * 2);
  }
  car.lastX = car.x;
  car.lastY = car.y;
}

export function update(G, dt) {
  // Vehicles with no driver and no route sit parked; the traffic
  // module drives traffic cars. Player-driven cars are integrated here
  // from the intent player.js wrote (car.throttle / steer / brake) —
  // this is the single owner of player-car motion.
  const list = (G.vehicles && G.vehicles.list) || [];
  for (const car of list) {
    if (!car) continue;
    // Parked cars never move.
    if (car.parked) { car.speed = 0; continue; }
    // The player car: drive it from manual intent.
    if (car.driver === 'player') { driveManual(car, G, dt); continue; }
    // Traffic / courier / autopilot cars are driven by their owners
    // (traffic.js / missions / autopilot call driveToward directly).
  }
}

export function draw(G, ctx) {
  // Cars are drawn by render.js (single draw pass). This is a no-op
  // kept for the module contract.
}

export default { init, update, draw, createCar, driveToward, setRoute, maybeRebuildRoute, effectiveTopSpeed, CAR_TYPES };
