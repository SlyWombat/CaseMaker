# Run sheet — 938 hardwood flat-cutter feed coupon F1000

Generated 2026-11-03 · file `938-hardwood-flat-cutter-feed-coupon-F1000.nc` · sha256 `31b0b23d` · estimated cutting time 1 min 44 s (cutting + rapids through the trapezoid, timed on a rapid model of 1200 mm/min XY / 600 mm/min Z at 150 mm/s² (config read 2026-10-07 + stopwatch 2026-10-08) — a planning estimate, not a measured cycle time.)

## 1 · What you need

1. The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job and regenerate — do not run this file. — **36 × 100 × 36 mm hardwood**
2. The cutter — ⌀ 1 mm flat end · 7 mm flute. — **⌀ 1 mm cutting**
3. Record the cutter's flute length and its stick-out from the collet. — \_\_\_\_\_\_\_\_  *(flute length (mm) / stick-out (mm))*
4. The Z1 low-profile vise, and the wired probe that ships with the machine — a mechanical touch tip, so it triggers on PLA (measured 2026-10-08, 0.001 mm). The 3D Probe stays in reserve.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-75.31 -156.5 108.6 219.93" class="cutter-profile-svg cutter-profile--print" role="img" aria-label="TiN Coating Corn Bit - 1/8&quot; Shank 1mm * 7mm — flat end mill profile" style="color:#111111;--cutter-missing:#8a1c1c;--cutter-muted:#555555"><title>TiN Coating Corn Bit - 1/8&quot; Shank 1mm * 7mm — flat end mill profile</title><desc>Side profile of TiN Coating Corn Bit - 1/8&quot; Shank 1mm * 7mm, drawn from its Tool record: a flat end mill. Stated: DS 3.175 (shank diameter), DC 1.0 (cutting diameter), LC 7.0 (flute length). Not stated, drawn dashed: LS shoulder length.</desc><path d="M0,0 L4.26,0 L4.26,-59.61 L4.26,-80.9 L13.52,-80.9 L13.52,-148.5 L-13.52,-148.5 L-13.52,-148.5 L-13.52,-80.9 L-4.26,-80.9 L-4.26,-59.61 L-4.26,0 L0,0 Z" fill="#f4f4f4" stroke="none" fill-opacity="1" /><path d="M0,0 L4.26,0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M0,0 L-4.26,0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M4.26,0 L4.26,-59.61" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,0 L-4.26,-59.61" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M4.26,-59.61 L4.26,-80.9" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,-59.61 L-4.26,-80.9" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M4.26,-80.9 L13.52,-80.9" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,-80.9 L-13.52,-80.9" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="1.4" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M13.52,-80.9 L13.52,-148.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-13.52,-80.9 L-13.52,-148.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /><path d="M-13.52,-148.5 L-6.76,-143.5 L0,-148.5 L6.76,-143.5 L13.52,-148.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" /><path d="M0,17.03 L0,-148.5" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-dasharray="4 3" opacity="0.45" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,0 L4.26,0" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-dasharray="4 3" opacity="0.45" stroke-linecap="round" stroke-linejoin="round" /><g class="cutter-profile__dimension" data-dimension="DS" data-field="handleDiameter"><path d="M-13.52,-114.7 L13.52,-114.7" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-13.52,-114.7 L-9.52,-112.9 L-9.52,-116.5 Z" fill="currentColor" stroke="none" /><path d="M13.52,-114.7 L9.52,-116.5 L9.52,-112.9 Z" fill="currentColor" stroke="none" /><path d="M-13.52,-80.9 L-13.52,-114.7" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M13.52,-80.9 L13.52,-114.7" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><rect x="-21.72" y="-127.2" width="43.44" height="10.5" fill="#f4f4f4" /><text x="0" y="-118.7" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111">DS 3.175</text></g><g class="cutter-profile__dimension" data-dimension="DC" data-field="tipDiameter"><path d="M-4.26,-26.83 L4.26,-26.83" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,-26.83 L-0.26,-25.03 L-0.26,-28.63 Z" fill="currentColor" stroke="none" /><path d="M4.26,-26.83 L0.26,-28.63 L0.26,-25.03 Z" fill="currentColor" stroke="none" /><rect x="-16.79" y="-39.33" width="33.58" height="10.5" fill="#f4f4f4" /><text x="0" y="-30.83" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111">DC 1.0</text></g><g class="cutter-profile__dimension is-missing" data-dimension="LS" data-field="shoulderLength"><path d="M-27.52,-80.9 L-27.52,0" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.7" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-27.52,-80.9 L-29.32,-76.9 L-25.72,-76.9 Z" fill="currentColor" stroke="none" /><path d="M-27.52,0 L-25.72,-4 L-29.32,-4 Z" fill="currentColor" stroke="none" /><path d="M-13.52,-80.9 L-27.52,-80.9" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.6" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,0 L-27.52,0" fill="none" stroke="var(--cutter-missing, #8a1c1c)" stroke-width="0.6" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" /><text x="-32.52" y="-37.45" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="600" fill="var(--cutter-missing, #8a1c1c)" transform="rotate(-90 -32.52 -37.45)">LS ?</text></g><g class="cutter-profile__dimension" data-dimension="LC" data-field="fluteLength"><path d="M-47.52,-59.61 L-47.52,0" fill="none" stroke="currentColor" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M-47.52,-59.61 L-49.32,-55.61 L-45.72,-55.61 Z" fill="currentColor" stroke="none" /><path d="M-47.52,0 L-45.72,-4 L-49.32,-4 Z" fill="currentColor" stroke="none" /><path d="M-4.26,-59.61 L-47.52,-59.61" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M-4.26,0 L-47.52,0" fill="none" stroke="var(--cutter-muted, currentColor)" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" /><text x="-52.52" y="-26.81" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8.5" font-weight="400" fill="#111111" transform="rotate(-90 -52.52 -26.81)">LC 7.0</text></g><g class="cutter-profile__scale"><path d="M-21.29,39.03 L21.29,39.03" fill="none" stroke="#111111" stroke-width="1" /><path d="M-21.29,35.03 L-21.29,43.03" fill="none" stroke="#111111" stroke-width="1" /><path d="M21.29,35.03 L21.29,43.03" fill="none" stroke="#111111" stroke-width="1" /><text x="0" y="52.03" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="8" font-weight="400" fill="#111111">scale 5 mm</text></g></svg>

*DS shank diameter · DC cutting diameter · LC flute length · LS shoulder length*

## 2 · Mount the vise

1. Home the machine, remove any tool, then switch the machine off at its switch.
2. Remove the MDF wasteboard. Insert the two 4 × 11 mm locating pins.
3. With the left fixed jaw off, seat the vise on the pins; fasten it with six M5 × 20 screws.
4. Refit the left fixed jaw with its locating key seated. Switch the machine on.

## 3 · Load the blank

1. The blank's length runs left–right between the jaws. The face to be cut is up. — **36 mm**
2. The top face stands 16 mm above the jaw tops. Every cut keeps at least 1 mm clear of the jaws. Record the measured value. No cut on this job sweeps over a jaw, so there is no stop threshold to check. — \_\_\_\_\_\_\_\_  *(measured stock proud (mm))*
3. Push the blank's front edge to where the file expects it: the front edge is 10 mm behind the front of the jaws.
4. Tighten. Check the blank does not rock.

## 4 · Fit the cutter and measure its length

1. Fit the cutter with its collar. Run tool-length calibration from the app’s console or Studio (M491). — \_\_\_\_\_\_\_\_  *(the cutter's PRB (mm))*
2. Do not skip this because the program contains T1 M6. If the machine already believes tool 1 is fitted, that line does nothing.

## 5 · Set the work origin

1. The vise already references X and rotation to within ±0.05 mm, before any touch.
2. Touch 1 of 3: the right edge — the one against the moving jaw, about 25 mm along it from the front end — this gives position and rotation.
3. Touch 2 of 3: the right edge — the one against the moving jaw, about 75 mm along it from the front end — this gives rotation.
4. Touch 3 of 3: the front edge — the one nearest you, at about its middle, 18 mm from the left end — this gives Y.
5. Z0: the blank's top face — probe it, or touch off on it. Record the reading AND the tool that made it: on a job cut by two cutters the second program’s Z0 is worked out from this surface and the PRB of whichever tool took this touch, so both go on this one blank — the first cutter’s own PRB is a separate reading, taken where it is fitted. — \_\_\_\_\_\_\_\_  *(surface Z (mm) and the PRB of the tool that set Z0 (mm))*
6. X0 Y0 Z0 is the top-front-left corner of the blank. That leaves the work origin within ±0.02 mm in X and Y and ±0.022° in rotation. Move there and check by eye before going on. How well YOU set it is not modelled: the file places the blank at this corner and judges the jaws against it, so an origin that is out by a little — or a blank sitting differently from what was measured — shifts the whole job relative to both without the app knowing. The only X/Y slack for that is this job's edge margin, 1 mm, which is the gap the content keeps from a stock edge rather than a locating tolerance: a cut standing at that margin has used all of it.
7. Rotation is measured, and a static .nc cannot compensate it (Smoothieware has no variables): apply it in Studio's dialogs, or re-post with the rotation baked into the geometry
8. Z is always probed on the face to be cut: no fixture can supply it
9. The blank's top is measured at 5 points across the cut — its centre, then both extents on each axis — because a printed blank’s colour line is a plane and its dome is extra material above it: one touch at the centre cannot tell you the floor at the ends of a line. Take them in the order below and write each reading down. — \_\_\_\_\_\_\_\_  *(surface Z at each point (mm), and how each was taken (probe / touch-off))*
10. Surface touch 1 of 5: the cut area's centre, X 18 Y 68 — take the top there and record the reading.
11. Surface touch 2 of 5: the cut area's left extent, X 1.826 Y 68 — take the top there and record the reading.
12. Surface touch 3 of 5: the cut area's right extent, X 34.174 Y 68 — take the top there and record the reading.
13. Surface touch 4 of 5: the cut area's front extent, X 18 Y 63.378 — take the top there and record the reading.
14. Surface touch 5 of 5: the cut area's back extent, X 18 Y 72.622 — take the top there and record the reading.
15. This blank states no colour split, so only the ceiling limits the floors: they must stay at most 35 mm below the top (the blank's underside, including its 1 mm margin). A surface spread wider than that band cannot keep every floor past the colour line and clear of the pocket at the same time. — **band 35 mm**
16. Set Z0 from the LOWEST of these 5 readings, not from the registration touch above and not from the centre alone. Every programmed floor depth is measured from Z0, so at a higher touch the local floor is deeper by exactly its height above Z0: with Z0 at the lowest reading, the programmed depth is the SHALLOWEST floor and the programmed depth plus the spread is the deepest. — **Z0 = the lowest surface touch** — \_\_\_\_\_\_\_\_  *(the touch Z0 was set from, and the readings it came from)*
17. **If the touches miss a fitted plane by more than 35 mm, do not cut. The app fits a plane to the readings and follows it when the leftover — the bow the tilt cannot explain — fits the band; it refuses that blank as: “this blank's top is not one plane: the touches miss the fitted plane by <residual> mm, wider than the band”.**

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-18 -108 72 126" class="run-sheet-svg" role="img" aria-label="Top view of the stock, the vise jaws and the work origin"><defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs><rect data-stock="true" class="run-sheet-stock" x="0" y="-100" width="36" height="100" /><text class="run-sheet-label" x="18" y="-102" text-anchor="middle">36 × 100 mm stock</text><rect data-jaw-id="vise-fixed-jaw" class="run-sheet-jaw" x="-10" y="-90" width="10" height="100" /><text class="run-sheet-label" x="-5" y="-40" text-anchor="middle">Fixed jaw (left)</text><rect data-jaw-id="vise-moving-jaw" class="run-sheet-jaw" x="36" y="-90" width="10" height="100" /><text class="run-sheet-label" x="41" y="-40" text-anchor="middle">Moving jaw (right)</text><circle class="run-sheet-origin" cx="0" cy="0" r="1.2" /><text class="run-sheet-origin-label" x="1.6" y="3.2">X0 Y0 (front-left, top face)</text><line class="run-sheet-axis" x1="0" y1="0" x2="14" y2="0" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="15" y="1.2">X</text><line class="run-sheet-axis" x1="0" y1="0" x2="0" y2="-14" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="-1" y="-15">Y</text><rect data-item-id="938-hardwood-feed-lbl-0" class="run-sheet-item" x="1.8257142857142838" y="-72.62214285714286" width="32.34857142857143" height="9.244285714285716"><title>Engrave &quot;F1000&quot;</title></rect><text class="run-sheet-item-depth" x="18" y="-68" text-anchor="middle" dominant-baseline="central">1 mm</text></svg>

## 6 · Dry run

1. Load 938-hardwood-flat-cutter-feed-coupon-F1000-frame.nc and run it. The cutter traces the job's outline in the air, 20 mm above the work — no Z offset to set. Watch that the trace stays over the blank and clear of the jaws. — **20 mm above the work**
2. If the trace is not where the job should land, stop and change the job. Otherwise face the top and re-touch Z0 first (the next section), then load 938-hardwood-flat-cutter-feed-coupon-F1000.nc and cut.

## 7 · Face the stock top

1. No facing pass — this job turns it off. By default the stock whose finish is not recorded is faced first: the finish is not known, so it is faced first. — **facing off**

## 8 · Cut

1. Spindle, feed, plunge, passes and step-down. Vacuum on. — **12000 RPM · 1000 mm/min feed · 150 mm/min plunge · 4 depth passes — 1 × 1 mm, 3 × 0.3 mm · 0.45 mm step-over**
2. Program 1, 938-hardwood-flat-cutter-feed-coupon-F1000.nc — the cycle is 1 min 44 s: 15 % of it in air, 17 hops taking 5 s, and the feed running at 86 % of the rate it commands. The air path is 84.052 mm against a 56.893 mm lower bound for visiting its loop entries — 48 % past it. Those are the cycle estimate's own trapezoids on the job machine's rapid model — the same clock the file is posted with. — **15 % in air · 17 hops · feed at 86 %**
3. The feed path sweeps 694.798 mm² of stock at up to 1 mm deep — the strip is Σ (path length × the cutter's width at that depth) on the feed moves; the sweep removed 153.006 mm³. — **694.798 mm² swept · 153.006 mm³ removed**
4. the toolpath is ordered by proximity: the cutter finishes each contour to its depth before entering the next, takes each entry at the point nearest where it just was, and cuts the pocket rings inside-out so the wall is the last thing it touches. The file spends 84.052 mm in the air against 694.798 mm cutting (0.121 : 1). The previous ordering spent 302.403 mm (0.435 : 1) on the same cut. — **84.052 mm rapid · 694.798 mm cut**
5. Finish allowance: the roughing pass leaves 0.2 mm of stock on the walls and the floor (the seed this shop was started with). This file follows it with the finishing pass, at full depth. — **0.2 mm stock to leave**
6. Engrave "F1000" — roughing pass: leaves 0.2 mm of stock on the walls and the floor. — **rough to 0.8 mm deep · 0.2 mm stock left**
7. Engrave "F1000" — finishing pass: full depth along the walls and the floor, 0.2 mm below the roughing cut. — **1 mm deep · full depth**
8. Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.

## 9 · Warnings carried from the app

1. Checked: the tool against the stock and the modelled fixture (Vise fixed jaw (left), Vise moving jaw (right)).
2. Not checked: the spindle body, head and gantry; anything on the bed other than the declared stock, workholding and sacrificial material.
3. The modelled fixture is a shipped default.

## 10 · Record afterwards

1. Measured floor depth — Engrave "F1000" — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
2. Wall-clock minutes the run took (start to finish) — the cycle estimate is 1 min 44 s. — \_\_\_\_\_\_\_\_  *(minutes)*
3. Is the text legible? — \_\_\_\_\_\_\_\_  *(yes / no)*
4. Surface finish — \_\_\_\_\_\_\_\_  *(clean / fuzzy / burnt)*
5. Anything that went wrong — \_\_\_\_\_\_\_\_  *(notes)*

---

*Coupon program `938-hardwood-feed-f1000` of `938 hardwood flat-cutter feed coupon` (#248): 938 hardwood flat-cutter feed coupon: F1000 at 1 mm deep. Generated by `scripts/engrave-job.ts`. Fill this program's verdict in the coupon record — then `scripts/feeds-readback.ts` flips the matching `feeds.ts` row to measured from it.*
