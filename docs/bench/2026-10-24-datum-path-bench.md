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
