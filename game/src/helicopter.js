// game/src/helicopter.js — Crescent Bay police helicopter.
//
// Fresh from the prose spec (gta6-01-v4-prose-spec.md §3.1, §2 m9/m12).
// No code copied from any earlier version. State lives on the shared G:
//   G.heli   — helicopter state object (created by init)
//   G.wanted — star level (police.js derives it from G.heat)
//   G.player — { x, y, ... } (Rook)
//   G.missions — mission script may request the helicopter for m9 / m12
//
// Behaviour:
//   - Appears at 3+ stars, and in m9/m12 when the mission script asks.
//   - Flies (no road constraint), shadows Rook from above at a fixed
//     visual height, faster than any car.
//   - Spotlight cone/circle on the ground follows Rook; while the
//     spotlight is on Rook, heat does NOT decay (police.js reads
//     G.heli.spotlightOn).
//   - Never shoots.
//   - Rook can shoot it: combat.js already lands hits on it (radius 42).
//     Damage arrives here as G.heli.hp (written directly by combat), as
//     G.heli.pendingDamage, or via the exported damageHeli(G, amount).
//     Enough damage => it smokes and retreats for 20 seconds, then
//     returns if wanted is still 3+ (or the mission still wants it).
//   - Below 3 stars (and no mission request) it leaves.
//   - Drawn with a shadow on the ground + rotor blur.

export const HELI_HIT_RADIUS = 42;
export const HELI_MAX_HP = 100;
export const HELI_SPEED = 620;      // faster than any car
export const HELI_RETREAT_TIME = 20; // seconds smoked + away before return
export const HELI_VISUAL_HEIGHT = 46; // px the body is drawn above its shadow
export const SPOTLIGHT_RADIUS = 130;

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

function starsFromHeat(heat) {
  const t = [0, 12, 30, 52, 74, 92];
  let stars = 0;
  for (let i = 0; i < t.length; i++) if (heat >= t[i]) stars = i;
  return stars;
}

function wantedOf(G) {
  if (typeof G.wanted === 'number') return G.wanted;
  if (typeof G.heat === 'number') return starsFromHeat(G.heat);
  return 0;
}

function playerPos(G) {
  const p = G.player || {};
  return { x: typeof p.x === 'number' ? p.x : 1600, y: typeof p.y === 'number' ? p.y : 1600 };
}

// Does the mission script want the helicopter up regardless of stars?
// m9 "Sky Watch" and m12 "Bay Finale" fly it by script. Accept the few
// shapes the missions module may use; anything else is simply "no".
function missionWantsHeli(G) {
  const ms = G.missions;
  if (!ms || typeof ms !== 'object') return false;
  if (ms.heliRequested === true || ms.helicopter === true) return true;
  const cur = ms.current || ms.active || null;
  if (cur && typeof cur === 'object') {
    if (cur.helicopter === true || cur.heli === true) return true;
    const id = cur.id || cur.missionId || cur.name || '';
    if (id === 'm9' || id === 'm12') return true;
    if (typeof id === 'string' && /^(m9|m12)\b/.test(id)) return true;
  }
  if (typeof cur === 'string' && (cur === 'm9' || cur === 'm12')) return true;
  return false;
}

function ensureHeli(G) {
  if (!G.heli || typeof G.heli !== 'object') {
    G.heli = {
      active: false,
      x: 1600, y: 1600,
      angle: 0,
      hp: HELI_MAX_HP, maxHp: HELI_MAX_HP,
      pendingDamage: 0,
      smoking: false,
      retreatT: 0,
      spotlightOn: false,
      rotor: 0,
      state: 'off', // 'off' | 'shadowing' | 'retreating' | 'leaving'
      radius: HELI_HIT_RADIUS,
    };
  }
  const h = G.heli;
  if (typeof h.hp !== 'number') h.hp = HELI_MAX_HP;
  if (typeof h.maxHp !== 'number') h.maxHp = HELI_MAX_HP;
  if (typeof h.pendingDamage !== 'number') h.pendingDamage = 0;
  if (typeof h.retreatT !== 'number') h.retreatT = 0;
  if (typeof h.rotor !== 'number') h.rotor = 0;
  if (typeof h.radius !== 'number') h.radius = HELI_HIT_RADIUS;
  return h;
}

// Damage entry point for combat.js (or any shooter). Combat may also write
// G.heli.hp / G.heli.pendingDamage directly; update() honours all three.
export function damageHeli(G, amount) {
  if (!G || typeof amount !== 'number' || !(amount > 0)) return;
  const h = ensureHeli(G);
  if (!h.active) return;
  h.hp = Math.max(0, h.hp - amount);
}

export function init(G) {
  if (!G) return;
  ensureHeli(G);
}

export function update(G, dt) {
  if (!G) return;
  if (typeof dt !== 'number' || !(dt > 0)) dt = 1 / 60;
  dt = Math.min(dt, 0.1);
  const h = ensureHeli(G);
  const { x: px, y: py } = playerPos(G);
  const wanted = wantedOf(G);
  const missionHeli = missionWantsHeli(G);
  const shouldBeUp = wanted >= 3 || missionHeli;

  h.rotor += dt * 22;

  // Fold in damage reported through the accumulator, then check the
  // smoked threshold (also catches hp written directly by combat.js).
  if (h.pendingDamage > 0) {
    h.hp = Math.max(0, h.hp - h.pendingDamage);
    h.pendingDamage = 0;
  }
  if (h.active && h.hp <= 0 && !h.smoking && h.state !== 'retreating') {
    h.smoking = true;
    h.state = 'retreating';
    h.retreatT = HELI_RETREAT_TIME;
    h.spotlightOn = false;
  }

  if (!h.active) {
    h.spotlightOn = false;
    if (!shouldBeUp) {
      h.state = 'off';
      return;
    }
    // Spawn: arrive from off to one side, then close in on Rook.
    if (h.state === 'retreating') {
      // Coming back from a retreat: only if still wanted / requested.
      h.x = px + 500;
      h.y = py - 500;
    } else if (h.state !== 'off') {
      h.x = px + 420;
      h.y = py - 320;
    } else {
      h.x = px + 420;
      h.y = py - 320;
    }
    h.active = true;
    h.smoking = false;
    h.hp = HELI_MAX_HP;
    h.state = 'shadowing';
    return;
  }

  // Active: decide the mode first.
  if (h.state === 'retreating') {
    h.retreatT -= dt;
    h.spotlightOn = false;
    // Fly away from Rook while smoking.
    const away = angleTo(px, py, h.x, h.y);
    h.angle = away;
    h.x += Math.cos(away) * HELI_SPEED * dt;
    h.y += Math.sin(away) * HELI_SPEED * dt;
    if (h.retreatT <= 0) {
      if (wanted >= 3 || missionWantsHeli(G)) {
        // Return: fresh airframe, back over Rook.
        h.smoking = false;
        h.hp = HELI_MAX_HP;
        h.state = 'shadowing';
        h.x = px + 420;
        h.y = py - 320;
      } else {
        h.active = false;
        h.state = 'off';
        h.smoking = false;
      }
    }
    return;
  }

  if (!shouldBeUp) {
    // Wanted dropped below 3 and no mission wants it: leave.
    h.state = 'leaving';
    h.spotlightOn = false;
    const away = angleTo(px, py, h.x, h.y);
    h.angle = away;
    h.x += Math.cos(away) * HELI_SPEED * dt;
    h.y += Math.sin(away) * HELI_SPEED * dt;
    if (dist(h.x, h.y, px, py) > 900) {
      h.active = false;
      h.state = 'off';
    }
    return;
  }

  // Shadowing: close in on Rook from above, faster than any car. The
  // hover point sits right over Rook so the spotlight stays on them.
  h.state = 'shadowing';
  const d = dist(h.x, h.y, px, py);
  if (d > 4) {
    const a = angleTo(h.x, h.y, px, py);
    h.angle = a;
    const step = Math.min(HELI_SPEED * dt, d);
    h.x += Math.cos(a) * step;
    h.y += Math.sin(a) * step;
  }
  // Spotlight is on Rook while the helicopter is overhead.
  h.spotlightOn = dist(h.x, h.y, px, py) < SPOTLIGHT_RADIUS + 60;
}

export function draw(G, ctx) {
  if (!G || !ctx) return;
  const h = G.heli;
  if (!h || !h.active) return;
  const { x: px, y: py } = playerPos(G);

  // Spotlight cone/circle on the ground, centred on Rook.
  if (h.spotlightOn) {
    ctx.save();
    const grad = ctx.createRadialGradient
      ? ctx.createRadialGradient(px, py, 10, px, py, SPOTLIGHT_RADIUS)
      : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(255, 246, 200, 0.35)');
      grad.addColorStop(1, 'rgba(255, 246, 200, 0)');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(255, 246, 200, 0.18)';
    }
    ctx.beginPath();
    ctx.arc(px, py, SPOTLIGHT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Shadow on the ground under the helicopter.
  ctx.save();
  ctx.fillStyle = 'rgba(10, 10, 30, 0.35)';
  ctx.beginPath();
  ctx.ellipse(h.x, h.y, 30, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Body, drawn above its shadow by the fixed visual height.
  const bx = h.x;
  const by = h.y - HELI_VISUAL_HEIGHT;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(h.angle || 0);
  // Tail.
  ctx.fillStyle = h.smoking ? '#3a3f46' : '#24344d';
  ctx.fillRect(-34, -3, 22, 6);
  // Body.
  ctx.fillStyle = h.smoking ? '#4a4f57' : '#2e4a6b';
  ctx.beginPath();
  ctx.ellipse(0, 0, 16, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // Cockpit glass.
  ctx.fillStyle = '#9fd8ef';
  ctx.beginPath();
  ctx.ellipse(10, 0, 6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Rotor blur: two translucent spinning blades + hub.
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(h.rotor || 0);
  ctx.strokeStyle = 'rgba(220, 230, 240, 0.45)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-30, 0);
  ctx.lineTo(30, 0);
  ctx.moveTo(0, -30);
  ctx.lineTo(0, 30);
  ctx.stroke();
  ctx.fillStyle = 'rgba(220, 230, 240, 0.5)';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Smoke trail while shot down and retreating.
  if (h.smoking) {
    ctx.save();
    ctx.fillStyle = 'rgba(120, 120, 120, 0.5)';
    ctx.beginPath();
    ctx.arc(bx - 8, by + 6, 9, 0, Math.PI * 2);
    ctx.arc(bx - 18, by + 12, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
