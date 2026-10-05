# Run sheet — 165 depth ladder

Generated 2026-10-04 · file `165-depth-ladder.nc` · sha256 `6f782fa0` · estimated cutting time 6 min 22 s (simulated — rapids not included)

## 1 · What you need

1. The blank. Measure it. If it differs by more than 0.5 mm in any dimension, change the job and regenerate — do not run this file. — **76.2 × 38.1 × 3.81 mm PLA**
2. The cutter — 1 mm flat end (assumed). — **⌀ 1 mm cutting**
3. Record the cutter's flute length and its stick-out from the collet. — \_\_\_\_\_\_\_\_  *(flute length (mm) / stick-out (mm))*
4. The Z1 low-profile vise, and the Makera 3D Probe — the one rated for non-conductive material, NOT the 3D Probe Rod that came in the box.

## 2 · Mount the vise

1. Remove the MDF wasteboard. Seat the vise on its two locating pins; fasten with six M5×20 screws.  ⚠ *Not yet confirmed on the machine (#208).*
2. The fixed jaw is on the left.  ⚠ *Not yet confirmed on the machine (#208).*

## 3 · Load the blank

1. The blank's length runs left–right between the jaws. The face to be engraved is up. — **76.2 mm**
2. The top face must stand 3 mm above the jaw tops. Record the measured value. If it is less than 2.6 mm, stop: the cutter would work below the jaw tops. — \_\_\_\_\_\_\_\_  *(measured stock proud (mm))*
3. Push the blank's front edge to where the file expects it: the front edge is 10 mm behind the front of the jaws.
4. Tighten. Check the blank does not rock.

## 4 · Fit the cutter and measure its length

1. Fit the cutter with its collar. Run tool-length calibration from Studio (M491).  ⚠ *Not yet confirmed on the machine (#208).*
2. Do not skip this because the program contains T1 M6. If the machine already believes tool 1 is fitted, that line does nothing.  ⚠ *Not yet confirmed on the machine (#208).*

## 5 · Set the work origin

1. X0: the blank's left face (against the fixed jaw).  ⚠ *Not yet confirmed on the machine (#208).*
2. Y0: the blank's front edge.  ⚠ *Not yet confirmed on the machine (#208).*
3. Z0: the blank's top face — probe it, or touch off on it.  ⚠ *Not yet confirmed on the machine (#208).*
4. X0 Y0 Z0 is the top-front-left corner of the blank. Move there and check by eye before going on.  ⚠ *Not yet confirmed on the machine (#208).*

<svg xmlns="http://www.w3.org/2000/svg" viewBox="-23 -78 122.2 96" class="run-sheet-svg" role="img" aria-label="Top view of the stock, the vise jaws and the work origin"><defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs><rect data-stock="true" class="run-sheet-stock" x="0" y="-38.1" width="76.2" height="38.1" /><text class="run-sheet-label" x="38.1" y="-40.1" text-anchor="middle">76.2 × 38.1 mm stock</text><rect data-jaw-id="vise-fixed-jaw" class="run-sheet-jaw" x="-15" y="-70" width="15" height="80" /><text class="run-sheet-label" x="-7.5" y="-30" text-anchor="middle">Fixed jaw (left)</text><rect data-jaw-id="vise-moving-jaw" class="run-sheet-jaw" x="76.2" y="-70" width="15" height="80" /><text class="run-sheet-label" x="83.7" y="-30" text-anchor="middle">Moving jaw (right)</text><circle class="run-sheet-origin" cx="0" cy="0" r="1.2" /><text class="run-sheet-origin-label" x="1.6" y="3.2">X0 Y0 (front-left, top face)</text><line class="run-sheet-axis" x1="0" y1="0" x2="14" y2="0" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="15" y="1.2">X</text><line class="run-sheet-axis" x1="0" y1="0" x2="0" y2="-14" marker-end="url(#run-sheet-arrow)" /><text class="run-sheet-axis-label" x="-1" y="-15">Y</text><rect data-item-id="shp-a-0.6" class="run-sheet-item" x="18.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 0.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="20.6" y="-19.05" text-anchor="middle" dominant-baseline="central">0.6 mm</text><rect data-item-id="shp-a-0.8" class="run-sheet-item" x="25.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 0.8&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="27.6" y="-19.05" text-anchor="middle" dominant-baseline="central">0.8 mm</text><rect data-item-id="shp-a-1" class="run-sheet-item" x="32.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.0&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="34.6" y="-19.05" text-anchor="middle" dominant-baseline="central">1 mm</text><rect data-item-id="shp-a-1.2" class="run-sheet-item" x="39.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.2&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="41.6" y="-19.05" text-anchor="middle" dominant-baseline="central">1.2 mm</text><rect data-item-id="shp-a-1.4" class="run-sheet-item" x="46.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.4&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="48.6" y="-19.05" text-anchor="middle" dominant-baseline="central">1.4 mm</text><rect data-item-id="shp-a-1.6" class="run-sheet-item" x="53.1" y="-21.55" width="5" height="5"><title>Pocket rect &quot;A over pocket 1.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="55.6" y="-19.05" text-anchor="middle" dominant-baseline="central">1.6 mm</text><rect data-item-id="shp-b-0.6" class="run-sheet-item" x="18.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 0.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="20.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">0.6 mm</text><rect data-item-id="shp-b-0.8" class="run-sheet-item" x="25.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 0.8&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="27.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">0.8 mm</text><rect data-item-id="shp-b-1" class="run-sheet-item" x="32.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 1.0&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="34.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">1 mm</text><rect data-item-id="shp-b-1.2" class="run-sheet-item" x="39.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 1.2&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="41.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">1.2 mm</text><rect data-item-id="shp-b-1.4" class="run-sheet-item" x="46.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 1.4&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="48.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">1.4 mm</text><rect data-item-id="shp-b-1.6" class="run-sheet-item" x="53.1" y="-33.55" width="5" height="4.9999999999999964"><title>Pocket rect &quot;B clear 1.6&quot; 5×5</title></rect><text class="run-sheet-item-depth" x="55.6" y="-31.049999999999997" text-anchor="middle" dominant-baseline="central">1.6 mm</text></svg>

## 6 · Dry run

1. Raise the work Z by 20 mm and run the whole file in the air. Watch that the cutter stays over the blank and clear of the jaws.
2. Then restore Z to the work origin.

## 7 · Cut

1. Spindle, feed, plunge, passes and step-down. Air on. — **12000 RPM · 500 mm/min feed · 200 mm/min plunge · 48 × 0.3 mm passes · 0.45 mm step-over**
2. Pocket rect "A over pocket 0.6" 5×5 — **0.6 mm deep**
3. Pocket rect "A over pocket 0.8" 5×5 — **0.8 mm deep**
4. Pocket rect "A over pocket 1.0" 5×5 — **1 mm deep**
5. Pocket rect "A over pocket 1.2" 5×5 — **1.2 mm deep**
6. Pocket rect "A over pocket 1.4" 5×5 — **1.4 mm deep**
7. Pocket rect "A over pocket 1.6" 5×5 — **1.6 mm deep**
8. Pocket rect "B clear 0.6" 5×5 — **0.6 mm deep**
9. Pocket rect "B clear 0.8" 5×5 — **0.8 mm deep**
10. Pocket rect "B clear 1.0" 5×5 — **1 mm deep**
11. Pocket rect "B clear 1.2" 5×5 — **1.2 mm deep**
12. Pocket rect "B clear 1.4" 5×5 — **1.4 mm deep**
13. Pocket rect "B clear 1.6" 5×5 — **1.6 mm deep**
14. Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.

## 8 · Warnings carried from the app

1. **Vise dimensions are unmeasured defaults (#208); collisions cannot be trusted yet.**
2. Only 0.81 mm of the stock is gripped below the jaw tops; under 3 mm the part can lift (PROVISIONAL threshold, #208).
3. the deepest cut is 1.600 mm below the stock top and tool "1 mm flat end (assumed)" states no shoulder or flute length: holder clearance cannot be proven
4. the collet nut's size or the tool's stick-out is not known: clearance to the vise cannot be proven

## 9 · Record afterwards

1. Measured floor depth — Pocket rect "A over pocket 0.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
2. Measured floor depth — Pocket rect "A over pocket 0.8" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
3. Measured floor depth — Pocket rect "A over pocket 1.0" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
4. Measured floor depth — Pocket rect "A over pocket 1.2" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
5. Measured floor depth — Pocket rect "A over pocket 1.4" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
6. Measured floor depth — Pocket rect "A over pocket 1.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
7. Measured floor depth — Pocket rect "B clear 0.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
8. Measured floor depth — Pocket rect "B clear 0.8" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
9. Measured floor depth — Pocket rect "B clear 1.0" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
10. Measured floor depth — Pocket rect "B clear 1.2" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
11. Measured floor depth — Pocket rect "B clear 1.4" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
12. Measured floor depth — Pocket rect "B clear 1.6" 5×5 — \_\_\_\_\_\_\_\_  *(measured depth (mm))*
13. Is the text legible? — \_\_\_\_\_\_\_\_  *(yes / no)*
14. Surface finish — \_\_\_\_\_\_\_\_  *(clean / fuzzy / burnt)*
15. Anything that went wrong — \_\_\_\_\_\_\_\_  *(notes)*

---

*Rendered from `buildRunSheet` (#207) by `casemaker-app/scripts/bench-files.ts`; the app’s `RunSheetView` renders the same structure. This is the sheet for #165’s depth ladder on the printed badge blank — its blanks are filled at the machine and the results go to #165 / `docs/bench/2026-10-bench-day-1.md` (E). No result is recorded here.*

*Row A (“A over pocket”) is centred on the 45 × 13 mm magnet pocket — the unsupported-membrane test. Row B (“B clear”) is 12 mm behind it in the clear band. The job document has no field for the pocket, so the row names and the operator, not the diagram, carry that distinction (logged on #206’s dogfood issue).*
