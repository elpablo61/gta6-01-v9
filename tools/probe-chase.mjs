// Chase probe for Crescent Bay (gta6-01-v9) — the m2 Tail Chase, sampled
// once a second until the mission completes or the time budget runs out.
//
// Written for the v11/v12 chase: the arc run slid along the west/south
// world walls for 600+s while the probe passed, so this probe records
// the numbers that distinguish the two runs — courier distance, whether
// the player is on a road, car heading, and the autopilot's route
// target — every second, so a wall-slide shows up as a pattern, not a
// guess. Summary counters at the end: closest approach, seconds spent
// off-road (and off-road while the courier is close), hit times, and
// how many times the mission restarted after a timeout.
//
// Usage: node tools/probe-chase.mjs [--seconds 300] [--port 8933]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME_DIR = path.join(ROOT, 'game');
const LOG_PATH = '/tmp/probe-chase.txt';

const SHELL = path.join(
  os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255',
  'chrome-headless-shell-linux64', 'chrome-headless-shell',
);
const CONTENT_TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const argv = process.argv.slice(2);
let chaseSecs = 300;
let port = 8933;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--seconds') chaseSecs = Number(argv[++i]);
  if (argv[i] === '--port') port = Number(argv[++i]);
}

function serve(portNo) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let file = path.join(ROOT, decodeURIComponent(url.pathname));
        if (url.pathname === '/') file = path.join(GAME_DIR, 'index.html');
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        res.writeHead(200, { 'content-type': CONTENT_TYPE[path.extname(file)] || 'application/octet-stream' });
        res.end(fs.readFileSync(file));
      } catch (e) { res.writeHead(404); res.end('nf'); }
    });
    server.on('error', reject);
    server.listen(portNo, '127.0.0.1', () => resolve(server));
  });
}

function say(line) {
  fs.appendFileSync(LOG_PATH, line + '\n');
  console.log(line);
}

// One 1-second snapshot of the chase: player + courier + autopilot.
async function snapshot(page) {
  return page.evaluate(() => {
    const G = window.__game;
    if (!G) return null;
    const p = G.player || {};
    const car = p.car || null;
    const m = G.missions || {};
    const c = m.courier || null;
    const ap = G.autopilot || {};
    const world = G.world || {};
    const out = {
      mission: (m.active && m.active.id) || null,
      timeLeft: typeof m.timeLeft === 'number' ? Math.round(m.timeLeft) : null,
      done: Array.isArray(m.completed) ? m.completed.slice() : [],
      hits: (m.progress && m.progress.hits) || 0,
      px: Math.round(p.x || 0),
      py: Math.round(p.y || 0),
      angle: car ? +((car.angle || 0)).toFixed(2) : null,
      speed: Math.round(Math.abs((car && car.speed) || p.speed || 0)),
      inCar: !!p.inCar,
      carTop: car ? (car.topSpeed || null) : null,
      mode: ap.mode || null,
      routeTarget: ap.routeTarget ? `${Math.round(ap.routeTarget.x)},${Math.round(ap.routeTarget.y)}` : null,
      routeLen: Array.isArray(ap.route) ? ap.route.length : null,
      onRoad: (typeof world.isOnRoad === 'function') ? !!world.isOnRoad(p.x, p.y) : null,
    };
    if (c) {
      out.cx = Math.round(c.x);
      out.cy = Math.round(c.y);
      out.cAngle = +(c.angle || 0).toFixed(2);
      out.cSpeed = Math.round(c.speed || 0);
      out.cCruise = Math.round(c.cruise || 0);
      out.cDest = (typeof c.destX === 'number') ? `${Math.round(c.destX)},${Math.round(c.destY)}` : null;
      out.cRouteLen = Array.isArray(c.route) ? c.route.length : null;
      out.dist = Math.round(Math.hypot((p.x || 0) - c.x, (p.y || 0) - c.y));
    }
    // B9 branch telemetry: the autopilot publishes one plain object per
    // frame (G.chaseDebug) — branch, throttle/steer the car actually
    // got, keys held vs keys the input module sees, courier dest,
    // mission timer. Pass it through whole; the log line formats it.
    out.dbg = G.chaseDebug || null;
    return out;
  });
}

async function main() {
  fs.writeFileSync(LOG_PATH, `=== probe-chase ${new Date().toISOString()} ===\n`);
  const server = await serve(port);
  const browser = await chromium.launch({
    headless: true,
    executablePath: SHELL,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  let outcome = 'TIMEOUT';
  let minDist = Infinity;
  let samples = 0;
  let in70 = 0;
  let slowSamples = 0;
  let speedSum = 0;
  let maxSpeed = 0;
  let offRoadSecs = 0;
  let closeOffRoadSecs = 0; // off-road while the courier is within 250
  let lastHits = 0;
  let restarts = 0;
  // B9 freeze detector: rounded player position unchanged across
  // samples. The v12 arc froze pixel-identical for ~580s, so 10s of
  // no movement is the tripwire — dump the full debug object then.
  let freezePos = null;
  let freezeSecs = 0;
  let maxFreezeSecs = 0;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/game/?seed=7&autopilot=1`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1000);
    const btn = page.locator('#new-game-btn');
    if (await btn.count()) await btn.click({ timeout: 2000 }).catch(() => {});
    await page.evaluate(() => {
      if (window.__game) window.__game.autopilotEnabled = true;
      window.__autopilot = true;
    });

    // Wait for m1 to finish and m2 to become active (up to 240s).
    const t0 = Date.now();
    let chaseAt = null;
    while (Date.now() - t0 < 240000) {
      const s = await snapshot(page).catch(() => null);
      if (s && s.mission === 'm2') { chaseAt = Date.now(); break; }
      if (s && s.done.includes('m2')) { outcome = 'ALREADY-DONE'; break; }
      await page.waitForTimeout(1000);
    }
    if (!chaseAt && outcome !== 'ALREADY-DONE') {
      say('m2 never became active within 240s');
      outcome = 'NO-M2';
    } else if (outcome !== 'ALREADY-DONE') {
      say(`m2 active after ${Math.round((chaseAt - t0) / 1000)}s`);
      const chaseStart = Date.now();
      while (Date.now() - chaseStart < chaseSecs * 1000) {
        const s = await snapshot(page).catch(() => null);
        if (!s) { await page.waitForTimeout(1000); continue; }
        if (s.done.includes('m2')) { outcome = 'M2-COMPLETE'; break; }
        if (s.mission !== 'm2') { say(`left m2 (now ${s.mission})`); outcome = 'LEFT-M2'; break; }
        const t = Math.round((Date.now() - chaseStart) / 1000);
        if (s.hits !== lastHits) {
          if (s.hits < lastHits) {
            restarts += 1;
            say(`  RESTART? hits ${lastHits} -> ${s.hits} at t=${t}s (m2 timed out and restarted)`);
          } else {
            say(`  HIT ${s.hits}/4 at t=${t}s dist=${s.dist} speed=${s.speed} courier=${s.cSpeed}/${s.cCruise}`);
          }
          lastHits = s.hits;
        }
        samples += 1;
        if (typeof s.dist === 'number') {
          if (s.dist < minDist) minDist = s.dist;
          if (s.dist < 70) in70 += 1;
        }
        speedSum += s.speed || 0;
        if ((s.speed || 0) > maxSpeed) maxSpeed = s.speed;
        if (s.inCar && (s.speed || 0) < 60) slowSamples += 1;
        if (s.onRoad === false) {
          offRoadSecs += 1;
          if (typeof s.dist === 'number' && s.dist <= 250) closeOffRoadSecs += 1;
        }
        say(`t=${t}s hits=${s.hits} tl=${s.timeLeft} p=(${s.px},${s.py}) a=${s.angle} v=${s.speed} onRoad=${s.onRoad} courier=(${s.cx},${s.cy}) a=${s.cAngle} ${s.cSpeed}/${s.cCruise} dest=${s.cDest} route=${s.cRouteLen} dist=${s.dist} mode=${s.mode} rt=${s.routeTarget || '-'} rlen=${s.routeLen ?? '-'} br=${s.dbg?.branch ?? '-'} drv=${s.dbg?.drive ?? '-'} thr=${s.dbg?.carThrottle ?? '-'} str=${s.dbg?.carSteer ?? '-'} held=[${(s.dbg?.heldKeys || []).join(',')}] inp=[${(s.dbg?.inputKeys || []).join(',')}] st=${s.dbg?.gameState ?? '-'} en=${s.dbg?.enabled ?? '-'} dCorn=${s.dbg?.dCorner ?? '-'} r0=${s.dbg?.route0 || '-'}`);
        // B9 freeze tripwire: same rounded position 10s running.
        const posKey = `${s.px},${s.py}`;
        if (posKey === freezePos) freezeSecs += 1;
        else { freezePos = posKey; freezeSecs = 0; }
        if (freezeSecs > maxFreezeSecs) maxFreezeSecs = freezeSecs;
        if (freezeSecs === 10 || (freezeSecs > 10 && freezeSecs % 30 === 0)) {
          say(`  FREEZE? pos ${posKey} unchanged ${freezeSecs}s mode=${s.mode} br=${s.dbg?.branch} drv=${s.dbg?.drive} thr=${s.dbg?.carThrottle} str=${s.dbg?.carSteer} held=[${(s.dbg?.heldKeys || []).join(',')}] inp=[${(s.dbg?.inputKeys || []).join(',')}] st=${s.dbg?.gameState} en=${s.dbg?.enabled} angle=${s.angle} cDest=${s.dbg?.courier?.dest} cSpeed=${s.dbg?.courier?.speed} dCorn=${s.dbg?.dCorner} dCourier=${s.dbg?.dCourier} tl=${s.timeLeft} hits=${s.hits} stuckFor=${s.dbg?.stuckFor} revT=${s.dbg?.carReverseTimer} stuckT=${s.dbg?.carStuckTimer} dlg=${s.dbg?.dialogOpen}`);
          say(`  FREEZE-DBG ${JSON.stringify(s.dbg)}`);
        }
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  say(`\n== CHASE RESULT: ${outcome} ==`);
  say(`samples=${samples} minDist=${minDist === Infinity ? 'n/a' : minDist} in70=${in70} avgPlayerSpeed=${samples ? Math.round(speedSum / samples) : 'n/a'} maxSpeed=${maxSpeed} slowSamples=${slowSamples} offRoadSecs=${offRoadSecs} offRoadWhileCourierWithin250=${closeOffRoadSecs} restartsSeen=${restarts} maxFreezeSecs=${maxFreezeSecs} consoleErrors=${errors.length}`);
  if (errors.length) for (const e of errors.slice(0, 5)) say(`  err: ${e}`);
  return outcome === 'M2-COMPLETE' ? 0 : 1;
}

process.exitCode = await main();
