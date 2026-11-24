// Weapon-switch proof for Crescent Bay (gta6-01-v9) — gate 2 evidence.
//
// Drives the REAL game in headless Chromium: Rook starts with pistol +
// SMG, switches 1 / 2 / Q and the live weapon state + ammo is asserted
// each time, firing the pistol spends ammo, walking onto the docks
// shotgun crate grants the shotgun, and key 3 selects it. Two HUD
// screenshots (SMG, shotgun) are saved as visual proof.
//
// Usage: node tools/weapon-switch.mjs [--port 8937] [--out screenshots]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const GAME_DIR = path.join(ROOT, 'game');
const SHELL = path.join(
  os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255',
  'chrome-headless-shell-linux64', 'chrome-headless-shell',
);
const CONTENT_TYPE = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg',
};

const opts = { port: 8937, out: path.join(ROOT, 'screenshots') };
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--port') opts.port = Number(process.argv[++i]);
  if (process.argv[i] === '--out') opts.out = path.resolve(process.argv[++i]);
}

// --- tiny static server ---------------------------------------------------

function serve() {
  const server = http.createServer((req, res) => {
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      let file = path.join(ROOT, decodeURIComponent(pathname));
      if (pathname === '/') file = path.join(GAME_DIR, 'index.html');
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      res.writeHead(200, { 'content-type': CONTENT_TYPE[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(opts.port, '127.0.0.1', () => resolve(server)));
}

// --- probe helpers --------------------------------------------------------

function verdict(name, ok, detail) {
  return { name, ok: !!ok, detail: detail || '' };
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: SHELL,
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

// Hold a key for ~200ms (long enough for the edge-triggered readers),
// then let the game settle for 300ms.
async function tapKey(page, code) {
  await page.keyboard.down(code);
  await page.waitForTimeout(200);
  await page.keyboard.up(code);
  await page.waitForTimeout(300);
}

function readWeapons(page) {
  return page.evaluate(() => {
    const w = window.__game?.weapons;
    if (!w) return null;
    return {
      current: w.current,
      owned: { ...w.owned },
      ammo: { ...w.ammo },
      crates: (w.crates || []).map((c) => ({ x: c.x, y: c.y, weapon: c.weapon, taken: c.taken })),
    };
  });
}

function shot(page, name) {
  const file = path.join(opts.out, name);
  return page.screenshot({ path: file, type: 'jpeg', quality: 80 })
    .then(() => console.log(`   HUD shot: ${file} ${fs.statSync(file).size} bytes`));
}

// --- the probe ------------------------------------------------------------

async function main() {
  const server = await serve();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const results = [];
  const record = (name, ok, detail) => results.push(verdict(name, ok, detail));

  await page.goto(`http://127.0.0.1:${opts.port}/game/?seed=7`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('#new-game-btn').click({ timeout: 3000 });
  await page.waitForTimeout(1500);
  if (await page.locator('#mission-dialog').isVisible().catch(() => false)) {
    await page.locator('#accept-btn').click({ timeout: 2000 });
    await page.waitForTimeout(800);
  }
  const screen = await page.evaluate(() => {
    const d = document.getElementById('mission-dialog');
    return d && !d.hidden ? 'dialog' : 'play';
  });
  record('dialog accepted, game in play', screen === 'play', `screen=${screen}`);

  const start = await readWeapons(page);
  record(
    'Rook starts with pistol + SMG owned',
    start && start.current === 'pistol' && start.owned.pistol && start.owned.smg && !start.owned.shotgun,
    start
      ? `current=${start.current} owned=${JSON.stringify(start.owned)} ammo=${JSON.stringify(start.ammo)}`
      : 'no weapons hook',
  );

  await tapKey(page, 'Digit2');
  const smg = await readWeapons(page);
  record(
    'key 2 selects SMG with different ammo',
    smg && smg.current === 'smg' && smg.ammo.smg !== start.ammo.pistol,
    smg ? `current=${smg.current} ammo smg=${smg.ammo.smg} vs pistol=${start.ammo.pistol}` : 'no hook',
  );
  await shot(page, 'weapon-smg.jpg');

  await tapKey(page, 'Digit1');
  const pistol = await readWeapons(page);
  record('key 1 selects pistol back', pistol?.current === 'pistol', `current=${pistol?.current}`);

  await tapKey(page, 'KeyQ');
  const q1 = await readWeapons(page);
  record('Q cycles pistol -> SMG', q1?.current === 'smg', `current=${q1?.current}`);
  await tapKey(page, 'KeyQ');
  const q2 = await readWeapons(page);
  record('Q cycles SMG -> pistol', q2?.current === 'pistol', `current=${q2?.current}`);

  // Fire the pistol 3 times; ammo must drop by 3 (fire rate 0.30s, so
  // 450ms gaps between clicks).
  const ammoBefore = (await readWeapons(page)).ammo.pistol;
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.click(900, 300);
    await page.waitForTimeout(450);
  }
  const ammoAfter = (await readWeapons(page)).ammo.pistol;
  record('firing pistol spends ammo', ammoAfter === ammoBefore - 3, `${ammoBefore} -> ${ammoAfter}`);

  // Docks shotgun crate: teleport Rook onto it (probe staging, the same
  // trick the screenshot poses use) and let the game's own pickup
  // radius grant it.
  const crate = (await readWeapons(page)).crates.find((c) => c.weapon === 'shotgun' && !c.taken);
  record('shotgun crate exists in the world', !!crate, crate ? `at (${crate.x},${crate.y})` : 'no untaken shotgun crate');
  if (crate) {
    await page.evaluate(({ x, y }) => {
      const p = window.__game.player;
      p.x = x;
      p.y = y;
      if (window.__game.camera) { window.__game.camera.x = x; window.__game.camera.y = y; }
    }, crate);
    await page.waitForTimeout(800);
    const afterCrate = await readWeapons(page);
    record(
      'walking over the crate grants the shotgun',
      afterCrate.owned.shotgun === true && afterCrate.ammo.shotgun > 0,
      `owned.shotgun=${afterCrate.owned.shotgun} ammo.shotgun=${afterCrate.ammo.shotgun}`,
    );
    await tapKey(page, 'Digit3');
    const sg = await readWeapons(page);
    record('key 3 selects shotgun', sg?.current === 'shotgun', `current=${sg?.current} ammo=${sg?.ammo.shotgun}`);
    await shot(page, 'weapon-shotgun.jpg');
  }

  record('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n== WEAPON-SWITCH ${passed}/${results.length} ==`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
