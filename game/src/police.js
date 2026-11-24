// game/src/police.js — Crescent Bay police: heat, wanted stars, foot cops,
// patrol cars, roadblocks, Spray Shop, arrests.
//
// Fresh from the prose spec (gta6-01-v4-prose-spec.md §1, §3.1). No code
// copied from any earlier version. State lives on the shared G object:
//   G.heat    — 0..100 wanted heat
//   G.wanted  — star level derived from heat, thresholds [0,12,30,52,74,92]
//   G.police  — array of cop entities (foot cops, patrol cars, roadblocks)
//   G.player  — { x, y, speed, onFoot, ... }
//   G.heli    — helicopter state (read-only here: its spotlight blocks decay)
//   G.world   — city; the Spray Shop is found defensively, see findSprayShop.
//
// Cop entity shapes (kept plain so combat / render can use them):
//   foot cop:    { kind:'foot', x, y, angle, speed, hp, maxHp, radius,
//                  slotAngle, arrestTimer }
//   patrol car:  { kind:'car', x, y, angle, speed, hp, maxHp, radius,
//                  reversing }
//   roadblock:   { kind:'roadblock', x, y, angle, speed:0, hp, maxHp,
//                  radius, life }

export const STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];
export const HEAT_MAX = 100;
export const HIDE_RADIUS = 450;      // no police within this => hiding
export const HIDE_DELAY = 3;         // seconds hidden before heat decays
export const HEAT_DECAY_RATE = 6;    // heat per second while hidden
export const SPRAY_RADIUS = 150;     // Spray Shop clears heat inside this
export const SPRAY_DRAIN = 50;       // heat per second inside Spray Shop
export const SPRAY_BRAKE_RADIUS = 130; // patrol cars brake+reverse inside this
export const COP_COLLISION_DAMAGE = 3; // damage per second per patrol car
export const ARREST_RANGE = 30;      // foot cop must stay this close...
export const ARREST_TIME = 1.2;      // ...for this long, in a row...
export const ARREST_MAX_PLAYER_SPEED = 80; // ...to a slow on-foot player
export const COP_SHOT_HEAT = 6;      // heat added when a foot cop is shot

const FOOT_COP_HP = 40;
const FOOT_COP_SPEED = 115;
const FOOT_COP_RADIUS = 14;
const PATROL_CAR_HP = 120;
const PATROL_CAR_RADIUS = 26;
const PATROL_TOP_SPEED = 430;
const PATROL_ACCEL = 300;
const PATROL_TURN = 2.8;
const RING_RADIUS = 150; // shootout perimeter: cops hold a ring, never pile up

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function starsFromHeat(heat) {
  let stars = 0;
  for (let i = 0; i < STAR_THRESHOLDS.length; i++) {
    if (heat >= STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

function worldBounds(G) {
  const w = G.world || {};
  return {
    w: w.width || w.w || 3200,
    h: w.height || w.h || 3200,
  };
}

function clampToWorld(G, x, y) {
  const b = worldBounds(G);
  return { x: clamp(x, 20, b.w - 20), y: clamp(y, 20, b.h - 20) };
}

// The Spray Shop location is owned by the world module; look for it in the
// few shapes it may take and give up gracefully if it is not there yet.
function findSprayShop(G) {
  const w = G.world || {};
  const cands = [
    w.sprayShop,
    w.spray,
    G.sprayShop,
    w.locations && w.locations.sprayShop,
    w.locations && w.locations.spray,
  ];
  for (const c of cands) {
    if (c && typeof c.x === 'number' && typeof c.y === 'number') {
      return { x: c.x, y: c.y };
    }
  }
  return null;
}

function playerPos(G) {
  const p = G.player || {};
  return { x: typeof p.x === 'number' ? p.x : 1600, y: typeof p.y === 'number' ? p.y : 1600 };
}

function playerOnFoot(G) {
  const p = G.player || {};
  if (typeof p.onFoot === 'boolean') return p.onFoot;
  if (typeof p.inCar === 'boolean') return !p.inCar;
  if (typeof p.driving === 'boolean') return !p.driving;
  // No car reference at all => on foot.
  return !(p.car || p.vehicle || p.currentCar);
}

function playerSpeed(G) {
  const p = G.player || {};
  if (typeof p.speed === 'number') return Math.abs(p.speed);
  return 0;
}

function playerVehicle(G) {
  const p = G.player || {};
  return p.car || p.vehicle || p.currentCar || null;
}

function meta(G) {
  if (!G._policeMeta || typeof G._policeMeta !== 'object') {
    G._policeMeta = { hiddenTimer: 0, roadblock: null, spawnAngle: 0 };
  }
  return G._policeMeta;
}

function ensurePoliceArray(G) {
  if (!Array.isArray(G.police)) G.police = [];
  return G.police;
}

function makeFootCop(G, x, y, slotAngle) {
  const p = clampToWorld(G, x, y);
  return {
    kind: 'foot',
    x: p.x, y: p.y,
    angle: 0, speed: 0,
    hp: FOOT_COP_HP, maxHp: FOOT_COP_HP,
    radius: FOOT_COP_RADIUS,
    slotAngle: typeof slotAngle === 'number' ? slotAngle : 0,
    arrestTimer: 0,
    leaving: false,
  };
}

function makePatrolCar(G, x, y) {
  const p = clampToWorld(G, x, y);
  return {
    kind: 'car',
    x: p.x, y: p.y,
    angle: 0, speed: 0,
    hp: PATROL_CAR_HP, maxHp: PATROL_CAR_HP,
    radius: PATROL_CAR_RADIUS,
    reversing: false,
    leaving: false,
  };
}

function makeRoadblockCar(G, x, y, angle) {
  const p = clampToWorld(G, x, y);
  return {
    kind: 'roadblock',
    x: p.x, y: p.y,
    angle: typeof angle === 'number' ? angle : 0,
    speed: 0,
    hp: PATROL_CAR_HP, maxHp: PATROL_CAR_HP,
    radius: PATROL_CAR_RADIUS,
    life: 0,
    leaving: false,
  };
}

// Spawn point on a ring around the player, spread by a rotating angle so
// fresh cops never stack on one spot.
function ringSpawn(G, px, py, minR, maxR) {
  const m = meta(G);
  m.spawnAngle += 2.39996; // golden angle: successive spawns spread out
  const r = minR + ((maxR - minR) * 0.5);
  return clampToWorld(G, px + Math.cos(m.spawnAngle) * r, py + Math.sin(m.spawnAngle) * r);
}

function countKind(cops, kind) {
  let n = 0;
  for (const c of cops) if (c && c.kind === kind && !c.leaving) n++;
  return n;
}

function spawnForWanted(G, stars, px, py) {
  const cops = ensurePoliceArray(G);
  // Foot cops from 1 star.
  const wantFoot = stars >= 1 ? Math.min(1 + stars, 6) : 0;
  let haveFoot = countKind(cops, 'foot');
  while (haveFoot < wantFoot) {
    const s = ringSpawn(G, px, py, 340, 480);
    const slot = (haveFoot / Math.max(1, wantFoot)) * Math.PI * 2;
    cops.push(makeFootCop(G, s.x, s.y, slot));
    haveFoot++;
  }
  // Patrol cars from 2 stars.
  const wantCars = stars >= 2 ? Math.min(stars, 5) : 0;
  let haveCars = countKind(cops, 'car');
  while (haveCars < wantCars) {
    const s = ringSpawn(G, px, py, 380, 520);
    cops.push(makePatrolCar(G, s.x, s.y));
    haveCars++;
  }
  // One roadblock at 4-5 stars, ahead of the player's heading.
  const m = meta(G);
  if (stars >= 4 && !m.roadblock) {
    const p = G.player || {};
    const heading = typeof p.angle === 'number' ? p.angle : 0;
    const ahead = 520;
    const cx = px + Math.cos(heading) * ahead;
    const cy = py + Math.sin(heading) * ahead;
    const perp = heading + Math.PI / 2;
    const block = [];
    for (const off of [-52, 0, 52]) {
      const car = makeRoadblockCar(
        G,
        cx + Math.cos(perp) * off,
        cy + Math.sin(perp) * off,
        perp
      );
      cops.push(car);
      block.push(car);
    }
    m.roadblock = block;
  }
  if (stars < 4 && m.roadblock) {
    for (const car of m.roadblock) car.leaving = true;
    m.roadblock = null;
  }
}

function updateFootCop(G, cop, dt, px, py, onFoot, pSpeed) {
  // Perimeter: hold a ring slot around the player instead of piling on.
  const tx = px + Math.cos(cop.slotAngle) * RING_RADIUS;
  const ty = py + Math.sin(cop.slotAngle) * RING_RADIUS;
  const dTarget = dist(cop.x, cop.y, tx, ty);
  const dPlayer = dist(cop.x, cop.y, px, py);
  if (cop.leaving) {
    const a = angleTo(px, py, cop.x, cop.y); // walk away from the player
    cop.x += Math.cos(a) * FOOT_COP_SPEED * dt;
    cop.y += Math.sin(a) * FOOT_COP_SPEED * dt;
    cop.angle = a;
    cop.speed = FOOT_COP_SPEED;
    return;
  }
  if (dTarget > 12) {
    const a = angleTo(cop.x, cop.y, tx, ty);
    cop.x += Math.cos(a) * FOOT_COP_SPEED * dt;
    cop.y += Math.sin(a) * FOOT_COP_SPEED * dt;
    cop.angle = a;
    cop.speed = FOOT_COP_SPEED;
  } else {
    cop.speed = 0;
  }
  // Arrest: only a foot cop, only a slow on-foot player, only 1.2s in a row.
  if (onFoot && pSpeed < ARREST_MAX_PLAYER_SPEED && dPlayer <= ARREST_RANGE) {
    cop.arrestTimer += dt;
    if (cop.arrestTimer >= ARREST_TIME) {
      arrestPlayer(G);
    }
  } else {
    cop.arrestTimer = 0;
  }
}

function updatePatrolCar(G, car, dt, px, py, spray) {
  const dPlayer = dist(car.x, car.y, px, py);
  if (car.leaving) {
    const a = angleTo(px, py, car.x, car.y);
    car.angle = a;
    car.speed = Math.min(car.speed + PATROL_ACCEL * dt, PATROL_TOP_SPEED);
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    return;
  }
  // Spray Shop: brake and reverse within 130 of it, never push through.
  if (spray && dist(car.x, car.y, spray.x, spray.y) < SPRAY_BRAKE_RADIUS) {
    car.reversing = true;
    const away = angleTo(spray.x, spray.y, car.x, car.y);
    car.angle = away;
    car.speed = -70;
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    if (dist(car.x, car.y, spray.x, spray.y) > SPRAY_BRAKE_RADIUS + 40) {
      car.reversing = false;
    }
    return;
  }
  car.reversing = false;
  // Chase the player: steer toward them, ease off when close (ram, not orbit).
  const wantAngle = angleTo(car.x, car.y, px, py);
  const diff = angleDiff(wantAngle, car.angle);
  const turn = clamp(diff, -PATROL_TURN * dt, PATROL_TURN * dt);
  car.angle += turn;
  const targetSpeed = dPlayer > 90 ? PATROL_TOP_SPEED : Math.max(120, dPlayer * 1.5);
  if (car.speed < targetSpeed) {
    car.speed = Math.min(car.speed + PATROL_ACCEL * dt, targetSpeed);
  } else if (car.speed > targetSpeed) {
    car.speed = Math.max(car.speed - PATROL_ACCEL * 1.5 * dt, targetSpeed);
  }
  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  const c = clampToWorld(G, car.x, car.y);
  car.x = c.x;
  car.y = c.y;
  // Ramming the player's car hurts it: 3 damage per second per car.
  const veh = playerVehicle(G);
  if (veh && typeof veh.hp === 'number' && dPlayer < car.radius + (veh.radius || 24)) {
    veh.hp = Math.max(0, veh.hp - COP_COLLISION_DAMAGE * dt);
  } else if (!veh && typeof G.player.health === 'number' && dPlayer < car.radius + 16) {
    // On foot and run over: same tick rate against player health.
    G.player.health = Math.max(0, G.player.health - COP_COLLISION_DAMAGE * dt);
  }
}

function arrestPlayer(G) {
  const p = G.player || {};
  p.caught = true;
  G.caught = true;
  G.gameOver = 'CAUGHT';
  if (typeof G.onCaught === 'function') {
    try { G.onCaught(G); } catch (e) { /* never let a hook break the update */ }
  }
}

// Heat added by other systems (combat adds +6 when a foot cop is shot;
// missions may add heat of their own). Kept exported so callers share one
// clamp + star recompute path.
export function addHeat(G, amount) {
  if (!G || typeof amount !== 'number') return;
  G.heat = clamp((typeof G.heat === 'number' ? G.heat : 0) + amount, 0, HEAT_MAX);
  G.wanted = starsFromHeat(G.heat);
}

export function init(G) {
  if (!G) return;
  if (typeof G.heat !== 'number') G.heat = 0;
  G.heat = clamp(G.heat, 0, HEAT_MAX);
  G.wanted = starsFromHeat(G.heat);
  ensurePoliceArray(G);
  meta(G);
}

export function update(G, dt) {
  if (!G) return;
  if (typeof dt !== 'number' || !(dt > 0)) dt = 1 / 60;
  dt = Math.min(dt, 0.1);
  if (typeof G.heat !== 'number') G.heat = 0;
  G.heat = clamp(G.heat, 0, HEAT_MAX);
  const m = meta(G);
  const cops = ensurePoliceArray(G);
  const { x: px, y: py } = playerPos(G);
  const onFoot = playerOnFoot(G);
  const pSpeed = playerSpeed(G);

  // Wanted stars follow heat.
  const stars = starsFromHeat(G.heat);
  G.wanted = stars;

  // Spray Shop: fast heat drain inside radius 150.
  const spray = findSprayShop(G);
  if (spray && dist(px, py, spray.x, spray.y) < SPRAY_RADIUS) {
    G.heat = Math.max(0, G.heat - SPRAY_DRAIN * dt);
    G.wanted = starsFromHeat(G.heat);
    m.hiddenTimer = 0;
  }

  // Hiding: no police within 450 for 3 seconds => heat decays. The
  // helicopter spotlight blocks decay entirely while it is on Rook.
  const spotlightOn = !!(G.heli && G.heli.spotlightOn);
  let nearest = Infinity;
  for (const c of cops) {
    if (!c || c.leaving) continue;
    const d = dist(c.x, c.y, px, py);
    if (d < nearest) nearest = d;
  }
  if (spotlightOn) {
    m.hiddenTimer = 0;
  } else if (nearest > HIDE_RADIUS) {
    m.hiddenTimer += dt;
    if (m.hiddenTimer >= HIDE_DELAY) {
      G.heat = Math.max(0, G.heat - HEAT_DECAY_RATE * dt);
      G.wanted = starsFromHeat(G.heat);
    }
  } else {
    m.hiddenTimer = 0;
  }

  // Spawn / stand down with the star level.
  if (stars > 0) {
    spawnForWanted(G, stars, px, py);
  } else {
    // No heat: every cop leaves; roadblock stands down.
    for (const c of cops) c.leaving = true;
    if (m.roadblock) {
      for (const car of m.roadblock) car.leaving = true;
      m.roadblock = null;
    }
  }

  // Move every cop; drop the dead and the ones that walked far away.
  for (let i = cops.length - 1; i >= 0; i--) {
    const c = cops[i];
    if (!c || typeof c.hp !== 'number' || c.hp <= 0) {
      cops.splice(i, 1);
      continue;
    }
    if (c.kind === 'foot') {
      updateFootCop(G, c, dt, px, py, onFoot, pSpeed);
    } else if (c.kind === 'car') {
      updatePatrolCar(G, c, dt, px, py, spray);
    } else if (c.kind === 'roadblock') {
      c.life = (c.life || 0) + dt;
      // A roadblock stands still; it only leaves when stood down.
      if (c.leaving) {
        const a = angleTo(px, py, c.x, c.y);
        c.angle = a;
        c.speed = 200;
        c.x += Math.cos(a) * c.speed * dt;
        c.y += Math.sin(a) * c.speed * dt;
      }
    }
    // Despawn anything that ended up far from the player.
    if (c && dist(c.x, c.y, px, py) > 900) {
      cops.splice(i, 1);
    }
  }
}

export function draw(G, ctx) {
  if (!G || !ctx) return;
  const cops = Array.isArray(G.police) ? G.police : [];
  const time = (G.time && typeof G.time.t === 'number') ? G.time.t
    : (typeof G.time === 'number' ? G.time : 0);
  const blink = Math.floor(time * 4) % 2 === 0;
  for (const c of cops) {
    if (!c || c.hp <= 0) continue;
    if (c.kind === 'foot') {
      // Foot cop: dark uniform, badge dot, facing tick.
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.fillStyle = '#1d2f6e';
      ctx.beginPath();
      ctx.arc(0, 0, c.radius || FOOT_COP_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd94a';
      ctx.beginPath();
      ctx.arc(0, -3, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0c1533';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(c.angle || 0) * 14, Math.sin(c.angle || 0) * 14);
      ctx.stroke();
      ctx.restore();
    } else {
      // Patrol car / roadblock car: dark body, white doors, flashing bar.
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle || 0);
      ctx.fillStyle = '#101828';
      ctx.fillRect(-26, -12, 52, 24);
      ctx.fillStyle = '#e8ecf4';
      ctx.fillRect(-8, -12, 16, 24);
      ctx.fillStyle = blink ? '#ff3b30' : '#2f7bff';
      ctx.fillRect(-6, -14, 12, 5);
      ctx.fillStyle = blink ? '#2f7bff' : '#ff3b30';
      ctx.fillRect(-6, 9, 12, 5);
      ctx.restore();
    }
  }
}
