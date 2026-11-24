# Playtest R2 — Suite 1: Cold / Edge / Weapon-switch / FPS

Recording R2 (id 01a20b10-c24e-7096-87e8-5fd3579b7a65). Repo elpablo61/gta6-01-v9.
Date: 2026-11-24 (WIB). Base HEAD df25962; this report covers the fixes
found while running these suites.

## Results

| Suite | Result |
|---|---|
| COLD | **8/8 PASS** — load, title, 3 save slots (Slot 1/2/3 Empty), rAF 92→149, new game + dialog accepted → play, player moves (200,200)→(200,20), HUD, 0 console errors |
| EDGE | **9/9 PASS** — reload keeps title, resize survives (play), pause Esc opens, corrupt save slot does not crash title, rapid keys no freeze (138→196 frames), weapon switch 1/2/Q, radio cycles, save slots write+read (3/3), 0 console errors |
| WEAPON-SWITCH (tools/weapon-switch.mjs) | **11/11 PASS** — pistol+SMG owned at start (pistol 48, SMG 96); 2→SMG, 1→pistol, Q cycles pistol→SMG→pistol; firing pistol 48→45; docks shotgun crate at (2200,3000) grants shotgun (ammo 24); 3→shotgun; 0 console errors |
| FPS (wanted chase, 8s) | **59.3 fps** (gate ≥59) — 2/2 PASS, 0 console errors |
| SMOKE regression | smoke-b6 **62/62**, smoke-b3 **43/43** (unchanged) |

HUD proof (read visually, not just state): `playtest/weapon-smg.jpg`
(43,513 B) shows **SMG • 96**; `playtest/weapon-shotgun.jpg`
(53,146 B) shows **Shotgun • 24**. (They live under playtest/, not
screenshots/: buildDossier counts every file in screenshots/ toward its
4-image cap, so only the 4 poses may live there.)

## Bugs found + fixed in this suite (all in game/src, NOT main.ts)

1. **Mission dialog could never be accepted — game soft-locked after New
   Game (BLOCKER).** `main.js` accept-btn handler called
   `moduleByName(G,'missions').acceptDialog`, but missions.js only exports
   init/update/draw — acceptDialog lives on the exposed API object
   `G.missions`. The click was a silent no-op; `syncMissionDialog`
   re-opened the dialog the next frame, so E, Enter, Space and the
   Accept button all failed and the player stayed frozen at (200,200).
   The autopilot clicks the same button, so the arc would have deadlocked
   at m1 too. Fix: call `G.missions.acceptDialog(G)` (namespace as
   fallback). Verified: dialog closes, m1 starts, W moves the player.
   Same root-cause class fixed alongside: Continue (`mod.load` never
   existed → always started a new game; now `G.save.loadSlot`), manual
   save (`mod.saveGame` never existed → Save button did nothing; now
   `G.save.saveSlot`), slot labels (read the wrong localStorage key, so a
   real save always showed Empty; now `G.save.readSlot`), Retry (no
   restartMission export; now `G.missions.startMission`), and slot choice
   lost across startNewGame (save.init replaces G.save; the picked slot
   is now preserved + synced to activeSlot).
2. **Radio R never cycled (BLOCKER for the §3.4 scripted check).**
   `radio.js` justPressed only recognised `inp.pressed.has` (a Set shape
   that never exists) and `inp.rPressed` (never set); the input module
   exposes `pressed()` as a function. Fix: call `inp.pressed(code)` first.
   Verified: Bay FM → Harbor Jazz → Crescent Rock → Bay FM.
3. **HUD always showed "Pistol • 0" (BLOCKER for the weapon-switch gate).**
   `hud.js` weaponInfo read `cur.name`/`cur.ammo` off `G.weapons.current`,
   but current is a STRING id and ammo lives in the `w.ammo` map. Fix:
   string-current branch with a display-name map + ammo map lookup.
   Same shape bug in radioInfo: it String()'d the numeric station index
   (HUD showed '1'/'2'); now it calls `stationName()`. Verified visually
   in the two HUD screenshots above.
4. **Suite fixes (tools/playtest.mjs, no game change):** cold is now 8
   checks (added "3 save slots visible" + dialog-accept step before the
   movement check); edge is now 9 checks (weapon-switch check replaces
   the redundant "initial load"; radio/save hooks now read the real
   `window.__game` instead of the non-existent `__cbDebug`/`G`, which
   used to pass vacuously); `acceptDialogIfOpen` waits up to 4s for the
   mission offer (offerTimer ~0.8–1.2s) instead of checking once at
   500ms — the too-early check left the dialog open and every later
   key-driven check ran in dialog state, where module updates don't run
   (this caused one 8/9 edge flake: weapon switch + radio both failed
   that run, then passed 9/9 on re-run); weapon check has a documented
   one-retry flake guard for sub-frame key edges.

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
- Weapon screenshots show the world edge (dark void) on the left: Rook
  spawns at (200,200) near the NW corner, so the camera shows area
  outside the 3200×3200 map. Not a bug — the city simply ends there.

## Still open (next suites)

- ARC 12/12, 4 screenshots + contact sheet + readability, dossier build
  size, final smoke re-run.
