# The v2 demo-jobs pipeline (2026-10-28)

These are the scripts that built the 2026-10-28 real-jobs run and its page. They were kept here because the scratchpad they ran from is wiped on reboot.

- `jobs2.py` builds the job files in `../jobs/` from the sources.
- `run.sh` and `render-all2.sh` run each job through `casemaker cut` on a clone of main.
- `render.py` is the independent height-field sweep. Balls and drills are drawn at their cutting size, which v1 got wrong.
- `make-male.mts` derives an inlay male plug.
- `meshgen.py` handles the relief inputs.
- `cards.py`, `gen_page.py`, `page-head.html` and `summ.py` build the page and its summary.

They were written for a one-off run, so paths inside them point at the scratchpad they ran from (`.../scratchpad/real/`). Set those to a working folder before re-running. The house location file the runs used (`location.json`) is not committed. Use the location export from the machine you run on.

The downloaded inputs (wolf model, portrait, Vader outline) are not committed. `../README.md` gives each one's URL and licence.

## Scoring a vendor program, and the cut-into rule (#955)

`goal_check.py --mkr --dz <mm> [--only-tools n,..] <goal-prefix> <stock> <out> <nc>...` scores a **Makera
Studio** program on the same goal heightfield the page uses for ours. The `;@MKR|TOOL|number=N|…` header
gives each tool's geometry (flat / ball / V-cone with tip / drill); every `T<N> M6` switches the stamp; a
tool change resets the position to a safe height (Studio emits the next XY move before its `G0 Z…`).
Studio's own cycle estimate is read from `;@MKR|TIME|seconds=` into `vendorSeconds`. A tool number in the
NC with no header is reported in `unmappedToolNumbers` — never silently swept as nothing.

The **cut-into** line of the card rule is `cutInto0p1Pct` = 0: cells whose swept top is more than 0.1 mm
below the goal, outside the three classes below. 0.1 mm is the goal heightfield's own pitch; below it a
difference is grid or toolpath quantisation (Studio's ball path steps ~0.03 mm). Each excluded class is
reported, never silently dropped:

| class | report key | what it is |
|---|---|---|
| **edge break** | `edgeBreakPct`, `edgeBreakMaxMm` | a cell cut by a V-shaped tool (V-bit, engraving, chamfer), within that bit's reach of a design edge (a goal step > 0.2 mm, or the model's silhouette), and no deeper than the bit's **leg** — the cone's depth at its cutting radius, `(R − tip) / tan(half-angle)`. A V tool gouging a floor away from any edge stays cut-into. |
| **wall cells** | `wallNotScoredPct` | the cell straddling a vertical goal step: at 0.1 mm the wall lands on one side of the cell boundary or the other, and the sample cannot say which. |
| **wall shadow** | `shadowNotScoredPct` | cells within the largest cutting tool's radius of a wall step: the cutter at a lower level cannot reach material behind the wall, but a heightfield stamp spreads its profile over every cell under it. |

`cutIntoPct` (the 0.01 mm floor used by the in-app check) stays in the report as an advisory number;
`cutIntoInclEdgePct` is the raw count before any allowance.

A cell is charged only where its centre lies **strictly inside** the cutter's footprint —
`distance < radius − 1e-6`, the app's `EDGE_EPS_MM` (#964). A contour is posted with the tool centre
offset by the cutter's radius, so the disc's edge is tangent to the outline; `distance <= radius`
charged every goal cell centred on that outline with the full cutting depth, a zero-measure contact.
`goal_check.py` and the app's `exactSweptField` carry the same line, so the page and the app agree
cell for cell (on the j07 card: 631,601 of 631,601 cells bit-identical, same verdict). Measured on
Makera's own tray program, before → after the rule: raw 6.85 → 6.81 %, edge break 3.66 → 3.81 %
(max 0.45 mm), wall cells 0.30 → 0.12 %, wall shadow 2.45 → 2.44 %, remaining at 0.01 0.45 %
(max 0.036 mm) and at 0.1 **0.00 %** both; leftover over 0.1 mm 0.48 → 0.75 %, i.e. vendor coverage
99.52 → 99.25 % — cells no longer charged read the stock top, honestly; vendor time 47.6 min. Ours
on the tray card (2 mm + 0.5 mm balls) is unchanged by the rule: raw 0.08 %, 0.00 % at 0.1, coverage
98.55 %.

`--only-tools` scores a subset (the calibration's "without the chamfer" line). The sweep is single-setup
(side 1; work Z 0 = stock top) — a whole-surface comparison needs the maker's NC per side.
