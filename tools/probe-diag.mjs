// Diagnostic chase probe (B8): dense 1s sampling of the m2 Tail Chase.
// Written fresh for the v11 arc failure: the arc run slid along the
// west/south world walls for 600+s while the probe run passed, so this
// probe records the numbers that distinguish the two runs — courier
// distance (does the dCourier>250 recovery gate ever open?), whether the
// player is on a road, car heading, and the autopilot's route target —
// every second, so a wall-slide shows up as a pattern, not a guess.
//
// Usage: node tools/probe-diag.mjs [--seconds 300] [--port 8934]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const gameDir = path.join(root, 'game');
const logPath = '/tmp/probe-diag.txt';

const shell = path.join(
  os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255',
  'chrome-headless-shell-linux64', 'chrome-headless-shell',
);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const argv = process.argv.slice(2);
let chaseSecs = 300;
let port = 8934;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--seconds') chaseSecs = Number(argv[++i]);
  if (argv[i] === '--port') port = Number(argv[++i]);
}

function serve(portNo) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let fp = path.join(root, decodeURIComponent(url.pathname));
        if (url.pathname === '/') fp = path.join(gameDir, 'index.html');
        if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
        if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
        res.writeHead(200, { 'content-type': mime[path.extname(fp)] || 'application/octet-stream' });
        res.end(fs.readFileSync(fp));
      } catch { res.writeHead(404); res.end('nf'); }
    });
    server.on('error', reject);
    server.listen(portNo, '127.0.0.1', () => resolve(server));
  });
}

function say(line) {
  fs.appendFileSync(logPath, line + '\n');
  console.log(line);
}

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
      px: Math.round(p.x || 0), py: Math.round(p.y || 0),
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
      out.cx = Math.round(c.x); out.cy = Math.round(c.y);
      out.cAngle = +(c.angle || 0).toFixed(2);
      out.cSpeed = Math.round(c.speed || 0);
      out.cCruise = Math.round(c.cruise || 0);
      out.cDest = (typeof c.destX === 'number') ? `${Math.round(c.destX)},${Math.round(c.destY)}` : null;
      out.cRouteLen = Array.isArray(c.route) ? c.route.length : null;
      out.dist = Math.round(Math.hypot((p.x || 0) - c.x, (p.y || 0) - c.y));
    }
    return out;
  });
}

async function main() {
  fs.writeFileSync(logPath, `=== probe-diag ${new Date().toISOString()} ===\n`);
  const server = await serve(port);
  const browser = await chromium.launch({
    headless: true,
    executablePath: shell,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  let outcome = 'TIMEOUT';
  let minDist = Infinity;
  let offRoadSecs = 0;
  let closeOffRoadSecs = 0; // off-road while courier within 250 (recovery gate shut)
  let lastHits = 0;
  let restarts = 0;
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
          if (s.hits < lastHits) { restarts += 1; say(`  RESTART? hits ${lastHits} -> ${s.hits} at t=${t}s (m2 timed out and restarted)`); }
          else say(`  HIT ${s.hits}/4 at t=${t}s dist=${s.dist} speed=${s.speed} courier=${s.cSpeed}/${s.cCruise}`);
          lastHits = s.hits;
        }
        if (typeof s.dist === 'number' && s.dist < minDist) minDist = s.dist;
        if (s.onRoad === false) {
          offRoadSecs += 1;
          if (typeof s.dist === 'number' && s.dist <= 250) closeOffRoadSecs += 1;
        }
        say(`t=${t}s hits=${s.hits} tl=${s.timeLeft} p=(${s.px},${s.py}) a=${s.angle} v=${s.speed} onRoad=${s.onRoad} courier=(${s.cx},${s.cy}) a=${s.cAngle} ${s.cSpeed}/${s.cCruise} dest=${s.cDest} route=${s.cRouteLen} dist=${s.dist} mode=${s.mode} rt=${s.routeTarget || '-'} rlen=${s.routeLen ?? '-'}`);
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  say(`\n== DIAG RESULT: ${outcome} ==`);
  say(`minDist=${minDist === Infinity ? 'n/a' : minDist} offRoadSecs=${offRoadSecs} offRoadWhileCourierWithin250=${closeOffRoadSecs} restartsSeen=${restarts} consoleErrors=${errors.length}`);
  if (errors.length) for (const e of errors.slice(0, 5)) say(`  err: ${e}`);
  return outcome === 'M2-COMPLETE' ? 0 : 1;
}

process.exitCode = await main();
