// hud.js — Crescent Bay HUD, drawn on the game canvas.
// Fresh from the prose spec §1: wanted stars (>=36px), objective banner
// (>=28px bold over a dark scrim, lower-left), minimap (>=180px,
// upper-right), thick health bar, big cash / speed / ammo, current
// weapon name + ammo, radio station name + small animated equalizer.
// ES module, vanilla JS. Defensive: every shared field is read with a
// fallback so the HUD never throws when another module is absent.

const STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];
const WORLD_SIZE = 3200;

function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function starsFromHeat(heat) {
  let s = 0;
  for (let i = 0; i < STAR_THRESHOLDS.length; i++) {
    if (heat >= STAR_THRESHOLDS[i]) s = i;
  }
  return s;
}

function wantedStars(G) {
  if (typeof G.wanted === 'number' && Number.isFinite(G.wanted)) {
    return Math.max(0, Math.min(5, Math.round(G.wanted)));
  }
  return starsFromHeat(num(G.heat, 0));
}

function objectiveText(G) {
  const m = G.missions;
  if (m) {
    const cur = m.current || m.active || null;
    if (cur) {
      if (typeof cur.objective === 'string' && cur.objective) return cur.objective;
      if (typeof cur.title === 'string' && cur.title) return cur.title;
      if (typeof cur.name === 'string' && cur.name) return cur.name;
    }
    if (typeof m.objective === 'string' && m.objective) return m.objective;
    if (typeof m.banner === 'string' && m.banner) return m.banner;
  }
  if (typeof G.objective === 'string' && G.objective) return G.objective;
  return 'Free roam — explore Crescent Bay';
}

function missionLabel(G) {
  const m = G.missions;
  if (m) {
    const cur = m.current || m.active || null;
    if (cur) {
      const id = cur.id || cur.code || '';
      const title = cur.title || cur.name || '';
      if (id && title) return id.toUpperCase() + ' — ' + title;
      if (title) return title;
      if (id) return String(id).toUpperCase();
    }
  }
  return '';
}

function healthOf(G) {
  const p = G.player || {};
  const h = num(p.hp, num(p.health, 100));
  return Math.max(0, Math.min(100, h));
}

function cashOf(G) {
  if (typeof G.cash === 'number') return G.cash;
  const p = G.player || {};
  if (typeof p.cash === 'number') return p.cash;
  return 0;
}

function speedOf(G) {
  const p = G.player || {};
  if (p.car && typeof p.car.speed === 'number') return Math.abs(p.car.speed);
  if (typeof p.speed === 'number') return Math.abs(p.speed);
  return 0;
}

function weaponInfo(G) {
  const w = G.weapons || {};
  const cur = w.current || w.active || null;
  if (cur) {
    return {
      name: cur.name || cur.id || 'Pistol',
      ammo: num(cur.ammo, num(cur.reserve, 0)),
      mag: num(cur.mag, num(cur.magazine, 0)),
    };
  }
  const p = G.player || {};
  return {
    name: p.weaponName || p.weapon || 'Pistol',
    ammo: num(p.ammo, 0),
    mag: 0,
  };
}

function radioInfo(G) {
  const r = G.radio || {};
  const st = r.station || r.current || null;
  if (st) {
    return {
      name: st.name || st.title || String(st),
      on: r.on !== false,
    };
  }
  if (typeof r.stationName === 'string' && r.stationName) {
    return { name: r.stationName, on: r.on !== false };
  }
  const a = G.audio || {};
  if (typeof a.stationName === 'string' && a.stationName) {
    return { name: a.stationName, on: a.radioOn !== false };
  }
  return { name: 'Bay FM', on: true };
}

function canvasSize(G, ctx) {
  const c = ctx.canvas || {};
  return {
    w: num(G.viewW, num(c.width, 1280)),
    h: num(G.viewH, num(c.height, 720)),
  };
}

function drawStars(G, ctx, x, y) {
  const stars = wantedStars(G);
  const size = 40; // >=36px per spec
  const gap = 8;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const cx = x + i * (size + gap) + size / 2;
    const cy = y + size / 2;
    const lit = i < stars;
    ctx.font = size + 'px sans-serif';
    ctx.fillStyle = lit ? '#ffd21f' : 'rgba(255,255,255,0.28)';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText('★', cx, cy);
    ctx.fillText('★', cx, cy);
  }
  ctx.restore();
  return 5 * size + 4 * gap;
}

function drawHealth(G, ctx, x, y, w) {
  const hp = healthOf(G);
  const h = 18; // thick bar
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = '#1c1c22';
  ctx.fillRect(x, y, w, h);
  const frac = hp / 100;
  ctx.fillStyle = frac > 0.5 ? '#37d67a' : frac > 0.25 ? '#ffb02e' : '#e5484d';
  ctx.fillRect(x, y, Math.max(0, w * frac), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('HP ' + Math.round(hp), x + 6, y + h / 2 + 1);
  ctx.restore();
}

function drawMinimap(G, ctx, x, y, size) {
  const scale = size / WORLD_SIZE;
  ctx.save();
  // Panel
  ctx.fillStyle = 'rgba(8,12,20,0.82)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  // Land base
  ctx.fillStyle = '#16202e';
  ctx.fillRect(x, y, size, size);
  // Water at the east edge (x > 3060 per spec)
  ctx.fillStyle = '#1d5f8a';
  ctx.fillRect(x + 3060 * scale, y, size - 3060 * scale, size);
  // Beach strip
  ctx.fillStyle = '#c9b489';
  ctx.fillRect(x + 3000 * scale, y, 60 * scale, size);
  // Roads: 8x8 grid at 200 + i*400, width 64 (spec §1)
  ctx.fillStyle = '#3a4150';
  for (let i = 0; i < 8; i++) {
    const p = (200 + i * 400) * scale;
    const wdt = Math.max(2, 64 * scale);
    ctx.fillRect(x + p - wdt / 2, y, wdt, size);
    ctx.fillRect(x, y + p - wdt / 2, size, wdt);
  }
  // Spray Shop marker (fixed spot, south-west quadrant)
  const spray = sprayShopPos(G);
  ctx.fillStyle = '#37d67a';
  ctx.beginPath();
  ctx.arc(x + spray.x * scale, y + spray.y * scale, 4, 0, Math.PI * 2);
  ctx.fill();
  // Mission marker
  const mk = missionMarker(G);
  if (mk) {
    ctx.fillStyle = '#ffd21f';
    ctx.beginPath();
    ctx.arc(x + mk.x * scale, y + mk.y * scale, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Police dots
  const cops = policePositions(G);
  ctx.fillStyle = '#4da3ff';
  for (const c of cops) {
    ctx.beginPath();
    ctx.arc(x + c.x * scale, y + c.y * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Helicopter dot
  const heli = G.heli || G.helicopter || null;
  if (heli && heli.active && typeof heli.x === 'number') {
    ctx.fillStyle = '#ff5d5d';
    ctx.beginPath();
    ctx.arc(x + heli.x * scale, y + heli.y * scale, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Player dot (white, ringed)
  const p = G.player || {};
  const px = num(p.x, WORLD_SIZE / 2);
  const py = num(p.y, WORLD_SIZE / 2);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + px * scale, y + py * scale, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Viewport rectangle
  const cam = G.camera || {};
  const vw = num(G.viewW, 1280);
  const vh = num(G.viewH, 720);
  const cx = num(cam.x, px) - vw / 2;
  const cy = num(cam.y, py) - vh / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + cx * scale, y + cy * scale, vw * scale, vh * scale);
  ctx.restore();
}

function sprayShopPos(G) {
  const s = (G.world && G.world.sprayShop) || G.sprayShop || null;
  if (s && typeof s.x === 'number' && typeof s.y === 'number') return s;
  return { x: 600, y: 2600 };
}

function missionMarker(G) {
  const m = G.missions;
  if (m) {
    const cur = m.current || m.active || null;
    if (cur && cur.marker && typeof cur.marker.x === 'number') return cur.marker;
    if (cur && typeof cur.tx === 'number' && typeof cur.ty === 'number') {
      return { x: cur.tx, y: cur.ty };
    }
    if (m.marker && typeof m.marker.x === 'number') return m.marker;
  }
  return null;
}

function policePositions(G) {
  const out = [];
  const pol = G.police || {};
  const list = pol.officers || pol.cops || pol.units || G.cops || [];
  if (Array.isArray(list)) {
    for (const c of list) {
      if (c && typeof c.x === 'number' && typeof c.y === 'number') out.push(c);
    }
  }
  const cars = pol.cars || pol.patrolCars || [];
  if (Array.isArray(cars)) {
    for (const c of cars) {
      if (c && typeof c.x === 'number' && typeof c.y === 'number') out.push(c);
    }
  }
  return out.slice(0, 40);
}

function drawObjective(G, ctx, x, y, maxW) {
  const label = missionLabel(G);
  const text = objectiveText(G);
  const titleSize = 28; // >=28px bold per spec
  ctx.save();
  ctx.font = 'bold ' + titleSize + 'px sans-serif';
  const textW = ctx.measureText(text).width;
  const labelW = label ? ctx.measureText(label).width : 0;
  const pad = 14;
  const boxW = Math.min(maxW, Math.max(textW, labelW) + pad * 2);
  const boxH = label ? titleSize + 22 + pad * 2 + 18 : titleSize + pad * 2;
  // Dark scrim behind the banner
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = 'rgba(255,210,31,0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, boxW, boxH);
  let ty = y + pad + titleSize * 0.78;
  if (label) {
    ctx.fillStyle = '#ffd21f';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x + pad, y + pad + 15);
    ty = y + pad + 18 + titleSize * 0.78;
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold ' + titleSize + 'px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + pad, ty);
  ctx.restore();
  return boxH;
}

function drawEqualizer(ctx, x, y, t) {
  // Small animated equalizer bars next to the station name.
  ctx.save();
  const bars = 5;
  const bw = 4;
  const gap = 3;
  for (let i = 0; i < bars; i++) {
    const h = 4 + 9 * Math.abs(Math.sin(t * 3.1 + i * 1.3));
    ctx.fillStyle = i % 2 === 0 ? '#37d67a' : '#ffd21f';
    ctx.fillRect(x + i * (bw + gap), y - h, bw, h);
  }
  ctx.restore();
}

function drawBottomRight(G, ctx, xRight, yBottom) {
  const w = weaponInfo(G);
  const radio = radioInfo(G);
  const cash = cashOf(G);
  const speed = speedOf(G);
  const p = G.player || {};
  const inCar = !!p.car || p.inCar === true || p.driving === true;
  const t = num(G.time, 0) + (typeof performance !== 'undefined' ? performance.now() / 1000 : 0);
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  // Cash — big
  ctx.font = 'bold 34px sans-serif';
  ctx.fillStyle = '#37d67a';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 4;
  ctx.strokeText('$' + Math.round(cash).toLocaleString('en-US'), xRight, yBottom);
  ctx.fillText('$' + Math.round(cash).toLocaleString('en-US'), xRight, yBottom);
  // Weapon name + ammo — big
  const ammoText = w.name + '  •  ' + w.ammo + (w.mag ? ' / ' + w.mag : '');
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.strokeText(ammoText, xRight, yBottom - 40);
  ctx.fillText(ammoText, xRight, yBottom - 40);
  // Speed — big, only meaningful in a car, still shown on foot
  const speedText = inCar
    ? Math.round(speed) + ' km/h'
    : 'ON FOOT';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = '#ffd21f';
  ctx.strokeText(speedText, xRight, yBottom - 78);
  ctx.fillText(speedText, xRight, yBottom - 78);
  // Radio station + equalizer
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = radio.on ? '#ffffff' : 'rgba(255,255,255,0.5)';
  const rText = '♪ ' + radio.name;
  const rW = ctx.measureText(rText).width;
  ctx.strokeText(rText, xRight, yBottom - 112);
  ctx.fillText(rText, xRight, yBottom - 112);
  drawEqualizer(ctx, xRight - rW - 42, yBottom - 112, t);
  ctx.restore();
}

function drawClock(G, ctx, x, y) {
  const time = G.time || {};
  let label = '';
  if (typeof time.hour === 'number') {
    const h = Math.floor(time.hour) % 24;
    const m = Math.floor(((time.hour % 1) + 1) % 1 * 60);
    label = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    if (time.day) label = 'Day ' + time.day + '  ' + label;
  } else if (typeof G.time === 'number') {
    const h = Math.floor(G.time) % 24;
    label = String(h).padStart(2, '0') + ':00';
  }
  if (!label) return;
  ctx.save();
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const w = ctx.measureText(label).width + 16;
  ctx.fillRect(x, y - 22, w, 30);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + 8, y + 2);
  ctx.restore();
}

export function init(G) {
  G.hud = G.hud || {};
  G.hud.ready = true;
}

export function update(G, dt) {
  // HUD is stateless per frame; keep a clock for the equalizer.
  if (!G.hud) G.hud = {};
  G.hud.t = num(G.hud.t, 0) + num(dt, 0);
}

export function draw(G, ctx) {
  if (!ctx) return;
  const { w, h } = canvasSize(G, ctx);
  const margin = 16;
  // Top-left: wanted stars + health bar under them
  drawStars(G, ctx, margin, margin);
  drawHealth(G, ctx, margin, margin + 48, 240);
  drawClock(G, ctx, margin, margin + 48 + 18 + 34);
  // Top-right: minimap, >=180px
  const mapSize = Math.max(180, Math.min(240, Math.floor(Math.min(w, h) * 0.3)));
  drawMinimap(G, ctx, w - margin - mapSize, margin, mapSize);
  // Bottom-left: objective banner
  drawObjective(G, ctx, margin, h - margin - 84, Math.floor(w * 0.55));
  // Bottom-right: cash / weapon+ammo / speed / radio
  drawBottomRight(G, ctx, w - margin, h - margin);
}
