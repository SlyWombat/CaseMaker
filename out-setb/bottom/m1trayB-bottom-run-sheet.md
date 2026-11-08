# Run sheet — m1trayB-bottom

Generated 2026-11-08 · file `m1trayB-bottom.nc` · sha256 `ec11b300` · estimated cutting time 2 h 8 min (cutting + rapids through the trapezoid, timed on a rapid model of 1200 mm/min XY / 600 mm/min Z at 150 mm/s² (config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time.)

## 1 · What you need

1. The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job and regenerate — do not run this file. — **106 × 136 × 25 mm hardwood**
2. The cutter — ⌀ 3.175 mm flat end · 25 mm flute — the cutter the posted programs run. — **⌀ 3.175 mm cutting**
3. Record the cutter's flute length and its stick-out from the collet. — \_\_\_\_\_\_\_\_  *(flute length (mm) / stick-out (mm))*
4. the wired probe that ships with the machine — a mechanical touch tip, so it triggers on PLA (measured 2026-10-08, 0.001 mm). The 3D Probe stays in reserve.
5. Sacrificial material: — **a 6 mm board under the part, flush with the part, fixed with tape**

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-71.25 -157.77 132.62 224.63" class="cutter-profile-svg cutter-profile--print" role="img" aria-label="Spiral &apos;O&apos; Single Flute Bit - 1/8&quot; Shank 3.175mm * 42mm — flat end mill profile" style="color:#111111;--cutter-missing:#8a1c1c;--cutter-muted:#555555"><title>Spiral &apos;O&apos; Single Flute Bit - 1/8&quot; Shank 3.175mm * 42mm — flat end mill profile</title><desc>Side profile of Spiral &apos;O&apos; Single Flute Bit - 1/8&quot; Shank 3.175mm * 42mm, drawn from its Tool record: a flat end mill. Stated: DS 3.175 (shank diameter), DC 3.175 (cutting diameter), LC 42.0 (flute length). Not stated, drawn dashed: LS shoulder length.</desc><path d="M0,0 L7,0 L7,-118.85 L7,-126.04 L7,-126.04 L7,-148.5 L-7,-148.5 L-7,-148.5 L-7,-126.04 L-7,-126.04 L-7,-118.85 L-7,0 L0,0 Z" fill="#f4f4f4" stroke="none" fill-opacity="1" /><path d="M0,0 L7,0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M0,0 L-7,0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M7,0 L7,-118.85" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,0 L-7,-118.85" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M7,-118.85 L7,-126.04" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-118.85 L-7,-126.04" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M7,-126.04 L7,-126.04" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-126.04 L-7,-126.04" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M7,-126.04 L7,-148.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-126.04 L-7,-148.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-148.5 L-3.5,-143.5 L0,-148.5 L3.5,-143.5 L7,-148.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" /><path d="M0,5.66 L0,-148.5" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-dasharray="4 3" opacity="0.45" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,0 L7,0" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-dasharray="4 3" opacity="0.45" stroke-linecap="round" stroke-linejoin="round" /><g class="cutter-profile__dimension" data-dimension="DS" data-field="handleDiameter"><path d="M-7,-137.27 L7,-137.27" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-137.27 L-3,-135.47 L-3,-139.07 Z" fill="currentColor" stroke="none" /><path d="M7,-137.27 L3,-139.07 L3,-135.47 Z" fill="currentColor" stroke="none" /><path d="M-7,-126.04 L-7,-137.27" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M7,-126.04 L7,-137.27" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><rect x="-21.72" y="-149.77" width="43.44" height="10.5" fill="#f4f4f4" /><text x="0" y="-141.27" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111">DS 3.175</text></g><g class="cutter-profile__dimension" data-dimension="DC" data-field="tipDiameter"><path d="M-7,-53.48 L7,-53.48" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,-53.48 L-3,-51.68 L-3,-55.28 Z" fill="currentColor" stroke="none" /><path d="M7,-53.48 L3,-55.28 L3,-51.68 Z" fill="currentColor" stroke="none" /><rect x="-21.72" y="-65.98" width="43.44" height="10.5" fill="#f4f4f4" /><text x="0" y="-57.48" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111">DC 3.175</text></g><g class="cutter-profile__dimension is-missing" data-dimension="LS" data-field="shoulderLength"><path d="M-21,-126.04 L-21,0" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.7" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-21,-126.04 L-22.8,-122.04 L-19.2,-122.04 Z" fill="currentColor" stroke="none" /><path d="M-21,0 L-19.2,-4 L-22.8,-4 Z" fill="currentColor" stroke="none" /><path d="M-7,-126.04 L-21,-126.04" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.6" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,0 L-21,0" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.6" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><text x="-26" y="-60.02" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="600" fill="var(--cutter-missing, #8a1c1c)" transform="rotate(-90 -26 -60.02)">LS ?</text></g><g class="cutter-profile__dimension" data-dimension="LC" data-field="fluteLength"><path d="M-41,-118.85 L-41,0" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-41,-118.85 L-42.8,-114.85 L-39.2,-114.85 Z" fill="currentColor" stroke="none" /><path d="M-41,0 L-39.2,-4 L-42.8,-4 Z" fill="currentColor" stroke="none" /><path d="M-7,-118.85 L-41,-118.85" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M-7,0 L-41,0" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><text x="-46" y="-56.43" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111" transform="rotate(-90 -46 -56.43)">LC 42.0</text></g><g class="cutter-profile__scale"><path d="M-22.05,27.66 L22.05,27.66" fill="none" stroke="#111111" stroke-width="1" /><path d="M-22.05,23.66 L-22.05,31.66" fill="none" stroke="#111111" stroke-width="1" /><path d="M22.05,23.66 L22.05,31.66" fill="none" stroke="#111111" stroke-width="1" /><text x="0" y="40.66" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8" font-weight="400" fill="#111111">scale 10 mm</text><text x="0" y="55.66" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8" font-weight="400" fill="#111111">length compressed 1.56×</text></g></svg>

*DS shank diameter · DC cutting diameter · LC flute length · LS shoulder length*

## 2 · What the plan states

1. The part's outline is the stock's — no freeing contour
2. The curved pipeline follows the ruling: the flat Z-steps each remainder region to its CL less 0.3 mm, the ball runs ONE final level, the pencil follows the creases, and no rest flat was offered
3. Pencil: 1 region emitted no moves — nothing for it to cut; the deepest ground among them is 9.6 mm below the part top

## 3 · Fit the bracket

1. Home the machine, remove any tool, then switch the machine off at its switch.
2. The bracket is pinned at anchor 1 through the wasteboard with its two 4 mm dowels and screwed down; the wasteboard stays.
3. Switch the machine on.

## 4 · Load the blank

1. Fix the part to the board before loading — the board goes in with it. — **6 mm board, fixed with tape**
2. The face to be cut is up. — **106 mm**
3. Push the blank's front-left corner into the bracket's inside corner at anchor 1 — the datum is measured from the anchor, so the corner must seat fully.
4. There are no clamps in this job: lay double-sided tape over most of the part's top face (it lies face down), press it onto the board and push the part into the bracket’s anchored corner, as Makera does.
5. Check the part does not rock and its corner stays seated.

## 5 · Fit the cutter and measure its length

1. Fit the cutter with its collar. Run tool-length calibration from the app’s console or Studio (M491). — \_\_\_\_\_\_\_\_  *(the cutter's PRB (mm))*
2. Do not skip this because the program contains T1 M6. If the machine already believes tool 1 is fitted, that line does nothing.

## 6 · Set the work origin

1. THE FIRST TOUCH OF THE DAY: the bracket seat has not been measured on this machine. The program’s first touch is one bounded Z seek with the wired probe on the wasteboard beside the bracket’s front arm — the surface the blank stands on — at work X 90.7 Y -7.5 (machine X -100.19 Y -201.33). — **machine X -100.19 · Y -201.33**
2. The seat is expected at machine Z -87.25 to -84.25. The seek starts at machine Z -81.25 (above the band) and goes no further than -92.25; a reading outside the band stops the run. the seat is expected at machine Z -85.75 ± 1.5 — derived from the 2026-11-07 touch (wired-V2 blank top −60.75, TLO −14.068, less the 25 mm blank), verified by the seek
3. Look at the spot first: bare wasteboard, no screw head or countersink (the board’s screws sit 1 mm below its surface; a touch on one stores a seat 1 mm low).
4. The reading is written as the bed profile’s bracket seat, and it is valid only for the probe fitting it was measured with: the press measures every session, and the stored value is only the next session’s expected band.
5. Z0: the PART's top face — probe it, or touch off on it. NOT the board's top face. Record the reading AND the tool that made it: on a job cut by two cutters the second program’s Z0 is worked out from this surface and the PRB of whichever tool took this touch, so both go on this one blank — the first cutter’s own PRB is a separate reading, taken where it is fitted. — \_\_\_\_\_\_\_\_  *(surface Z (mm) and the PRB of the tool that set Z0 (mm))*
6. After the seat is stored, press Plan registration again: the cut region’s footprint touches are planned against the reading.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -144 122 152" class="run-sheet-svg" role="img" aria-label="Top view of the stock and the work origin"><defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs><rect data-stock="true" class="run-sheet-stock" x="0" y="-136" width="106" height="136" /><text class="run-sheet-label" x="53" y="-138" text-anchor="middle">106 × 136 mm stock</text><circle class="run-sheet-origin" cx="0" cy="0" r="1.2" /><text class="run-sheet-origin-label" x="1.6" y="3.2">X0 Y0 (front-left, top face)</text><line class="run-sheet-axis" x1="0" y1="0" x2="14" y2="0" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="15" y="1.2">X</text><line class="run-sheet-axis" x1="0" y1="0" x2="0" y2="-14" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="-1" y="-15">Y</text></svg>

## 7 · Dry run

1. A 3D surface program carries no air-trace frame; its check is the material sweep. Look at the work origin and the clamps before you load m1trayB-bottom.nc. — **no frame by design**

## 8 · Cut

1. Cutting parameters were not resolved for this job.
2. Program 1, m1trayB-bottom.nc — the cycle is 2 h 8 min: 1 % of it in air, no hops, and the feed running at 96 % of the rate it commands. The air path is 520.926 mm against a 0.697 mm lower bound for visiting its loop entries — 74640 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **1 % in air · 0 hops · feed at 96 %**
3. The feed path sweeps 388102.104 mm² of stock at up to 9.615 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 97524.204 mm³. — **388102.104 mm² swept · 97524.204 mm³ removed**
4. Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.

## 9 · Cut, program 2 — ⌀ 0.9 mm flat end

1. Program 2 is m1trayB-bottom-p2.nc, the cut for setup 1 — cut with ⌀ 0.9 mm flat end. — **1 operation · about 1 min 38 s**
2. Program 2’s the cycle is 1 min 38 s: 46 % of it in air, no hops, and the feed running at 92 % of the rate it commands. The air path is 568.078 mm against a 285.845 mm lower bound for visiting its loop entries — 99 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **46 % in air · 0 hops · feed at 92 %**
3. The feed path sweeps 26.22 mm² of stock at up to 9.615 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 19.507 mm³. — **26.22 mm² swept · 19.507 mm³ removed**
4. **There is no frame file for program 2: the goal (model) path writes no air-trace frame. m1trayB-bottom-p2.nc itself passed verification, so it can still be cut — look at the origin and the clamps before you start.**
5. Load m1trayB-bottom-p2.nc and run it — 1 operation, 159 cutting moves. — **about 1 min 38 s**

## 10 · Cut, program 3 — ⌀ 3.175 mm flat end · 12 mm flute

1. Program 3 is m1trayB-bottom-p3.nc, the cut for setup 1 — cut with ⌀ 3.175 mm flat end · 12 mm flute. — **1 operation · about 13 min 46 s**
2. Program 3’s the cycle is 13 min 46 s: 22 % of it in air, 27 hops taking 16 s, and the feed running at 83 % of the rate it commands. The air path is 2419.435 mm against a 344.808 mm lower bound for visiting its loop entries — 602 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **22 % in air · 27 hops · feed at 83 %**
3. The feed path sweeps 26311.058 mm² of stock at up to 7 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 15537.857 mm³. — **26311.058 mm² swept · 15537.857 mm³ removed**
4. **There is no frame file for program 3: the goal (model) path writes no air-trace frame. m1trayB-bottom-p3.nc itself passed verification, so it can still be cut — look at the origin and the clamps before you start.**
5. Load m1trayB-bottom-p3.nc and run it — 1 operation, 4589 cutting moves. — **about 13 min 46 s**

## 11 · Cut, program 4 — ⌀ 2 mm ball · 15 mm flute

1. Program 4 is m1trayB-bottom-p4.nc, the cut for setup 1 — cut with ⌀ 2 mm ball · 15 mm flute. — **1 operation · about 1 h 50 min**
2. Program 4’s the cycle is 1 h 50 min: 0 % of it in air, no hops, and the feed running at 98 % of the rate it commands. The air path is 75.151 mm against a 178.155 mm lower bound for visiting its loop entries — 0 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **0 % in air · 0 hops · feed at 98 %**
3. The feed path sweeps 67755.095 mm² of stock at up to 9.614 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 30013.14 mm³. — **67755.095 mm² swept · 30013.14 mm³ removed**
4. **There is no frame file for program 4: the goal (model) path writes no air-trace frame. m1trayB-bottom-p4.nc itself passed verification, so it can still be cut — look at the origin and the clamps before you start.**
5. Load m1trayB-bottom-p4.nc and run it — 1 operation, 313384 cutting moves. — **about 1 h 50 min**

## 12 · Cut, program 5 — ⌀ 3.175 mm ball · 22 mm flute

1. Program 5 is m1trayB-bottom-p5.nc, the cut for setup 1 — cut with ⌀ 3.175 mm ball · 22 mm flute. — **1 operation · about 56 min 40 s**
2. Program 5’s the cycle is 56 min 40 s: 0 % of it in air, no hops, and the feed running at 96 % of the rate it commands. The air path is 171.488 mm against a 290.541 mm lower bound for visiting its loop entries — 0 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **0 % in air · 0 hops · feed at 96 %**
3. The feed path sweeps 68323.444 mm² of stock at up to 9.613 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 32528.283 mm³. — **68323.444 mm² swept · 32528.283 mm³ removed**
4. **There is no frame file for program 5: the goal (model) path writes no air-trace frame. m1trayB-bottom-p5.nc itself passed verification, so it can still be cut — look at the origin and the clamps before you start.**
5. Load m1trayB-bottom-p5.nc and run it — 1 operation, 171755 cutting moves. — **about 56 min 40 s**

## 13 · Warnings carried from the app

1. The top setup reproduces 52 % of the goal's surface. 48 % of the goal faces away from this setup and is left as stock — 30 % of its surface is downward faces and undercuts, and 18 % lies in an overhang's shadow, so it is not cut from this side.
2. Sacrificial dimensions: shipped defaults. Check the cut depth onto them before cutting.
3. the bracket fixture envelope is not one of this plan's own region obstacles — the posted program is checked against it by the verifier and the sweep
4. program 2 (⌀ 0.9 mm flat end): the deepest cut is 9.615 mm below the stock top and tool "Haocher corn (PCB router) bit ⌀0.9" states no shoulder or flute length: holder clearance cannot be proven
5. Checked: all 5 programs in the run — program 1 (⌀ 3.175 mm flat end · 25 mm flute), program 2 (⌀ 0.9 mm flat end), program 3 (⌀ 3.175 mm flat end · 12 mm flute), program 4 (⌀ 2 mm ball · 15 mm flute) and program 5 (⌀ 3.175 mm ball · 22 mm flute) — in cut order, each on the stock the earlier programs left, against the stock, the sacrificial material and the modelled fixture (the bracket’s front arm, the bracket’s left arm).
6. The material was swept by the sampled column engine for program 4 (⌀ 2 mm ball · 15 mm flute) and program 5 (⌀ 3.175 mm ball · 22 mm flute), not the exact 2.5D boolean, so those programs' removed volumes and gouge depths carry a grid resolution.
7. Swept from the blank: program 4 (⌀ 2 mm ball · 15 mm flute) and program 5 (⌀ 3.175 mm ball · 22 mm flute) — their engines cannot start from the material the earlier programs left, so each result covers its own cuts only.
8. Not checked: the spindle body, head and gantry; anything on the bed other than the declared stock, workholding and sacrificial material; the shank of the cutter in program 2 (⌀ 0.9 mm flat end), which states no shoulder or flute length.
9. The modelled fixture is a shipped default.
10. Program 2 (⌀ 0.9 mm flat end) spends 46 % of its cycle in air — over the 35 % the shop warns at (efficiency.maxAirFraction in location.json). Operation 1 ([T1] Pocket "pocket-0") is the airiest at 52 %. Shorten the hops, or order the neighbouring cuts so the tool enters next to where it stopped.

## 14 · Record afterwards

1. Wall-clock minutes the run took (start to finish) — the cycle estimate is 2 h 8 min. — \_\_\_\_\_\_\_\_  *(minutes)*
2. Is the text legible? — \_\_\_\_\_\_\_\_  *(yes / no)*
3. Surface finish — \_\_\_\_\_\_\_\_  *(clean / fuzzy / burnt)*
4. Anything that went wrong — \_\_\_\_\_\_\_\_  *(notes)*

---

*Generated from `m1trayB-bottom.cutjob.json` by `casemaker engrave`; the app’s `RunSheetView` renders the same `buildRunSheet` structure. No result is recorded here.*
