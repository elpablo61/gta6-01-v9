# Crescent Bay — GTA v9

[![make.fun](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01)
[![rank](https://make.fun/badge/gta6-01/elpablo61/gta6-01-v9/rank.svg)](https://make.fun/bounty/gta6-01)
[![entries](https://make.fun/badge/gta6-01/elpablo61/gta6-01-v9/entries.svg)](https://make.fun/bounty/gta6-01)
[![reward](https://make.fun/badge/gta6-01/elpablo61/gta6-01-v9/reward.svg)](https://make.fun/bounty/gta6-01)

A 2D top-down open-world crime game set in the city of Crescent Bay. Play as
Rook: drive, run jobs for fixers Mara and Dex across a 12-mission arc, dodge
the police (roadblocks, patrol cars and a helicopter), upgrade your car at
the Fixer Garage, switch weapons, tune the radio, and save your progress in
3 slots. Pure Canvas 2D + procedural WebAudio — no libraries, no network,
no external assets.

## Play

```sh
node serve.ts
# open http://localhost:8080
```

Move with WASD / arrows, mouse to aim, click to shoot, Shift to sprint,
E to enter/exit a car (or accept a mission / open the garage), R to change
the radio station, Q to cycle weapons, 1/2/3 to pick pistol / SMG / shotgun.

## Playtest

```sh
node tools/playtest.mjs cold
node tools/playtest.mjs arc
```

## Build the entry

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

Built for the make.fun bounty board. Referral code: vky0ybyt
