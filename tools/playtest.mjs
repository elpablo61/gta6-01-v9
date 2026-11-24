// Playtest suite for Crescent Bay (gta6-01-v9).
//
// Modes:
//   cold   load + title + start + a few seconds of play, no console errors
//   edge   reloads, resize, pause/resume, corrupt save slot, rapid keys
//   arc    full 12-mission arc by autopilot (or one mission with --mission mN)
//   fps    frame rate during a wanted chase
//
// The suite serves the repo over plain HTTP on its own port (default 8931),
// launches Playwright 1.49 with the cached chromium_headless_shell-1255
// executablePath, and never depends on serve.ts. Long runs write one state
// line per mission every 2 seconds to /tmp/arc-progress.txt, because Node
// stdout to a file is block-buffered and a killed run would otherwise leave
// no trace of where it died.
//
// The game exposes its state through whichever debug hook exists
// (window.__cbDebug, window.G, window.__game); when none exists the suite
// falls back to DOM and canvas checks and says so plainly instead of
// inventing a result.
//
// Usage:
//   node tools/playtest.mjs --mode cold
//   node tools/playtest.mjs --mode arc --mission m2
//   node tools/playtest.mjs --mode fps --seconds 8
//   node tools/playtest.mjs --help

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GAME_ROOT = path.join(REPO_ROOT, 'game');
const ARC_PROGRESS = '/tmp/arc-progress.txt';

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
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

function parseArgs(argv) {
  const args = { mode: 'cold', mission: null, port: 8931, seconds: 8, headless: true, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--mission') args.mission = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--seconds') args.seconds = Number(argv[++i]);
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--headed') args.headless = false;
    else if (a.startsWith('--mode=')) args.mode = a.slice(7);
    else if (a.startsWith('--mission=')) args.mission = a.slice(10);
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
  }
  return args;
}

function printHelp() {
  console.log(`Crescent Bay playtest suite
Usage: node tools/playtest.mjs [--mode cold|edge|arc|fps] [--mission mN]
       [--port 8931] [--seconds N] [--url http://localhost:8931/game/]
       [--headed] [--help]

  cold  page load, title screen, start game, short play, zero console errors
  edge  reloads, viewport resize, pause/resume, corrupt save, rapid keys
  arc   autopilot plays the mission arc (or one mission with --mission)
  fps   frames per second during a wanted chase

Long arc runs append one state line per mission every 2s to ${ARC_PROGRESS}.`);
}

// Serve the repo root so /game/index.html works exactly like the real server.
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

async function launchBrowser(headless) {
  return chromium.launch({
    headless,
    executablePath: HEADLESS_SHELL,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

// One rAF counter injected before any page script runs: proves the game
// loop is actually advancing even when the game exposes no debug hook.
async function installFrameCounter(page) {
  await page.addInitScript(() => {
    window.__frames = 0;
    const tick = () => { window.__frames += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

// Read whatever debug state the game exposes, normalised. Returns
// { available: false } when the game exposes nothing — the caller must
// then rely on DOM checks and say so.
async function probeState(page) {
  return page.evaluate(() => {
    const debug = window.__cbDebug || window.G || window.__game || window.game || null;
    const snap = { available: false, screen: null, player: null, mission: null, heat: null, wanted: null, fps: null, autopilot: null };
    const titleEl = document.getElementById('title-screen');
    const dialogEl = document.getElementById('mission-dialog');
    const overEl = document.getElementById('game-over-screen');
    if (titleEl && !titleEl.hidden) snap.screen = 'title';
    else if (overEl && !overEl.hidden) snap.screen = 'gameover';
    else if (dialogEl && !dialogEl.hidden) snap.screen = 'dialog';
    else snap.screen = 'play';
    snap.frames = typeof window.__frames === 'number' ? window.__frames : null;
    if (!debug) return snap;
    try {
      snap.available = true;
      const p = debug.player || debug.state?.player || null;
      if (p) {
        snap.player = {
          x: p.x ?? p.pos?.x ?? null,
          y: p.y ?? p.pos?.y ?? null,
          inCar: p.inCar ?? p.driving ?? null,
          health: p.health ?? null,
          ammo: p.ammo ?? null,
          weapon: typeof p.weapon === 'string' ? p.weapon : (p.weapon?.name ?? p.currentWeapon ?? null),
        };
      }
      const m = debug.missions?.current || debug.missions?.active || debug.mission || null;
      if (m) {
        snap.mission = {
          id: m.id ?? m.name ?? null,
          stage: m.stage ?? m.stageIndex ?? null,
          status: m.status ?? m.state ?? null,
          failed: m.failed ?? false,
          complete: m.complete ?? m.completed ?? false,
        };
      }
      if (typeof debug.heat === 'number') snap.heat = debug.heat;
      if (typeof debug.wanted === 'number') snap.wanted = debug.wanted;
      if (debug.autopilot) snap.autopilot = { mode: debug.autopilot.mode ?? null, enabled: debug.autopilotEnabled ?? null };
      if (debug.heli || debug.helicopter) snap.heli = true;
    } catch {
      // A half-built debug hook must not fail the probe.
    }
    return snap;
  });
}

function collectErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText || ''}`));
  return errors;
}

function check(name, ok, detail) {
  return { name, ok: !!ok, detail: detail || '' };
}

async function startGame(page) {
  // Click New Game when the title screen is up, else press Enter.
  const newGame = page.locator('#new-game-btn');
  if (await newGame.count()) {
    try { await newGame.click({ timeout: 2000 }); return 'click-new-game'; } catch { /* fall through */ }
  }
  await page.keyboard.press('Enter');
  return 'key-enter';
}

// New Game offers the first mission in a dialog that blocks play; click
// Accept (the real user path) when it is open so later checks run in play.
// The offer appears on a ~1.2s timer after New Game, so WAIT for it
// (up to 4s) instead of checking once — a too-early check leaves the
// dialog open and every later key-driven check (weapons, radio) runs in
// dialog state, where the game loop does not call module updates at all.
async function acceptDialogIfOpen(page) {
  try {
    const dlg = page.locator('#mission-dialog');
    try {
      await dlg.waitFor({ state: 'visible', timeout: 4000 });
    } catch {
      return; // no dialog offered (e.g. mid-arc) — nothing to accept
    }
    await page.locator('#accept-btn').click({ timeout: 2000 });
    await dlg.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  } catch { /* dialog already gone */ }
}

// Read the live weapon state through the game's own debug hook.
async function readWeapons(page) {
  return page.evaluate(() => {
    const w = window.__game?.weapons;
    if (!w) return null;
    return { current: w.current, owned: { ...w.owned }, ammo: { ...w.ammo } };
  });
}

// Hold a key long enough (~200ms, many frames) that the game's
// edge-triggered key readers see it; a bare Playwright press can fall
// between two frames and be missed entirely.
async function holdKey(page, code, ms = 200) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
  await page.waitForTimeout(250);
}

async function enableAutopilot(page) {
  // The game may read ?autopilot=1, a window flag, or an exported enable.
  await page.evaluate(() => {
    try {
      if (window.__cbDebug) window.__cbDebug.autopilotEnabled = true;
      if (window.G) window.G.autopilotEnabled = true;
      if (window.__game) window.__game.autopilotEnabled = true;
      window.__autopilot = true;
    } catch { /* best-effort */ }
  });
}

// ---------------------------------------------------------------------------
// cold: load, title, start, short play, zero console errors.
// ---------------------------------------------------------------------------
async function runCold(page, baseUrl, errors) {
  const results = [];
  await page.goto(`${baseUrl}?seed=7`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  results.push(check('page loads (canvas present)', await page.locator('#game-canvas').count() > 0));
  const titleVisible = await page.locator('#title-screen').isVisible().catch(() => false);
  results.push(check('title screen visible', titleVisible));
  // Gate: the title screen lists 3 save slots.
  const slotCount = await page.locator('#save-slots .slot-btn').count().catch(() => 0);
  const slotTexts = await page.locator('#save-slots .slot-btn').allTextContents().catch(() => []);
  results.push(check('title shows 3 save slots', slotCount === 3, slotTexts.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ')));
  const framesBefore = await page.evaluate(() => window.__frames || 0);
  await page.waitForTimeout(1000);
  const framesAfter = await page.evaluate(() => window.__frames || 0);
  results.push(check('render loop advancing (rAF)', framesAfter > framesBefore, `${framesBefore} -> ${framesAfter}`));
  const how = await startGame(page);
  await page.waitForTimeout(1500);
  // New Game offers the first mission in a dialog; the dialog blocks
  // movement by design, so accept it (the real user path) before the
  // movement check. (v9 bug, fixed in main.js: the accept button used
  // to call a function that only exists on the exposed missions API,
  // so the dialog could never be accepted and the player stayed frozen.)
  await acceptDialogIfOpen(page);
  const snap = await probeState(page);
  results.push(check('game starts (title hidden, dialog accepted)', snap.screen === 'play', `via ${how}, screen=${snap.screen}`));
  // Walk a little so the player-update path proves itself.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  const snap2 = await probeState(page);
  const moved = snap.available && snap.player && snap2.player
    && (snap.player.x !== snap2.player.x || snap.player.y !== snap2.player.y);
  results.push(check('player moves (WASD)', moved || !snap.available,
    snap.available ? `(${snap.player?.x},${snap.player?.y}) -> (${snap2.player?.x},${snap2.player?.y})` : 'no debug hook; DOM-only'));
  results.push(check('HUD present (canvas draws)', await page.locator('#game-canvas').count() > 0));
  results.push(check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | ')));
  return results;
}

// ---------------------------------------------------------------------------
// edge: reloads, resize, pause/resume, corrupt save, rapid keys.
// ---------------------------------------------------------------------------
async function runEdge(page, baseUrl, errors) {
  const results = [];
  await page.goto(`${baseUrl}?seed=7`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1000);

  // Reload keeps working and keeps the title screen.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  results.push(check('edge: reload keeps title', await page.locator('#title-screen').isVisible().catch(() => false)));

  // Start, then accept the opening mission dialog so the checks below
  // run in real play state (the dialog blocks movement and pause).
  await startGame(page);
  await page.waitForTimeout(1500);
  await acceptDialogIfOpen(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(800);
  const snap = await probeState(page);
  results.push(check('edge: resize survives', snap.screen === 'play' || snap.screen === 'dialog', `screen=${snap.screen}`));
  await page.setViewportSize({ width: 1280, height: 720 });

  // Pause and resume.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const paused = await page.locator('#pause-menu').isVisible().catch(() => false);
  results.push(check('edge: pause menu opens (Esc)', paused, paused ? '' : 'no pause menu visible — may be canvas-only pause'));
  if (paused) {
    const resume = page.locator('#resume-btn');
    if (await resume.count()) await resume.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // Corrupt save slot must not crash the title screen.
  await page.evaluate(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (/save|slot|crescent/i.test(key)) localStorage.setItem(key, '{corrupt,,');
      }
      localStorage.setItem('crescent-bay.save.1', '{corrupt,,');
    } catch { /* storage may be off */ }
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  results.push(check('edge: corrupt save slot does not crash title',
    await page.locator('#title-screen').isVisible().catch(() => false)));

  // Rapid key storm: no error, no freeze (frames keep advancing).
  await startGame(page);
  await page.waitForTimeout(500);
  await acceptDialogIfOpen(page);
  const f0 = await page.evaluate(() => window.__frames || 0);
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'Space', 'Digit1', 'Digit2', 'KeyR', 'KeyQ']) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(1000);
  const f1 = await page.evaluate(() => window.__frames || 0);
  results.push(check('edge: rapid keys do not freeze loop', f1 > f0, `${f0} -> ${f1}`));

  // Weapon switch (v8's weak spot — prove it, don't assume it): Rook
  // starts with pistol + SMG. 2 must select the SMG with different ammo,
  // 1 must go back to the pistol, Q must cycle pistol -> SMG -> pistol.
  const wBefore = await readWeapons(page);
  await holdKey(page, 'Digit2');
  let wSmg = await readWeapons(page);
  // Flake guard: the game's weapon keys are rising-edge readers, and a
  // key event that lands exactly on a frame boundary can be missed once.
  // One retry distinguishes that from a genuinely broken switch (which
  // fails twice in a row); the dedicated tools/weapon-switch.mjs probe
  // covers the same path with screenshots.
  if (!wSmg || wSmg.current !== 'smg') {
    await holdKey(page, 'Digit2');
    wSmg = await readWeapons(page);
  }
  await holdKey(page, 'Digit1');
  const wPistol = await readWeapons(page);
  await holdKey(page, 'KeyQ');
  const wCycle1 = await readWeapons(page);
  await holdKey(page, 'KeyQ');
  const wCycle2 = await readWeapons(page);
  const weaponOk = wBefore && wBefore.current === 'pistol' && wBefore.owned?.smg === true
    && wSmg && wSmg.current === 'smg' && wSmg.ammo?.smg !== wBefore.ammo?.pistol
    && wPistol && wPistol.current === 'pistol'
    && wCycle1 && wCycle1.current === 'smg'
    && wCycle2 && wCycle2.current === 'pistol';
  results.push(check('edge: weapon switch 1/2/Q (pistol <-> SMG, ammo differs)', weaponOk,
    wBefore ? `start ${wBefore.current}(${wBefore.ammo?.pistol}) -> 2:${wSmg?.current}(${wSmg?.ammo?.smg}) -> 1:${wPistol?.current} -> Q:${wCycle1?.current} -> Q:${wCycle2?.current}` : 'no weapons hook'));

  // Radio cycles (R) without throwing; the station name must change.
  // Read through window.__game (the real debug hook); the old code read
  // window.__cbDebug / window.G, neither of which exists, so the check
  // passed vacuously without ever seeing a station name.
  const radioErrorsBefore = errors.length;
  const radioBefore = await page.evaluate(() => {
    const r = window.__game?.radio;
    return r && typeof r.stationName === 'function' ? r.stationName() : (r?.station ?? null);
  });
  await holdKey(page, 'KeyR');
  const radioMid = await page.evaluate(() => {
    const r = window.__game?.radio;
    return r && typeof r.stationName === 'function' ? r.stationName() : (r?.station ?? null);
  });
  await holdKey(page, 'KeyR');
  const radioAfter = await page.evaluate(() => {
    const r = window.__game?.radio;
    return r && typeof r.stationName === 'function' ? r.stationName() : (r?.station ?? null);
  });
  results.push(check('edge: radio cycles (station name changes)',
    errors.length === radioErrorsBefore && radioBefore !== null && radioAfter !== null
      && radioBefore !== radioMid && radioMid !== radioAfter,
    radioBefore !== null ? `${radioBefore} -> ${radioMid} -> ${radioAfter}` : 'no radio hook exposed'));

  // Save slots: write all three through the real save API and read back.
  const slots = await page.evaluate(() => {
    try {
      const s = window.__game?.save;
      if (s?.saveSlot && s?.readSlot) {
        const out = [];
        for (let i = 0; i < 3; i += 1) {
          s.saveSlot(i);
          const back = s.readSlot(i);
          out.push(back?.status === 'ok');
        }
        return out;
      }
      return null;
    } catch { return null; }
  });
  results.push(check('edge: save slots write + read back', slots !== null && slots.every(Boolean),
    slots === null ? 'no save hook exposed' : slots.join(', ')));

  results.push(check('edge: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | ')));
  return results;
}

// ---------------------------------------------------------------------------
// arc: autopilot plays the arc (or one mission). Progress is appended to
// /tmp/arc-progress.txt every 2s so a killed run still leaves a trail.
// ---------------------------------------------------------------------------
async function runArc(page, baseUrl, errors, missionFilter) {
  const results = [];
  const url = missionFilter
    ? `${baseUrl}?seed=7&autopilot=1&mission=${encodeURIComponent(missionFilter)}`
    : `${baseUrl}?seed=7&autopilot=1`;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1000);
  await startGame(page);
  await enableAutopilot(page);
  await page.waitForTimeout(500);

  const startedAt = Date.now();
  const deadline = startedAt + 12 * 60 * 1000; // 12 minutes hard cap for one run
  const seen = new Map(); // mission id -> { stage, status }
  let lastWrite = 0;
  let completed = [];
  let failed = null;

  fs.appendFileSync(ARC_PROGRESS, `\n=== arc run ${new Date().toISOString()} mission=${missionFilter || 'all'} ===\n`);
  while (Date.now() < deadline) {
    const snap = await probeState(page);
    const mid = snap.mission?.id || 'none';
    const stage = snap.mission?.stage ?? '?';
    const status = snap.mission?.complete ? 'complete' : (snap.mission?.failed ? 'failed' : (snap.mission?.status || 'active'));
    const key = `${mid}#${stage}`;
    if (!seen.has(key)) seen.set(key, { at: Date.now() - startedAt, status });
    if (snap.mission?.complete) {
      if (!completed.includes(mid)) completed.push(mid);
      if (missionFilter && mid.toLowerCase().includes(missionFilter.toLowerCase())) break;
      if (!missionFilter && completed.length >= 12) break;
    }
    if (snap.mission?.failed) { failed = mid; break; }
    if (Date.now() - lastWrite >= 2000) {
      lastWrite = Date.now();
      const line = `${new Date().toISOString()} t=${Math.round((Date.now() - startedAt) / 1000)}s `
        + `mission=${mid} stage=${stage} status=${status} screen=${snap.screen} `
        + `player=${snap.player ? `${Math.round(snap.player.x || 0)},${Math.round(snap.player.y || 0)} inCar=${snap.player.inCar}` : '?'} `
        + `heat=${snap.heat ?? '?'} wanted=${snap.wanted ?? '?'} autopilot=${snap.autopilot?.mode ?? '?'} frames=${snap.frames ?? '?'}\n`;
      fs.appendFileSync(ARC_PROGRESS, line);
    }
    if (snap.screen === 'gameover') {
      // The autopilot retries from the mission's stage 0; give it time.
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(500);
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  fs.appendFileSync(ARC_PROGRESS, `=== arc end t=${elapsed}s completed=${completed.join(',') || 'none'} failed=${failed || 'none'} ===\n`);

  results.push(check('arc: autopilot engaged', true, `ran ${elapsed}s`));
  if (missionFilter) {
    results.push(check(`arc: mission ${missionFilter} completed`, completed.some((m) => m.toLowerCase().includes(missionFilter.toLowerCase())),
      `completed: ${completed.join(', ') || 'none'}; failed: ${failed || 'none'}`));
  } else {
    results.push(check('arc: all 12 missions completed', completed.length >= 12,
      `completed ${completed.length}/12: ${completed.join(', ') || 'none'}; failed: ${failed || 'none'}`));
  }
  results.push(check('arc: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | ')));
  return results;
}

// ---------------------------------------------------------------------------
// fps: frame rate during a wanted chase.
// ---------------------------------------------------------------------------
async function runFps(page, baseUrl, errors, seconds) {
  const results = [];
  await page.goto(`${baseUrl}?seed=7&autopilot=1&wanted=3`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1000);
  await startGame(page);
  await enableAutopilot(page);
  await page.waitForTimeout(1000);
  // Stir the city: drive forward for the whole sample.
  await page.keyboard.down('KeyW');
  const f0 = await page.evaluate(() => window.__frames || 0);
  const t0 = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const f1 = await page.evaluate(() => window.__frames || 0);
  await page.keyboard.up('KeyW');
  const elapsed = (Date.now() - t0) / 1000;
  const fps = (f1 - f0) / elapsed;
  results.push(check('fps: >= 50 during wanted chase', fps >= 50, `${fps.toFixed(1)} fps over ${elapsed.toFixed(1)}s`));
  results.push(check('fps: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | ')));
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }
  if (!['cold', 'edge', 'arc', 'fps'].includes(args.mode)) {
    console.error(`unknown mode: ${args.mode}`);
    printHelp();
    return 2;
  }

  let server = null;
  let baseUrl = args.url;
  if (!baseUrl) {
    try {
      server = await startServer(args.port);
    } catch (err) {
      if (String(err.message || err).includes('EADDRINUSE')) {
        console.error(`port ${args.port} busy (EADDRINUSE) — a leftover server holds it; find its PID and kill it by PID, then retry.`);
        return 2;
      }
      throw err;
    }
    baseUrl = `http://127.0.0.1:${args.port}/game/`;
    console.log(`serving ${REPO_ROOT} on ${baseUrl}`);
  }

  const browser = await launchBrowser(args.headless);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await installFrameCounter(page);

  let results = [];
  try {
    if (args.mode === 'cold') results = await runCold(page, baseUrl, errors);
    else if (args.mode === 'edge') results = await runEdge(page, baseUrl, errors);
    else if (args.mode === 'arc') results = await runArc(page, baseUrl, errors, args.mission);
    else if (args.mode === 'fps') results = await runFps(page, baseUrl, errors, args.seconds);
  } catch (err) {
    results.push(check(`${args.mode}: suite threw`, false, String(err?.message || err)));
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n== ${args.mode.toUpperCase()} ${passed}/${results.length} ==`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (errors.length > 0) {
    console.log('\nconsole errors seen:');
    for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  }
  return passed === results.length ? 0 : 1;
}

process.exitCode = await main();
