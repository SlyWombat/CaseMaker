# Bench 2026-10-16 — Single Barrel badge from `single.3mf`, first two-tool cut

**Result:** the rough pass cut cleanly; the rest pass broke its cutter at ~12 %. To be repeated
2026-10-17 with a different second cutter (see "Tomorrow").

## Setup
- Blank: the scrap "ladder" two-colour **PETG** badge blank (maintainer, after the cut — the job and these notes
  assumed PLA) (38.1 × 76.2 × 3.81, colour change 3 mm above the
  back face), in the vise, long side front-to-back, 38 mm between the jaws — unmoved since 2026-10-15.
- Programs regenerated from HEAD with `npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts
  --from-3mf ../samples/badge-blank/single.3mf --out ../.scratch/badge-2026-10-16` (the `--tsconfig` flag is
  required, or `@/` imports fail). Both programs verified and simulated with 0 errors; overlap 0.5 mm (#436),
  leftover 0.44 %.

## The routine as run (bench helper `.scratch/badge-2026-10-16/bench.mjs`, trace in
`traces/2026-10-16-single-barrel-bench.log`)
1. **Probe in.** `M491` → probe reference PRB **−75.775** (2026-10-15: −75.774).
2. **Surface at the clean point** (work X3 Y38): `G91 G38.2 Z-56 F300`, lift 1, `G91 G38.2 Z-2 F100` →
   **−55.752** (2026-10-15: −55.753). **`G38.2` here is RELATIVE in effect** — an absolute target went only
   the difference (4 mm) and missed; always send `G91 G38.2 Z-<distance>` then `G90`.
3. **Edge scans**, park at surface + 3, each touch `G91 G38.2 Z-3.5 F150` (≤ surface − 0.5), stop at the first
   off-stock touch: left 0→−0.5, right 39→39.5, front −8.5→−9, back 68→68.5 (roll-off). With the 0.7 mm tip
   offset: width **38.1** ✓, length 75.6. Front-left corner → **G54 X −181.100, Y −193.150** (identical to
   2026-10-15's scan).
4. **The top is domed**: centre (cut area) −55.452, edges −55.64…−55.80 — **0.3 mm** high in the middle.
   Z0 taken from **−55.65**, so every cut lands 0.85–1.18 mm deep (reveal needs > 0.81; ≤ 1.2 over the
   magnet pocket). Auto-level (#176) would replace this compromise.
5. `$H`, fit the **yellow case "Spiral 'O' Single Flute Bit - 1/8" Shank 2mm * 12mm"**, `M491` → **−72.777**.
   Z0 = −55.65 + (−72.777 − −75.775) → `G10 L2 P1 Z-52.652`.
6. Upload four files (`single`, `single-frame`, `single-rest`, `single-rest-frame`); run `single-frame.nc` —
   **clear of the jaws** (maintainer).
7. `M331`, `single.nc` (134 s), `M332`, `$H` — **clean** ("all good").
8. **Vacuum stays on between tool changes** (maintainer): `M331` before the bit change, off after the last
   program.
9. Fit the **yellow case "TiN Coating Corn Bit - 1/8" Shank 0.6mm * 3mm"**, `M491` → **−70.974**.
   Z0 = −55.65 + (−70.974 − −75.775) → `G10 L2 P1 Z-50.849` (verified live: WPos Z −0.400 at MPos −51.249).
10. `single-rest.nc`: shallow passes over already-cleared area looked like "not cutting" at first; at ~12 %
    (line ~5300/42 686, 132–138 s, on "br", work Z −0.8) **the 0.6 mm corn bit broke**. Stopped with `abort`
    ("Aborted playing or paused file") → Idle → `M332` → lift → `$H`; plug off.

## What the vendor's own library says (read locally, not committed)
Makera's cutter library lists its **corn bits only for PCB and carbon fibre — no plastic rows at all**. For
fine detail in plastic it lists **30° single-flute engraving V-bits** (0.1–0.5 mm tips) and **flat end mills of
1 mm and up**. Our corn-bit feeds were no harsher than its PCB row. **Observed (maintainer): the broken corn bit is melted into
the PETG** — the burr's chips welded, so heat and chip packing in the thermoplastic is the cause, not a guess.

## Decisions (maintainer)
- **Follow the database for recommendations**: a cutter the catalogue lists for no row of the job's material
  is not recommended (filed as an issue).
- **Tomorrow's second cutter is the 30° V-bit** (maintainer): the **yellow case "Single Flute Engraving Bit -
  1/8" Shank 30° * 0.3mm"**, with feeds informed by an internet search for fine detail in PETG.
- The job's material is set to PETG for tomorrow, and PETG maps to the catalogue's nearest plastic rows (#455).
- A 60° bit was considered and set aside: wider groove per depth (reveal needs a ~1.04 mm gap vs ~0.73 mm for
  the 30° 0.3), and the only owned 60° is the orange metal-line bit.

## Tomorrow
1. Regenerate the rest pass for the chosen second cutter; simulate it.
2. Fresh blank or the same ladder blank (re-scan either way).
3. The whole routine above, including the frame check and the vacuum left on across the bit change.
- Research for tomorrow's second cutter: [2026-10-16-fine-detail-petg-pagf.md](2026-10-16-fine-detail-petg-pagf.md).
