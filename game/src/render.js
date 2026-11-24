// render.js — Crescent Bay renderer.
// Written fresh in-session from the prose spec. No prior game code read.
//
// Performance rule (proven in v4 builder 1): NEVER repaint the whole
// 3200x3200 city every frame — software rendering stalls. The static
// city is pre-rendered ONCE to a 1600x1600 offscreen canvas (scale 0.5)
// and blitted per frame; only dynamic entities are drawn per frame.
// 2.5D buildings: roof + darker south/east sides, blue-purple shadows
// to the south-east (sun from the north-west). Day/night cycle with
// car headlights and street-lamp light pools at night.

export const STATIC_SCALE = 0.5;
export const STATIC_SIZE = 1600; // 3200 * 0.5

function shadeColor(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawStaticCity(ctx, G) {
  const W = G.world;
  const S = STATIC_SCALE;
  ctx.save();
  ctx.scale(S, S);
  // Ground: grass base.
  ctx.fillStyle = '#5d8a4a';
  ctx.fillRect(0, 0, 3200, 3200);
  // District ground tints (blocks).
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const x0 = 200 + bx * 400;
      const y0 = 200 + by * 400;
      const d = districtTint(W, x0 + 200, y0 + 200);
      if (d) {
        ctx.fillStyle = d;
        ctx.fillRect(x0 + 32, y0 + 32, 400 - 64, 400 - 64);
      }
    }
  }
  // Beach sand + water at the east edge.
  ctx.fillStyle = '#e6d194';
  ctx.fillRect(3000, 0, 60, 3200);
  ctx.fillStyle = '#2f6fb2';
  ctx.fillRect(3060, 0, 140, 3200);
  ctx.fillStyle = '#3d84c6';
  for (let y = 40; y < 3200; y += 160) {
    ctx.fillRect(3075, y, 90, 6);
  }
  // Marina pier.
  ctx.fillStyle = '#8a6f4d';
  ctx.fillRect(W.pier.x, W.pier.y, W.pier.w, W.pier.h);
  ctx.fillStyle = '#6b563c';
  for (let x = W.pier.x + 10; x < W.pier.x + W.pier.w; x += 30) {
    ctx.fillRect(x, W.pier.y, 4, W.pier.h);
  }
  // Roads: dark asphalt with centre dashes.
  ctx.fillStyle = '#3a3d42';
  for (let i = 0; i < 8; i++) {
    const c = 200 + i * 400;
    ctx.fillRect(c - 32, 168, 64, 2864);
    ctx.fillRect(168, c - 32, 2864, 64);
  }
  ctx.fillStyle = '#c8c25a';
  for (let i = 0; i < 8; i++) {
    const c = 200 + i * 400;
    for (let d = 220; d < 3000; d += 80) {
      ctx.fillRect(c - 2, d, 4, 36);
      ctx.fillRect(d, c - 2, 36, 4);
    }
  }
  // Sidewalks: light border around each block.
  ctx.fillStyle = '#9aa0a8';
  for (let by = 0; by < 7; by++) {
    for (let bx = 0; bx < 7; bx++) {
      ctx.fillRect(200 + bx * 400 + 32, 200 + by * 400 + 32, 400 - 64, 400 - 64);
    }
  }
  // Buildings, sorted so south buildings draw over north shadows.
  const bs = W.buildings.slice().sort((a, b) => (a.y + a.h) - (b.y + b.h));
  for (const b of bs) {
    // Blue-purple shadow to the south-east.
    ctx.fillStyle = 'rgba(70,70,140,0.35)';
    const sh = b.height * 0.45;
    ctx.fillRect(b.x + 10, b.y + 10 + sh * 0.4, b.w, b.h);
    // South + east sides (darker), then roof.
    ctx.fillStyle = shadeColor(b.color, b.shade * 0.62);
    ctx.fillRect(b.x + 6, b.y + b.h - 6, b.w, 8); // south face
    ctx.fillRect(b.x + b.w - 6, b.y + 6, 8, b.h); // east face
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h - 6);
    ctx.fillRect(b.x, b.y, b.w - 6, b.h);
    // Roof inset + details by kind.
    ctx.fillStyle = b.roof;
    ctx.fillRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
    if (b.kind === 'tower') {
      ctx.fillStyle = 'rgba(200,230,255,0.55)';
      for (let wy = b.y + 14; wy < b.y + b.h - 12; wy += 16) {
        for (let wx = b.x + 12; wx < b.x + b.w - 12; wx += 18) {
          ctx.fillRect(wx, wy, 10, 7);
        }
      }
    } else if (b.kind === 'house') {
      ctx.fillStyle = shadeColor(b.roof, 1.15);
      ctx.fillRect(b.x + b.w * 0.3, b.y + b.h * 0.3, b.w * 0.4, b.h * 0.4);
    } else if (b.kind === 'industrial') {
      ctx.fillStyle = '#c8c8c8';
      ctx.fillRect(b.x + 8, b.y + 8, b.w - 16, 6);
    }
  }
  // Street lamps at junctions (drawn as dots on the static layer;
  // the night light pools are drawn dynamically).
  ctx.fillStyle = '#3c3f45';
  for (const j of W.junctions) {
    ctx.fillRect(j.x + 36, j.y + 36, 6, 6);
  }
  ctx.restore();
}

function districtTint(W, x, y) {
  // districtAt lives in world.js; re-derive cheaply here to avoid a
  // cross-module import cycle in the static pass.
  if (x >= 2500) return '#cbb98a';
  if (y >= 2500) return '#7d838a';
  if (x >= 1200 && x < 2000 && y >= 1200 && y < 2000) return '#6f7f8c';
  if (y < 800) return '#6f9a58';
  return '#8a7a68';
}

// Hours 0..24 from G.time if present, else midday.
export function hoursOf(G) {
  if (G.time && typeof G.time.hours === 'number') return G.time.hours;
  if (G.time && typeof G.time.t === 'number') return (G.time.t % 24 + 24) % 24;
  return 12;
}

export function isNight(G) {
  const h = hoursOf(G);
  return h < 6 || h >= 19;
}

// 0 = full day, 1 = full night.
export function darkness(G) {
  const h = hoursOf(G);
  if (h >= 7 && h < 17) return 0;
  if (h >= 17 && h < 19) return (h - 17) / 2 * 0.55;
  if (h >= 5 && h < 7) return (1 - (h - 5) / 2) * 0.55;
  return 0.55;
}

function drawCarShape(ctx, car, G) {
  const colors = {
    sedan: '#c94f42', taxi: '#e8c832', truck: '#5a7a4a',
    sports: '#3f6fd1', police: '#20242c',
  };
  const w = car.type === 'truck' ? 30 : 22;
  const l = car.type === 'truck' ? 52 : 40;
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle || 0);
  ctx.fillStyle = 'rgba(70,70,140,0.3)';
  ctx.fillRect(-l / 2 + 4, -w / 2 + 5, l, w);
  ctx.fillStyle = car.color || colors[car.type] || '#888888';
  ctx.fillRect(-l / 2, -w / 2, l, w);
  ctx.fillStyle = 'rgba(180,220,255,0.75)';
  ctx.fillRect(l * 0.05, -w / 2 + 3, l * 0.28, w - 6);
  if (car.type === 'police') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-l * 0.32, -w / 2, l * 0.2, w);
    if (G.time && Math.floor((G.time.now || 0) * 2) % 2 === 0) {
      ctx.fillStyle = '#ff2a2a';
    } else {
      ctx.fillStyle = '#2a6bff';
    }
    ctx.fillRect(-l * 0.1, -w / 2 - 2, 8, 5);
  }
  ctx.restore();
}

function drawHeadlights(ctx, car, dark) {
  if (!dark) return;
  const a = car.angle || 0;
  const l = car.type === 'truck' ? 52 : 40;
  const hx = car.x + Math.cos(a) * (l / 2);
  const hy = car.y + Math.sin(a) * (l / 2);
  const grad = ctx.createRadialGradient(hx, hy, 4, hx, hy, 150);
  grad.addColorStop(0, 'rgba(255,244,180,0.5)');
  grad.addColorStop(1, 'rgba(255,244,180,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(hx + Math.cos(a) * 60, hy + Math.sin(a) * 60, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,246,190,0.9)';
  ctx.beginPath();
  ctx.arc(hx + Math.cos(a + 0.35) * 8, hy + Math.sin(a + 0.35) * 8, 3, 0, Math.PI * 2);
  ctx.arc(hx + Math.cos(a - 0.35) * 8, hy + Math.sin(a - 0.35) * 8, 3, 0, Math.PI * 2);
  ctx.fill();
}

export function init(G) {
  G.render = G.render || {};
  // Offscreen static layer — created once, only in a browser.
  if (typeof document !== 'undefined' && document.createElement) {
    if (!G.render.staticCanvas) {
      const c = document.createElement('canvas');
      c.width = STATIC_SIZE;
      c.height = STATIC_SIZE;
      const sctx = c.getContext('2d');
      drawStaticCity(sctx, G);
      G.render.staticCanvas = c;
      G.render.staticDirty = false;
    }
  }
  return G.render;
}

export function draw(G, ctx, viewW, viewH) {
  const cam = G.camera || { x: 0, y: 0 };
  const vw = viewW || (ctx.canvas && ctx.canvas.width) || 960;
  const vh = viewH || (ctx.canvas && ctx.canvas.height) || 540;
  const zoom = (G.camera && G.camera.zoom) || 1;
  ctx.save();
  ctx.clearRect(0, 0, vw, vh);
  // Camera transform: world -> screen.
  ctx.translate(vw / 2, vh / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-cam.x, -cam.y);
  // Static layer (blitted, never repainted).
  if (G.render && G.render.staticCanvas) {
    ctx.drawImage(G.render.staticCanvas, 0, 0, 3200, 3200);
  } else {
    // Fallback (no offscreen canvas, e.g. headless test): flat ground.
    ctx.fillStyle = '#5d8a4a';
    ctx.fillRect(0, 0, 3200, 3200);
  }
  const dark = darkness(G);
  const night = dark > 0.05;

  // --- dynamic entities only ---
  const cars = (G.vehicles && G.vehicles.list) || G.vehicles || [];
  if (Array.isArray(cars)) {
    for (const car of cars) {
      if (car && typeof car.x === 'number') drawCarShape(ctx, car, G);
    }
  }
  // Pedestrians.
  const peds = (G.peds && G.peds.list) || G.peds || [];
  if (Array.isArray(peds)) {
    for (const p of peds) {
      if (!p || typeof p.x !== 'number') continue;
      ctx.fillStyle = p.color || '#d8c8a8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Player.
  const pl = G.player;
  if (pl && typeof pl.x === 'number') {
    ctx.save();
    ctx.translate(pl.x, pl.y);
    ctx.rotate(pl.angle || 0);
    ctx.fillStyle = '#e8e8e8';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222222';
    ctx.fillRect(6, -2, 10, 4);
    ctx.restore();
    if (pl.inCar && pl.car) drawHeadlights(ctx, pl.car, night);
  }
  // Police / helicopter shadows (positions owned by their modules).
  if (G.heli && typeof G.heli.x === 'number' && G.heli.active) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(G.heli.x, G.heli.y, 26, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2c313a';
    ctx.beginPath();
    ctx.ellipse(G.heli.x, G.heli.y - 40, 20, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,220,220,0.7)';
    ctx.beginPath();
    ctx.moveTo(G.heli.x - 26, G.heli.y - 40);
    ctx.lineTo(G.heli.x + 26, G.heli.y - 40);
    ctx.stroke();
    // Spotlight cone on the ground following the player.
    if (pl && typeof pl.x === 'number') {
      const grad = ctx.createRadialGradient(pl.x, pl.y, 10, pl.x, pl.y, 130);
      grad.addColorStop(0, 'rgba(255,250,200,0.35)');
      grad.addColorStop(1, 'rgba(255,250,200,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pl.x, pl.y, 130, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Headlights for driven / nearby cars at night.
  if (night && Array.isArray(cars)) {
    for (const car of cars) {
      if (car && typeof car.x === 'number') drawHeadlights(ctx, car, true);
    }
  }
  // Street-lamp light pools at night (junctions near the camera).
  if (night) {
    const R = 700;
    for (const j of (G.world ? G.world.junctions : [])) {
      if (Math.abs(j.x - cam.x) > R || Math.abs(j.y - cam.y) > R) continue;
      const grad = ctx.createRadialGradient(j.x + 39, j.y + 39, 4, j.x + 39, j.y + 39, 90);
      grad.addColorStop(0, 'rgba(255,220,140,0.28)');
      grad.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(j.x + 39, j.y + 39, 90, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Night darkness overlay (screen space).
  ctx.restore();
  if (dark > 0) {
    ctx.fillStyle = 'rgba(8,10,38,' + dark.toFixed(3) + ')';
    ctx.fillRect(0, 0, vw, vh);
  }
}

export function update(G, dt) {
  // Advance the clock if the time module is not driving it.
  if (G.time && typeof G.time.hours === 'number' && !G.time.frozen) {
    // Time advances slowly: 1 game hour per 120 real seconds.
    G.time.hours = (G.time.hours + dt / 120) % 24;
  }
}

export default { init, update, draw, hoursOf, isNight, darkness };
