// Crescent Bay — make.fun entrypoint (Node 22, standard library only).
// The game is plain static files under game/ (index.html + ES modules, no
// library, no network). This script copies game/ and the four seed-7
// screenshots into the output directory and writes /output/dossier.json
// with the vendored make.fun library, then logs the dossier size so an
// oversize entry is caught before it is ever submitted.
//
// Fresh dossier data, regenerated 24 Nov 2026 ~15:41 WIB (B15 scope-cut):
//   screenshots (seed 7, all JPEG, cap 200 KiB each):
//     1-cover.jpg    66,984 bytes — daytime waterfront, wanted 3, M7 Highway Heat
//     2-mission.jpg  58,520 bytes — on foot, fixer Mara dialog, M8 Crescent Job
//     3-night.jpg    56,677 bytes — night 22:00, wanted 4, M7 Highway Heat
//     4-start.jpg    63,887 bytes — title overlay over the living city
//   contact-sheet.jpg (768x480, 44,001 bytes) + grayscale twin (38,781 bytes)
//   live in screenshots/ for the human 2-second readability check ONLY —
//   they are NOT copied to the output: buildDossier refuses more than
//   4 images, so only the four shots above go into the dossier.
//   gates at this HEAD (119270e): cold 8/8, edge 9/9, FPS 57.5/57.2,
//   zero console errors; arc best 7/12 (B14, m1-m7, 0 errors).
//
// Run locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four dossier shots, in name order (first = cover). Anything else in
// screenshots/ (contact sheet + grayscale twin) stays out of the output.
const SHOTS = ['1-cover.jpg', '2-mission.jpg', '3-night.jpg', '4-start.jpg'];

// Validate the game folder before copying: count files and bytes so a
// half-written game/ (or an accidental huge asset) is caught here, with
// a plain log line, instead of failing later inside the dossier builder.
function gameStats(dir) {
  let files = 0, bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = gameStats(p);
      files += sub.files; bytes += sub.bytes;
    } else {
      files += 1; bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}
const stats = gameStats(join(here, 'game'));
console.log(`game/: ${stats.files} files, ${stats.bytes} bytes`);
if (stats.files > 993) {
  console.warn(`WARNING: game/ has ${stats.files} files, above the 993-file scorer cap`);
}
if (stats.bytes > 50331648) {
  console.warn(`WARNING: game/ is ${stats.bytes} bytes, above the 48 MiB scorer cap`);
}

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
for (const shot of SHOTS) {
  const src = join(here, 'screenshots', shot);
  if (!existsSync(src)) throw new Error(`missing screenshot: screenshots/${shot}`);
  copyFileSync(src, join(out, 'screenshots', shot));
  console.log(`screenshots/${shot}: ${statSync(src).size} bytes`);
}

// The scorer's caps: only text_max_bytes shapes the byte count; the other
// limits refuse an entry the scorer would refuse (more than 4 screenshots
// or one over 256 KiB; more than 993 files in game/ or 48 MiB of game files
// in all, or a path under game/ over 1000 bytes).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

const dossierBytes = statSync(join(out, 'dossier.json')).size;
console.log(`dossier.json: ${dossierBytes} bytes`);
if (dossierBytes > 1450000) {
  console.warn(`WARNING: dossier is ${dossierBytes} bytes, above the 1,450,000 byte budget`);
}
