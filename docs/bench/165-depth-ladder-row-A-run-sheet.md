# Run sheet — 165 depth ladder row A

Generated 2026-10-12 · file `165-depth-ladder-row-A.nc` · sha256 `94d39f74` · estimated cutting time 1 min 8 s (cutting + rapids through the trapezoid, timed on a rapid model of 1200 mm/min XY / 600 mm/min Z at 150 mm/s² (config read 2026-10-07 + stopwatch 2026-10-08 (#281)) — a planning estimate, not a measured cycle time.)

## 1 · What you need

1. The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job and regenerate — do not run this file. — **38.1 × 76.2 × 3.81 mm PLA**
2. The cutter — Spiral O single flute 2 × 12. — **⌀ 2 mm cutting**
3. Record the cutter's flute length and its stick-out from the collet. — \_\_\_\_\_\_\_\_  *(flute length (mm) / stick-out (mm))*
4. The Z1 low-profile vise, and the wired probe that ships with the machine — a mechanical touch tip, so it triggers on PLA (measured 2026-10-08, 0.001 mm). The 3D Probe stays in reserve.

## 2 · Mount the vise

1. Remove the MDF wasteboard. Seat the vise on its two locating pins; fasten with six M5×20 screws.  ⚠ *Not yet confirmed on the machine (#208).*
2. The fixed jaw is on the left.  ⚠ *Not yet confirmed on the machine (#208).*

## 3 · Load the blank

1. The blank's length runs left–right between the jaws. The face to be engraved is up. — **38.1 mm**
2. The top face must stand 1.2 mm above the jaw tops. Record the measured value. If it is less than 2.6 mm, stop: the cutter would work below the jaw tops. — \_\_\_\_\_\_\_\_  *(measured stock proud (mm))*
3. Push the blank's front edge to where the file expects it: the front edge is 10 mm behind the front of the jaws.
4. Tighten. Check the blank does not rock.

## 4 · Fit the cutter and measure its length

1. Fit the cutter with its collar. Run tool-length calibration from Studio (M491).  ⚠ *Not yet confirmed on the machine (#208).*
2. Do not skip this because the program contains T1 M6. If the machine already believes tool 1 is fitted, that line does nothing.  ⚠ *Not yet confirmed on the machine (#208).*

## 5 · Set the work origin

1. The vise already references X and rotation to within ±0.05 mm, before any touch.  ⚠ *Not yet confirmed on the machine (#208).*
2. Touch 1 of 3: the right edge — the one against the moving jaw, about 19.1 mm along it from the front end — this gives position and rotation.  ⚠ *Not yet confirmed on the machine (#208).*
3. Touch 2 of 3: the right edge — the one against the moving jaw, about 57.2 mm along it from the front end — this gives rotation.  ⚠ *Not yet confirmed on the machine (#208).*
4. Touch 3 of 3: the front edge — the one nearest you, at about its middle, 19.1 mm from the left end — this gives Y.  ⚠ *Not yet confirmed on the machine (#208).*
5. Z0: the blank's top face — probe it, or touch off on it.  ⚠ *Not yet confirmed on the machine (#208).*
6. X0 Y0 Z0 is the top-front-left corner of the blank. That leaves the work origin within ±0.02 mm in X and Y and ±0.027° in rotation. Move there and check by eye before going on.  ⚠ *Not yet confirmed on the machine (#208).*
7. Rotation is measured, and a static .nc cannot compensate it (Smoothieware has no variables, §7.3 / #187 item 1): apply it in Studio's dialogs, or re-post with the rotation baked into the geometry  ⚠ *Not yet confirmed on the machine (#208).*
8. Z is always probed on the engraved face (§7.2): no fixture can supply it  ⚠ *Not yet confirmed on the machine (#208).*

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-23 -84.2 84.1 102.2" class="run-sheet-svg" role="img" aria-label="Top view of the stock, the vise jaws and the work origin"><defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs><rect data-stock="true" class="run-sheet-stock" x="0" y="-76.2" width="38.1" height="76.2" /><text class="run-sheet-label" x="19.05" y="-78.2" text-anchor="middle">38.1 × 76.2 mm stock</text><rect data-jaw-id="vise-fixed-jaw" class="run-sheet-jaw" x="-15" y="-70" width="15" height="80" /><text class="run-sheet-label" x="-7.5" y="-30" text-anchor="middle">Fixed jaw (left)</text><rect data-jaw-id="vise-moving-jaw" class="run-sheet-jaw" x="38.1" y="-70" width="15" height="80" /><text class="run-sheet-label" x="45.6" y="-30" text-anchor="middle">Moving jaw (right)</text><circle class="run-sheet-origin" cx="0" cy="0" r="1.2" /><text class="run-sheet-origin-label" x="1.6" y="3.2">X0 Y0 (front-left, top face)</text><line class="run-sheet-axis" x1="0" y1="0" x2="14" y2="0" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="15" y="1.2">X</text><line class="run-sheet-axis" x1="0" y1="0" x2="0" y2="-14" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="-1" y="-15">Y</text><rect data-item-id="shp-a-0.6" class="run-sheet-item" x="16.55" y="-23.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 0.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-20.6" text-anchor="middle" dominant-baseline="central">0.6 mm</text><rect data-item-id="shp-a-0.8" class="run-sheet-item" x="16.55" y="-30.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 0.8&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-27.6" text-anchor="middle" dominant-baseline="central">0.8 mm</text><rect data-item-id="shp-a-1" class="run-sheet-item" x="16.55" y="-37.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.0&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-34.6" text-anchor="middle" dominant-baseline="central">1 mm</text><rect data-item-id="shp-a-1.2" class="run-sheet-item" x="16.55" y="-44.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.2&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-41.6" text-anchor="middle" dominant-baseline="central">1.2 mm</text><rect data-item-id="shp-a-1.4" class="run-sheet-item" x="16.55" y="-51.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.4&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-48.6" text-anchor="middle" dominant-baseline="central">1.4 mm</text><rect data-item-id="shp-a-1.6" class="run-sheet-item" x="16.55" y="-58.1" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="19.05" y="-55.6" text-anchor="middle" dominant-baseline="central">1.6 mm</text></svg>

## 6 · Dry run

1. Load 165-depth-ladder-row-A-frame.nc and run it. The cutter traces the job's outline in the air, 20 mm above the work — no Z offset to set. Watch that the trace stays over the blank and clear of the jaws. — **20 mm above the work**
2. If the trace is not where the job should land, stop and change the job. Otherwise load 165-depth-ladder-row-A.nc and cut.

## 7 · Cut

1. Spindle, feed, plunge, passes and step-down. Vacuum on. — **12000 RPM · 500 mm/min feed · 200 mm/min plunge · 16 × 0.5 mm passes · 0.9 mm step-over**
2. Pocket rect "A over pocket 0.6" 5×5 — **0.6 mm deep**
3. Pocket rect "A over pocket 0.8" 5×5 — **0.8 mm deep**
4. Pocket rect "A over pocket 1.0" 5×5 — **1 mm deep**
5. Pocket rect "A over pocket 1.2" 5×5 — **1.2 mm deep**
6. Pocket rect "A over pocket 1.4" 5×5 — **1.4 mm deep**
7. Pocket rect "A over pocket 1.6" 5×5 — **1.6 mm deep**
8. Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.

## 8 · Warnings carried from the app

1. **Vise dimensions are unmeasured defaults (#208); collisions cannot be trusted yet.**
2. The stock stands 1.2 mm above the jaw tops, but the deepest cut reaches 1.6 mm; at least 1 mm of clearance is wanted, so the cutter would work below the jaw tops (stockProud ≥ 2.6 mm).
3. Only 2.6100000000000003 mm of the stock is gripped below the jaw tops; under 3 mm the part can lift (PROVISIONAL threshold, #208).
4. the Vise fixed jaw (left) is declared 1.200 mm below the stock top, but the unmeasured 2 mm band around it lifts its top 0.800 mm ABOVE — and the collet nut's size is not known: clearance to it cannot be proven
5. Checked: the tool against the stock and the modelled fixture (Vise fixed jaw (left), Vise moving jaw (right)).
6. Not checked: the spindle body, head and gantry; anything on the bed other than the declared stock, workholding and sacrificial material; the collet nut, which this machine states no dimensions for.
7. The modelled fixture is a shipped default, not a measurement.

## 9 · Record afterwards

1. Measured floor depth — Pocket rect "A over pocket 0.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
2. Measured floor depth — Pocket rect "A over pocket 0.8" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
3. Measured floor depth — Pocket rect "A over pocket 1.0" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
4. Measured floor depth — Pocket rect "A over pocket 1.2" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
5. Measured floor depth — Pocket rect "A over pocket 1.4" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
6. Measured floor depth — Pocket rect "A over pocket 1.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
7. Is the text legible? — \_\_\_\_\_\_\_\_  *(yes / no)*
8. Surface finish — \_\_\_\_\_\_\_\_  *(clean / fuzzy / burnt)*
9. Anything that went wrong — \_\_\_\_\_\_\_\_  *(notes)*

---

*Rendered from `buildRunSheet` (#207) by `casemaker-app/scripts/bench-files.ts`; the app’s `RunSheetView` renders the same structure. No result is recorded here.*

*This is the sheet for #165’s depth ladder on the printed badge blank — its blanks are filled at the machine and the results go to #165 / `docs/bench/2026-10-bench-day-1.md` (E).*

*Row A (“A over pocket”) is centred on the 45 × 13 mm magnet pocket — the unsupported-membrane test. Row B (“B clear”) is 12 mm behind it in the clear band. The job document has no field for the pocket, so the row names and the operator, not the diagram, carry that distinction (logged on #206’s dogfood issue).*
