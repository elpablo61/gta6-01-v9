# Playtest R2 — Arc + Screenshots + Dossier (24 Nov 2026)

Recording R2 `01a20b10-c24e-7096-87e8-5fd3579b7a65`. Suite 1 (cold 8/8, edge 9/9,
weapon-switch 11/11, FPS 59.3) in `playtest/r2-cold-edge-weapon-fps.md`.

## Ringkasan gate

| Gate | Hasil |
|---|---|
| COLD 8/8 | PASS (Suite 1) |
| EDGE 9/9 incl. weapon-switch | PASS (Suite 1) |
| ARC 12/12 | **FAIL — 1/12** (lihat di bawah) |
| FPS ≥ 59 | 59.3 PASS (Suite 1) |
| 0 console/page error semua run | PASS (arc run 3 + run 4: 0 error) |
| Screenshot 4 pose seed 7, ≤200 KiB, dibaca visual | PASS |
| Contact sheet + grayscale + readability 2 detik | PASS |
| Dossier ≤ 1.450.000 byte | PASS — 493.286 byte |
| Smoke regresi | 62/62 + 43/43 PASS |

## ARC — FAIL 1/12 (m2 chase)

Dua full-arc run (cap 720 detik tiap run, 0 console error):

- **Run 3** (commit `16bf8fb`, setelah fix rem): `completed 1/12: m1; per-mission: m1@63s`.
- **Run 4** (commit `a64c6fe`, setelah fix ram): `completed 1/12: m1; per-mission: m1@64s`.

m1 lulus cepat dan stabil di kedua run. m2 gagal dua kali lewat timeout
300 detik per percobaan (dua percobaan dalam tiap run). m3–m12 tidak pernah
tercapai, jadi tidak ada data lulus/gagal untuk mereka — arc berhenti di m2.

### Perbaikan yang sudah dipakai (2x, sesuai batas tugas)

1. **Rem sebelum belokan tajam** (`16bf8fb`, `driveToward` di
   `game/src/autopilot.js`): mobil tiba di persimpangan pasar ~178 u/s dan
   masuk zona mati — terlalu cepat untuk cabang stop-and-rotate (>140) tapi
   di bawah ambang rem lama (>180) — lalu menabrak gedung di utara
   persimpangan dan terjebak (HP 46 → 2 dalam 47 detik). Sekarang rem lebih
   awal untuk belokan tajam DI waypoint (kaki masuk vs kaki keluar, <260
   unit) dan untuk belokan tajam apa pun di atas 120 u/s. Hasil: m1 63–64
   detik, tidak pernah macet lagi.
2. **Mode ram untuk m2** (`a64c6fe`, `driveToward(..., { ram })`):
   tabrakan hanya terhitung di atas 120 u/s, tapi rem kedatangan
   (`closeIn`, ≤60 dalam 140 unit dari target) membuat mobil selalu tiba
   di kurir terlalu pelan. Mode ram menahan gas penuh dan melewati rem
   kedatangan + rem belokan dalam 260 unit dari kurir. Hasil: m2 tetap
   gagal — lihat diagnosis.

### Diagnosis m2 (probe khusus, `tools/probe-m2-diag.mjs`, sudah dihapus)

Chase 220 detik dengan autopilot (`?autopilot=1&mission=m2`):

- **Hit: 0/4. Jarak terdekat pemain–kurir: 115 unit (butuh <70).**
  0 sampel dalam 70 unit. Kurir konstan 380 u/s, tidak pernah melambat
  (0 hit → cruise tidak pernah dipotong 55%).
- **Mobil pemain kebanyakan merangkak 1–54 u/s**, terjebak ~30 detik di
  tiap klaster persimpangan ((1750,950), (1030,1010), (1050,1460)),
  dengan semburan sesekali sampai 415 u/s. Kurir terus kabur ke sudut
  jauh peta ((200,2966), (2961,3000), (2965,200)).
- **Hipotesis akar masalah** (untuk koordinator): rute jalan dihitung
  ulang tiap ~0,3 detik karena kurir bergerak 380 u/s, dan tiap hitung
  ulang memicu lagi logika rem-sebelum-belokan-tajam + rotate-in-place —
  mobil menghabiskan chase dengan mengerem/berputar di tempat, bukan
  mengemudi. Perbaikan berikutnya (di luar jangkauan tugas ini) perlu
  mengejar kurir dengan rute yang stabil / aim langsung, bukan
  route-recompute tiap frame.

Repro: `node tools/playtest.mjs --mode arc` → m1 selesai ~63 detik,
m2 stage 0 sampai timeout 300 detik, restart, timeout lagi, run berakhir
1/12 pada cap 720 detik. 0 console error.

## Screenshot (seed 7, dibaca visual)

| File | Ukuran | Isi (dilihat) |
|---|---|---|
| `screenshots/1-cover.jpg` | 64.807 B | Kota siang top-down, jalan/gedung/air, minimap, HUD (3 bintang, HP 100, Day 1 12:00), kartu M7 "Highway Heat", ON FOOT / Pistol • 48 / $0, Bay FM. Terbaca, bukan frame hitam. |
| `screenshots/2-mission.jpg` | 58.509 B | Dialog misi "MARA / CRESCENT JOB" + teks brief + ACCEPT (E) / NOT NOW di atas kota yang diredupkan; kartu M8. Terbaca. |
| `screenshots/3-night.jpg` | 56.017 B | Sama dengan cover tapi malam: 22:00, 4 bintang, palet gelap, cahaya headlight. Terbaca. |
| `screenshots/4-start.jpg` | 63.886 B | Title "CRESCENT BAY / AN OPEN-CITY STORY • ROOK • MARA & DEX", 3 slot save Empty, NEW GAME / CONTINUE, daftar kontrol, "Free roam — explore Crescent Bay", kota di belakang overlay. Terbaca penuh. |

Semua ≤200 KiB (cap 204.800).

## Contact sheet

- `playtest/contact-sheet.jpg` 768×480, 44.366 B (colour).
- `playtest/contact-sheet-gray.jpg` 768×480, 39.068 B (grayscale twin).
- **Uji keterbacaan 2 detik: PASS.** Sekilas: cover = kota siang + "Day 1
  12:00" + minimap + "Bay FM / ON FOOT"; baris bawah = dialog
  "CRESCENT JOB", kota malam, title "CRESCENT BAY" — ketiganya teridentifikasi
  tanpa warna (grayscale tetap terbaca: blok gedung, jalan, minimap, judul).
- Sheet disimpan di `playtest/`, BUKAN `screenshots/`, supaya dossier
  tetap berisi tepat 4 gambar (cap buildDossier).

## Dossier

`MAKEFUN_OUTPUT_DIR=/tmp/dossier-r2 node main.ts` → sukses, tanpa warning:
- `dossier.json`: **493.286 byte** (cap 1.450.000 — 34%).
- `game/`: 23 file, 287.832 byte.
- `screenshots/`: tepat 4 file (poses seed 7).

## Regresi

- `tools/smoke-b6.mjs`: **62/62**.
- `tools/smoke-b3.mjs`: **43/43**.
- Setelah commit `16bf8fb` dan `a64c6fe` (keduanya smoke hijau).

## HEAD

`a64c6fe` — "R2 playtest: ram mode for m2 chase (driveToward braked away every hit)".

## Keputusan untuk koordinator

READY **TIDAK** — gate ARC 1/12 (m2 chase, 0/4 hit, jarak terdekat 115).
Semua gate lain PASS. Opsi: (a) submit apa adanya dengan arc 1/12,
(b) satu ronde perbaikan chase lagi dengan hipotesis di atas
(rute stabil / aim langsung ke kurir, bukan recompute tiap frame).
