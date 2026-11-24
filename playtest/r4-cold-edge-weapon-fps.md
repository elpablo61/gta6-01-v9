# Playtest R4 — Suite 1: Cold / Edge / Weapon-switch / FPS

Recording R4 (id 01a20ba1-01eb-721c-a1d6-2c4880b4afe4). Repo elpablo61/gta6-01-v9.
Date: 2026-11-24 (WIB). Base HEAD ca1b465 — this report covers the
re-authored code (B8-FINAL) and the fixes found while running these suites.

## Results

| Suite | Result |
|---|---|
| COLD | **8/8 PASS** — load, title, 3 save slots (Slot 1/2/3 Empty), rAF 92→153, new game + dialog accepted → play, player moves (200,200)→(200,20), HUD, 0 console errors |
| EDGE | **9/9 PASS** — reload keeps title, resize survives (play), pause Esc opens, corrupt save slot does not crash title, rapid keys no freeze (162→218 frames), weapon switch 1/2/Q, radio cycles, save slots write+read (3/3), 0 console errors |
| WEAPON-SWITCH (tools/weapon-switch.mjs) | **11/11 PASS** — pistol+SMG owned at start (pistol 48, SMG 96); 2→SMG, 1→pistol, Q cycles pistol→SMG→pistol; firing pistol 48→45; docks shotgun crate at (2200,3000) grants shotgun (ammo 24); 3→shotgun; 0 console errors |
| FPS (wanted chase, 8s) | **57.8–58.2 fps over two runs** (suite gate ≥50: 2/2 PASS, 0 console errors). The ≥59 stretch target was NOT met on these runs — headless-shell variance; R2 measured 59.3 on the same gate. |
| SMOKE regression | smoke-b6 **62/62**, smoke-b3 **43/43** |

HUD proof (read visually, not just state): `playtest/weapon-smg.jpg`
(43,533 B) shows **SMG • 96**; `playtest/weapon-shotgun.jpg`
(53,036 B) shows **Shotgun • 24**. (They live under playtest/, not
screenshots/: buildDossier counts every file in screenshots/ toward its
4-image cap, so only the 4 poses may live there.)

## Bugs found + fixed in this suite (all in game/src or tools, NOT main.ts)

1. **Radio R never cycled after the radio.js re-author (my own bug,
   caught by edge).** The rewritten `justPressed` extracted
   `inp.pressed` and called it unbound (`fn(code)`), so `this._pressed`
   threw inside `pressed()` and the `try/catch` swallowed it as
   "not pressed" — R never registered (edge showed
   Bay FM → Bay FM → Bay FM). Fix: call with the input object as
   `this` (`fn.call(inp, code)`). Verified: edge 9/9, radio
   Harbor Jazz → Crescent Rock → Bay FM.
2. **Edge weapon-switch flake was a test-order artifact, not a game
   bug.** The rapid-key storm earlier in the edge suite presses Digit2
   and leaves the weapon on SMG, so the check's "starts with pistol"
   assertion failed on some runs (8/9). Fix in tools/playtest.mjs:
   press Digit1 and confirm pistol BEFORE asserting the start state.
   Verified: edge 9/9 on re-run; the dedicated weapon-switch probe
   (11/11) covers the same path with screenshots.
3. **Dossier failed `screenshots.max` because tool outputs landed in
   screenshots/.** The weapon-switch and contact-sheet runs write to
   `screenshots/` by default, so it held 8 files against the 4-image
   cap and `main.ts` threw. Fix: those outputs live in `playtest/`
   (fresh copies regenerated there); the 4 extra files were removed
   from screenshots/ (recoverable trash). Verified: dossier builds,
   496,426 bytes — see the R4 arc/screenshots/dossier report.

## Notes / fragile parts

- Quick Playwright `keyboard.press()` (down+up in ~0ms) can fall between
  two frames and be missed by the game's edge-triggered key readers
  (`_pressed` is cleared by endFrame every frame; `pressedE` edge-detects
  on `keys`). Real human presses last 50–100ms and are fine; the suites
  hold keys ~200ms (`holdKey`). The autopilot taps E every frame while a
  dialog is open, so it is not affected.
- The docks shotgun crate sits at (2200,3000) live, not (2600,2600) as
  seeded — `place()` snaps it to the nearest road/place. The probe reads
  the live crate position instead of assuming the seed.
- smoke-b6 lesson: the mock G's RNG must be freshly seeded per section.
  Sharing one RNG across sections changed the autopilot section's world
  and dropped its roam maxSpeed to 32 (61/62); a fresh
  `createRng(20261118)` per section restores 62/62.

## Still open (next suites)

- ARC 12/12 (m2 chase — see the R4 arc/screenshots/dossier report),
  4 screenshots + contact sheet + readability, dossier build size,
  final smoke re-run.
