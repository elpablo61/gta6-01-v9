# Playtest R4 — Arc + Screenshots + Dossier (24 Nov 2026)

Recording R4 `01a20ba1-01eb-721c-a1d6-2c4880b4afe4`. Suite 1 (cold 8/8, edge 9/9,
weapon-switch 11/11, FPS 57.8–58.2) in `playtest/r4-cold-edge-weapon-fps.md`.
HEAD ca1b465 (re-authored code, B8-FINAL).

## Ringkasan gate

| Gate | Hasil |
|---|---|
| COLD 8/8 | PASS (Suite 1) |
| EDGE 9/9 incl. weapon-switch | PASS (Suite 1) |
| ARC 12/12 | **FAIL — 1/12** (lihat di bawah) |
| FPS ≥ 59 (stretch) | 57.8 / 58.2 — suite gate ≥50 PASS, stretch TIDAK tercapai |
| 0 console/page error semua run | PASS (arc v11 + v12, probe, diag: 0 error) |
| Screenshot 4 pose seed 7, ≤200 KiB, dibaca visual | PASS |
| Contact sheet + grayscale + readability 2 detik | PASS |
| Dossier ≤ 1.450.000 byte | PASS — 496.426 byte |
| Smoke regresi | 62/62 + 43/43 PASS |

## ARC — FAIL 1/12 (m2 chase)

Dua full-arc run (cap 720 detik tiap run, 0 console error) plus dua probe:

- **Probe v11** (`tools/probe-chase.mjs`, 300 detik): **M2-COMPLETE** —
  hit di t=3s, t=9s, t=49s; courier cruise 380→209→115→63; 87 sampel,
  minDist 6, in70 2, avgPlayerSpeed 180, maxSpeed 420, 17/87 sampel
  lambat (<60, driving), 0 console error.
- **Arc run 1 (v11, kode tidak berubah)**: `completed 1/12: m1; per-mission: m1@37s`.
  m2 gagal: opening sprint melaju ke barat di y≈1000 ~420 u/s sampai
  dinding barat x=16 (t≈52s), lalu meluncur ke selatan sepanjang dinding
  barat, lalu ping-pong timur–barat sepanjang dinding selatan y=3184
  selama 600+ detik.
- **Probe diagnostik** (`tools/probe-diag.mjs`, 300 detik):
  **M2-COMPLETE** (m1 79 detik). minDist 64, offRoad 94 dari ~160 detik
  chase, offRoadWhileCourierWithin250 7, restartsSeen 0, 0 console error.
  Diagnosis: mode direct (opening sprint / lunge / slow-courier)
  mengarahkan lurus ke posisi prediksi kurir tanpa cek jalan/halangan;
  pemain lebih cepat dari kurir (420 vs 209) dan meluncur melewatinya
  ke dinding. Gate recovery off-road lama (`dCourier>250`) tidak pernah
  terbuka karena kurir melaju satu jalan di seberang, ~180 unit jauhnya
  melewati deretan gedung.
- **Arc run 2 (v12, satu iterasi yang diizinkan)**: `completed 1/12:
  m1; per-mission: m1@82s`. m1 82 detik (osilasi marker stage 0 ~24 detik
  di ~(650,200), stage 1 ~30 detik di ~(2280,600) — marker-circling yang
  sudah ada sebelumnya, m1 tetap lulus). m2 gagal dengan mode baru:
  mobil melaju cepat di jalan (y≈600–1000), lalu **membeku identik
  piksel di (253,632) dari ~t=140 sampai t=720 (~580 detik)**, selamat
  dari restart timeout m2 (~t=383). 0 console error.
- **Analisis freeze (Node, modul world asli, seed 20261118):** di
  (253,632) TIDAK ada gedung, `isOnRoad`=true (batas: |632−600|=32),
  road point terdekat (253,600), rute ke utara bersih. Jadi freeze ini
  adalah freeze KONTROL di tanah terbuka, bukan terjepit fisik —
  mekanismenya belum terkonfirmasi (butuh instrumentasi level cabang:
  mode autopilot + tombol yang ditahan + routeTarget + dest kurir saat
  freeze, yang tidak dimiliki). Anggaran probe (2 penuh) dan iterasi
  (1 setelah v11) sudah habis; TIDAK ada v13.

m1 lulus cepat dan stabil di kedua run. m2 gagal dua kali. m3–m12 tidak
pernah tercapai, jadi tidak ada data lulus/gagal untuk mereka — arc
berhenti di m2.

### Perbaikan yang sudah dipakai (v12, commit `20175d9`)

1. **`segmentBlocked(G, from, to)`** — sampling segmen lurus tiap ~50
   unit via `world.pointInBuilding(x, y, 20)`; menghalangi opening
   sprint, slow-courier direct, dan lunge bila terhalang (jatuh ke
   corner drive via rute jalan).
2. **`brakeStraight(G, state)`** — lepas A/D/W, tahan S saja.
3. **Recovery ditulis ulang** — jalan kapan pun off-road (gate turun
   dari dCourier>250 ke dCourier>90 — ram tidak mungkin menembus
   gedung); target = breadcrumb segar (dalam 400, >40 jauhnya) atau
   road point terdekat; dikemudikan dengan `driveToward(target, 120)`
   (cukup pelan untuk stop-and-rotate).
4. **Alignment gate** di atas `driveChase` — bila speed >120 dan
   |angleDiff ke waypoint berikut (atau kurir bila tanpa rute)| > 1,0
   rad, `brakeStraight` — jangan masuk belokan tajam dalam kecepatan.

Hasil: probe diagnostik lulus (M2-COMPLETE), arc tetap 1/12 dengan mode
gagal baru (freeze kontrol di (253,632)).

Repro: `node tools/playtest.mjs --mode arc` → m1 selesai ~37–82 detik,
m2 sampai timeout 300 detik, restart, timeout lagi, run berakhir 1/12
pada cap 720 detik. 0 console error.

## Screenshot (seed 7, dibaca visual)

| File | Ukuran | Isi (dilihat) |
|---|---|---|
| `screenshots/1-cover.jpg` | 66.010 B | Kota siang top-down, jalan/gedung/air (waterfront kanan), minimap, HUD (3 bintang, HP 100, Day 1 12:00), kartu M7 "Highway Heat", ON FOOT / Pistol • 48 / $0, Bay FM. Terbaca, bukan frame hitam. |
| `screenshots/2-mission.jpg` | 58.494 B | Dialog misi "MARA / CRESCENT JOB" + teks brief + ACCEPT (E) / NOT NOW di atas kota yang diredupkan; kartu M8. Terbaca. |
| `screenshots/3-night.jpg` | 57.302 B | Sama dengan cover tapi malam: 22:00, 4 bintang, palet gelap, cahaya headlight. Terbaca. |
| `screenshots/4-start.jpg` | 63.881 B | Title "CRESCENT BAY / AN OPEN-CITY STORY • ROOK • MARA & DEX", 3 slot save Empty, NEW GAME / CONTINUE, daftar kontrol, "Free roam — explore Crescent Bay", kota di belakang overlay. Terbaca penuh. |

Semua ≤200 KiB (cap 204.800).

## Contact sheet

- `playtest/contact-sheet.jpg` 768×480, 43.699 B (colour).
- `playtest/contact-sheet-gray.jpg` 768×480, 38.870 B (grayscale twin).
- **Uji keterbacaan 2 detik: PASS.** Sekilas: cover = kota siang +
  "Day 1 12:00" + minimap + "Bay FM / ON FOOT"; baris bawah = dialog
  "CRESCENT JOB", kota malam ("Highway Heat"), title "CRESCENT BAY" —
  ketiganya teridentifikasi tanpa warna (grayscale tetap terbaca: blok
  gedung, jalan, minimap, judul).
- Sheet disimpan di `playtest/`, BUKAN `screenshots/`, supaya dossier
  tetap berisi tepat 4 gambar (cap buildDossier). Salinan di
  screenshots/ sudah dipindah ke trash (recoverable) saat dossier
  gagal `screenshots.max` dengan 8 file.

## Dossier

`MAKEFUN_OUTPUT_DIR=/tmp/dossier-r4c node main.ts` → sukses, tanpa warning:
- `dossier.json`: **496.426 byte** (cap 1.450.000 — 34%).
- `game/`: 23 file, 314.703 byte.
- `screenshots/`: tepat 4 file (poses seed 7).
- Catatan: run pertama ke `/tmp/dossier-r4` gagal `screenshots.max`
  (8 file) karena output tool mendarat di screenshots/; setelah
  dibersihkan ke tepat 4 file, run ke direktori baru sukses.

## Regresi

- `tools/smoke-b6.mjs`: **62/62**.
- `tools/smoke-b3.mjs`: **43/43**.
- `tools/playtest.mjs --mode cold`: **8/8**; `--mode edge`: **9/9**;
  `tools/weapon-switch.mjs`: **11/11**.

## HEAD

`ca1b465` — "B8 re-author smoke-b6" (laporan ini + screenshot
diregenerasi di atasnya; commit laporan menyusul).

## Keputusan untuk koordinator

READY **TIDAK** — gate ARC 1/12 (m2 chase: v12 freeze kontrol di
(253,632), mekanisme belum terkonfirmasi; anggaran probe + iterasi
habis). Semua gate lain PASS kecuali FPS stretch ≥59 (57.8–58.2,
gate suite ≥50 PASS). Opsi: (a) submit apa adanya dengan arc 1/12,
(b) scope-cut m2 (bila kit mengizinkan), (c) ronde perbaikan chase
baru dengan instrumentasi cabang (mode + tombol + routeTarget saat
freeze) — di luar anggaran tugas ini, perlu persetujuan koordinator.
