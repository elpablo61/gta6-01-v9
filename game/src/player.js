// player.js — Rook on foot and behind the wheel (Crescent Bay).
// Fresh from the prose spec §1. On foot: WASD / arrows move, mouse aim,
// click shoot, Shift sprint. Driving: E enter / exit a car, steal a
// parked car, carjack a traffic car (its driver flees). Manual driving
// is SKIPPED on any frame the autopilot drove the car (guard flag on G:
// autopilotDrove / autopilot_drove / autopilot.drove) — the autopilot
// vs manual conflict froze cars in the v4 first attempt, so this guard
// is load-bearing. ES module, vanilla JS, defensive throughout.

const WORLD_SIZE = 3200;
const WALK_SPEED = 230;
const SPRINT_SPEED = 350;
const ENTER_RANGE = 100;
const CARJACK_HEAT = 6;

function num(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- input helpers: tolerate keys as Set, plain object, or array ---
function keySet(G) {
  const inp = G.input || {};
  if (inp.keys instanceof Set) return inp.keys;
  if (Array.isArray(inp.keys)) return new Set(inp.keys);
  if (inp.keys && typeof inp.keys === 'object') {
    const s = new Set();
    for (const k of Object.keys(inp.keys)) if (inp.keys[k]) s.add(k);
    return s;
  }
  if (inp.pressedKeys instanceof Set) return inp.pressedKeys;
  return new Set();
}

function keyDown(G, ...codes) {
  const inp = G.input || {};
  if (typeof inp.isDown === 'function') {
    for (const c of codes) { try { if (inp.isDown(c)) return true; } catch (e) {} }
    return false;
  }
  const keys = keySet(G);
  for (const c of codes) {
    if (keys.has(c)) return true;
    // Also accept lowercase / 'KeyW' style aliases.
    if (keys.has(c.toLowerCase())) return true;
  }
  return false;
}

function mouseOf(G) {
  const inp = G.input || {};
  const m = inp.mouse || inp.pointer || {};
  return {
    x: num(m.x, num(m.sx, 0)),
    y: num(m.y, num(m.sy, 0)),
    down: !!(m.down || m.held || m.left),
    clicked: !!(m.clicked || m.pressed),
    worldX: num(m.worldX, NaN),
    worldY: num(m.worldY, NaN),
  };
}

function mouseWorld(G, ctxW, ctxH) {
  const m = mouseOf(G);
  if (Number.isFinite(m.worldX) && Number.isFinite(m.worldY)) {
    return { x: m.worldX, y: m.worldY, down: m.down, clicked: m.clicked };
  }
  const cam = G.camera || {};
  const p = G.player || {};
  const cx = num(cam.x, num(p.x, WORLD_SIZE / 2));
  const cy = num(cam.y, num(p.y, WORLD_SIZE / 2));
  return {
    x: cx + (m.x - ctxW / 2),
    y: cy + (m.y - ctxH / 2),
    down: m.down,
    clicked: m.clicked,
  };
}

function autopilotDrove(G) {
  if (G.autopilotDrove === true || G.autopilot_drove === true) return true;
  const a = G.autopilot || {};
  if (a.drove === true || a.driving === true) return true;
  return false;
}

function addHeat(G, amount) {
  if (typeof G.heat !== 'number') G.heat = 0;
  G.heat = clamp(G.heat + amount, 0, 100);
}

function blockedAt(G, x, y) {
  const w = G.world || {};
  if (typeof w.isBlocked === 'function') {
    try { return !!w.isBlocked(x, y); } catch (e) { return false; }
  }
  if (typeof w.isSolid === 'function') {
    try { return !!w.isSolid(x, y); } catch (e) { return false; }
  }
  return false;
}

function moveWithCollision(G, p, dx, dy) {
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (!blockedAt(G, nx, ny)) {
    p.x = nx;
    p.y = ny;
    return;
  }
  // Slide along the wall: try each axis on its own.
  if (!blockedAt(G, nx, p.y)) p.x = nx;
  else if (!blockedAt(G, p.x, ny)) p.y = ny;
}

function nearestCar(G, x, y, maxDist) {
  const cars = G.vehicles || G.cars || [];
  let best = null;
  let bestD = maxDist;
  if (!Array.isArray(cars)) return null;
  for (const c of cars) {
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') continue;
    if (c.wrecked === true || c.destroyed === true) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function driverFlees(G, car) {
  // The carjacked driver runs away on foot.
  const peds = G.peds || G.pedestrians || null;
  if (Array.isArray(peds)) {
    peds.push({
      x: car.x + 30,
      y: car.y + 30,
      angle: Math.atan2(num(G.player && G.player.y, 0) - car.y, num(G.player && G.player.x, 0) - car.x) + Math.PI,
      speed: 260,
      state: 'flee',
      fleeing: true,
      color: '#d8c49a',
    });
  }
  car.driver = null;
  car.occupied = false;
  if (car.ai) car.ai = null;
}

function enterCar(G, p, car) {
  const hadDriver = !!(car.driver && car.driver !== 'player');
  if (hadDriver) {
    driverFlees(G, car);
    addHeat(G, CARJACK_HEAT);
  }
  car.driver = 'player';
  car.occupied = true;
  p.car = car;
  p.inCar = true;
  p.onFoot = false;
  p.driving = true;
  p.x = car.x;
  p.y = car.y;
  p.speed = 0;
  if (typeof G.audio === 'object' && G.audio && typeof G.audio.play === 'function') {
    try { G.audio.play('carEnter'); } catch (e) {}
  }
}

function exitCar(G, p) {
  const car = p.car;
  if (!car) return;
  car.driver = null;
  car.occupied = false;
  // Step out to the side of the car, away from traffic.
  const side = Math.PI / 2;
  const a = num(car.angle, 0) + side;
  p.x = car.x + Math.cos(a) * 46;
  p.y = car.y + Math.sin(a) * 46;
  p.x = clamp(p.x, 20, WORLD_SIZE - 20);
  p.y = clamp(p.y, 20, WORLD_SIZE - 20);
  p.car = null;
  p.inCar = false;
  p.onFoot = true;
  p.driving = false;
  p.speed = 0;
  if (typeof G.audio === 'object' && G.audio && typeof G.audio.play === 'function') {
    try { G.audio.play('carExit'); } catch (e) {}
  }
}

function updateOnFoot(G, p, dt, viewW, viewH) {
  // Movement: WASD / arrows.
  let mx = 0;
  let my = 0;
  if (keyDown(G, 'KeyW', 'ArrowUp', 'w', 'W', 'up')) my -= 1;
  if (keyDown(G, 'KeyS', 'ArrowDown', 's', 'S', 'down')) my += 1;
  if (keyDown(G, 'KeyA', 'ArrowLeft', 'a', 'A', 'left')) mx -= 1;
  if (keyDown(G, 'KeyD', 'ArrowRight', 'd', 'D', 'right')) mx += 1;
  const sprint = keyDown(G, 'ShiftLeft', 'ShiftRight', 'Shift', 'shift');
  const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
  p.sprinting = sprint && (mx !== 0 || my !== 0);
  if (mx !== 0 || my !== 0) {
    const len = Math.hypot(mx, my);
    mx /= len;
    my /= len;
    moveWithCollision(G, p, mx * speed * dt, my * speed * dt);
    p.moving = true;
    p.speed = speed;
    // Face the direction of travel when not aiming with the mouse.
    if (!mouseOf(G).down) p.moveAngle = Math.atan2(my, mx);
  } else {
    p.moving = false;
    p.speed = 0;
  }
  p.x = clamp(p.x, 20, WORLD_SIZE - 20);
  p.y = clamp(p.y, 20, WORLD_SIZE - 20);

  // Aim: mouse position in world space.
  const mw = mouseWorld(G, viewW, viewH);
  p.aimAngle = Math.atan2(mw.y - p.y, mw.x - p.x);
  p.angle = p.aimAngle;
  p.aimX = mw.x;
  p.aimY = mw.y;

  // Shoot: mouse held / clicked. Combat owns the firing itself; the
  // player only raises the request flag and a direct hook if present.
  p.shooting = mw.down || mw.clicked;
  if (p.shooting) {
    G.input = G.input || {};
    G.input.shootHeld = true;
    if (G.combat && typeof G.combat.tryShoot === 'function') {
      try { G.combat.tryShoot(G, dt); } catch (e) {}
    } else if (G.weapons && typeof G.weapons.tryFire === 'function') {
      try { G.weapons.tryFire(G, dt); } catch (e) {}
    }
  } else {
    if (G.input) G.input.shootHeld = false;
  }
}

function updateDriving(G, p, dt) {
  const car = p.car;
  if (!car) return;
  // Keep the player glued to the car.
  p.x = car.x;
  p.y = car.y;
  p.angle = num(car.angle, p.angle || 0);
  p.speed = num(car.speed, 0);

  // ★ AUTOPILOT GUARD: if the autopilot drove this frame, do NOT apply
  // manual throttle / steering / braking — that conflict stalls the car.
  if (autopilotDrove(G)) return;

  // Manual input intent for the vehicle physics owner (vehicles.js):
  // throttle -1..1, steer -1..1, brake flag. Player only writes intent;
  // it never integrates the car itself, so there is exactly one owner
  // of car motion.
  let throttle = 0;
  if (keyDown(G, 'KeyW', 'ArrowUp', 'w', 'W', 'up')) throttle += 1;
  if (keyDown(G, 'KeyS', 'ArrowDown', 's', 'S', 'down')) throttle -= 1;
  let steer = 0;
  if (keyDown(G, 'KeyA', 'ArrowLeft', 'a', 'A', 'left')) steer -= 1;
  if (keyDown(G, 'KeyD', 'ArrowRight', 'd', 'D', 'right')) steer += 1;
  const brake = keyDown(G, 'Space', ' ', 'space');
  car.throttle = throttle;
  car.inputThrottle = throttle;
  car.steer = steer;
  car.inputSteer = steer;
  car.brake = brake;
  car.inputBrake = brake;
  car.manualInput = { throttle, steer, brake, dt };
  p.drivingInput = { throttle, steer, brake };
}

export function init(G) {
  G.player = G.player || {};
  const p = G.player;
  if (typeof p.x !== 'number') p.x = 1600;
  if (typeof p.y !== 'number') p.y = 1600;
  if (typeof p.hp !== 'number' && typeof p.health !== 'number') p.hp = 100;
  if (typeof p.angle !== 'number') p.angle = 0;
  p.onFoot = p.inCar !== true;
  p.inCar = p.inCar === true;
  p.speed = 0;
  p.moving = false;
  p.sprinting = false;
  p.shooting = false;
  p._prevE = false;
}

export function update(G, dt) {
  const p = G.player || (G.player = {});
  if (typeof p.x !== 'number') p.x = 1600;
  if (typeof p.y !== 'number') p.y = 1600;
  dt = num(dt, 0.016);
  const viewW = num(G.viewW, 1280);
  const viewH = num(G.viewH, 720);

  // E: enter / exit car — edge-triggered, on foot or driving.
  const eDown = keyDown(G, 'KeyE', 'e', 'E');
  const ePressed = eDown && !p._prevE;
  p._prevE = eDown;
  if (ePressed && !G.paused && !G.dialogOpen) {
    if (p.inCar && p.car) {
      exitCar(G, p);
    } else if (!p.inCar) {
      const car = nearestCar(G, p.x, p.y, ENTER_RANGE);
      if (car) enterCar(G, p, car);
    }
  }

  if (p.inCar && p.car) {
    updateDriving(G, p, dt);
  } else {
    p.inCar = false;
    p.onFoot = true;
    updateOnFoot(G, p, dt, viewW, viewH);
  }

  // Camera follows Rook (render may override; this is the fallback).
  const cam = G.camera || (G.camera = {});
  cam.x = num(cam.x, p.x);
  cam.y = num(cam.y, p.y);
  // Gentle follow: move the camera toward the player each frame.
  cam.x += (p.x - cam.x) * Math.min(1, dt * 6);
  cam.y += (p.y - cam.y) * Math.min(1, dt * 6);
}

export function draw(G, ctx) {
  // The player is drawn by render.js; this draw is a defensive
  // fallback so the module satisfies the draw(G, ctx) contract when
  // render is absent. It draws a simple top-down Rook marker.
  if (!ctx) return;
  const p = G.player || {};
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
  if (p.inCar && p.car) return; // inside the car, nothing to draw
  const cam = G.camera || {};
  const viewW = num(G.viewW, 1280);
  const viewH = num(G.viewH, 720);
  const sx = p.x - num(cam.x, p.x) + viewW / 2;
  const sy = p.y - num(cam.y, p.y) + viewH / 2;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(num(p.angle, 0));
  ctx.fillStyle = '#e8b64c';
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#22222a';
  ctx.fillRect(8, -3, 16, 6); // gun barrel / aim direction
  ctx.restore();
}
