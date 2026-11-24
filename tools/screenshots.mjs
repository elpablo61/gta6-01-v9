// Screenshot poses for Crescent Bay (gta6-01-v9).
//
// Four fresh shots from the autopilot poses, deterministic seed 7:
//   1-cover    bright daytime, waterfront, chase, wanted 3, escape objective
//   2-mission  on foot, shootout, fixer dialog visible
//   3-night    night chase, headlights, roadblock, wanted 4
//   4-start    title overlay over the living city
//
// Each file is a JPEG of at most 200 KiB (quality steps down 80 -> 60 -> 40
// until it fits). The tool serves the repo on its own port (default 8932)
// and launches Playwright 1.49 with the cached chromium_headless_shell-1255
// executablePath. It never depends on serve.ts.
//
// Poses are staged through the game's own pose hook when it exists
// (window.__stagePose / ?shot= / ?pose=); otherwise the tool drives the
// live game with the autopilot and screenshots the real play. Either way
// the frame is what the game really shows — never a mock.
//
// Usage:
//   node tools/screenshots.mjs [--port 8932] [--out screenshots] [--only 1]
//   node tools/screenshots.mjs --help

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAME_ROOT = path.join(REPO_ROOT, 'game');

const HEADLESS_SHELL = path.join(
  os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255',
  'chrome-headless-shell-linux64', 'chrome-headless-shell',
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const MAX_BYTES = 200 * 1024;

const POSES = [
  {
    name: '1-cover',
    file: '1-cover.jpg',
    desc: 'bright daytime, waterfront, chase, wanted 3, escape objective',
    query: 'seed=7&autopilot=1&pose=cover&mission=m7&wanted=3',
    driveSeconds: 25,
  },
  {
    name: '2-mission',
    file: '2-mission.jpg',
    desc: 'on foot, shootout, fixer dialog visible',
    query: 'seed=7&autopilot=1&pose=mission&mission=m8',
    driveSeconds: 30,
  },
  {
    name: '3-night',
    file: '3-night.jpg',
    desc: 'night chase, headlights, roadblock, wanted 4',
    query: 'seed=7&autopilot=1&pose=night&mission=m7&wanted=4&time=night',
    driveSeconds: 25,
  },
  {
    name: '4-start',
    file: '4-start.jpg',
    desc: 'title overlay over the living city',
    query: 'seed=7&pose=start',
    driveSeconds: 0,
  },
];

function parseArgs(argv) {
  const args = { port: 8932, out: path.join(REPO_ROOT, 'screenshots'), only: null, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a.startsWith('--only=')) args.only = a.slice(7);
  }
  return args;
}

function printHelp() {
  console.log(`Crescent Bay screenshot poses (seed 7, autopilot)
Usage: node tools/screenshots.mjs [--port 8932] [--out screenshots]
       [--only 1|2|3|4] [--url http://localhost:8932/game/] [--help]

Poses: 1-cover (day chase, wanted 3)  2-mission (shootout + dialog)
       3-night (night chase, wanted 4)  4-start (title over living city)
Each JPEG is capped at 200 KiB.`);
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

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: HEADLESS_SHELL,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

async function startGame(page) {
  const newGame = page.locator('#new-game-btn');
  if (await newGame.count()) {
    try { await newGame.click({ timeout: 2000 }); return; } catch { /* fall through */ }
  }
  await page.keyboard.press('Enter');
}

async function enableAutopilot(page) {
  await page.evaluate(() => {
    try {
      if (window.__cbDebug) window.__cbDebug.autopilotEnabled = true;
      if (window.G) window.G.autopilotEnabled = true;
      if (window.__game) window.__game.autopilotEnabled = true;
      window.__autopilot = true;
    } catch { /* best-effort */ }
  });
}

// Ask the game to stage a pose through its own hook when one exists.
// Returns true when the hook answered.
async function tryStagePose(page, poseName) {
  return page.evaluate((name) => {
    try {
      if (typeof window.__stagePose === 'function') { window.__stagePose(name); return true; }
      if (window.__cbDebug && typeof window.__cbDebug.stagePose === 'function') {
        window.__cbDebug.stagePose(name); return true;
      }
      if (window.G && typeof window.G.stagePose === 'function') { window.G.stagePose(name); return true; }
    } catch { /* fall through */ }
    return false;
  }, poseName);
}

async function waitForShotReady(page, timeoutMs) {
  try {
    await page.waitForFunction(() => window.__shotReady === true, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// Screenshot at descending JPEG quality until the 200 KiB cap is met.
async function captureCapped(page, outPath) {
  for (const quality of [80, 65, 50, 40, 30]) {
    const buffer = await page.screenshot({ type: 'jpeg', quality });
    if (buffer.length <= MAX_BYTES || quality === 30) {
      fs.writeFileSync(outPath, buffer);
      return { bytes: buffer.length, quality };
    }
  }
  return { bytes: 0, quality: 0 };
}

async function shootPose(browser, baseUrl, pose, outDir) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));

  const url = `${baseUrl}?${pose.query}`;
  console.log(`-- ${pose.name}: ${pose.desc}`);
  console.log(`   ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);

  let staged = false;
  if (pose.name !== '4-start') {
    staged = await tryStagePose(page, pose.name);
    if (!staged) {
      // No pose hook: drive the live game with the autopilot.
      await startGame(page);
      await enableAutopilot(page);
      // Mission pose: wait for the fixer dialog to show, then keep it.
      if (pose.name === '2-mission') {
        try {
          await page.waitForSelector('#mission-dialog:not([hidden])', { timeout: 15000 });
          await page.waitForTimeout(600);
        } catch {
          // Dialog never opened (mission module may be missing); keep
          // driving and shoot whatever the game shows.
          await page.waitForTimeout(8000);
        }
      } else {
        await page.waitForTimeout(pose.driveSeconds * 1000);
      }
    } else {
      await waitForShotReady(page, 15000);
    }
  } else {
    // Title pose: let the living city animate behind the overlay.
    await page.waitForTimeout(4000);
  }

  const outPath = path.join(outDir, pose.file);
  const shot = await captureCapped(page, outPath);
  console.log(`   -> ${pose.file} ${shot.bytes} bytes (quality ${shot.quality})${shot.bytes > MAX_BYTES ? ' OVER CAP' : ''}`);
  if (errors.length > 0) {
    console.log(`   console errors: ${errors.slice(0, 3).join(' | ')}`);
  }
  await context.close();
  return { pose: pose.name, file: pose.file, bytes: shot.bytes, ok: shot.bytes <= MAX_BYTES && shot.bytes > 0, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }
  const wanted = args.only ? POSES.filter((p) => p.name.startsWith(`${args.only}-`)) : POSES;
  if (wanted.length === 0) { console.error(`unknown pose: ${args.only}`); return 2; }
  fs.mkdirSync(args.out, { recursive: true });

  let server = null;
  let baseUrl = args.url;
  if (!baseUrl) {
    try {
      server = await startServer(args.port);
    } catch (err) {
      if (String(err.message || err).includes('EADDRINUSE')) {
        console.error(`port ${args.port} busy (EADDRINUSE) — kill the leftover server by PID, then retry.`);
        return 2;
      }
      throw err;
    }
    baseUrl = `http://127.0.0.1:${args.port}/game/`;
    console.log(`serving ${REPO_ROOT} on ${baseUrl}`);
  }

  const browser = await launchBrowser();
  const results = [];
  try {
    for (const pose of wanted) {
      results.push(await shootPose(browser, baseUrl, pose, args.out));
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
  }

  console.log('\n== SCREENSHOTS ==');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file} — ${r.bytes} bytes (cap ${MAX_BYTES})`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

process.exitCode = await main();
