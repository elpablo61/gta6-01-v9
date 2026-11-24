// Crescent Bay — weapons: pistol, SMG, shotgun.
//
// Three weapons, one per key (1 / 2 / 3), Q cycles to the next owned
// weapon. Switching is instant: no animation lock, works on foot.
// Each weapon keeps its own ammo count. Rook starts owning the pistol
// AND the SMG, so keys 1 / 2 / Q all work from the first minute.
// Weapon crates sit at fixed spots in the world (gun store, docks,
// hideout) plus inside the m10 / m12 shootout arenas; walking over a
// crate picks the weapon up and gives ammo. Ammo pickups sit in the
// shootout arenas; the autopilot grabs one when its current weapon's
// ammo drops to 6 or less. Enemies use the pistol only (see combat.js).
//
// Contract: ES module, vanilla JS. State lives on G.weapons.
//   init(G), update(G, dt), draw(G, ctx)
//   tryFire(G, opts) -> array of shots, or null when nothing fired
//   selectWeapon(G, id), cycleWeapon(G), giveWeapon(G, id, ammo),
//   addAmmo(G, id, n), spawnArenaCrates(G, cx, cy)
// Defensive: every optional G field is guarded with a default.

export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol', key: '1', name: 'Pistol',
    damage: 18, rate: 0.30, range: 430, speed: 920,
    spread: 0.02, pellets: 1, startAmmo: 48, pickupAmmo: 48,
  },
  smg: {
    id: 'smg', key: '2', name: 'SMG',
    damage: 10, rate: 0.09, range: 360, speed: 980,
    spread: 0.07, pellets: 1, startAmmo: 96, pickupAmmo: 96,
  },
  shotgun: {
    id: 'shotgun', key: '3', name: 'Shotgun',
    damage: 8, rate: 0.85, range: 230, speed: 820,
    spread: 0.17, pellets: 5, startAmmo: 24, pickupAmmo: 24,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];

// ---------------------------------------------------------------- helpers

function rnd(G) {
  if (G && typeof G.rng === 'function') return G.rng();
  if (G && G.rng && typeof G.rng.next === 'function') return G.rng.next();
  return Math.random();
}

function keyDown(G, code) {
  const inp = G && G.input;
  if (!inp) return false;
  if (inp.keys instanceof Set) return inp.keys.has(code);
  if (inp.keys && typeof inp.keys === 'object') return !!inp.keys[code];
  if (inp.down && typeof inp.down === 'object') return !!inp.down[code];
  if (Array.isArray(inp.pressed)) return inp.pressed.indexOf(code) !== -1;
  return false;
}

function keyHit(G, code) {
  // Rising-edge detect, tracked inside our own state so it works no
  // matter which key representation the input module uses.
  const w = G && G.weapons;
  if (!w) return false;
  w._prevKeys = w._prevKeys || {};
  const down = keyDown(G, code);
  const hit = down && !w._prevKeys[code];
  w._prevKeys[code] = down;
  return hit;
}

// Aim angle for the player: explicit aim angle first, then the mouse
// position converted to world coordinates, then the facing angle.
export function aimAngle(G) {
  const p = (G && G.player) || {};
  if (typeof p.aimAngle === 'number') return p.aimAngle;
  if (typeof p.aim === 'number') return p.aim;
  const inp = G && G.input;
  const cam = G && G.camera;
  let mx = null;
  let my = null;
  if (inp) {
    if (inp.mouse && typeof inp.mouse.x === 'number') { mx = inp.mouse.x; my = inp.mouse.y; }
    else if (typeof inp.mouseX === 'number') { mx = inp.mouseX; my = inp.mouseY; }
  }
  if (mx !== null && cam && typeof cam.x === 'number') {
    return Math.atan2(my + cam.y - p.y, mx + cam.x - p.x);
  }
  if (typeof p.angle === 'number') return p.angle;
  return 0;
}

// A named place in the world. The world module may publish named
// locations; otherwise fall back to the fixed defaults below.
function place(G, name, fx, fy) {
  const w = (G && G.world) || {};
  const spots = w.locations || w.markers || w.places || null;
  if (spots && spots[name] && typeof spots[name].x === 'number') {
    return { x: spots[name].x, y: spots[name].y };
  }
  if (w[name] && typeof w[name].x === 'number') return { x: w[name].x, y: w[name].y };
  return { x: fx, y: fy };
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

// ---------------------------------------------------------------- state

export function ensureWeapons(G) {
  if (!G.weapons) {
    G.weapons = {
      owned: { pistol: true, smg: true, shotgun: false },
      current: 'pistol',
      ammo: {
        pistol: WEAPON_DEFS.pistol.startAmmo,
        smg: WEAPON_DEFS.smg.startAmmo,
        shotgun: 0,
      },
      cooldown: 0,
      crates: [],
      ammoPickups: [],
      _prevKeys: {},
      _cratesSeeded: false,
    };
  }
  const w = G.weapons;
  w.owned = w.owned || { pistol: true, smg: true, shotgun: false };
  if (w.owned.pistol === undefined) w.owned.pistol = true;
  // v9 fix: Rook starts with the pistol AND the SMG owned.
  if (w.owned.smg === undefined) w.owned.smg = true;
  w.ammo = w.ammo || {};
  for (const id of WEAPON_ORDER) {
    if (typeof w.ammo[id] !== 'number') {
      w.ammo[id] = id === 'pistol' ? WEAPON_DEFS.pistol.startAmmo
        : id === 'smg' ? WEAPON_DEFS.smg.startAmmo : 0;
    }
  }
  if (!w.current || !w.owned[w.current]) w.current = 'pistol';
  if (typeof w.cooldown !== 'number') w.cooldown = 0;
  if (!Array.isArray(w.crates)) w.crates = [];
  if (!Array.isArray(w.ammoPickups)) w.ammoPickups = [];
  w._prevKeys = w._prevKeys || {};
  return w;
}

export function currentDef(G) {
  const w = ensureWeapons(G);
  return WEAPON_DEFS[w.current] || WEAPON_DEFS.pistol;
}

export function currentAmmo(G) {
  const w = ensureWeapons(G);
  return w.ammo[w.current] || 0;
}

// ---------------------------------------------------------------- actions

export function selectWeapon(G, id) {
  const w = ensureWeapons(G);
  if (!WEAPON_DEFS[id] || !w.owned[id]) return false;
  if (w.current === id) return true;
  w.current = id;
  w.cooldown = 0; // instant switch: no animation lock, no penalty
  sfx(G, 'switch');
  return true;
}

export function cycleWeapon(G) {
  const w = ensureWeapons(G);
  const owned = WEAPON_ORDER.filter((id) => w.owned[id]);
  if (owned.length < 2) return false;
  const i = owned.indexOf(w.current);
  const next = owned[(i + 1) % owned.length];
  return selectWeapon(G, next);
}

export function giveWeapon(G, id, ammo) {
  const w = ensureWeapons(G);
  if (!WEAPON_DEFS[id]) return false;
  const isNew = !w.owned[id];
  w.owned[id] = true;
  const gain = typeof ammo === 'number' ? ammo : WEAPON_DEFS[id].pickupAmmo;
  w.ammo[id] = (w.ammo[id] || 0) + gain;
  if (isNew) sfx(G, 'pickup');
  return isNew;
}

export function addAmmo(G, id, n) {
  const w = ensureWeapons(G);
  if (!WEAPON_DEFS[id]) return false;
  w.ammo[id] = (w.ammo[id] || 0) + (n || 0);
  return true;
}

// Fire the current weapon. Returns an array of shots
// { x, y, angle, damage, range, speed } for combat.js to turn into
// bullets, or null when nothing fired (cooling down or empty).
// opts may override { x, y, angle } — defaults to the player + aim.
export function tryFire(G, opts) {
  const w = ensureWeapons(G);
  const def = currentDef(G);
  if (w.cooldown > 0) return null;
  if ((w.ammo[w.current] || 0) <= 0) {
    w.cooldown = 0.18; // dry click, brief pause before the next try
    sfx(G, 'dryfire');
    return null;
  }
  const o = opts || {};
  const p = (G && G.player) || {};
  const x = typeof o.x === 'number' ? o.x : (p.x || 0);
  const y = typeof o.y === 'number' ? o.y : (p.y || 0);
  const base = typeof o.angle === 'number' ? o.angle : aimAngle(G);
  w.ammo[w.current] -= 1;
  w.cooldown = def.rate;
  const shots = [];
  for (let i = 0; i < def.pellets; i++) {
    const spread = (rnd(G) - 0.5) * 2 * def.spread * (def.pellets > 1 ? 1 : 0.6);
    shots.push({
      x, y,
      angle: base + spread,
      damage: def.damage,
      range: def.range,
      speed: def.speed,
    });
  }
  return shots;
}

// Crates for a shootout arena centred on (cx, cy): one SMG crate,
// one shotgun crate, plus two ammo pickups. Called by the mission
// layer when an arena (m10 / m12) is set up.
export function spawnArenaCrates(G, cx, cy) {
  const w = ensureWeapons(G);
  const x = typeof cx === 'number' ? cx : 1600;
  const y = typeof cy === 'number' ? cy : 1600;
  w.crates.push({ x: x - 90, y: y - 60, weapon: 'smg', taken: false });
  w.crates.push({ x: x + 90, y: y + 60, weapon: 'shotgun', taken: false });
  w.ammoPickups.push({ x: x - 60, y: y + 80, weapon: 'smg', amount: 64, taken: false });
  w.ammoPickups.push({ x: x + 60, y: y - 80, weapon: 'shotgun', amount: 16, taken: false });
  return w.crates;
}

// Fixed world crates: SMG at the gun store, shotgun at the docks,
// SMG again at the hideout. Seeded once.
function seedWorldCrates(G) {
  const w = ensureWeapons(G);
  if (w._cratesSeeded) return;
  w._cratesSeeded = true;
  const store = place(G, 'gunStore', 1000, 1400);
  const docks = place(G, 'docks', 2600, 2600);
  const hideout = place(G, 'hideout', 600, 600);
  w.crates.push({ x: store.x, y: store.y, weapon: 'smg', taken: false });
  w.crates.push({ x: docks.x, y: docks.y, weapon: 'shotgun', taken: false });
  w.crates.push({ x: hideout.x, y: hideout.y, weapon: 'smg', taken: false });
}

// ---------------------------------------------------------------- lifecycle

export function init(G) {
  const w = ensureWeapons(G);
  seedWorldCrates(G);
  // Hooks the player module calls: fire through the current weapon,
  // and the shared held-fire flag it sets while the trigger is held.
  G.weapons.tryFire = (opts) => tryFire(G, opts);
  G.weapons.select = (id) => selectWeapon(G, id);
  G.weapons.cycle = () => cycleWeapon(G);
  G.weapons.give = (id, ammo) => giveWeapon(G, id, ammo);
  G.weapons.addAmmo = (id, n) => addAmmo(G, id, n);
  G.weapons.spawnArenaCrates = (cx, cy) => spawnArenaCrates(G, cx, cy);
  return w;
}

export function update(G, dt) {
  const w = ensureWeapons(G);
  const step = typeof dt === 'number' && dt > 0 ? dt : 0.016;
  if (w.cooldown > 0) w.cooldown -= step;

  // Weapon keys: 1 / 2 / 3 select, Q cycles to the next owned weapon.
  // Instant, works on foot; switching while driving is ignored here
  // (the player module only calls this update on foot).
  const p = (G && G.player) || {};
  const onFoot = p.onFoot !== false;
  if (onFoot) {
    if (keyHit(G, 'Digit1') || keyHit(G, '1')) selectWeapon(G, 'pistol');
    else if (keyHit(G, 'Digit2') || keyHit(G, '2')) selectWeapon(G, 'smg');
    else if (keyHit(G, 'Digit3') || keyHit(G, '3')) selectWeapon(G, 'shotgun');
    else if (keyHit(G, 'KeyQ') || keyHit(G, 'q') || keyHit(G, 'Q')) cycleWeapon(G);
  }

  // Pickups: only on foot, within arm's reach.
  if (onFoot && typeof p.x === 'number') {
    for (const c of w.crates) {
      if (c.taken) continue;
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (dx * dx + dy * dy < 30 * 30) {
        c.taken = true;
        giveWeapon(G, c.weapon);
        if (typeof G.hud === 'object' && G.hud !== null && typeof G.hud.toast === 'function') {
          try { G.hud.toast('Picked up ' + WEAPON_DEFS[c.weapon].name); } catch (e) { /* ignore */ }
        }
      }
    }
    for (const a of w.ammoPickups) {
      if (a.taken) continue;
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      if (dx * dx + dy * dy < 28 * 28) {
        a.taken = true;
        addAmmo(G, a.weapon, a.amount);
      }
    }
  }
  w.crates = w.crates.filter((c) => !c.taken);
  w.ammoPickups = w.ammoPickups.filter((a) => !a.taken);
}

export function draw(G, ctx) {
  if (!ctx) return;
  const w = (G && G.weapons) || null;
  if (!w) return;
  try {
    for (const c of w.crates || []) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.fillStyle = '#20242e';
      ctx.strokeStyle = '#f5c542';
      ctx.lineWidth = 2;
      ctx.fillRect(-13, -10, 26, 20);
      ctx.strokeRect(-13, -10, 26, 20);
      ctx.fillStyle = '#f5c542';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.weapon === 'smg' ? 'SMG' : 'SG', 0, 1);
      ctx.restore();
    }
    for (const a of w.ammoPickups || []) {
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.fillStyle = '#3a2f10';
      ctx.strokeStyle = '#ffd75e';
      ctx.lineWidth = 2;
      ctx.fillRect(-9, -7, 18, 14);
      ctx.strokeRect(-9, -7, 18, 14);
      ctx.fillStyle = '#ffd75e';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AMMO', 0, 1);
      ctx.restore();
    }
  } catch (e) { /* drawing is never fatal */ }
}
