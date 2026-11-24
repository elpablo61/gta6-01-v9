// Crescent Bay — make.fun entrypoint (Node 22, standard library only).
// The game is plain static files under game/ (index.html + ES modules, no
// library, no network). This script copies game/ and screenshots/ into the
// output directory and writes /output/dossier.json with the vendored
// make.fun library, then logs the dossier size so an oversize entry is
// caught before it is ever submitted.
//
// Run locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

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
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
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
