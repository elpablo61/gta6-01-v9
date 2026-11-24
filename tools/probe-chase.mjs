// Chase probe (B7): watches the m2 Tail Chase live and reports numbers.
// Plays m1 on autopilot first (~60s), then samples the chase once per
// second: player speed / car type, courier speed / cruise / hits, distance,
// autopilot mode, and the closest approach. Prints a summary at the end so
// a fix can be judged on numbers, not on vibes.
//
// Usage: node tools/probe-chase.mjs [--seconds 320] [--port 8933]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAME_ROOT = path.join(REPO_ROOT, 'game');
const LOG = '/tmp/probe-chase.txt';

const HEADLESS_SHELL = path.join(
  os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255',
  'chrome-headless-shell-linux64', 'chrome-headless-shell',
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const args = process.argv.slice(2);
let chaseSeconds = 320;
let port = 8933;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--seconds') chaseSeconds = Number(args[++i]);
  if (args[i] === '--port') port = Number(args[++i]);
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let filePath = path.join(REPO_ROOT, decodeURIComponent(url.pathname));
        if (url.pathname === '/') filePath = path.join(GAME_ROOT, 'index.html');
        if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function log(line) {
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

async function readChase(page) {
  return page.evaluate(() => {
    const G = window.__game;
    if (!G) return null;
    const p = G.player || {};
    const car = p.car || p.vehicle || null;
    const m = G.missions || {};
    const c = m.courier || null;
    const out = {
      mission: (m.active && m.active.id) || null,
      stage: m.stage ?? null,
      status: m.status ?? null,
      completed: Array.isArray(m.completed) ? m.completed.slice() : [],
      hits: (m.progress && m.progress.hits) || (c && c.hits) || 0,
      px: p.x ?? null, py: p.y ?? null,
      inCar: !!p.inCar,
      carType: car ? (car.type || '?') : null,
      carTop: car ? (car.topSpeed ?? null) : null,
      carSpeed: car ? Math.round(Math.abs(car.speed || 0)) : Math.round(Math.abs(p.speed || 0)),
      mode: (G.autopilot && G.autopilot.mode) || null,
      heat: typeof G.heat === 'number' ? Math.round(G.heat) : null,
    };
    if (c) {
      out.cx = Math.round(c.x); out.cy = Math.round(c.y);
      out.cSpeed = Math.round(c.speed || 0);
      out.cCruise = Math.round(c.cruise || 0);
      out.cAngle = +(c.angle || 0).toFixed(2);
      out.cRouteLen = Array.isArray(c.route) ? c.route.length : null;
      out.cDest = (typeof c.destX === 'number') ? `${Math.round(c.destX)},${Math.round(c.destY)}` : null;
      if (typeof out.px === 'number') {
        out.dist = Math.round(Math.hypot(out.px - c.x, out.py - c.y));
      }
    }
    const ap = G.autopilot || {};
    if (ap.chaseIntercept) out.ambush = `${Math.round(ap.chaseIntercept.x)},${Math.round(ap.chaseIntercept.y)}`;
    if (Array.isArray(ap.chaseRoute)) out.chaseRouteLen = ap.chaseRoute.length;
    return out;
  });
}

async function main() {
  fs.writeFileSync(LOG, `=== probe-chase ${new Date().toISOString()} ===\n`);
  const server = await startServer(port);
  const browser = await chromium.launch({
    headless: true,
    executablePath: HEADLESS_SHELL,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  let minDist = Infinity;
  let samplesIn70 = 0;
  let samplesTotal = 0;
  let speedSum = 0;
  let speedSamples = 0;
  let maxSpeed = 0;
  let slowSamples = 0; // player speed < 60 while driving during chase
  let result = 'TIMEOUT';
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

    // Phase 1: wait for m2 to become active (m1 plays first, ~60s).
    const t0 = Date.now();
    let m2At = null;
    while (Date.now() - t0 < 240000) {
      const s = await readChase(page).catch(() => null);
      if (s && s.mission === 'm2') { m2At = Date.now(); break; }
      if (s && s.completed && s.completed.includes('m2')) { result = 'ALREADY-DONE'; break; }
      await page.waitForTimeout(1000);
    }
    if (!m2At && result !== 'ALREADY-DONE') {
      log('m2 never became active within 240s');
      result = 'NO-M2';
    } else if (result !== 'ALREADY-DONE') {
      log(`m2 active after ${Math.round((m2At - t0) / 1000)}s (m1 done first)`);
      // Phase 2: sample the chase.
      const chaseStart = Date.now();
      let lastHits = 0;
      while (Date.now() - chaseStart < chaseSeconds * 1000) {
        const s = await readChase(page).catch(() => null);
        if (!s) { await page.waitForTimeout(1000); continue; }
        if (s.completed.includes('m2')) { result = 'M2-COMPLETE'; break; }
        if (s.mission !== 'm2') {
          log(`mission left m2 (now ${s.mission}, status ${s.status}) — chase ended`);
          result = 'LEFT-M2';
          break;
        }
        samplesTotal += 1;
        if (typeof s.dist === 'number') {
          if (s.dist < minDist) minDist = s.dist;
          if (s.dist < 70) samplesIn70 += 1;
        }
        if (typeof s.carSpeed === 'number') {
          speedSum += s.carSpeed;
          speedSamples += 1;
          if (s.carSpeed > maxSpeed) maxSpeed = s.carSpeed;
          if (s.inCar && s.carSpeed < 60) slowSamples += 1;
        }
        if (s.hits !== lastHits) {
          log(`  HIT ${s.hits}/4 at t=${Math.round((Date.now() - chaseStart) / 1000)}s dist=${s.dist} speed=${s.carSpeed} courier=${s.cSpeed}/${s.cCruise}`);
          lastHits = s.hits;
        }
        if (samplesTotal % 10 === 0 || samplesTotal <= 3) {
          log(`t=${Math.round((Date.now() - chaseStart) / 1000)}s mode=${s.mode} p=(${s.px},${s.py}) car=${s.carType}/${s.carTop} speed=${s.carSpeed} courier=(${s.cx},${s.cy}) ${s.cSpeed}/${s.cCruise} routeLen=${s.cRouteLen} dest=${s.cDest} ambush=${s.ambush || '-'} chaseRoute=${s.chaseRouteLen ?? '-'} dist=${s.dist} hits=${s.hits}`);
        }
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  const avgSpeed = speedSamples ? Math.round(speedSum / speedSamples) : null;
  log(`\n== PROBE RESULT: ${result} ==`);
  log(`samples=${samplesTotal} minDist=${minDist === Infinity ? 'n/a' : minDist} in70=${samplesIn70} avgPlayerSpeed=${avgSpeed} maxSpeed=${maxSpeed} slowSamples(<60,driving)=${slowSamples}/${speedSamples} consoleErrors=${errors.length}`);
  if (errors.length) for (const e of errors.slice(0, 5)) log(`  err: ${e}`);
  return result === 'M2-COMPLETE' ? 0 : 1;
}

process.exitCode = await main();
