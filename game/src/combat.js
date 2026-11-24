// Crescent Bay — combat: bullets, hits, shootouts.
//
// Owns the bullet list and resolves every shot: player bullets against
// mission enemies, foot police and the helicopter; enemy bullets
// against Rook. Enemies use the pistol only. Shooting is on foot;
// the player module calls G.combat.tryShoot() while the trigger is
// held (flag `shootHeld` on G.input or G.player) and passes aimed
// bursts — combat itself only enforces rate of fire and ammo through
// the weapons module, it never sprays on its own.
//
// A shootout needs a cop perimeter (police hold a ring around the
// area, never pile onto one spot) — that rule lives in police.js;
// combat only exposes the enemy list and a helper to find the
// nearest living enemy for the autopilot's aimed bursts.
//
// Contract: ES module, vanilla JS. State lives on G.combat.
//   init(G), update(G, dt), draw(G, ctx)
//   tryShoot(G) -> true when a shot left the barrel
//   enemyFire(G, enemy), damageEnemy(G, enemy, dmg),
//   nearestEnemy(G, x, y), liveEnemies(G)
// Defensive: every optional G field is guarded with a default.

import { tryFire as weaponsTryFire, aimAngle } from './weapons.js';

const WORLD = 3200;

function rnd(G) {
  if (G && typeof G.rng === 'function') return G.rng();
  if (G && G.rng && typeof G.rng.next === 'function') return G.rng.next();
  return Math.random();
}

function sfx(G, name) {
  try {
    const a = G && G.audio;
    if (!a) return;
    if (typeof a.play === 'function') a.play(name);
    else if (typeof a.sfx === 'function') a.sfx(name);
    else if (typeof a.playSound === 'function') a.playSound(name);
  } catch (e) { /* audio is never fatal */ }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Enemies may live on G.combat.enemies (owned here) or be published by
// the mission layer under G.missions.enemies. Read both, prefer ours.
export function liveEnemies(G) {
  const list = [];
  const a = G && G.combat && Array.isArray(G.combat.enemies) ? G.combat.enemies : [];
  const b = G && G.missions && Array.isArray(G.missions.enemies) ? G.missions.enemies : [];
  for (const e of a.concat(b)) {
    if (e && !e.dead && typeof e.x === 'number' && (e.hp === undefined || e.hp > 0)) list.push(e);
  }
  return list;
}

export function nearestEnemy(G, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const e of liveEnemies(G)) {
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

export function damageEnemy(G, enemy, dmg) {
  if (!enemy || enemy.dead) return false;
  const hp = typeof enemy.hp === 'number' ? enemy.hp : 36;
  enemy.hp = hp - dmg;
  enemy.hitFlash = 0.12;
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.dead = true;
    sfx(G, 'enemyDown');
    return true;
  }
  return false;
}

// One enemy pistol shot at Rook. Enemies use the pistol only:
// 18 damage, medium rate, single bullet, short-ish range.
export function enemyFire(G, enemy) {
  const p = (G && G.player) || {};
  if (!enemy || enemy.dead || typeof p.x !== 'number') return false;
  const c = G.combat;
  const dx = p.x - enemy.x;
  const dy = p.y - enemy.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 400 || dist < 1) return false;
  const spread = (rnd(G) - 0.5) * 0.09;
  const ang = Math.atan2(dy, dx) + spread;
  const speed = 920;
  c.bullets.push({
    x: enemy.x, y: enemy.y,
    vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
    damage: 18, range: 400, travelled: 0,
    from: 'enemy', radius: 3, life: 1.2,
  });
  sfx(G, 'enemyShoot');
  return true;
}

// Player shot. Fires the current weapon through weapons.tryFire and
// turns each returned shot into a bullet. Returns true when at least
// one bullet left the barrel.
export function tryShoot(G) {
  const p = (G && G.player) || {};
  if (typeof p.x !== 'number') return false;
  if (p.onFoot === false) return false; // shooting is on foot only
  if (p.hp !== undefined && p.hp <= 0) return false;
  const shots = weaponsTryFire(G, { x: p.x, y: p.y, angle: aimAngle(G) });
  if (!shots || shots.length === 0) return false;
  const c = G.combat;
  for (const s of shots) {
    c.bullets.push({
      x: s.x, y: s.y,
      vx: Math.cos(s.angle) * s.speed, vy: Math.sin(s.angle) * s.speed,
      damage: s.damage, range: s.range, travelled: 0,
      from: 'player', radius: 3, life: 1.5,
    });
  }
  c.muzzle = 0.06;
  c.muzzleX = p.x;
  c.muzzleY = p.y;
  c.muzzleAngle = aimAngle(G);
  sfx(G, 'shoot');
  return true;
}

function hitPlayer(G, dmg) {
  const p = (G && G.player) || {};
  if (typeof p.hp !== 'number') return;
  if (p.hp <= 0) return;
  p.hp = Math.max(0, p.hp - dmg);
  p.hitFlash = 0.15;
  if (typeof p.invuln === 'number') p.invuln = Math.max(p.invuln, 0.1);
  sfx(G, 'playerHit');
}

function damageHeli(G, dmg) {
  const h = (G && G.heli) || null;
  if (!h || !h.active) return false;
  if (typeof h.damage === 'function') {
    try { h.damage(dmg); return true; } catch (e) { /* fall through */ }
  }
  if (typeof h.hp === 'number') {
    h.hp = Math.max(0, h.hp - dmg);
    return true;
  }
  return false;
}

function damageCop(G, cop, dmg) {
  if (!cop || cop.dead) return false;
  const hp = typeof cop.hp === 'number' ? cop.hp : 20;
  cop.hp = hp - dmg;
  if (cop.hp <= 0) {
    cop.hp = 0;
    cop.dead = true;
    cop.downTimer = 6; // stays down a while, then the street clears
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- lifecycle

export function init(G) {
  if (!G.combat) {
    G.combat = { bullets: [], enemies: [], muzzle: 0 };
  }
  const c = G.combat;
  if (!Array.isArray(c.bullets)) c.bullets = [];
  if (!Array.isArray(c.enemies)) c.enemies = [];
  if (typeof c.muzzle !== 'number') c.muzzle = 0;
  // Hooks the player module calls while the trigger is held.
  c.tryShoot = () => tryShoot(G);
  c.enemyFire = (enemy) => enemyFire(G, enemy);
  c.damageEnemy = (enemy, dmg) => damageEnemy(G, enemy, dmg);
  c.nearestEnemy = (x, y) => nearestEnemy(G, x, y);
  c.liveEnemies = () => liveEnemies(G);
  return c;
}

export function update(G, dt) {
  const c = (G && G.combat) || null;
  if (!c) return;
  const step = typeof dt === 'number' && dt > 0 ? dt : 0.016;
  if (c.muzzle > 0) c.muzzle -= step;

  const p = (G && G.player) || {};
  const px = typeof p.x === 'number' ? p.x : 0;
  const py = typeof p.y === 'number' ? p.y : 0;

  // Held trigger: the player module sets shootHeld (on G.input or
  // G.player) while the mouse button is down. Fire through the
  // weapons module, which enforces rate of fire and ammo.
  const held = (G.input && (G.input.shootHeld || G.input.mouseDown))
    || p.shootHeld || false;
  if (held) tryShoot(G);

  // Enemy pistol fire: each living enemy shoots at Rook when in
  // range, on its own cooldown. Enemies use the pistol only.
  for (const e of liveEnemies(G)) {
    if (typeof e.shootCooldown !== 'number') e.shootCooldown = 0.5 + rnd(G);
    e.shootCooldown -= step;
    if (e.shootCooldown <= 0) {
      const dx = px - e.x;
      const dy = py - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 400 && p.hp > 0) {
        if (enemyFire(G, e)) e.shootCooldown = 0.9 + rnd(G) * 0.5;
        else e.shootCooldown = 0.4;
      } else {
        e.shootCooldown = 0.4;
      }
    }
    if (e.hitFlash > 0) e.hitFlash -= step;
  }

  // Move bullets and resolve hits.
  const heli = (G && G.heli) || null;
  const cops = (G && G.police && Array.isArray(G.police.cops)) ? G.police.cops : [];
  const kept = [];
  for (const b of c.bullets) {
    b.x += b.vx * step;
    b.y += b.vy * step;
    const moved = Math.sqrt(b.vx * b.vx + b.vy * b.vy) * step;
    b.travelled += moved;
    b.life -= step;
    let dead = b.life <= 0 || b.travelled >= b.range
      || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;
    if (!dead) {
      if (b.from === 'player') {
        // Enemies first.
        for (const e of liveEnemies(G)) {
          const r = (typeof e.radius === 'number' ? e.radius : 16) + b.radius;
          const dx = b.x - e.x;
          const dy = b.y - e.y;
          if (dx * dx + dy * dy < r * r) {
            damageEnemy(G, e, b.damage);
            dead = true;
            break;
          }
        }
        // Then foot police.
        if (!dead) {
          for (const cop of cops) {
            if (cop.dead) continue;
            const r = 15 + b.radius;
            const dx = b.x - cop.x;
            const dy = b.y - cop.y;
            if (dx * dx + dy * dy < r * r) {
              damageCop(G, cop, b.damage);
              if (G.police && typeof G.police.addHeat === 'function') {
                try { G.police.addHeat(6); } catch (err) { /* ignore */ }
              }
              dead = true;
              break;
            }
          }
        }
        // Then the helicopter (big target, generous radius).
        if (!dead && heli && heli.active && typeof heli.x === 'number') {
          const dx = b.x - heli.x;
          const dy = b.y - heli.y;
          if (dx * dx + dy * dy < 42 * 42) {
            damageHeli(G, b.damage);
            dead = true;
          }
        }
      } else {
        // Enemy bullet vs Rook.
        const r = 15 + b.radius;
        const dx = b.x - px;
        const dy = b.y - py;
        if (dx * dx + dy * dy < r * r && p.hp > 0) {
          hitPlayer(G, b.damage);
          dead = true;
        }
      }
    }
    if (!dead) kept.push(b);
  }
  c.bullets = kept;

  // Clear dead enemies out of our own list (mission-owned lists are
  // left alone — the mission layer filters by .dead itself).
  if (Array.isArray(c.enemies)) {
    c.enemies = c.enemies.filter((e) => e && !e.dead);
  }
}

export function draw(G, ctx) {
  if (!ctx) return;
  const c = (G && G.combat) || null;
  if (!c) return;
  try {
    // Bullets as short tracer lines along their travel.
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const b of c.bullets) {
      const len = 14;
      const mag = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
      const nx = b.vx / mag;
      const ny = b.vy / mag;
      ctx.strokeStyle = b.from === 'player' ? '#ffe066' : '#ff5a4e';
      ctx.beginPath();
      ctx.moveTo(b.x - nx * len, b.y - ny * len);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Muzzle flash.
    if (c.muzzle > 0) {
      ctx.save();
      ctx.translate(c.muzzleX || 0, c.muzzleY || 0);
      ctx.rotate(c.muzzleAngle || 0);
      ctx.fillStyle = 'rgba(255, 214, 64, 0.9)';
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.lineTo(30, -6);
      ctx.lineTo(26, 0);
      ctx.lineTo(30, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Enemy health bars + hit flash.
    for (const e of liveEnemies(G)) {
      if (typeof e.hp !== 'number' || typeof e.maxHp !== 'number') continue;
      const w = 34;
      const frac = clamp(e.hp / e.maxHp, 0, 1);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(e.x - w / 2, e.y - 26, w, 5);
      ctx.fillStyle = frac > 0.5 ? '#58d68d' : frac > 0.25 ? '#f5c542' : '#ff5a4e';
      ctx.fillRect(e.x - w / 2, e.y - 26, w * frac, 5);
      if (e.hitFlash > 0) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 16, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  } catch (e) { /* drawing is never fatal */ }
}
