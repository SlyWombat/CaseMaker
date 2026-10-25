# 2026-10-24 — the datum path on the bench (web UI, build ffd997fe)

Operator: the maintainer's session driving `http://192.168.10.38:8000` from a headless Chromium on
dave-1 as a LAN user (`.scratch/web-cdp-*.mjs`); the maintainer nearby, no hands in the machine.
Blank: the 38.1 × 76.2 × 3.81 PLA badge, unchanged in the vise since 2026-10-22; Makera Wired Probe
V2 fitted throughout. House on k3: `ffd997fe` (= #598–#613 + #601/#596/#584/#602–#606). Power via
`power.sh` through a CRLF-cleaned copy of `ha-api.sh` (the Windows checkout's copy has CRLF again —
`power.sh` fails silently on it: "could not read switch.makera_cnc").

## What was being verified

The registration v2 sequence end to end on a house that started with **no bed profile, no datum,
no vise accessory** (`fixtures: {}`): (1) typed-seat registration creates the bed and writes the
jaw frame (#613/#600); (2) "Tap the fixed jaw" writes the datum (#599/#603); (3) the datum path
registers with the in-run tap check (#598/#599); (4) Cut re-posts against the tilt (#608) and the
#584 patch is read.

## Runs

| time | run | path | result |
|---|---|---|---|
| 15:18–15:23 | 1 | typed seat −58.79, ±0.7 | **completed**: surface −55.033 (expected −55.68…−54.28), left edge ≈ +0.3, front ≈ +5.6, five extents (lowest −55.505 right, highest −55.096 front), spread 0.409 vs 0.2 band, homed. **No origin written** — X off 0.83 / Y off 6.38 > 0.5 margin (#620). House after: `bp-first-2026-10-24` created, `fx-vise-1` checked out, frame `fixedJawFaceX −180.375, jawStartY −202.75` (#613 ✓, #600 ✓) |
| 15:26–15:28 | tap | machine card › Bed › Measure… | **jaw top −56.807** at (−185.375, −152.75) — mid-bar, 5 mm behind the face, from the frame; fit-probe prompt → Continue; datum written `by: fx-probe-1`, history "tapped" (#599/#603 ✓). The 50 mm descent at touch feed took ~25 s (#615) |
| 15:31–15:35 | 2 | **datum path** (override off, after a page reload — #617) | M119 `Probe: 0` → M491 −75.922 → **in-run tap −56.806** (0.001 from the datum) → M119 open → surface −55.033 **above the band −57.507…−55.397** → stopped (#619); Idle at the surface 58 s before `$H` (#588 park); stop text still offered `$X` recovery (#588, fixed in 6f23b626) |
| 15:36–15:43 | 3 | typed seat (repeat of run 1) | **completed**, identical numbers: surface −55.033, lowest −55.501, X off 0.83, Y off 6.38 → no origin (#620) |

Repeatability (run 1 vs 3, same clamping): surface 0.000, lowest extent 0.004, X/Y offsets 0.00 —
recorded on #570. Jaw top: −56.807 / −56.806 today vs −56.818 manual on 2026-10-23.

## Findings → issues

- **#619** (bench-blocking) — the datum path's band assumes the blank sits on the ledge (0.71 proud);
  this blank stands 1.77 proud; a reading ABOVE the band must be the stock, not a miss, and the
  measured proud must be written back.
- **#620** (bench-blocking) — no "use the found position" control: a stock > 0.5 mm from the saved
  G54 can never get an origin, so step 4 is unreachable.
- **#617** — Setups section plans from a stale machine record after a card-side tap (needed a reload).
- **#614** — need-datum never shows for a shipped-vise job (default seat pre-fills).
- **#616** — Bed › Measure… wording still says "via the registration executor in the wizard (S3)".
- **#615** — tap descent at touch feed over the full height.
- **#588** — the 60 s park reproduced (comment); narration/wording landed in 6f23b626.
- Not reached: #608's re-post step and the #584 patch (Upload was disabled: "the simulation does not
  match the prediction" — the under-cut is still there on this job).

## Records

- Transcripts: `traces/2026-10-24-run1-transcript.txt` (585 lines), `-run2-transcript.txt` (113),
  `-run3-transcript.txt` (579); results `-run{1,2,3}-result.txt`; status trail (4 s)
  `-run1-status-trail.log` covers all three runs and the tap (15:18–15:43).
- Frames: `img/2026-10-24-register/camera-run1/` (400 @ 3 s, 15:18–15:38), `camera-run3/`;
  screenshots `img/2026-10-24-register/*.png` (need-datum, seat-approved, cut-frozen, before/after
  tap, run{1,2,3}-result).
- House document after the session: bed profile + frame + datum present; `fx-probe-1` in the Z1,
  `fx-probe-3d` boxed, `fx-vise-1` checked out; nickname "Zoomba".

## Closed

15:45: machine Idle at home (`MPos:-1,-1,-1`), plug OFF (`power.sh off`: "machine is Idle · plug is
off"). Badge and the wired probe left in the machine. Browser harness stopped.

## Evening session (build 9b94d1cd = + #619 pt1, #620, #617, #588/#587, #601 follow-up)

Power on 16:41 (`power.sh on` through the CRLF-cleaned helper), page reloaded on the new build, job
regenerated, plan on the DATUM path (override off), approved, regenerated, frozen 16:43.

| time | step | result |
|---|---|---|
| 16:44–16:50 | **run 4, datum path** | M119 open → M491 −75.922 → **in-run tap −56.801** (stored −56.807) → M119 open → surface **−55.028 accepted** 1.77 proud (#619 ✓) → left edge (bisect to 0.25/0.5) → front edge ≈ 5.6 → five extents (lowest −55.518 right, highest −55.079 centre) → home. X off 1.08, Y off 6.38, spread 0.439 |
| 16:50 | **Use the found position** (#620 ✓) | "Writing the origin…" → prompt "Take the probe out, fit the cutter, then continue" (step 1/2 went stale at the same time — #621, fixed cfb56150 later) |
| 19:15 | cutter fitted by the maintainer (4 mm shank 0.5 mm 30° engraver) → **Continue** | `M491` −72.544 / −72.529 (cutter) → **`G10 L2 P1 X-180.125 Y-192.750 Z-52.129`** → `$H`, homed 19:16:44. X/Y = the found offsets; Z0 = lowest touch −55.518 + (−72.529 − −75.922) |
| 19:17 | **Re-post against the measured tilt** (0.336 toward +X, 0.354 toward +Y) | re-generated + re-frozen 19:17 ("Re-posted against the measured tilt") (#608 ✓) |
| 19:18 | Cut step 4 | **Upload disabled — "the simulation does not match the prediction"**: worst under-cut **301.39 mm²** at level Z −0.98 near (18.84, 38.45), a 26.25 × 66.86 mm patch = the whole pattern → **#623** (lifted file vs flat prediction); the original #584 0.0815 mm² sits underneath |

Verified today: #613, #600, #599, #603, #619 pt1, #620, #608's re-post; blocked: #623 (then #584).
Records: `traces/2026-10-24-run4-{transcript,transcript-full,result,result-after-use-found,result-after-continue,result-final,after-repost,oracle-lines}.txt`, `-run4-status-trail.log`, `-run4-origin-status-trail.log`; frames `img/2026-10-24-register/camera-run4/`, `camera-run4-origin/`; screenshots `run4-*.png`.
State at 23:30: Z1 ON, idle at home, cutter fitted, badge in the vise — left on at the maintainer's option for the #623 retest.
Switched OFF at 23:35.

## Session 2, 2026-10-24 evening (local 17:59–19:20; screenshots carry UTC stamps 22:08–23:16) — build 65034e22, then 264b3df8

k3 on 65034e22 (= 1881f8f8 + #623 oracle in the surface frame + #610 + #566 + #616 + #624 + #607). Power on
17:59 (`power.sh on`, controller came up in `Home`, Idle at rest 18:00); M821; the maintainer swapped the
cutter for the Wired Probe V2 on request. Page reloaded, job regenerated, datum plan approved, re-generated,
frozen 18:08 (UTC 22:08).

| local | step | result |
|---|---|---|
| 18:08:59–18:14:39 | **run 5, datum path** | completed and homed: in-run jaw tap (datum re-written **−56.754**, vs −56.801 last night — the probe was re-fitted tonight, so its installed length differs; #611's point, within the tap's ±2 mm check) → surface −55.02 at centre, **1.793 proud** → left/front edges → five extents (lowest −55.472 right, highest −55.02 centre), spread 0.452 vs 0.2 band → **X off 0.08, Y off −0.17 — within the 0.5 margin** (last night's origin is in G54), so the ordinary **Write the origin from this measurement** path was exercised for the first time. Tilt **0.784°** (0.352 toward +X, 0.358 toward +Y) |
| 18:15–18:16 | Write the origin → "Take the probe out, fit the cutter, then continue" → cutter fitted → Continue | M491 ×2 → **`G10 L2 P1 X-180.050 Y-192.925 Z-54.086`** → homed 18:16. Z0 differs from last night's −52.129 by ~2 mm = the cutter's stickout after tonight's re-fit (the delta probe→cutter was 3.39 last night, 1.39 tonight) |
| 18:16 | Cut step after the origin write | **"The package of 22:08 is stale — the job or the machine frame changed"** → **#627** (the origin write's flatness provenance stamp moved the fingerprint; #621 covered only the found-position path). Masked tonight by the re-post |
| 19:02 | **Re-post against the measured tilt** | re-generated + re-frozen 19:02; **oracle: under-cut 1.6339 mm² at Z −0.98 near (14.92, 38.75), a 15.59 × 66.24 mm patch, over-cut 74.4797 mm², tolerance 0.085, "in the blank's fitted surface frame"** — last night the same step read 301.39 mm² in the work frame → **#623 verified, closed**. The residual is #625 (the lift tips the flat job onto the column engine; its staircase fails the oracle) |
| 19:10 | publish **264b3df8** (#584 V-floor prediction, #615, #625, #588 status-gated $X, #611, #566 env stamp, + #627 still pending) | health ok; house intact (jaw top −56.754, frame −180.05 / −202.925, 3 accessories). Browser session dropped by the publish, as always |
| 19:14 | flat oracle on 264b3df8 (regenerate, no registration) | **"under-cut 0.0000 mm², over-cut 0.0000 mm², both within the 0.0399 mm² floor"** — #584's 0.0815 mm² is gone (the Ø0.61 dot the V cannot floor is no longer predicted as floored) |
| 19:16 | datum plan approved, re-generated, frozen (UTC 23:16) | step 3 staged |
| 19:52:18–19:57:12 | **run 6, datum path, on 264b3df8** (probe re-fitted) | completed and homed in **4:54** (run 5: 5:40 — #615's two-stage tap descent): X off 0.08, Y off 0.08 — confirmed; lowest −55.466 (right extent), highest −54.997 (centre), spread 0.469; **tilt 0.817°** (0.373 toward +X, 0.338 toward +Y). Repeatability vs run 5: tilt 0.784 → 0.817°, lowest −55.472 → −55.466, offsets within 0.1 mm |
| 19:57–20:06 | Write the origin → cutter fitted (third re-fit tonight) → Continue | M491 ×2 → **`G10 L2 P1 X-179.975 Y-192.850 Z-49.936`** → homed 20:06. Z0 moved 4.15 mm from run 5's −54.086: the cutter's stickout changes with every hand re-fit; M491 absorbs it |
| 20:10 | Re-post against the tilt (0.373/0.338) → re-frozen 00:10 UTC | **oracle: under-cut 1.6602 mm² at Z −0.98 near (11.29, 39.20), a 9.34 × 65.32 mm patch, over-cut 75.4995 mm², "in the blank's fitted surface frame"** — unchanged from run 5 (1.6339 / 74.4797) although #625 and #584 are on this build. The badge is a V-bit job → **column engine**; #625 reworked only the exact sweeper. → **#628** (the column path's surface-frame judging, #623 follow-up). **Upload still disabled; no cut tonight** |

Findings → issues: **#627** (origin write stales the package), **#628** (column-engine surface-frame oracle wrong
on the real job; my run-5 attribution of the residual to #625 was wrong — corrected on #625). Verified
tonight: #623 (frame: 301 → 1.6 mm²), #584 (flat verdict 0/0 on 264b3df8), #615 (tap time), the ordinary
origin-write path ×2, #620/#619 again, #608's re-post ×2, #603/#599's tap write-back (datum −56.754 by
fx-probe-1). Owed: #628 → then the badge re-post must read 0/0 → the first cut (#569) → #570; #588 (a clean
stop), #618 (pause on a scrap blank).

Records: `traces/2026-10-25-run5-run6-{result,writing}.txt` (regstate tags), `-run6-result-after-continue.txt`,
`-run6-after-repost.txt`, `-run6-transcript.txt` (614 lines, 32 PRB, the G10); frames `img/2026-10-25-register/camera-run6/`.

Findings → issues: **#627** (origin write stales the package). Verified: #623 (frame), #620/#619 again, the
ordinary origin-write path, #608's re-post, #603/#599's tap write-back. Owed on 264b3df8: #625 + #584 together
(the badge re-post must read 0/0), #615 (tap descent time), #588 (no 60 s park at a stop), the first cut (#569).

Records: `traces/2026-10-25-run5-{status-trail.log,after-run,result,writing,result-after-continue,after-repost,transcript}.txt`
(transcript 610 lines, two M491s, the G10), frames `img/2026-10-25-register/camera-run5/` (500 @ 3 s from
18:05) and `camera-run5b/`, screenshots `img/2026-10-25-register/*run5*.png` + the driver's `img/2026-10-23-register/2026102{4,5}-22*`.
