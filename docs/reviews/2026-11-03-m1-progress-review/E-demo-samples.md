# Review E — #944 demo-page gate, the five sample jobs, 14b68270, the k3 writes

Read-only review of origin/main 829708cc (2026-11-03). "Page" = the committed
docs/bench/2026-10-28-z1-real-jobs/page.html (fa75efe1; states sha 3c5a8184; built 2026-11-03 03:21 UTC).

## Severity-ranked findings

### HIGH

H1. The k3 V-bit feeds row was written AFTER the manager said item 4 "still needs the maintainer's numbers", and it is labelled `source: chosen`.
Timeline on #943 (UTC, gh api comments): 18:00:28 manager lists the shop data "for the maintainer/IT, not code";
18:23:32 manager item 4 ("Record the 0.1 mm tip … shop data, not code"); 18:31:01 E writes items 1 and 3 (tip ⌀ on
kz-chamfer-90, stock stock-m1-hardwood-stick); 18:31:57 manager: "IT declined app-data edits; E made items 1 and 3 …
Item 4 (V-bit hardwood feeds) still needs the maintainer's numbers"; 18:39:23 E writes five `angle` fields and a new
feed row feed-m1-hardwood-v-0.1 (12000 / F1000 / plunge 500 / step-down 1.0; step-over and peck taken from the seeded
values) and "refreshed the k3 location file the page reads". On disk the row is `"source": "chosen", "setAt":
"2026-11-03T18:37:04Z"` (/home/dave/casemaker-manager/demo-build/k3/location.json feeds[]) — the state the app reserves
for an operator's pick. Makera-library numbers were seeded into the LIVE house store (memory: no vendor rows; never seed
k3). Reversal is recorded (DELETE the row; PATCH angle null ×5) and was not run. Batch 1 (tip, stock entry) is
reversible, recorded with request/response and export sha256 before/after, and is shop fact the house lacked — defensible
once the manager relayed IT's refusal. Batch 2 is a decision made for the maintainer.

H2. The sample cards do not run on "owned cutters only": flat-1.0 is a registry BUILT-IN, absent from the k3
inventory, and s1, s2, s4-p2 and s5-p2 cut with it.
cards.py:111-114, README.md:39-41 and the page header ("sample cards on 'My shop' (29 owned cutters, the k3 export)")
claim the sample cards are judged as the bench will run them. The k3 export inventory is 29 `kz-*` ids, no flat-1.0
(demo-build/k3/location.json); flat-1.0 is the built-in (casemaker-app/src/engine/cnc/toolLibrary.ts:153,
toolRegistry.ts:10). Program headers in demo-build/runs/3c5a8184/{s2,s4,s5}/*.nc carry `;@CM|TOOL|key=flat-1.0` for
s2, s4 p2 (the initials, 6.8 mm deep) and s5 p2 ("rest of Pocket rect 36×6", 10.0 mm deep with a 1 mm flat). The
committed 936 program (docs/bench/Milestone-1-sample-1-flagship-text-on-the-stick.nc:9-10) is the same cutter,
flutelength=0. The manager saw this only at 18:31:57 ("the operator must OWN a ⌀1 mm flat"). Failure: S2 opens with a
program for a cutter the shop does not own; s5's 10 mm rest pass exceeds any 1 mm end mill's flute length, and the page
reads it as "Matches the design".

H3. The #938 ladder does not bracket the row: the seeded hardwood 0.8–1.6 row is F400, not F1000.
Both locations' feed-hardwood-flat-0.8-1.6 has params.feed 400.0; the committed 936 program runs 400 mm/min
(…-run-sheet.md:68). The coupon (d4a49b4a; 938-hardwood-feed.json values 400/700/1000/1200; note "its starting F1000 is
cut so the readback can adopt it"), the s2 title "F1000, the row's own value" (cards.py:118) and e567c974's message all
say F1000. The ladder has the row at its bottom and cannot tell whether 400 is already too fast.

H4. s4 and s5 as committed are not the samples docs/bench/milestone-1-clean-samples.md describes.
Line 38: "two initials V-carved 0.8 deep … flat then V/chamfer". 940-two-cutter.job.json has a plain label (no
vCarveDepth); on k3 at 3c5a8184 the programs are o-flute 3.175 (pocket) then flat-1.0 "Pocket outline 'rest of CM'
6.8mm" — flat-engraved, not V; the job's name still says "V-carved initials"; #940's routing comment admits the sample
"cannot be posted today", the card does not. Line 39: "Chamfer … then a 6 × 10 through-slot … chamfer then flat".
941-chamfer-slot.json posts slot → 1 mm-flat rest (10 mm deep) → chamfer LAST (runs/3c5a8184/s5/*-p3.nc): opposite
order and a third program. Line 35 says S1 uses "the recommended V/engraving cutter"; the job uses a 1 mm flat at the
seeded row. None of the five §2 rows describes the job committed for it.

### MEDIUM

M1. "Matches the design" on s5 and s2 rests on an unmeasured item, or a box.
design_check.py has no chamfer model (lines 428-437 only excuse a band around the bevel); s5's single measured item is the
slot. j16a — the same chamfer — sits in the "Not checkable" appendix (build.py:160-161), but s5 escapes it because the
slot is measurable, so Sample 5's headline feature is unjudged under a Matches pill. Labels are judged by a bounding BOX
(design_check.py:155-161, 340-356): reachRatio = deepest cell / depth, deep = cells below depth — no glyph geometry, so s2
(one label) and s1 (three) pass if one cell per box reaches the floor; wrong letters or fused counters would pass.
README.md:18-22 states the interim nature; the pill does not.

M2. s4 "Deviates — material left on 3.4 %" is a checker artefact: shape_mask draws every rect SQUARE
(design_check.py:133-134 ignores cornerRadius). The committed s4 overlay shows four red corner squares outside the r 3
arcs; s3's pocket-rect (r 2) shows the same (0.35 %, under TOL). C's fix is on 940-s4-corner-mask @ ccba36f7, unlanded.
The verdict E, the manager (#944 "routed to B") and B's column spent effort on was a bug in E's own tool. The overlay also
tints the initials blue ("cut below floor") because labels are not in floor_map (line 328).

M3. The committed page is three tool commits stale: fa75efe1 (03:21 UTC) predates a714e825 (coverage labels) and
bdc4fff6 (s1 card). The page has four sample cards, prints "Coverage 83.58 %" not "Top-surface / Whole-surface", and its
samples table says S1 is "the app's default job, run from the GUI" while cards.py:22 says "job file committed (card s1)".
manifest.json has no s1. The README says rebuild per T3, but main shows no s1 verdict anywhere but an issue comment.

M4. 3D cut-into mixes two thresholds and the rule text says "zero". build.py:173 takes cutInto0p1Pct (> 0.1 mm) as the
percentage but prints cutIntoAreaMm2 from goal_check.py:120, at CUT_INTO = 0.01 (line 22): "1.01 % · 11.5 mm² · max
12.795 mm". README.md:19 and the page's rule box say "zero cut-into"; the code passes at ≤ 0.1 mm. The panther's
"max 12.795 mm" is a vertical-silhouette artefact of cell-by-cell heightfield comparison (the deviation map shows red only
as a one-cell fringe along the outline).

M5. j28's holding is unphysical: jobs/j28-panther-stick.json workholding stockProud 47.9 on a 36 mm stock, no seat —
the stock sits 11.9 mm above the jaws; the receipt warns "Only -11.9 mm of the stock is gripped" (manifest j28
warnings) and goal_verdict ignores warnings. j29 is 29.9 proud. Neither is the stick's real holding (seat floor, proud 16)
every sample job uses; #943 line 1b is judged on a holding the bench will not use.

M6. E edited src/engine/cnc/feeds.ts (c5121928) — B's file, C's task (marching orders §1.1; wave 2/3 rows). #941's
thread said "both outside Session C's files; ask before touching" and gave the string to B. Content is a correct
provenance sentence; the edit is the cross-column hunk the rule bans, in the file #922 was reworking. The footer names a
different session id and "Claude Sonnet 5".

M7. NC-ND inputs remain full cards: j19 (cards.py:81-83) and j23 (cards.py:93-95, 1,858 traced points from the
NC-ND PNG, committed in 5ac51410) are gate cards; j06 (also NC-ND) was retired. README.md:143 still says j20/j21/j23
"are not committed: their sources' licence is unstated or forbids modified copies"; 5ac51410 committed all three
(j21 = 95 k lines of CutRocket-derived contours).

### LOW

L1. j01's reference program is drawn, not compared: build.py:350-371 sweeps TopClamp.nc and prints referenceRemovedMm3
(4970.2 mm³); the verdict is the design check of E's job. Reference-vs-job is left to the eye.
L2. One command is real (build.sh:6-12 → build.py --sha; build.py:498-508 allows --sha ≠ HEAD only if the app dirs are
identical), but: the receipt cache is keyed by sha only (build.py:258) so a rebuild on the same sha after the k3 location
changed (11-03) reuses stale receipts; it needs ~/casemaker-manager/venv, ~/projects/cm-wt/944-demo-page, two location
files and the catalogue at $HOME defaults (README.md:36-38) plus a network fetch (build.py:358); demo and k3 locations
share one id (loc-18df72f2aaf89730).
L3. Mesh injection (8f142dcc) is right: materialise_job (build.py:78-95) writes into the run dir, refuses on sha256
mismatch; j28/j29 are 1,075/1,022 bytes with data absent at 5ac51410 and main.
L4. The 3D "reference" is the app's own sampler (goal-hf.mts:11 → src/engine/cnc/cam/surface3d.ts). The NC sweep
(render.py) stays independent; the cutter record comes from the program's ;@CM|TOOL|key header; "whole-surface" is
regex-parsed from the app's warning (build.py:323).
L5. Card time is program 1 only on multi-program cards (later programs have no sheet.estimatedTime; s4 shows 12 min
while its p2 on the later build is 1 h 53 min).
L6. Run sheets contradict themselves on facing (F1000 and 936 sheets line 60 "face the top and re-touch Z0" vs line 64
"No facing pass") — C's sheet, shipped on E's files.
L7. k3-smoke.mjs (44a0eb2a, F's) is read-only in intent (wizard "Zoomba" → Cut step 2, no registration control
pressed); whether the house persists the wizard's job is one question before it runs against live k3.

## Answers

1. Committed page (sha 3c5a8184; demo loc-18df72f2aaf89730 134 cutters; k3 "My shop" 29; catalogue 129/1,328 synced
2026-10-18): 21 Matches, 6 Deviates (j07 j10 j27 j28 j29 s4), 1 Refused (j18), 2 Not checkable (j16a j16b, appendix).
j01 reference+design; j07/j27/j28/j29 goal; the rest design. No photo verdicts; proxies gone (64e0a030). NC-ND still
full cards: j19, j23 (M7). Sha + both locations stated. One command: yes with L2 caveats. Meshes: L3.
2. 2.5D = design_check.py's own PIL raster masks + per-cell floor map against render.py's own sweep; Matches = verifier 0
errors (receipt) AND every item left ≤ 2 %, deep ≤ 2 % (labels: box reach ≥ 0.99) AND no cell > 0.15 mm outside the
design band; not the receipt's oracle. 3D = goal_check.py stamping the NC on the app's heightfield; Matches = cut-into
(> 0.1 mm) 0 % and top-surface coverage ≥ 95 %; whole-surface from the app's warning (a714e825). The sweep reads app
outputs only for the tool key and verifier count.
3. s1 absent (M3); s2 Matches (one label box); s3 Matches (6 items; square-corner artefact 0.35 %); s4 Deviates 3.4 % =
square mask on r 3 (M2); s5 Matches on the slot alone (M1). Manifest matches; holder-unproven warnings on s2/s4/s5.
4. All five: 36 × 100 × 36 hardwood, vise seat floor proud 16, along the jaws, facing off (c502c219), built by
scripts/bench-files.ts and posted by the app (;@MKR/;@CM headers). 936 matches D's recipe. 939 matches (bores mode
'bore'; cutter pinned kz-corn-3-0-12 at the SEEDED row, not "the measured row"). 938 cells sensible, row is F400 (H3).
940 not V-carved, M6 is a no-op T1→T1 (H4). 941 order reversed, extra 10 mm 1 mm-flat rest pass, edgeMargin/jawClearance
0 recorded (H2/H4). No depth exceeds its issue.
5. 14b68270: six lines present (§1 with 1b); §3 carries §4.4 verbatim (eleven rows, same numbers/instruments);
unchanged on main. §2's cutter column is what the committed jobs now contradict (H4).
6. See H1. Batch 1 reversible, recorded, shop fact; batch 2 a vendor feeds row under `chosen` written after the manager
said the numbers were the maintainer's; not reversed. The page's s4 verdict now depends on these writes.
7. E's own column throughout except c5121928 (feeds.ts, M6). All committed .nc/.job.json files came from the pipeline
(bench-files.ts → casemaker cut / engrave-job.ts --coupon), none hand-written.
