// Crescent Bay — shared constants. Everything the modules agree on lives
// here so no module hard-codes a world size, a road position, or a wanted
// threshold of its own. Values come from the prose spec, not from old code.

// World geometry: a 3200x3200 city on an 8x8 road grid.
export const WORLD_SIZE = 3200;
export const WORLD_WIDTH = 3200;
export const WORLD_HEIGHT = 3200;
export const ROAD_COUNT = 8;
export const ROAD_SPACING = 400;
export const ROAD_FIRST = 200;
export const ROAD_WIDTH = 64;
export const ROAD_HALF = ROAD_WIDTH / 2;

// Road centre lines: 200, 600, 1000, 1400, 1800, 2200, 2600, 3000.
export const ROADS = Array.from({ length: ROAD_COUNT }, (_, i) => ROAD_FIRST + i * ROAD_SPACING);

// Deterministic RNG seed for the whole city.
export const SEED = 20261118;

// Districts, west to east / north to south. Each entry gives the district
// name, its rectangle in world units, and its flavour for the renderer.
export const DISTRICTS = [
  { name: 'Northside',  x0: 0,    y0: 0,    x1: 1600, y1: 1600, kind: 'houses' },
  { name: 'Old Town',   x0: 1600, y0: 0,    x1: 3200, y1: 1600, kind: 'brick' },
  { name: 'Downtown',   x0: 0,    y0: 1600, x1: 1600, y1: 3200, kind: 'towers' },
  { name: 'Waterfront', x0: 1600, y0: 1600, x1: 3060, y1: 3200, kind: 'sand' },
  { name: 'South Docks',x0: 2600, y0: 2400, x1: 3200, y1: 3200, kind: 'industrial' },
];

// Beach and water hug the east edge of the map.
export const BEACH_X = 3060;
export const WATER_X = 3120;

// Wanted stars: heat thresholds. Index = star count (0..5).
// heat 0-11: 0 stars, 12-29: 1, 30-51: 2, 52-73: 3, 74-91: 4, 92+: 5.
export const WANTED_THRESHOLDS = [0, 12, 30, 52, 74, 92];
export const MAX_WANTED = 5;
export const MAX_HEAT = 100;

// Heat decay: only while no police unit is within this range for this long.
export const HEAT_DECAY_RANGE = 450;
export const HEAT_DECAY_DELAY = 3; // seconds of hiding before decay starts

// Spray Shop: repaint clears heat fast inside this radius.
export const SPRAY_RADIUS = 150;
export const SPRAY_HEAT_DRAIN = 50; // heat per second

// Police rules from the spec.
export const ARREST_RANGE = 30;      // foot cop must stay this close...
export const ARREST_HOLD_TIME = 1.2; // ...for this long, to a slow on-foot player
export const HELI_MIN_STARS = 3;     // helicopter spawns at 3 stars and above
export const HELI_RETREAT_TIME = 20; // seconds a smoked helicopter stays away

// Player tuning.
export const PLAYER_WALK_SPEED = 170;
export const PLAYER_SPRINT_SPEED = 260;
export const PLAYER_RADIUS = 14;
export const PLAYER_MAX_HEALTH = 100;

// Weapons (damage / rate / range) — see weapons.js for the full tables.
export const WEAPONS = {
  pistol:  { name: 'Pistol',  damage: 18, fireInterval: 0.28, range: 420, startAmmo: 48 },
  smg:     { name: 'SMG',     damage: 10, fireInterval: 0.09, range: 360, startAmmo: 120 },
  shotgun: { name: 'Shotgun', damage: 8,  pellets: 5, fireInterval: 0.8, range: 240, startAmmo: 24 },
};
export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];

// Mission arc: 12 missions, linear order, fixer, reward, time limit.
export const MISSIONS = [
  { id: 'm1',  name: 'First Job',    fixer: 'Mara', reward: 400,  limit: 300 },
  { id: 'm2',  name: 'Tail Chase',   fixer: 'Mara', reward: 700,  limit: 300 },
  { id: 'm3',  name: 'Hot Wheels',   fixer: 'Dex',  reward: 900,  limit: 240 },
  { id: 'm4',  name: 'Dockside',     fixer: 'Mara', reward: 1100, limit: 360 },
  { id: 'm5',  name: 'Midnight Run', fixer: 'Dex',  reward: 1400, limit: 300 },
  { id: 'm6',  name: 'Collector',    fixer: 'Mara', reward: 1800, limit: 420 },
  { id: 'm7',  name: 'Highway Heat', fixer: 'Dex',  reward: 4600, limit: 420 },
  { id: 'm8',  name: 'Crescent Job', fixer: 'Mara', reward: 6200, limit: 600 },
  { id: 'm9',  name: 'Sky Watch',    fixer: 'Dex',  reward: 2000, limit: 420 },
  { id: 'm10', name: 'Full Auto',    fixer: 'Mara', reward: 2500, limit: 420 },
  { id: 'm11', name: 'Tune-Up',      fixer: 'Dex',  reward: 3000, limit: 420 },
  { id: 'm12', name: 'Bay Finale',   fixer: 'Mara', reward: 8000, limit: 600 },
];

// Save slots.
export const SAVE_SLOTS = 3;
export const SAVE_VERSION = 1;

// Day/night: hour 0-24. Night roughly 20:00-06:00.
export const DAY_LENGTH = 600; // seconds for a full day cycle

export function wantedStars(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED_THRESHOLDS.length; i++) {
    if (heat >= WANTED_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function nearestRoadCoord(v) {
  let best = ROADS[0];
  let bestD = Math.abs(v - ROADS[0]);
  for (const r of ROADS) {
    const d = Math.abs(v - r);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
