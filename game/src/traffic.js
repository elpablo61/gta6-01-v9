// traffic.js — Crescent Bay traffic.
// Written fresh in-session from the prose spec. No prior game code read.
//
// Traffic follows the road graph (BFS routes from world.js) and slows
// behind the car ahead. A carjacked car rebuilds its route whenever its
// target moves >100 from the route's recorded destination (never every
// frame — the every-frame rebuild froze m2 in v4 builder 1).
// Traffic density varies by time of day: busier midday, quieter night.

import { createCar, driveToward, setRoute, maybeRebuildRoute, effectiveTopSpeed } from './vehicles.js';
import { nearestRoadPoint, nearestJunction, roadCoord, clamp } from './world.js';

const TRAFFIC_TYPES = ['sedan', 'sedan', 'taxi', 'truck', 'sports', 'sedan', 'taxi'];

// Density factor by hour: 1.0 midday, ~0.35 deep night.
export function densityFactor(G) {
  let h = 12;
  if (G.time && typeof G.time.hours === 'number') h = G.time.hours;
  else if (G.time && typeof G.time.t === 'number') h = (G.time.t % 24 + 24) % 24;
  if (h >= 10 && h < 16) return 1.0;
  if (h >= 7 && h < 10) return 0.8;
  if (h >= 16 && h < 19) return 0.85;
  if (h >= 19 && h < 22) return 0.6;
  if (h >= 22 || h < 5) return 0.35;
  return 0.5; // 5..7 dawn
}

export function baseTrafficCount(G) {
  return 26;
}

export function targetTrafficCount(G) {
  return Math.round(baseTrafficCount(G) * densityFactor(G));
}

function randomRoadPoint(G) {
  const rng = G.rng || { next: () => Math.random() };
  const i = Math.floor(rng.next() * 8);
  const along = 200 + rng.next() * 2800;
  if (rng.next() < 0.5) return { x: roadCoord(i), y: along };
  return { x: along, y: roadCoord(i) };
}

function randomDestination(G) {
  const p = randomRoadPoint(G);
  return { x: clamp(p.x, 200, 3000), y: clamp(p.y, 200, 3000) };
}

export function spawnTrafficCar(G) {
  const rng = G.rng || { next: () => Math.random() };
  const type = TRAFFIC_TYPES[Math.floor(rng.next() * TRAFFIC_TYPES.length)];
  const p = randomRoadPoint(G);
  // Face along the road: pick a random cardinal direction.
  const angle = [0, Math.PI / 2, Math.PI, -Math.PI / 2][Math.floor(rng.next() * 4)];
  const car = createCar(G, type, p.x, p.y, angle);
  car.driver = 'traffic';
  // Traffic cruises below top speed so the player can pass.
  car.cruise = effectiveTopSpeed(car) * (0.45 + rng.next() * 0.2);
  const dest = randomDestination(G);
  setRoute(car, G, dest.x, dest.y);
  return car;
}

export function init(G) {
  G.traffic = G.traffic || {};
  if (!Array.isArray(G.traffic.list)) G.traffic.list = [];
  // Seed the initial population (traffic cars also live in G.vehicles.list).
  if (!G.traffic.seeded) {
    G.traffic.seeded = true;
    const n = targetTrafficCount(G);
    for (let i = 0; i < n; i++) {
      const car = spawnTrafficCar(G);
      G.traffic.list.push(car);
      if (G.vehicles && Array.isArray(G.vehicles.list)) G.vehicles.list.push(car);
    }
  }
  return G.traffic;
}

// Find the car directly ahead of `car` within `range`, roughly in the
// car's forward direction. Used to slow behind the car ahead.
export function carAhead(G, car, range) {
  const list = (G.vehicles && G.vehicles.list) || [];
  let best = null;
  let bestD = range || 90;
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  for (const other of list) {
    if (!other || other === car || typeof other.x !== 'number') continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const d = Math.hypot(dx, dy);
    if (d < 8 || d > bestD) continue;
    // Must be in front (dot product with heading > 0.7).
    const dot = (dx * fx + dy * fy) / d;
    if (dot < 0.7) continue;
    best = other;
    bestD = d;
  }
  return best;
}

export function update(G, dt) {
  const list = (G.traffic && G.traffic.list) || [];
  const rng = G.rng || { next: () => Math.random() };
  // Density follows the time of day: add or remove cars gradually.
  const target = targetTrafficCount(G);
  if (list.length < target && rng.next() < 0.3) {
    const car = spawnTrafficCar(G);
    list.push(car);
    if (G.vehicles && Array.isArray(G.vehicles.list)) G.vehicles.list.push(car);
  } else if (list.length > target && rng.next() < 0.1) {
    // Remove a car far from the player (never the player's car).
    const pl = G.player;
    let idx = -1;
    let worst = -1;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || (pl && pl.car === c)) continue;
      const d = pl ? Math.hypot(c.x - pl.x, c.y - pl.y) : 9999;
      if (d > worst) { worst = d; idx = i; }
    }
    if (idx >= 0 && worst > 900) {
      const removed = list.splice(idx, 1)[0];
      if (G.vehicles && Array.isArray(G.vehicles.list)) {
        const vi = G.vehicles.list.indexOf(removed);
        if (vi >= 0) G.vehicles.list.splice(vi, 1);
      }
    }
  }

  for (const car of list) {
    if (!car) continue;
    // Carjacked cars (driver flagged 'carjacked') chase a moving
    // target: rebuild the route only when the target moved >100 from
    // the route's recorded destination.
    if (car.driver === 'carjacked' && car.chaseTarget) {
      maybeRebuildRoute(car, G, car.chaseTarget.x, car.chaseTarget.y);
    }
    // Route finished: pick a new destination and keep driving.
    if (!car.route || car.routeIndex >= car.route.length) {
      const dest = randomDestination(G);
      setRoute(car, G, dest.x, dest.y);
    }
    // Slow behind the car ahead.
    let cap = car.cruise;
    const ahead = carAhead(G, car, 95);
    if (ahead) {
      const gap = Math.hypot(ahead.x - car.x, ahead.y - car.y);
      const aheadSpeed = Math.abs(ahead.speed || 0);
      if (gap < 45) cap = Math.min(cap, aheadSpeed * 0.5);
      else if (gap < 95) cap = Math.min(cap, Math.max(aheadSpeed, 40));
    }
    // A carjacked car driven by the player is never driven here.
    if (G.player && G.player.car === car) continue;
    driveToward(car, G, dt, cap);
  }
}

export function draw(G, ctx) {
  // Cars are drawn by render.js (single draw pass).
}

export default { init, update, draw, spawnTrafficCar, densityFactor, targetTrafficCount, carAhead };
