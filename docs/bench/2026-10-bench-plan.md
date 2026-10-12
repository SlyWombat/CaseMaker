# Z1 bench plan: every bench-gated CNC item, grouped and sequenced

Written 2026-10-12 from a read of every open bench-gated issue (body and all comments), the
day-1 runbook (`2026-10-bench-day-1.md`), `Z1-Firmware-Dialect.md` §11 and `Fabrication.md`
§7.6/§9.4. Durations marked *est.* are estimates; the rest are cited from the issue or runbook.
The part is the printed two-colour PLA badge blank in the low-profile vise. Any issue text that
says wood is stale.

The sessions are ordered so each one produces what the next needs and so setup changes
(power cycles, tool changes, workholding swaps, Studio vs our console) happen as rarely as
possible. **Nothing here is scheduled; the maintainer calls each session.**

## The one gate on every chip-making session: the cutter

The fitted 1 × 4 mm ball nose cannot be simulated (the sweep refuses any non-flat tool), and the
green-box 1 mm flat is a metal cutter, ruled out for PLA (maintainer, 2026-10-09, on #209).
**Before S3, S4 or any cut:** photograph each yellow box close up so the labels and QR slugs can
be read, then pick a non-metal flat if one is owned (`3.175*1*3mm Flat End`, `1.5*8` or `2*12`),
or buy one. Sessions S1 and S2 do not need it and can run first.

## Before the bench (machine off, or no machine at all)

| # | What | Where | Feeds |
|---|---|---|---|
| 1 | Yellow-box photos, pick or buy the cutter; caliper it (runbook A1) | desk | every cut |
| 2 | Vise dimensions, proud height and rock (A3, A4, A5); wired-probe tip ⌀ (A8) | machine off, calipers | `DEFAULT_VISE`, regenerated files |
| 3 | 30° V-bit tip and angle under a loupe | desk | #185 |
| 4 | PrusaSlicer reads: `z_offset`, elephant-foot, layer heights, the colour-change layer (#269 item 2, #165 step 1); per-object infill (#166 item 2) | desk | #165, #166 |
| 5 | Makera Studio, **not connected to the machine**: the three reads in #268 (~30 min, cited); a Studio-made equivalent `.nc` for #176's diff | desk | #221, #176 |
| 6 | Check the D0/D1 MDI logs for what Studio's "Auto Workpiece Leveling" sends | desk | the dome-compensation decision |
| 7 | Print blanks on one recorded profile, 100 % infill, printed flipped (est. 4–6: ladder, +1 stroke test, 1–3 coupons, 2 for #176) | printer | S3, S4 |
| 8 | Code and file prep once 1 and 2 exist: regenerate the ladder and its run sheet for the chosen cutter; hand-write `185-v-groove.nc`; the #284 coupon spec; the #176 60 mm stroke file **along the 76.2 mm length** (the 38.1 mm width cannot hold it); a Windows desktop build for #255 | desk | S1–S4 |
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
3. **#176's bounded G32 test:** one 60 mm stroke **along the length** with `G32` active, depth
   measured at both ends and the centre, on its own blank. If it fails, split long `G1` moves in
   `post/z1.ts` before S4.
4. **#284:** the feeds coupons, one program per feed value; fill in the coupon record; run
   `feeds-readback.ts` (never hand-edit `<feeds-measured>`).
5. **#284 restart proof:** stop one coupon mid-cut, `generateRestart`, compare the floor across
   the seam.
6. Last: swap to the 30° V-bit, `M491`, cut the **#185** grooves on the ladder blank. **Confirm
   the groove placement first:** the brief says "the same X/Y band as Row B", which Row B
   occupies; the front clear band is free.

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
