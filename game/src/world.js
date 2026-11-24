// world.js — Crescent Bay: road graph, districts, buildings, beach/water.
// Written fresh in-session from the prose spec. No prior game code read.
// City: 3200x3200. 8x8 road grid, roads at 200 + i*400, width 64.
// Junction indexing (CRITICAL — never transpose): id = gy * 8 + gx,
// where gx is the x (column) index and gy is the y (row) index.
// x = 200 + gx * 400, y = 200 + gy * 400.

export const WORLD_SIZE = 3200;
export const ROAD_COUNT = 8;
export const ROAD_WIDTH = 64;
export const ROAD_HALF = 32;

export function roadCoord(i) {
  return 200 + i * 400;
}

export function junctionId(gx, gy) {
  return gy * ROAD_COUNT + gx;
}

export function junctionXY(id) {
  const gx = id % ROAD_COUNT;
  const gy = Math.floor(id / ROAD_COUNT);
  return { x: roadCoord(gx), y: roadCoord(gy), gx, gy };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// District by position. Waterfront east, South Docks south,
// Downtown centre, Northside north, Old Town the rest.
export function districtAt(x, y) {
  if (x >= 2500) return 'waterfront';
  if (y >= 2500) return 'docks';
  if (x >= 1200 && x < 2000 && y >= 1200 && y < 2000) return 'downtown';
  if (y < 800) return 'northside';
  return 'oldtown';
}

const DISTRICT_STYLE = {
  northside: { palette: ['#c9a37e', '#b98d68', '#d4b48f', '#a8b6c4', '#c2b280'], roof: '#7a5a44', kind: 'house', min: 2, max: 4, hMin: 10, hMax: 16 },
  oldtown: { palette: ['#9c5f4a', '#8a4f3d', '#a5715a', '#7d5a4e'], roof: '#5d4038', kind: 'brick', min: 2, max: 3, hMin: 14, hMax: 26 },
  downtown: { palette: ['#7fa8c9', '#6b9cc4', '#8fb4d4', '#5f8fb5'], roof: '#3d5a76', kind: 'tower', min: 1, max: 2, hMin: 34, hMax: 64 },
  waterfront: { palette: ['#e0c896', '#d9bd85', '#e8d5a8', '#cbb27a'], roof: '#a8895a', kind: 'house', min: 2, max: 3, hMin: 10, hMax: 20 },
  docks: { palette: ['#8a8f96', '#7c828a', '#969ba2', '#6f757d'], roof: '#4a4f55', kind: 'industrial', min: 1, max: 3, hMin: 12, hMax: 22 },
};

function makeBuildings(rng) {
  const buildings = [];
  // Blocks sit between roads: block (bx, by) spans the square between
  // road bx and road bx+1 (same for y). Inset 44 from each road edge
  // so buildings never touch the road.
  for (let by = 0; by < ROAD_COUNT - 1; by++) {
    for (let bx = 0; bx < ROAD_COUNT - 1; bx++) {
      const x0 = roadCoord(bx) + 44;
      const y0 = roadCoord(by) + 44;
      const x1 = roadCoord(bx + 1) - 44;
      const y1 = roadCoord(by + 1) - 44;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // East edge: beach + water starts at x > 3060; the last column of
      // blocks ends at 2956, so no building ever sits in the water.
      const district = districtAt(cx, cy);
      const style = DISTRICT_STYLE[district];
      const n = style.min + Math.floor(rng.next() * (style.max - style.min + 1));
      const bw = (x1 - x0);
      const bh = (y1 - y0);
      if (n === 1) {
        const w = bw * (0.55 + rng.next() * 0.25);
        const h = bh * (0.55 + rng.next() * 0.25);
        buildings.push(makeBuilding(rng, cx - w / 2, cy - h / 2, w, h, district, style));
      } else if (n === 2) {
        const vertical = rng.next() < 0.5;
        for (let k = 0; k < 2; k++) {
          const w = vertical ? bw * 0.8 : bw * 0.38;
          const h = vertical ? bh * 0.38 : bh * 0.8;
          const x = vertical ? x0 + bw * 0.1 : x0 + (k === 0 ? bw * 0.06 : bw * 0.56);
          const y = vertical ? y0 + (k === 0 ? bh * 0.06 : bh * 0.56) : y0 + bh * 0.1;
          buildings.push(makeBuilding(rng, x, y, w, h, district, style));
        }
      } else {
        // 2x2 small buildings (houses).
        const gw = bw / 2;
        const gh = bh / 2;
        for (let gy = 0; gy < 2; gy++) {
          for (let gx = 0; gx < 2; gx++) {
            const w = gw * (0.62 + rng.next() * 0.2);
            const h = gh * (0.62 + rng.next() * 0.2);
            const x = x0 + gx * gw + (gw - w) / 2;
            const y = y0 + gy * gh + (gh - h) / 2;
            buildings.push(makeBuilding(rng, x, y, w, h, district, style));
          }
        }
      }
    }
  }
  return buildings;
}

function makeBuilding(rng, x, y, w, h, district, style) {
  const color = style.palette[Math.floor(rng.next() * style.palette.length)];
  const height = style.hMin + rng.next() * (style.hMax - style.hMin);
  return {
    x, y, w, h, district, kind: style.kind, color, roof: style.roof,
    height,
    // 2.5D: sun from the north-west, so the south/east sides are darker
    // and the shadow falls to the south-east.
    shade: 0.72 + rng.next() * 0.12,
  };
}

// Named places, all snapped onto road points so missions/autopilot can
// drive to them. Coordinates are junction-adjacent road positions.
export function makePlaces() {
  return {
    hideout: { x: 600, y: 2600, label: 'Hideout' },
    market: { x: 600, y: 600, label: 'Market' },
    downtown: { x: 1800, y: 1400, label: 'Downtown' },
    club: { x: 1400, y: 1000, label: 'Club' },
    marina: { x: 3000, y: 1800, label: 'Marina' },
    airport: { x: 1000, y: 3000, label: 'Airport' },
    docks: { x: 2200, y: 3000, label: 'Docks' },
    sprayShop: { x: 2600, y: 600, label: 'Spray Shop' },
    garage: { x: 1000, y: 2200, label: 'Fixer Garage' },
    bank: { x: 1800, y: 1800, label: 'Bank' },
    gunStore: { x: 1000, y: 1400, label: 'Gun Store' },
    pier: { x: 3080, y: 2200, label: 'Pier' },
  };
}

export function buildWorld(rng) {
  const r = rng && typeof rng.next === 'function' ? rng : { next: () => Math.random() };
  const junctions = [];
  for (let gy = 0; gy < ROAD_COUNT; gy++) {
    for (let gx = 0; gx < ROAD_COUNT; gx++) {
      junctions.push({ id: junctionId(gx, gy), gx, gy, x: roadCoord(gx), y: roadCoord(gy) });
    }
  }
  // Adjacency: 4-neighbour grid, indexed by the same junctionId.
  const neighbours = junctions.map((j) => {
    const out = [];
    if (j.gx > 0) out.push(junctionId(j.gx - 1, j.gy));
    if (j.gx < ROAD_COUNT - 1) out.push(junctionId(j.gx + 1, j.gy));
    if (j.gy > 0) out.push(junctionId(j.gx, j.gy - 1));
    if (j.gy < ROAD_COUNT - 1) out.push(junctionId(j.gx, j.gy + 1));
    return out;
  });
  const world = {
    size: WORLD_SIZE,
    roadWidth: ROAD_WIDTH,
    junctions,
    neighbours,
    buildings: makeBuildings(r),
    places: makePlaces(),
    // Beach sand strip then open water at the east edge (x > 3060).
    beach: { x0: 3000, x1: 3060 },
    water: { x0: 3060, x1: WORLD_SIZE },
    // Marina pier juts east into the water.
    pier: { x: 3000, y: 2140, w: 180, h: 120 },
  };
  return world;
}

// ---- Routing ------------------------------------------------------------

// BFS on the junction graph. Visited set + parent map, bounded loop:
// the parent walk can never cycle because each node is visited once.
export function bfsPath(world, startId, goalId) {
  if (startId === goalId) return [startId];
  const prev = new Map();
  const seen = new Set([startId]);
  const queue = [startId];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const nb of world.neighbours[cur]) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === goalId) {
        const path = [goalId];
        let node = goalId;
        let guard = 0;
        while (node !== startId && guard++ < 256) {
          node = prev.get(node);
          path.unshift(node);
        }
        return path;
      }
      queue.push(nb);
    }
  }
  return [startId, goalId]; // unreachable (should not happen on a grid)
}

export function nearestJunction(world, x, y) {
  let best = world.junctions[0];
  let bestD = Infinity;
  for (const j of world.junctions) {
    const dx = j.x - x;
    const dy = j.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

// Nearest point on any road centreline, clamped inside the world.
// Roads run the full span 200..3000 on each axis; the result is always
// a legal on-road point, never outside the world edge.
export function nearestRoadPoint(world, x, y) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < ROAD_COUNT; i++) {
    const c = roadCoord(i);
    // Vertical road x = c, y clamped to the road span.
    const vy = clamp(y, 200, 3000);
    const dv = (x - c) * (x - c) + (y - vy) * (y - vy);
    if (dv < bestD) { bestD = dv; best = { x: c, y: vy }; }
    // Horizontal road y = c, x clamped to the road span.
    const hx = clamp(x, 200, 3000);
    const dh = (x - hx) * (x - hx) + (y - c) * (y - c);
    if (dh < bestD) { bestD = dh; best = { x: hx, y: c }; }
  }
  return best;
}

export function isOnRoad(world, x, y) {
  for (let i = 0; i < ROAD_COUNT; i++) {
    const c = roadCoord(i);
    if (Math.abs(x - c) <= ROAD_HALF && y >= 200 - ROAD_HALF && y <= 3000 + ROAD_HALF) return true;
    if (Math.abs(y - c) <= ROAD_HALF && x >= 200 - ROAD_HALF && x <= 3000 + ROAD_HALF) return true;
  }
  return false;
}

// Full route from any point to any point.
// Waypoints: [first junction near start, ...BFS junctions..., target].
// The FIRST junction is always the first waypoint — never cut
// diagonally across a block. Off-road starts recover to the nearest
// road point first, then to the nearest junction.
export function findRoute(world, sx, sy, tx, ty) {
  const startRoad = nearestRoadPoint(world, sx, sy);
  const startJ = nearestJunction(world, startRoad.x, startRoad.y);
  const endRoad = nearestRoadPoint(world, tx, ty);
  const endJ = nearestJunction(world, endRoad.x, endRoad.y);
  const ids = bfsPath(world, startJ.id, endJ.id);
  const points = [];
  // If the start is off-road, the road point comes first.
  if (Math.hypot(startRoad.x - sx, startRoad.y - sy) > 4) {
    points.push({ x: startRoad.x, y: startRoad.y });
  }
  for (const id of ids) {
    const j = junctionXY(id);
    const lastPt = points[points.length - 1];
    if (lastPt && Math.abs(lastPt.x - j.x) < 1 && Math.abs(lastPt.y - j.y) < 1) continue;
    points.push({ x: j.x, y: j.y });
  }
  // Final leg: end road point (if the target is off-road) then target.
  const endPt = { x: clamp(tx, 0, WORLD_SIZE), y: clamp(ty, 0, WORLD_SIZE) };
  const last = points[points.length - 1];
  if (Math.hypot(endRoad.x - endPt.x, endRoad.y - endPt.y) > 4) {
    if (Math.hypot(endRoad.x - last.x, endRoad.y - last.y) > 4) {
      points.push({ x: endRoad.x, y: endRoad.y });
    }
    points.push(endPt);
  } else if (Math.hypot(endPt.x - last.x, endPt.y - last.y) > 4) {
    points.push(endPt);
  }
  return points;
}

// ---- Collision ----------------------------------------------------------

export function pointInBuilding(world, x, y, pad) {
  const p = pad || 0;
  for (const b of world.buildings) {
    if (x >= b.x - p && x <= b.x + b.w + p && y >= b.y - p && y <= b.y + b.h + p) return b;
  }
  return null;
}

export function inWater(world, x, y) {
  return x > world.water.x0;
}

// Move a circle (radius r) by (dx, dy) with axis-separated sliding:
// try x then y so a wall collision slides along the wall instead of
// sticking. Returns { x, y, hitX, hitY, hitBuilding }.
export function moveWithCollision(world, x, y, dx, dy, r) {
  let hitX = false;
  let hitY = false;
  let hitBuilding = null;
  const nx = clamp(x + dx, r, WORLD_SIZE - r);
  if (!pointInBuilding(world, nx, y, r) && !inWater(world, nx, y)) {
    x = nx;
  } else {
    hitX = true;
    hitBuilding = pointInBuilding(world, nx, y, r);
  }
  const ny = clamp(y + dy, r, WORLD_SIZE - r);
  if (!pointInBuilding(world, x, ny, r) && !inWater(world, x, ny)) {
    y = ny;
  } else {
    hitY = true;
    if (!hitBuilding) hitBuilding = pointInBuilding(world, x, ny, r);
  }
  return { x, y, hitX, hitY, hitBuilding };
}

// ---- Module contract ----------------------------------------------------

export function init(G) {
  G.world = buildWorld(G.rng);
  return G.world;
}

export function update(G, dt) {
  // Static world: nothing per frame.
}

export default { init, update, buildWorld, findRoute, nearestJunction, nearestRoadPoint, bfsPath, districtAt };
