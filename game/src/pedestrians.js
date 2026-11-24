// pedestrians.js — Crescent Bay pedestrians.
// Written fresh in-session from the prose spec. No prior game code read.
//
// Pedestrians walk the sidewalks and flee when scared. Variety:
// different colours and walking speeds, some in pairs (a pair shares
// a destination and walks side by side).

import { nearestRoadPoint, roadCoord, clamp } from './world.js';

const PED_COLORS = ['#d8c8a8', '#c96a5a', '#5a7ac9', '#7ac95a', '#c9a85a', '#9e5ac9', '#e8e8e8', '#4a4a4a', '#c95a8a'];
const SIDEWALK_OFFSET = 46; // just outside the 32-wide road half + kerb

function sidewalkPoint(G, x, y) {
  // Snap onto the sidewalk beside the nearest road: offset the road
  // point perpendicular to the road by SIDEWALK_OFFSET.
  const rng = G.rng || { next: () => Math.random() };
  const rp = nearestRoadPoint(G.world, x, y);
  // Decide whether the nearest road is vertical or horizontal by which
  // coordinate matches a road line.
  let vertical = false;
  for (let i = 0; i < 8; i++) {
    if (Math.abs(rp.x - roadCoord(i)) < 1) { vertical = true; break; }
  }
  const side = rng.next() < 0.5 ? -1 : 1;
  if (vertical) {
    return { x: clamp(rp.x + side * SIDEWALK_OFFSET, 0, 3200), y: clamp(rp.y, 0, 3200) };
  }
  return { x: clamp(rp.x, 0, 3200), y: clamp(rp.y + side * SIDEWALK_OFFSET, 0, 3200) };
}

function randomSidewalkPoint(G) {
  const rng = G.rng || { next: () => Math.random() };
  const x = 200 + rng.next() * 2800;
  const y = 200 + rng.next() * 2800;
  return sidewalkPoint(G, x, y);
}

export function createPed(G, x, y, pairId) {
  const rng = G.rng || { next: () => Math.random() };
  const p = {
    x, y,
    angle: rng.next() * Math.PI * 2,
    color: PED_COLORS[Math.floor(rng.next() * PED_COLORS.length)],
    // Variety: walking speed 28..62.
    speed: 28 + rng.next() * 34,
    walkSpeed: 0,
    dest: null,
    pairId: pairId || null,
    fleeing: false,
    fleeX: 0, fleeY: 0,
    fleeTimer: 0,
    pauseTimer: rng.next() * 2,
  };
  p.walkSpeed = p.speed;
  p.dest = randomSidewalkPoint(G);
  return p;
}

export function init(G) {
  G.peds = G.peds || {};
  if (!Array.isArray(G.peds.list)) G.peds.list = [];
  if (!G.peds.seeded) {
    G.peds.seeded = true;
    const rng = G.rng || { next: () => Math.random() };
    // ~40 pedestrians; about a quarter walk in pairs.
    let pairCounter = 0;
    for (let i = 0; i < 40; i++) {
      const pt = randomSidewalkPoint(G);
      if (rng.next() < 0.25) {
        const pairId = ++pairCounter;
        const a = createPed(G, pt.x, pt.y, pairId);
        const b = createPed(G, pt.x + 12, pt.y + 8, pairId);
        // A pair shares one destination.
        b.dest = a.dest;
        b.speed = a.speed;
        b.walkSpeed = a.walkSpeed;
        G.peds.list.push(a, b);
        i++;
      } else {
        G.peds.list.push(createPed(G, pt.x, pt.y, null));
      }
    }
  }
  return G.peds;
}

// A pedestrian is scared by nearby gunfire / a nearby speeding car /
// high wanted heat close to the player. `threat` is {x, y} or null.
export function scarePeds(G, threat, radius) {
  const list = (G.peds && G.peds.list) || [];
  const r = radius || 260;
  for (const p of list) {
    if (!p) continue;
    const dx = p.x - threat.x;
    const dy = p.y - threat.y;
    const d = Math.hypot(dx, dy);
    if (d < r) {
      p.fleeing = true;
      p.fleeTimer = 2.5 + Math.random() * 1.5;
      // Flee directly away from the threat.
      const len = Math.max(d, 1);
      p.fleeX = p.x + (dx / len) * 300;
      p.fleeY = p.y + (dy / len) * 300;
      p.fleeX = clamp(p.fleeX, 40, 3160);
      p.fleeY = clamp(p.fleeY, 40, 3160);
    }
  }
}

export function update(G, dt) {
  const list = (G.peds && G.peds.list) || [];
  const pl = G.player;
  // Global scare: gunfire near the player scares nearby pedestrians.
  if (G.combat && G.combat.lastShotAt && (G.time && G.time.now || 0) - G.combat.lastShotAt < 0.5) {
    if (pl && typeof pl.x === 'number') scarePeds(G, { x: pl.x, y: pl.y }, 300);
  }
  for (const p of list) {
    if (!p) continue;
    let tx;
    let ty;
    let spd = p.walkSpeed;
    if (p.fleeing) {
      tx = p.fleeX;
      ty = p.fleeY;
      spd = p.walkSpeed * 2.6; // fleeing runs
      p.fleeTimer -= dt;
      if (p.fleeTimer <= 0) {
        p.fleeing = false;
        p.dest = randomSidewalkPoint(G);
      }
    } else {
      if (p.pauseTimer > 0) {
        p.pauseTimer -= dt;
        continue;
      }
      if (!p.dest) p.dest = randomSidewalkPoint(G);
      tx = p.dest.x;
      ty = p.dest.y;
      const dx = tx - p.x;
      const dy = ty - p.y;
      if (dx * dx + dy * dy < 20 * 20) {
        // Reached the destination: pick a new one, sometimes pause.
        // A pair picks a new shared destination together.
        if (p.pairId) {
          const nd = randomSidewalkPoint(G);
          for (const q of list) {
            if (q && q.pairId === p.pairId) q.dest = nd;
          }
        } else {
          p.dest = randomSidewalkPoint(G);
        }
        p.pauseTimer = Math.random() < 0.3 ? 1 + Math.random() * 2 : 0;
        continue;
      }
    }
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      p.angle = Math.atan2(dy, dx);
      const step = Math.min(spd * dt, d);
      // Pedestrians stay on sidewalks: they walk point to point along
      // sidewalk points, so no building collision is needed; clamp to
      // the world and skip steps that would enter a building.
      const nx = p.x + (dx / d) * step;
      const ny = p.y + (dy / d) * step;
      if (G.world) {
        const blocked = G.world.buildings.some(
          (b) => nx > b.x - 6 && nx < b.x + b.w + 6 && ny > b.y - 6 && ny < b.y + b.h + 6
        );
        if (!blocked) { p.x = nx; p.y = ny; }
        else { p.dest = randomSidewalkPoint(G); }
      } else {
        p.x = nx;
        p.y = ny;
      }
    }
  }
}

export function draw(G, ctx) {
  // Pedestrians are drawn by render.js (single draw pass).
}

export default { init, update, draw, createPed, scarePeds };
