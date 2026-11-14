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
difference is grid or toolpath quantisation (the vendor ball path's step: a figure kept on the share only). Each excluded class is
reported, never silently dropped:

| class | report key | what it is |
|---|---|---|
| **edge break** | `edgeBreakPct`, `edgeBreakMaxMm` | a cell cut by a V-shaped tool (V-bit, engraving, chamfer), within that bit's reach of a design edge (a goal step > 0.2 mm, or the model's silhouette), and no deeper than the bit's **leg** — the cone's depth at its cutting radius, `(R − tip) / tan(half-angle)`. A V tool gouging a floor away from any edge stays cut-into. |
| **wall cells** | `wallNotScoredPct` | the cell straddling a vertical goal step: at 0.1 mm the wall lands on one side of the cell boundary or the other, and the sample cannot say which. |
| **wall shadow** | `shadowNotScoredPct` | cells within the largest cutting tool's radius of a wall step: the cutter at a lower level cannot reach material behind the wall, but a heightfield stamp spreads its profile over every cell under it. |

`cutIntoPct` (the 0.01 mm floor used by the in-app check) stays in the report as an advisory number;
`cutIntoInclEdgePct` is the raw count before any allowance.

**One rule with the app (#948, `4ba147e8`).** Each posted program is scored with its **own
`;@MKR|TOOL` record** (a multi-program run's chamfer is a cone, not a flat), the chamfer's profile is
the app's **sharp cone** (its stated 0.1 mm tip still sets the edge-break leg, not the profile), a
**goal grid that ends at the model** has its outermost covered row/column as **border cells** —
excluded from cut-into like wall cells, and the **edge-break band seeds from wall ∪ border** (the
part's own silhouette is a design edge) while the wall shadow still seeds from `wall` alone — and,
for our own programs, the edge-break allowance is the **job's stated break**: every cell in the band
no deeper than the V bit's leg is edge break (the app's one-field read; the vendor path keeps the
stricter "the deepest cutter is the V bit itself"). Proven cell for cell at `4ba147e8`: j07's and
the tray's fields are bit-identical between `goal_check.py` and the app's `exactSweptField`,
`cutIntoInclEdgePct`/edge/wall/shadow/adjudicated/leftover agree, and the adjudicated max is 0.458
both.

A cell is charged only where its centre lies **strictly inside** the cutter's footprint —
`distance < radius − 1e-6`, the app's `EDGE_EPS_MM` (#964). A contour is posted with the tool centre
offset by the cutter's radius, so the disc's edge is tangent to the outline; `distance <= radius`
charged every goal cell centred on that outline with the full cutting depth, a zero-measure contact.
`goal_check.py` and the app's `exactSweptField` carry the same line, so the page and the app agree
cell for cell (on the j07 card: 631,601 of 631,601 cells bit-identical, same verdict). Measured on
the vendor's own tray program, before → after the rule: figures kept on the share only (vendor-derived
numbers are not committed). Cells no longer charged read the stock top, honestly. Ours
on the tray card (2 mm + 0.5 mm balls) is unchanged by the rule: raw 0.08 %, 0.00 % at 0.1, coverage
99.06 % from the app's own report at `d1851598` (the page's independent sweep of the same programs
reads 98.55 %, 1.45 % leftover — the receipt wins on the card since #953).

## Re-deriving a card (reproduction)

Every card is computed; nothing on the page is typed. The inputs are the app worktree at a sha and
the Makerables downloads, which are **evaluation-only and never committed**: `--makerables <dir>`
finds each vendor file under `dl/<slug>/` by name and sha256 (the references data file has both).

```sh
cd docs/bench/2026-10-28-z1-real-jobs/tools
CM_LOCATION=~/casemaker-manager/demo-build/location.json \
  python build.py --repo <worktree> [--sha <40-char sha>] --out <out-dir> \
    --makerables '<makerables dir>' --meshes '<samples/3d>' \
    --references '<references data file>' --only '<comma-separated card ids>' \
    [--section-html <candidate section fragment>]
```

The run directory is `out/runs/<the worktree's full 40-char HEAD>/<card id>` — **the full sha is the
cache key**, so a short `--sha` prefix still re-runs everything; pass the exact 40 characters to
reuse an existing run. Each card reads/writes its receipt, the posted `.nc`s, the goal heightfield
(`goal-hf.mts` samples the app's own goal surface from the materialised job) and the vendor's
`goalcheck.json` (cached once written — delete it to force a vendor re-score).

The two reference inputs this page was built against:

| file | sha256 |
|---|---|
| location (`demo-build/location.json`, 134 cutters) | `a568f2790455abb985dff1b12f1c17665612f30e95628f68eec5af501bb2d088` |
| catalogue (`demo-build/catalogue.json`, synced 2026-10-18) | `772fb77670b9497b3671af4c9524f64870b79fd8a657a226efe57e244a9aa37c` |
| app sha the reference page states | `d18515988539ed342adffd5e12313cea96666744` |

Per card: the vendor NC and model, matched by name and sha256 from the **references data file** (`--references <file>`).
That file — the table of reference parts, their vendor file names and hashes, and the reference cards — is data kept off the
repo with the evaluation downloads; `DATA-PINS.sha256` records its hash, so a re-run can prove it used the same data.

The candidate-engine section is its own tool: `candidate_section.py <manifest> <ours-dir> <sha>
<label> <fragment>` reads the acceptance run's stored facts and the page's own manifest (vendor and
old-engine columns) and writes the fragment that `--section-html` appends before the footer. It
never runs the app.

The checker's own rule is pinned by `test_goal_check.py`: a plunge (305 cells at 1.52 %, max
1.000 mm), a clean pocket (0 cut-into, 0 leftover, 4,941 cells) and a boundary-tangent contour
(0 cut-into — the old `distance <= radius` line charged exactly 1.00 % there). Run it with the venv
python; a change to the stamp or the allowances fails a pinned number before it reaches a card.
The suite runs it too (`casemaker-app/tests/unit/pageChecker1267.spec.ts`, #1267). It needs numpy and Pillow,
which a bare `python3` lacks: set `CM_PYTHON` to an interpreter that has both (the interpreter path, not the
venv directory — dave-1 `~/casemaker-manager/venv/bin/python`, k3 `~/v02-stage/venv/bin/python`). Without them the
spec FAILS and says how to fix it; `CM_SKIP_PAGE_CHECKER=1` is the only way out, it prints why, and a gate run never sets it.

`--only-tools` scores a subset (the calibration's "without the chamfer" line). The sweep is single-setup
(side 1; work Z 0 = stock top) — a whole-surface comparison needs the maker's NC per side.
