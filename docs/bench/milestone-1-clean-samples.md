# Milestone 1 — Clean samples from the app

*The acceptance document for Milestone 1 (tracking issue #943; plan `docs/reviews/2026-11-02-cnc-milestone-1-review.md`
§1 and §4.4; marching orders `docs/reviews/2026-11-02-manager-marching-orders.md`). Written 2026-11-02 at base
`main` 3c58b91e. The numbers in §3 were accepted by the maintainer on 2026-11-02 as written; any later adjustment
after the first part is recorded on #943 with its reason, then here.*

## 1. Done when

1. **The simulation validates a job** by the ten statements of review §2.3(e) before any cut, and the gate refuses a
   job that fails them. **1b.** The Z1 Demo Jobs page is the gate (#944): every card is visually validated from the
   simulation against an objective reference, rebuilt from the pinned sha every wave, and the elephant (#945) and the
   panther (#946), scaled in the app to fit the 36 × 36 × 100 mm stick, read "Matches the design" on it. No bench work
   of any kind, the air session included, before 1 and 1b are ticked.
2. **Five hardwood sample parts** (§2) are cut on the Z1 by an operator at the GUI from jobs the app generated,
   validated, registered, uploaded and ran; each is measured against §3 and photographed beside a scale; the
   transcript is saved.
3. **The badge is repeated twice after unclamping and re-seating** with the origin spread recorded (#570, #937).
4. **Every feeds row the five samples used is `measured`**, flipped by a cut coupon and the readback script, committed
   (#284).
5. **Predicted cycle time is within 10 % of the clock** on the five runs; air fraction and feed utilisation are printed
   on every run sheet.
6. **The #767 checklist is ticked or each unticked line is re-filed**; no closed issue on the path carries an
   unobserved machine claim.

**Material.** Hardwood, 36 × 36 × 100 mm sticks, in the low-profile vise. Printed plastic and laminate are 1.1 (#913).
Hardwood is new ground for this Z1: every sample is preceded by its coupon on the same stick and the frame air-run, the
vacuum is on for every cut, the seeded hardwood rows are "conservative guesses for a 150 W spindle" until a coupon
flips them.

## 2. The five samples

| # | Sample | Issue | Stock · holding · cutter | Cut order |
|---|---|---|---|---|
| 1 | The flagship text job ("CASE / MAKER / first chips") from the GUI, after a 10-minute groove coupon on the stick's end; calipers before the part leaves the vise area | #936 (S2); repeatability #937 (S3) | stick, vise, the recommended V/engraving cutter at the catalogue hardwood row | first |
| 2 | Flat-cutter feeds coupon ladder bracketing the catalogue hardwood row → the first measured hardwood row → a two-line flat-cutter label | #938 (S4) | stick, vise, the recommended flat cutter | second |
| 3 | Pocket-and-bores face: 20 × 10 × 3 rectangular pocket r2, ⌀8 × 3 round pocket, four ⌀3.2 bores 6 deep (bored) | #939 (S5) | stick (36 × 100 face), vise, flat cutter at the measured row | third |
| 4 | Two-cutter job: 24 × 24 × 6 pocket with the flat, two initials V-carved 0.8 deep on its floor, the tool change through the app's prompt | #940 (S5/S6) | stick, vise, flat then V/chamfer | fourth |
| 5 | Chamfer the four top edges 1 × 45°, then a 6 × 10 through-slot across the 36 mm width, open both sides | #941 (S6) | stick, vise, chamfer then flat | fifth |

Every sample: coupon first on the same stick, frame air-run, `M821` for the whole job, `M331` before play, one program
at a time from the app with no hand command, calipers at the machine, photo beside a scale, transcript saved, results
written on the issue before power-off.

## 3. Acceptance numbers (hardwood; accepted 2026-11-02)

Written as the operator's checklist; a caliper reads 0.01 mm, so each number has an instrument. Hardwood moves and
tears, so depth is ±0.1 mm, not the ±0.05 a plastic would allow.

| Property | Number | Instrument |
|---|---|---|
| Engrave depth (text) | within 0.1 mm of the programmed depth, centre vs ends within 0.1 mm | depth gauge |
| Text placement | centred on the face within 0.5 mm | calipers to the stock edges |
| Legibility | every item readable at arm's length; no fused counters | eye |
| Stroke and pocket edges | no tear-out, no fuzz standing above the surface, no burn mark | eye, loupe, photo beside a scale |
| Pocket dimensions | ±0.1 mm length/width/diameter; depth ±0.1 | calipers / depth gauge |
| Bores | go 3.0 pin / no-go 3.3 (⌀3.2 nominal) | pins or calipers ±0.1 |
| Slot | width and depth ±0.1; walls square; exit tear-out ≤0.3 mm deep | calipers, eye |
| Chamfer | legs 1.0 ±0.2 mm, even along the length | calipers |
| Tool change | both programs from the app, no hand command | transcript |
| Time | predicted within 10 % of the clock, per program | run record |
| Repeatability (sample 1) | origin spread over three re-seats recorded; depth criterion met each time | registration record |

## 4. Results

Filled at close-out (#942), one block per sample: date, pinned sha, job file, run record (predicted / actual), the
measured numbers against §3, the photo path, the transcript path, the feeds row and its `measured` commit.

| # | Date | sha | Result | Record |
|---|---|---|---|---|
| 1 | — | — | — | — |
| 2 | — | — | — | — |
| 3 | — | — | — | — |
| 4 | — | — | — | — |
| 5 | — | — | — | — |

Repeatability (#937): origin spread X / Y / Z over three re-seats — not yet measured.
