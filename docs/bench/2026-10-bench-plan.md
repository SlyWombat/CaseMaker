# Z1 bench plan: every bench-gated CNC item, grouped and sequenced

Written 2026-10-12 from a read of every open bench-gated issue (body and all comments), the
day-1 runbook (`2026-10-bench-day-1.md`), `Z1-Firmware-Dialect.md` §11 and `Fabrication.md`
§7.6/§9.4. Durations marked *est.* are estimates; the rest are cited from the issue or runbook.
The part is the printed two-colour PLA badge blank in the low-profile vise. Any issue text that
says wood is stale.

The sessions are ordered so each one produces what the next needs and so setup changes
(power cycles, tool changes, workholding swaps, Studio vs our console) happen as rarely as
possible. **Nothing here is scheduled; the maintainer calls each session.**

## Status, 2026-10-12 (end of day)

- **S1 done.** #255 upload, B3, B1, #283 modes (vacuum `M331`/`M332`; `M7` blows nothing).
- **S2 done.** D3 timed, #303 stop controls, B4, D1b (`N` lines are ignored, #385), C8, and
  #302 item 5: jobs start from our console with `play` from the card (#386).
- **Gate block done.** C9: `G38.2` does **not** share the tool-length sensor's input. D4: the
  regenerated ladder air-ran clean.
- **S3 step 1–2 done: first chips.** The #165 ladder, regenerated for the 2 × 12 O-flute with the
  blank as clamped (#383) and one file per row, was cut with the vacuum on. Depths and photos are on
  #165; solid plastic tracks the program to −0.1…−0.2 mm. The maintainer accepted that accuracy for
  V1 ("we can refine this in v2").
- **Before any cut (maintainer, 2026-10-12, #391):** offer to validate the material's position.
  On yes: wired probe in, `M491`, then find the blank's four edges with downward touches stepped
  across each one: blank top ≈ −56, jaw top ≈ −56.9, otherwise a capped miss. Compare with the
  job's origin and correct X/Y before the cutter goes back in. First, measure both jaw-top widths
  (calipers, or the same scan along X). They are still the unmeasured 15 mm defaults, and the scan
  needs them to know where a touch can land.
- **Which blank each S3 file goes on** (safety review of 3bc11ee, 2026-10-12). Every file cuts at
  a fixed place, so the blank decides what can share it:

  | Blank | Cuts | Why |
  |---|---|---|
  | Today's ladder blank | `185-v-groove.nc` in the free section **left of row A** (fixed-jaw side, X ≈ 2–11.5, clear of the pocket), then one coupon (back band, Y 62.5–73.5) | Maintainer's placement, 2026-10-12. Row A is in the middle, row B on the right; the squares span Y 18.1–58.1. |
  | Fresh blank 1 | `176-g32-stroke.nc` only | The stroke runs X 30–32 over Y 7–69. On the ladder blank it would run through every row B square, and it crosses any coupon cell. |
  | Fresh blank 2 | a coupon, then turn the blank end for end and cut a second | The coupon cell and the magnet pocket are symmetric about the blank's centre, so turned 180° the same file cuts the other end. Re-check the position (#391) after turning. |
  | Fresh blank 3 | the fourth coupon | spare end for a re-cut |

  Three fresh blanks, plus today's. The V-bit's Z0 is probed at the middle of the groove band
  (work X ≈ 7, Y ≈ 9, between the second and third grooves): the 0.33 mm dome is larger than
  the 0.2 mm steps between groove depths.
- **How to run a file** (from Windows, `casemaker-app/`): `z1.mjs send <host> 'M331'`, then
  `z1.mjs run <host> /sd/gcodes/<file>.nc --i-am-at-the-machine --first-reply 10000 --trace <log>`,
  then `send 'M332'` if the program didn't. Until the `run` follow-ups land (#386 comment), keep
  `--first-reply 10000`: a `play` reply slower than 3 s otherwise ends the polling while the job runs.
- **Next in S3:** #176's G32 stroke test, the #284 coupons and restart proof, #185 V-grooves. Before
  any of them: lift the head before `play` (#384) and set Z0 as the cutter tip's own height (#387).
- **S3's files are written; none of them has been run** (2026-10-12). `scripts/bench-files.ts` builds
  them through the app's own pipeline. The ladder comes back with the same motions it was cut with —
  the only change is the tool header's `shoulderlength`, 12 → 0, to match the house inventory (a3,
  2026-10-12; the cutter's shoulder is not a label's flute length), which is why the hashes moved to
  `94d39f74` / `bf0cb09b` and why the sheets' §8 warnings are unchanged. New: `176-g32-stroke.nc` and its run sheet (the `G32`/`M370`
  console steps, grid parameters blank until desk item 6, marked unverified), `284-pla-feed.json`
  and the four `284-PLA-feed-coupon-F{350,500,700,900}.nc` with their coupon record, and
  `185-v-groove.nc` — hand-written (a V-bit has no sweep), then put through the same verifier the
  upload gate uses before it was written. **While the vise is unmeasured, no cell on this blank may
  be wider than 34.1 mm across the jaws**: the 2 mm default band around the jaws, not `edgeMargin`,
  is the limit, and 11 mm is the largest cap height the app accepts for a coupon label.
- **Every sheet's §6 dry run loads a `<stem>-frame.nc`, and they all exist now** (2026-10-12, a3).
  Only the coupons' frames had been written: the ladder and #176 sheets told the operator to load a
  file nobody had written, which is a bench step that cannot be taken. `bench-files.ts` writes all
  six (rows A/B, the stroke, the four coupons), and the pipeline has already refused any frame that
  fails the verifier. The V-bit sheet's measuring note in S3 step 6 also changed what the caliper
  reads: the **top opening**, not the floor. A 0.3 mm flat tip leaves a 0.3 mm floor at every depth,
  so `w(d) = 0.3 + 2·d·tan 15°` is the width across the *top*; the file's header states the
  included angle (`angle=30`) alongside the half angle.
- The 2026-10-04 single-file ladder is **superseded** by the `-row-A` / `-row-B` files and moved to
  `docs/bench/superseded/`. Its card copy (`/sd/gcodes/165-depth-ladder.nc`), which would cut into the moving jaw on today's
  clamping, was **deleted from the card on 2026-10-12** at the maintainer's request (`md5` now answers
  not found). Our console's `play` can run any card file (#386).

## The one gate on every chip-making session: the cutter

The fitted 1 × 4 mm ball nose cannot be simulated (the sweep refuses any non-flat tool), and the
green-box 1 mm flat is a metal cutter, ruled out for PLA (maintainer, 2026-10-09, on #209).
Sessions S1 and S2 do not need a cutter and can run first.

**Cutter fitted (2026-10-12).** The maintainer asked which bit to put in the machine, was given the
one below, and has swapped it in. Every Makera box in the house was photographed and decoded that
day: 37 boxes, 28 codes. They are loaded into the desktop app's house inventory, and every code
scans as owned. (The records and photos are local, in `tool-labels/`, gitignored as vendor label
text.) The flat to fit for S3/S4:

- **Yellow case, label "Spiral 'O' Single Flute Bit - 1/8" Shank 2mm * 12mm", 单刃螺旋铣刀**,
  QR `C1-BIT-O-FLUTE-2-12` (one owned). It is the smallest plastic-rated flat in the house and the
  plan's own `2*12`. Check the Chinese: a label starting 金属 is the metal line (`O-FLUTE-M`),
  which also comes in yellow cases.
- Before cutting: caliper it (runbook A1), and confirm the badge's text is large enough for a 2 mm
  flat (the job's own recommendation, #211). If the job wants smaller, the only plastic-safe
  option owned is a 1 mm corn bit (`C1-BIT-CORN-1-7`), and that needs a test cut first. Corn bits
  are sold for PCB and composites.
- The ball nose is out and back in its yellow box ("Two Flute Ball Nose Bit … 1mm * 4mm",
  `C1-BIT-BALL-NOSE-1-4`). The house inventory's notes record the swap on both items.
- **#185's V-bit:** yellow case, "Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm",
  `C1-BIT-ENGRAVE-30-0.3`. The orange `ENGRAVE-M` bits are the metal line.
- The app reads all of these from their box codes since #377–#380. Before #379 an O-flute read as
  an unknown shape, so the build used at the bench must include `b74e148` or later.
- Only flat end mills simulate today. What it takes to simulate the rest of the owned set is
  #382.

## Before the bench (machine off, or no machine at all)

| # | What | Where | Feeds |
|---|---|---|---|
| 1 | ~~Yellow-box photos, pick the cutter~~ done 2026-10-12: `C1-BIT-O-FLUTE-2-12` (see the gate above); fitted 2026-10-12; still to do: caliper it (runbook A1) | desk | every cut |
| 2 | Vise dimensions, proud height and rock (A3, A4, A5); wired-probe tip ⌀ (A8) | machine off, calipers | `DEFAULT_VISE`, regenerated files |
| 3 | 30° V-bit (`C1-BIT-ENGRAVE-30-0.3`, label 30° × 0.3 mm flat tip) tip and angle under a loupe | desk | #185 |
| 4 | PrusaSlicer reads: `z_offset`, elephant-foot, layer heights, the colour-change layer (#269 item 2, #165 step 1); per-object infill (#166 item 2) | desk | #165, #166 |
| 5 | Makera Studio, **not connected to the machine**: the three reads in #268 (~30 min, cited); a Studio-made equivalent `.nc` for #176's diff | desk | #221, #176 |
| 6 | Check the D0/D1 MDI logs for what Studio's "Auto Workpiece Leveling" sends | desk | the dome-compensation decision |
| 7 | Print blanks on one recorded profile, 100 % infill, printed flipped (est. 4–6: ladder, +1 stroke test, 1–3 coupons, 2 for #176) | printer | S3, S4 |
| 8 | ~~Code and file prep~~ **done 2026-10-12**, one command (`casemaker-app/scripts/bench-files.ts`, plus `engrave-job.ts --coupon` for #284): the ladder and its run sheet for the chosen cutter (same motions as the one that was cut); `185-v-groove.nc`; `284-pla-feed.json` + its four programs; `176-g32-stroke.nc` **along the 76.2 mm length** (the 38.1 mm width cannot hold it); ~~a Windows desktop build for #255~~ closed in S1 | desk | S1–S4 |
| 9 | Get a USB cable for the Z1 (no serial port on hand, 2026-10-08) | — | #304 |

## Every session opens the same way

`casemaker-app/tools/z1/power.sh status`, then `?`, then read the `T:` field. After power-up the
machine is at T0, so register the cutter with `T1 M6` + `M490.2` before any `M491` (T0 makes `M491`
end in an Alarm, §11.9). Within a session the Studio block and our console block never overlap.
Watch for the network drop (#304) throughout; if it happens, note the head light and whether a
`Makera Z1` access point appears at 192.168.4.1, then `power.sh on --cycle` and `G28` before any
X/Y move.

## S1: plug on, no motion (est. 1.5–2 h)

Setup: vise on, collet empty.

1. **#255:** the desktop build discovers, identifies and uploads the regenerated ladder file;
   check it independently with `z1.mjs md5`. Closes #255 and stages the S3 file.
2. **B3:** `M499` verbatim.
3. **B1:** Studio's work-origin dialog screenshots (#187).
4. **#283:** toggle each of Studio's five assist switches one at a time and record the code each
   sends; why `M951` answers nothing; whether `M7` actually blows air.
5. **#283:** `power.sh on --cycle`, then re-read the modes (do they persist?).

Unblocks: #255, #289's panel, the §9.4 ATC question.

## S2: air and probe behaviour, no cutter needed (est. 2–3 h)

Setup: vise on, blank clamped, collet empty. Run the #275 broadcast listener throughout; it
sends nothing, so it can run beside everything else.

Studio block:
1. **D3 (#281):** timed air run of the D1 file, **feed and rapid portions recorded separately**.
   The file's words were re-ordered to the post's own order afterwards (#395, 2026-10-13), so the
   recorded split belongs to the pre-#395 bytes — the difference is the opening rapid, which is now
   an X/Y word and a separate `G0 Z30` rather than one `G0 X10 Y8 Z30`.
2. **#303:** red STOP, Pause/Resume, grey Stop, Reset, one fresh air run each. Our console
   disconnected while Studio drives.

Console block:
3. **B4:** a deliberate `$H` re-home.
4. **D1b:** does a numbered (`N`) line execute?
5. **C8:** `G38.2 Z-5` with the probe unplugged.
6. **#302 item 5:** start the air file from our console once, marked unverified.

Unblocks: #281's air half, #303 (then the stop decision and the restart proof in S3), #275,
§11.6.

## Gate block between S2 and S3: needs the cutter (est. 30–45 min)

1. Fit the chosen flat, register it as T1 (`T1 M6` + `M490.2`), `M491`.
2. **C9:** does `G38.2` share the tool-length sensor's input? (cutter in, probe plugged in and
   parked, T1 active)
3. **D4:** air run of the regenerated ladder at Z +20 over the clamped blank. **Go/no-go for S3.**

## S3: first chips on PLA (half a day to a day; the ladder alone is "an afternoon", cited)

Setup: vise on, the chosen flat as T1, wired probe. Record the wizard settings for every run:
the wizard's Auto Z and leveling can overwrite a console Z0 (D1's `G10 L20` moved Z by 6.5 mm).

1. Wired-probe Z at each row centre.
2. **#165 (and #209):** the depth ladder, cut once (no scrap blank), no `G32`, Z0 per row.
   Stopwatch it for D3's cutting half.
3. **#176's bounded G32 test:** `176-g32-stroke.nc` — one 60 mm stroke **along the length** at
   X 31.05 (the clear band), depth measured at both ends and the centre, on its own blank. Its run
   sheet carries the two lines the file may not: `G32 R1 …` from the console **before** `play`, with
   the grid numbers to be filled from Studio's Auto-Level log (desk item 6), and `M370` after. Both
   marked unverified. If it fails, split long `G1` moves in `post/z1.ts` before S4.
4. **#284:** `284-PLA-feed-coupon-F{350,500,700,900}.nc` (spec `284-pla-feed.json`), one program per
   feed value, the row's own 500 among them; fill in `284-pla-feed-coupon-record.json`; run
   `feeds-readback.ts` (never hand-edit `<feeds-measured>`). The cell loses 15–22 % of its area to
   the 2 mm cutter (`item-detail-lost` in §8) and its size is capped by the unmeasured vise, not by
   the blank — record whether the value was still readable, since that is what the readback needs.
5. **#284 restart proof:** stop one coupon mid-cut, `generateRestart`, compare the floor across
   the seam.
6. Last: swap to the 30° V-bit, `M491`, cut the **#185** grooves on the ladder blank:
   `185-v-groove.nc`, four 10 mm grooves along +Y (Y 4..14, in front of the magnet pocket's 15.6
   front edge) in the free section **left of row A** — the fixed-jaw side, work X 2.5 / 5.5 / 8.5 /
   11.5 at 0.6 / 0.8 / 1.0 / 1.2 mm deep, shallowest first. Caliper
   each groove's **top opening** — not its floor: a 0.3 mm flat tip leaves a 0.3 mm floor at every
   depth, so the floor reads the tip however deep the groove is — and compare with
   `w(d) = 0.3 + 2·d·tan 15°` = 0.622 / 0.729 / 0.836 / 0.943 mm;
   the 0.8 mm groove is the 0.81 mm reveal depth, #185's own reading. **Confirm the groove placement
   first:** the brief originally said "the same X/Y band as Row B", and a groove at X 30 *is* in Row
   B's band (squares X 28.55..33.55), which this blank has already been cut in — hence the maintainer's
   move left (2026-10-12). The strip is full 3.81 mm thickness, its left bound is the unmeasured jaws'
   2 mm band at work X 2 (so X 2.5 is 0.19 mm clear and safe only because the jaws' tops are 1.2 mm
   below the top face, too deep for a 0.6 mm groove to reach), and its right bound is the magnet
   pocket's wall at X 12.55 (X 11.5 leaves 0.58 mm for the widest opening).

Consumables: the ladder blank, +1 for the stroke test, 1–3 coupon blanks; the flat and the V-bit.
Unblocks: the #165 verdict, the #166 §7.2 table, #209, the Z-chain error, the G32 answer, the PLA
feeds row, the #250 gate (inspect a roughed floor), #175's membrane-boss question.

**Desk between S3 and S4:** the #165 verdict, the #166 table and `defaultBadgeParams` if needed,
the post split if the stroke test failed, the #176 job and its Studio diff.

## S4: the V1 acceptance badge, #176 (est. half a day)

Setup: as S3. Wired-probe Z touch-off, `G32 R1` grid (dump it with `M375.1` into the run record),
scrap badge, real badge, a stepped cut for collet seating (the last Z-chain term; probe and `M491`
are each measured at 0.001 mm); caliper every label; fill in the run record; `M370` to clear the
grid. Consumables: 2 blanks. **Closes V1 (#177).**

## S5: rotary R-1, #238 ("an afternoon", cited)

Last because it tears down the vise. Photograph the vise setup first; power off; vise and
wasteboard off; fit the module with the power off (never hot-plug its cable); power on; the §9
rows in the brief's order; one Studio rotary job to keep its header. Nothing is cut. Replaces the
config-read values in `Z1.rotary`.

## Not scheduled

- **#286 camera capture:** detection, the CV choice and the fit code are unbuilt, and the model
  needs rewriting for the frame-mounted camera.
- **#191 tape-tilt run sheet:** tape-down conflicts with decision 19 (the vise); run only if
  tape-down returns.
- **C5 X/Y edge-find:** Studio-only (the wired probe is Z-only); low value until a registration
  need appears.
- **#279's Z travel limit:** the only untested remainder of #279. Not scheduled casually: the one
  bare-bed touch on record (−65.1) says the bed is well above −100. Only on the maintainer's call.

## Decisions for the maintainer

Decided by the maintainer, 2026-10-12:
1. **No scrap blank** for the ladder: it is itself a test piece, and the D4 air run proves the
   path first. Blank count est. 4–6.
2. **No `G32`** on the ladder; G32 is proven separately by the 60 mm stroke test.
3. **One Z0 per row**, probed at each row centre (cancels most of the 0.33 mm dome).

At the bench or later: `toleranceMm` for #176 (3 touches or 1); rotary before or after the cuts
(the brief says after); whether to run the Z travel-limit test.

## Overlaps found in the read

- **#209 and #165** are now the same cut (the ladder is #209's program). #209 closes with the ladder.
- **#283 and #289** carry the same three bench unknowns; the bench rows live on #283.
- **#189**'s machine-free half is done; the rest lives in #286.
- **#175** (printed nest) is gated on decision 19 and likely obsolete unless S4 shows the vise
  cannot hold the blank.
