# Bench 2026-10-17 — Single Barrel on a fresh PETG blank, both passes ran; the V-bit "for fun"

**Result:** the rough pass (yellow "Spiral 'O' Single Flute Bit - 1/8" Shank 2mm * 12mm") cut cleanly in
136 s; the second pass ran yesterday's 0.6 mm rest toolpath with the yellow "Single Flute Engraving Bit -
1/8" Shank 30° * 0.3mm" fitted, all 42 626 lines in 856 s, no alarm, no visible melt. The badge reads, but
the second colour shows **patchily** ("it could have been deeper", maintainer) and "(Like the Whiskey)"
was not cut (no owned cutter reaches it; the job carries it turned off). Photo: `.scratch/badge-2026-10-17/result-photo.jpg` (local).

First bench session run from **DAVE-1** (Windows 11 ARM64; the Z1 harness through Windows Node 24, the
plug through a CR-stripped copy of `ha-api.sh`, the kdocker2 token as user `claude`).

## Setup
- Blank: a NEW two-colour PETG badge blank, 38.1 × 76.2 × 3.81 nominal, in the vise long side front-to-back.
- The blank sat **7 mm further back along the jaws** than yesterday's: front edge ≈ Y −1.3, back ≈ Y 75.05 in
  the 2026-10-16 frame (G54 X −181.1 Y −193.15); sides ≈ X −0.1 and 37.8. Length ≈ 76, width ≈ 37.9.
- New origin written so the blank's centre lands on the job's (19.05, 38.1): **G10 L2 P1 X−181.300 Y−194.375**.

## Surface (probe, machine Z) — the blank is domed ACROSS ITS WIDTH, ridge along the length
| point | Z |
|---|---|
| centre (19.05, 38.1) | **−55.131** |
| ridge ends (19.05, 5) / (19.05, 71.5) | −55.315 / −55.341 |
| "br" region flanks (12.2, 38.1) / (25.9, 38.1) | −55.269 / −55.232 |
| clean point (X3 Y38 old frame) | −55.559 |
| sides (X −0.5 / X 37.75) | −55.747 / −55.667 |
| fixed-jaw top (X −4) | −56.646 |

Spread over the cut area 0.21 mm; across the width 0.6. Yesterday's note said "domed across its length"; this
blank's ridge runs along the length. Probe reference `M491` **−75.775** (unchanged from 2026-10-15/16).

## Z0, and what the cut said about it
- Z0 surface **−55.33** (ridge peak − 0.2, the 2026-10-16 recipe), chosen by hand. O-flute `M491` −74.738 →
  `G10 L2 P1 Z−54.293`. V-bit `M491` −76.529 → `G10 L2 P1 Z−56.084`.
- Floors at 0.985/0.998 → machine −56.315: depth 1.19 at the centre, 0.98 at the ridge ends.
- **Observed:** the second colour shows along the whole title but speckled, with no gradient middle→ends. So
  the colour line is a PLANE at about the floor's height (≈ −56.3), ~1.0–1.2 below the ridge and ~0.6 below the
  sides: the dome is extra top-colour material on a flat back, not a bent plate. Z0 referenced to the ridge
  under-cuts the reveal; the reference should be the LOW surface or the back face. Auto-level following the top
  would make the reveal worse on such a blank. Filed on **#475**.
- The maintainer's rule, same session: **facing is for wood and metal only**, never printed plastic (#474).

## The second cutter
- `engrave-job.ts --from-3mf single.3mf --tool inv:kz-o-flute-2-12 --rest inv:kz-engrave-30-0-3` answers that a
  V-bit is "not a flat end mill (or a V-bit on a job with regions)" and that the rest pass has 0 mm² to cut:
  **the app has no V-bit program on a region design** — that is a V-carve, #221. Filed as **#486**.
- Owned 1 mm flats that the rules allow on plastic: none (the 1 mm corn is corn, the 1 mm O-flute is the
  metal line). A 1 mm single-flute O end mill for plastic would give a real second program today.
- On DAVE-1 the house document is the labels-built `kazoo-house.json` (no catalogue), so a **PETG** job stops at
  findings with no cutting parameters; program 1 was regenerated from the saved job document with the material
  set to PLA (same geometry as yesterday's file). `scripts/engrave-job-bench.ts` (untracked) is the copy that
  takes a job document through the two-tool route.

## Toolpath ordering (#487)
`single-rest.nc`: 479 XY rapids, 3 307 mm of rapid travel against 1 820 mm of cutting (1.82 : 1, 15 jumps over
20 mm); `single.nc`: 0.87 : 1. The maintainer watched it hop between letters and back.

## Routine as run (scripts in `.scratch/badge-2026-10-17/`)
1. `power.sh on` → Home; probe in; `step1.mjs`: `M491`, surface at the clean point (relative `G91 G38.2`).
2. `step2.mjs` / `step2b.mjs` / `step2c.mjs`: edge scans; the dome makes a ±0.25 band misclassify the middle
   as "off", so the front/back scan used a 0.6 band and MISS as the hard edge.
3. `step3.mjs`: centre touch, `G10 L2` XY, `$H`. `step3b.mjs`: jaw top and the regions' extents, `$H`.
4. Cutter in → `step4.mjs` (`M491`; the PRB lines arrive after the reply window, read them from the trace) →
   `step4b.mjs` (`G10 L2` Z). `upload.mjs` (runUpload from `protocol.ts`) to `/sd/gcodes/sb1017*.nc`.
5. Frame (`z1.mjs run`) — clear; `M331`; program 1 (136 s); `M331` again (the file's own `M332` ends it);
   `$H`; V-bit in; `M491`; `G10 L2` Z; program 2 (856 s); `M332`; `$H`; plug off.

## Next
- Decide #475 (Z0 reference on a domed printed blank) and #486 (V-carve or a 1 mm plastic O-flute).
- Print the next blank with the colour change closer to the top, or flatter, per #166.
- Install the house service / `location.json` on DAVE-1 so PETG jobs generate there.

## Evening: the laminate badge, V-carved in one program

- **The blank is a PURCHASED two-colour engraving laminate** (maintainer): 76 × 25.35 × 1.5, a thin cap of one colour
  over the core, no layers, no filament, material unknown ("plastic"), cap assumed 0.075 mm, no datasheet. The thin-film
  3MF's printed facts earlier in this record were my invention — see #492 (laminate stock model) and #493 (facing refused
  for every plastic).
- **The model decided with the maintainer (#221):** a V-carve is a constant-depth pocket cut with the V-bit's tip, offset
  so the design is exact at the COLOUR PLANE (rPlane = tip/2 + (D − film)·tan(half)); the walls widen the opening above;
  one bit does the whole job; pitch clamped to the tip radius (0.15) or narrow strokes keep a ridge. Depth-follows-width
  V-carving is a later option.
- **Registration:** the afternoon's G54 (−181.200 / −184.125) survived the plug cycle; the evening re-check put the front
  edge at work Y ≈ −0.1 (miss at −0.75) and the back at ≈ 76.5, as scanned; centre −57.597 (−57.565 before).
  Probe `M491` −75.621 (re-seated; −75.588 in the afternoon). Cutter `M491` −74.140 → Z0 surface −57.675 (midpoint of
  the item area) → `G10 L2 P1 Z−56.194`.
- **Program:** `single-thin.3mf` at 0.1 mm deep, generated by the #221 chain (`--tool inv:kz-engrave-30-0-3 --rest none`),
  labelled PETG for feeds (12 000 rpm, F500/F200, the placeholder row), cap read as 0 for the preview (0.007 mm from the
  laminate's offset): ONE program, 35 555 lines, verified, simulated on the cone (column engine, 0 errors), warnings:
  pitch clamped 0.18 → 0.15 on every item, surface merges on the title and the whiskey line, blank below the jaw tops
  with 1 mm clear (#488, no packer).
- **Run:** frame clear (47 s); `M331`; `sb1017-v.nc` **437 s**, no alarm; `M332`; `$H`; plug off.
- **Result (maintainer's photo `.scratch/badge-2026-10-17/result-laminate-vcarve.jpg`):** all three items, clean floors,
  the whiskey line fully legible at 6.2 mm cap height, no melt, no strings. First try.

## Open after the evening cut
- #492 laminate stock (cap as the film source; the fixture corrected), #493, #450 (measure the laminate's V row), #475/#495
  (the extents-touch executor and the app-driven registration — today's registration was still these scripts).
- Whether this cut is CNC-3's acceptance (#176) is the maintainer's call.
