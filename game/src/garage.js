// garage.js — Fixer Garage (Crescent Bay) — B4-missions lanjutan, GTA v9.
// Written fresh in this session from the prose spec §3.3 + §2 (m11) + §4.
// The Fixer Garage (Mara & Dex's place) is a real garage: drive into the
// zone, press E (or the on-screen button) and a DOM menu opens with the
// world paused. Cash buys per-car upgrades that stay on that car, plus
// paint (visual only — the Spray Shop is the separate place that clears
// heat). Every purchase bumps G.garage.purchases and calls the mission
// hook G.missions.onGaragePurchase() when it exists (m11 needs it).
// Autopilot API: openMenu(), buyCheapest(), closeMenu(), menuOpen flag.

// The garage sits at the world map's own Fixer Garage pin (1000,2200).
// The old Y (1400) landed on the Gun Store's pin instead, so the m11
// drive-to-garage step parked the player at the gun shop and the menu
// never opened. One source of truth: world.places.garage.
export const GARAGE_X = 1000;
export const GARAGE_Y = 2200;
export const GARAGE_RADIUS = 130;

export const PAINT_COLORS = [
  { name: 'Midnight', hex: '#1c2733' },
  { name: 'Crimson', hex: '#c22730' },
  { name: 'Sunset', hex: '#e07b39' },
  { name: 'Harbor', hex: '#2e6f9e' },
  { name: 'Lime', hex: '#7fb539' },
  { name: 'Pearl', hex: '#d8d8d2' },
];
export const PAINT_PRICE = 150;

// Prices rise per level. Engine is the expensive line; armor, tires and
// brakes are cheaper than engine (spec §3.3).
export const UPGRADES = {
  engine: {
    label: 'Engine', desc: '+ top speed each level', max: 3,
    prices: [800, 1500, 2500],
  },
  armor: {
    label: 'Armor', desc: 'damage resistance each level', max: 3,
    prices: [500, 900, 1400],
  },
  tires: {
    label: 'Tires', desc: 'better handling / tighter turning', max: 2,
    prices: [400, 800],
  },
  brakes: {
    label: 'Brakes', desc: 'shorter stopping distance', max: 2,
    prices: [350, 700],
  },
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// ---- shared-state helpers (defensive: every optional field guarded) ----

function getCash(G) {
  if (typeof G.cash === 'number') return G.cash;
  if (G.player && typeof G.player.cash === 'number') return G.player.cash;
  if (G.save && typeof G.save.cash === 'number') return G.save.cash;
  if (typeof G.money === 'number') return G.money;
  return 0;
}

function setCash(G, v) {
  if (typeof G.cash === 'number') G.cash = v;
  if (G.player && typeof G.player.cash === 'number') G.player.cash = v;
  if (G.save && typeof G.save.cash === 'number') G.save.cash = v;
  if (typeof G.money === 'number') G.money = v;
  // If cash lived nowhere yet, keep it on G so later reads agree.
  if (typeof G.cash !== 'number' && !G.player && !G.save) G.cash = v;
}

function currentCar(G) {
  if (!G) return null;
  if (G.player) {
    if (G.player.car) return G.player.car;
    if (G.player.vehicle) return G.player.vehicle;
    if (G.player.inCar) return G.player.inCar;
  }
  if (G.vehicles) {
    if (G.vehicles.playerCar) return G.vehicles.playerCar;
    if (G.vehicles.current) return G.vehicles.current;
    if (Array.isArray(G.vehicles.list)) {
      const p = playerPos(G);
      let best = null, bestD = 260 * 260;
      for (const v of G.vehicles.list) {
        if (!v || typeof v.x !== 'number') continue;
        const d = dist2(p.x, p.y, v.x, v.y);
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best) return best;
    }
  }
  return null;
}

function playerPos(G) {
  if (G.player && typeof G.player.x === 'number') return { x: G.player.x, y: G.player.y };
  if (G.player && G.player.pos) return { x: G.player.pos.x || 0, y: G.player.pos.y || 0 };
  return { x: GARAGE_X, y: GARAGE_Y };
}

function playerInCar(G) {
  if (!G || !G.player) return false;
  if (typeof G.player.inCar === 'boolean') return G.player.inCar;
  if (typeof G.player.driving === 'boolean') return G.player.driving;
  return !!G.player.car || !!G.player.vehicle;
}

function isKeyDown(G, codes) {
  const inp = G && G.input;
  if (!inp) return false;
  if (inp.keys) {
    for (const c of codes) if (inp.keys[c]) return true;
  }
  if (inp.pressed) {
    for (const c of codes) {
      if (inp.pressed instanceof Set && inp.pressed.has(c)) return true;
      if (Array.isArray(inp.pressed) && inp.pressed.indexOf(c) >= 0) return true;
    }
  }
  if (typeof inp.isDown === 'function') {
    for (const c of codes) { try { if (inp.isDown(c)) return true; } catch (e) { /* ignore */ } }
  }
  return false;
}

function justPressed(G, codes, prev) {
  const down = isKeyDown(G, codes);
  const hit = down && !prev;
  return { hit, down };
}

// ---- per-car upgrades ----

function upgradesFor(car) {
  if (!car) return { engine: 0, armor: 0, tires: 0, brakes: 0, paint: null };
  if (!car.upgrades || typeof car.upgrades !== 'object') {
    car.upgrades = { engine: 0, armor: 0, tires: 0, brakes: 0, paint: null };
  }
  const u = car.upgrades;
  if (typeof u.engine !== 'number') u.engine = 0;
  if (typeof u.armor !== 'number') u.armor = 0;
  if (typeof u.tires !== 'number') u.tires = 0;
  if (typeof u.brakes !== 'number') u.brakes = 0;
  // Alias some modules read under a different name.
  car.garageUpgrades = u;
  return u;
}

function applyUpgradesToCar(car) {
  if (!car) return;
  const u = upgradesFor(car);
  if (typeof car.topSpeed === 'number') {
    if (typeof car._baseTopSpeed !== 'number') car._baseTopSpeed = car.topSpeed;
    car.topSpeed = car._baseTopSpeed + 60 * u.engine;
    if (typeof car.maxSpeed === 'number') car.maxSpeed = car.topSpeed;
  } else if (typeof car.maxSpeed === 'number') {
    if (typeof car._baseMaxSpeed !== 'number') car._baseMaxSpeed = car.maxSpeed;
    car.maxSpeed = car._baseMaxSpeed + 60 * u.engine;
  }
  // Armor: level + a fractional resistance other modules can read.
  car.armorLevel = u.armor;
  car.damageResist = 0.15 * u.armor;
  car.armor = u.armor;
  // Tires: handling / grip / turn authority.
  car.tiresLevel = u.tires;
  car.handling = 1 + 0.12 * u.tires;
  car.grip = 1 + 0.12 * u.tires;
  if (typeof car.turnRate === 'number') {
    if (typeof car._baseTurnRate !== 'number') car._baseTurnRate = car.turnRate;
    car.turnRate = car._baseTurnRate * (1 + 0.10 * u.tires);
  }
  // Brakes: stronger deceleration.
  car.brakesLevel = u.brakes;
  car.brakePower = 1 + 0.25 * u.brakes;
  car.braking = 1 + 0.25 * u.brakes;
  if (typeof car.brake === 'number') {
    if (typeof car._baseBrake !== 'number') car._baseBrake = car.brake;
    car.brake = car._baseBrake * (1 + 0.25 * u.brakes);
  }
  if (u.paint) {
    car.paint = u.paint;
    car.color = u.paint;
  }
}

// ---- DOM menu ----

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function buildMenuDom(G) {
  const g = G.garage;
  const root = el('div', 'garage-menu');
  root.id = 'garage-menu';
  root.style.cssText = [
    'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
    'z-index:60', 'width:min(460px,92vw)', 'max-height:88vh', 'overflow:auto',
    'background:rgba(12,16,26,0.96)', 'color:#eef2f7', 'border:2px solid #e07b39',
    'border-radius:12px', 'padding:18px 20px', 'font-family:system-ui,sans-serif',
    'box-shadow:0 12px 40px rgba(0,0,0,0.6)', 'display:none',
  ].join(';');
  const title = el('h2', null, 'FIXER GARAGE — Mara & Dex');
  title.style.cssText = 'margin:0 0 4px;font-size:20px;letter-spacing:1px;';
  const sub = el('p', null, 'Upgrades stay on this car. Paint is visual only — heat is cleared at the Spray Shop, not here.');
  sub.style.cssText = 'margin:0 0 10px;font-size:13px;color:#aeb8c6;';
  const cashLine = el('p', null, '');
  cashLine.id = 'garage-cash';
  cashLine.style.cssText = 'margin:0 0 12px;font-size:17px;font-weight:700;color:#ffd166;';
  const msgLine = el('p', null, '');
  msgLine.id = 'garage-msg';
  msgLine.style.cssText = 'margin:0 0 10px;font-size:13px;color:#ffb4a2;min-height:18px;';
  const rows = el('div', null, '');
  rows.id = 'garage-rows';
  const paintTitle = el('h3', null, 'Paint — $' + PAINT_PRICE);
  paintTitle.style.cssText = 'margin:14px 0 8px;font-size:15px;';
  const paintRow = el('div', null, '');
  paintRow.id = 'garage-paint';
  paintRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  for (const c of PAINT_COLORS) {
    const b = el('button', null, c.name);
    b.type = 'button';
    b.dataset.color = c.hex;
    b.dataset.name = c.name;
    b.style.cssText = 'padding:8px 10px;border-radius:8px;border:2px solid ' + c.hex +
      ';background:' + c.hex + ';color:#fff;cursor:pointer;font-weight:600;';
    b.addEventListener('click', () => { g.buyPaint(c.hex, c.name); });
    paintRow.appendChild(b);
  }
  const closeBtn = el('button', null, 'Close (Esc)');
  closeBtn.id = 'garage-close';
  closeBtn.type = 'button';
  closeBtn.style.cssText = 'margin-top:16px;width:100%;padding:10px;border-radius:8px;border:none;background:#e07b39;color:#14100c;font-weight:700;font-size:15px;cursor:pointer;';
  closeBtn.addEventListener('click', () => { g.closeMenu(); });
  root.appendChild(title);
  root.appendChild(sub);
  root.appendChild(cashLine);
  root.appendChild(msgLine);
  root.appendChild(rows);
  root.appendChild(paintTitle);
  root.appendChild(paintRow);
  root.appendChild(closeBtn);
  document.body.appendChild(root);
  g._menuEl = root;
  g._cashEl = cashLine;
  g._msgEl = msgLine;
  g._rowsEl = rows;
  return root;
}

function refreshMenuDom(G) {
  const g = G.garage;
  if (!g || !g._menuEl) return;
  const car = currentCar(G);
  const u = upgradesFor(car);
  if (g._cashEl) g._cashEl.textContent = 'Cash: $' + getCash(G) + (car ? '   ·   Car: ' + (car.type || car.kind || 'car') : '   ·   No car nearby');
  if (g._rowsEl) {
    g._rowsEl.innerHTML = '';
    for (const key of Object.keys(UPGRADES)) {
      const def = UPGRADES[key];
      const lvl = u[key] || 0;
      const maxed = lvl >= def.max;
      const price = maxed ? null : def.prices[lvl];
      const row = el('div', null, '');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,0.12);';
      const info = el('div', null, '');
      info.style.cssText = 'flex:1;';
      const name = el('div', null, def.label + '  ' + '●'.repeat(lvl) + '○'.repeat(def.max - lvl));
      name.style.cssText = 'font-weight:700;font-size:15px;';
      const desc = el('div', null, def.desc + (maxed ? ' — MAX' : ' — next: $' + price));
      desc.style.cssText = 'font-size:12px;color:#aeb8c6;';
      info.appendChild(name);
      info.appendChild(desc);
      const btn = el('button', null, maxed ? 'MAX' : 'Buy $' + price);
      btn.type = 'button';
      btn.disabled = maxed;
      btn.style.cssText = 'padding:8px 14px;border-radius:8px;border:none;background:' + (maxed ? '#555' : '#ffd166') + ';color:#14100c;font-weight:700;cursor:' + (maxed ? 'default' : 'pointer') + ';';
      btn.addEventListener('click', () => { g.buyUpgrade(key); });
      row.appendChild(info);
      row.appendChild(btn);
      g._rowsEl.appendChild(row);
    }
  }
}

function showMenu(G, show) {
  const g = G.garage;
  if (!g) return;
  if (!g._menuEl && typeof document !== 'undefined') buildMenuDom(G);
  if (g._menuEl) g._menuEl.style.display = show ? 'block' : 'none';
  if (show) refreshMenuDom(G);
}

function setMessage(G, text) {
  const g = G.garage;
  if (g && g._msgEl) g._msgEl.textContent = text || '';
  if (g) g.lastMessage = text || '';
}

// ---- purchases ----

function doPurchase(G, kind, price, applyFn) {
  const g = G.garage;
  const cash = getCash(G);
  if (cash < price) {
    setMessage(G, 'Not enough cash — need $' + price + ', have $' + cash + '.');
    return false;
  }
  setCash(G, cash - price);
  if (typeof applyFn === 'function') applyFn();
  g.purchases = (typeof g.purchases === 'number' ? g.purchases : 0) + 1;
  // m11 hook (missions.js provides it).
  if (G.missions && typeof G.missions.onGaragePurchase === 'function') {
    try { G.missions.onGaragePurchase(); } catch (e) { /* hook must never break the shop */ }
  }
  if (G.audio && typeof G.audio.play === 'function') {
    try { G.audio.play('buy'); } catch (e) { /* ignore */ }
  }
  refreshMenuDom(G);
  return true;
}

function buyUpgrade(G, kind) {
  const g = G.garage;
  const def = UPGRADES[kind];
  if (!def) { setMessage(G, 'Unknown upgrade.'); return false; }
  const car = currentCar(G);
  if (!car) { setMessage(G, 'No car here — drive a car into the garage first.'); return false; }
  const u = upgradesFor(car);
  const lvl = u[kind] || 0;
  if (lvl >= def.max) { setMessage(G, def.label + ' is already MAX.'); return false; }
  const price = def.prices[lvl];
  const ok = doPurchase(G, kind, price, () => {
    u[kind] = lvl + 1;
    applyUpgradesToCar(car);
  });
  if (ok) setMessage(G, def.label + ' level ' + (lvl + 1) + ' installed on this car. ($' + price + ')');
  return ok;
}

function buyPaint(G, hex, name) {
  const g = G.garage;
  const car = currentCar(G);
  if (!car) { setMessage(G, 'No car here — drive a car into the garage first.'); return false; }
  const ok = doPurchase(G, 'paint', PAINT_PRICE, () => {
    const u = upgradesFor(car);
    u.paint = hex;
    applyUpgradesToCar(car);
  });
  if (ok) setMessage(G, 'Painted ' + (name || hex) + '. ($' + PAINT_PRICE + ')');
  return ok;
}

function buyCheapest(G) {
  const car = currentCar(G);
  if (!car) return false;
  const u = upgradesFor(car);
  let bestKind = null, bestPrice = Infinity;
  for (const key of Object.keys(UPGRADES)) {
    const def = UPGRADES[key];
    const lvl = u[key] || 0;
    if (lvl >= def.max) continue;
    const price = def.prices[lvl];
    if (price < bestPrice) { bestPrice = price; bestKind = key; }
  }
  if (!bestKind) return false; // everything maxed
  if (getCash(G) < bestPrice) return false;
  return buyUpgrade(G, bestKind);
}

// ---- module lifecycle ----

export function init(G) {
  if (!G) return;
  const prev = (G.garage && typeof G.garage.purchases === 'number') ? G.garage.purchases : 0;
  const g = {
    x: GARAGE_X,
    y: GARAGE_Y,
    garageX: GARAGE_X,
    garageY: GARAGE_Y,
    pos: { x: GARAGE_X, y: GARAGE_Y },
    location: { x: GARAGE_X, y: GARAGE_Y },
    radius: GARAGE_RADIUS,
    zone: GARAGE_RADIUS,
    name: 'Fixer Garage',
    menuOpen: false,
    purchases: prev,
    lastMessage: '',
    _prevE: false,
    _prevEsc: false,
    _menuEl: null,
    _cashEl: null,
    _msgEl: null,
    _rowsEl: null,

    isNearGarage: function (px, py) {
      const p = (typeof px === 'number') ? { x: px, y: py } : playerPos(G);
      return dist2(p.x, p.y, GARAGE_X, GARAGE_Y) <= GARAGE_RADIUS * GARAGE_RADIUS;
    },
    currentCar: function () { return currentCar(G); },
    levels: function () { return Object.assign({}, upgradesFor(currentCar(G))); },
    getLevels: function () { return Object.assign({}, upgradesFor(currentCar(G))); },
    getCash: function () { return getCash(G); },
    buyUpgrade: function (kind) { return buyUpgrade(G, kind); },
    buyPaint: function (hex, name) { return buyPaint(G, hex, name); },
    buyCheapest: function () { return buyCheapest(G); },
    openMenu: function () { return openMenu(G); },
    closeMenu: function () { return closeMenu(G); },
  };
  G.garage = g;
  return g;
}

function openMenu(G) {
  const g = G.garage;
  if (!g) return false;
  if (g.menuOpen) { refreshMenuDom(G); return true; }
  g.menuOpen = true;
  // Pause the world while the menu is open (main loop honours G.paused).
  if (typeof G.paused !== 'undefined' || true) G.paused = true;
  g._wasPaused = true;
  showMenu(G, true);
  setMessage(G, '');
  refreshMenuDom(G);
  return true;
}

function closeMenu(G) {
  const g = G.garage;
  if (!g) return false;
  if (!g.menuOpen) return false;
  g.menuOpen = false;
  G.paused = false;
  showMenu(G, false);
  return true;
}

export function update(G, dt) {
  const g = G && G.garage;
  if (!g) return;
  // E toggles the menu when near the garage; Esc closes it.
  const e = justPressed(G, ['KeyE', 'e', 'E'], g._prevE);
  g._prevE = e.down;
  const esc = justPressed(G, ['Escape', 'Esc'], g._prevEsc);
  g._prevEsc = esc.down;
  if (g.menuOpen) {
    if (esc.hit || e.hit) closeMenu(G);
    return; // world is paused while the menu is open
  }
  if (e.hit && g.isNearGarage()) {
    openMenu(G);
  }
}

export function draw(G, ctx) {
  const g = G && G.garage;
  if (!g || !ctx) return;
  const p = playerPos(G);
  const near = g.isNearGarage(p.x, p.y);
  // Garage building footprint + sign (drawn in world space).
  ctx.save();
  ctx.fillStyle = 'rgba(224,123,57,0.25)';
  ctx.strokeStyle = '#e07b39';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(GARAGE_X, GARAGE_Y, GARAGE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(GARAGE_X - 70, GARAGE_Y - 46, 140, 92);
  ctx.strokeStyle = '#e07b39';
  ctx.lineWidth = 2;
  ctx.strokeRect(GARAGE_X - 70, GARAGE_Y - 46, 140, 92);
  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FIXER', GARAGE_X, GARAGE_Y - 14);
  ctx.fillText('GARAGE', GARAGE_X, GARAGE_Y + 6);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#eef2f7';
  ctx.fillText('Mara & Dex', GARAGE_X, GARAGE_Y + 26);
  if (near && !g.menuOpen) {
    ctx.fillStyle = 'rgba(10,12,18,0.85)';
    const label = playerInCar(G) ? 'Press E — Fixer Garage (upgrades)' : 'Press E — Fixer Garage (need a car for upgrades)';
    ctx.font = 'bold 15px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 20;
    ctx.fillRect(p.x - w / 2, p.y - 78, w, 26);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(label, p.x, p.y - 65);
  }
  ctx.restore();
}

export default { init, update, draw, GARAGE_X, GARAGE_Y, GARAGE_RADIUS, UPGRADES, PAINT_COLORS, PAINT_PRICE };
