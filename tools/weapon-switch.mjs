// Weapon-switch proof for Crescent Bay (gta6-01-v9) — gate 2 evidence.
//
// Drives the REAL game in headless Chromium: starts with pistol + SMG,
// switches 1 / 2 / Q and asserts the live weapon state + ammo each time,
// fires the pistol and asserts ammo drops, walks onto the docks shotgun
// crate and asserts the shotgun is granted, then selects it with 3.
// Saves two HUD screenshots (SMG, shotgun) as visual proof.
//
// Usage: node tools/weapon-switch.mjs [--port 8937] [--out screenshots]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');
const GAME_ROOT = path.join(REPO_ROOT, 'game');
const SHELL = path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1255', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };

const args = { port: 8937, out: path.join(REPO_ROOT, 'screenshots') };
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i]);
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i]);
}

const server = http.createServer((req, res) => {
  try {
    let fp = path.join(REPO_ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (new URL(req.url, 'http://x').pathname === '/') fp = path.join(GAME_ROOT, 'index.html');
    if (fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(fs.readFileSync(fp));
  } catch { res.writeHead(404); res.end(); }
});

function check(name, ok, detail) { return { name, ok: !!ok, detail: detail || '' }; }

async function main() {
  await new Promise((r) => server.listen(args.port, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true, executablePath: SHELL, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const readW = () => page.evaluate(() => {
    const w = window.__game?.weapons;
    if (!w) return null;
    return { current: w.current, owned: { ...w.owned }, ammo: { ...w.ammo }, crates: (w.crates || []).map((c) => ({ x: c.x, y: c.y, weapon: c.weapon, taken: c.taken })) };
  });
  const holdKey = async (code, ms = 200) => {
    await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
    await page.waitForTimeout(300);
  };

  const results = [];
  await page.goto(`http://127.0.0.1:${args.port}/game/?seed=7`, { waitUntil: 'load', timeout: 30000 });
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
  results.push(check('dialog accepted, game in play', screen === 'play', `screen=${screen}`));

  const start = await readW();
  results.push(check('Rook starts with pistol + SMG owned',
    start && start.current === 'pistol' && start.owned.pistol && start.owned.smg && !start.owned.shotgun,
    start ? `current=${start.current} owned=${JSON.stringify(start.owned)} ammo=${JSON.stringify(start.ammo)}` : 'no weapons hook'));

  await holdKey('Digit2');
  const smg = await readW();
  const smgOk = smg && smg.current === 'smg' && smg.ammo.smg !== start.ammo.pistol;
  results.push(check('key 2 selects SMG with different ammo', smgOk,
    smg ? `current=${smg.current} ammo smg=${smg.ammo.smg} vs pistol=${start.ammo.pistol}` : 'no hook'));
  const smgShot = path.join(args.out, 'weapon-smg.jpg');
  await page.screenshot({ path: smgShot, type: 'jpeg', quality: 80 });
  console.log(`   HUD shot (SMG): ${smgShot} ${fs.statSync(smgShot).size} bytes`);

  await holdKey('Digit1');
  const pistol = await readW();
  results.push(check('key 1 selects pistol back', pistol?.current === 'pistol', `current=${pistol?.current}`));

  await holdKey('KeyQ');
  const q1 = await readW();
  results.push(check('Q cycles pistol -> SMG', q1?.current === 'smg', `current=${q1?.current}`));
  await holdKey('KeyQ');
  const q2 = await readW();
  results.push(check('Q cycles SMG -> pistol', q2?.current === 'pistol', `current=${q2?.current}`));

  // Fire the pistol 3 times; ammo must drop by 3 (rate 0.30s, so 450ms gaps).
  const ammoBefore = (await readW()).ammo.pistol;
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.click(900, 300);
    await page.waitForTimeout(450);
  }
  const ammoAfter = (await readW()).ammo.pistol;
  results.push(check('firing pistol spends ammo', ammoAfter === ammoBefore - 3, `${ammoBefore} -> ${ammoAfter}`));

  // Docks shotgun crate: teleport Rook onto it (probe staging, same as the
  // screenshot poses do) and let the game's own pickup radius grant it.
  const crate = (await readW()).crates.find((c) => c.weapon === 'shotgun' && !c.taken);
  results.push(check('shotgun crate exists in the world', !!crate,
    crate ? `at (${crate.x},${crate.y})` : 'no untaken shotgun crate'));
  if (crate) {
    await page.evaluate(({ x, y }) => {
      const p = window.__game.player;
      p.x = x; p.y = y;
      if (window.__game.camera) { window.__game.camera.x = x; window.__game.camera.y = y; }
    }, crate);
    await page.waitForTimeout(800);
    const afterCrate = await readW();
    results.push(check('walking over the crate grants the shotgun',
      afterCrate.owned.shotgun === true && afterCrate.ammo.shotgun > 0,
      `owned.shotgun=${afterCrate.owned.shotgun} ammo.shotgun=${afterCrate.ammo.shotgun}`));
    await holdKey('Digit3');
    const sg = await readW();
    results.push(check('key 3 selects shotgun', sg?.current === 'shotgun', `current=${sg?.current} ammo=${sg?.ammo.shotgun}`));
    const sgShot = path.join(args.out, 'weapon-shotgun.jpg');
    await page.screenshot({ path: sgShot, type: 'jpeg', quality: 80 });
    console.log(`   HUD shot (shotgun): ${sgShot} ${fs.statSync(sgShot).size} bytes`);
  }

  results.push(check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | ')));

  await browser.close();
  server.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n== WEAPON-SWITCH ${passed}/${results.length} ==`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
