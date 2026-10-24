# Case Maker vs the field — the 20-vendor grid with a Case Maker column

**As of `main` ffd997fe, 2026-10-24.** `FEATURE-MATRIX.md` §2 (study closed 2026-10-09, #228) has
no Case Maker column. This document adds one, keeps Makera Studio (`MKS`) beside it, and folds the
other 18 vendor columns into one `Field` cell so the table stays readable. The fine-grained Studio
comparison is `MAKERA-VS-CASEMAKER.md`; the vendor evidence is unchanged and lives in `notes/`.

**Legend.** `Y` present · `P` partial / adjacent · `N` absent · `?` not settled · `R-n` refused by
decision n of `/Makera-Parity.md` §14.4 (or a named `/Fabrication.md` decision). The `Field` cell is
**derived** by counting the 18 non-Makera columns of `FEATURE-MATRIX.md` §2 as they stand
(`C3 BT SM IV RG TM SC OB GM SP ST VC CV ES AD LB OF PN`); "tier" counts cells the grid qualifies
with a paid tier (`(Pro)`, `(Plus)`, `(M+)`, `(Starter)`, `(sub)`). No vendor was re-researched. The
`CM` cell cites the issue or file it was verified against; an issue in **bold** is open.

## A. Platform, licensing, reach

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| Windows (native app) | Y | Y — Tauri, NSIS (`src-tauri/tauri.conf.json`) | Y 13 · N 5 |
| macOS (native app) | ? | N — deferred (**#322**) | Y 8 · N 10 |
| Linux (native app) | N | N — deferred (**#323**; `npm ci` fails, **#565**) | Y 5 · N 13 |
| Runs in a browser | N | Y — `?BETA=yes` on the public site (#343); a LAN browser drives the machine (#571) | Y 5 · N 13 |
| Mobile app | P | P — responsive web (#503, #507), no native app (**#376**) | P 4 · N 13 · ? 1 |
| Free tier | Y | Y | Y 13 · P 3 · N 2 |
| Paid / subscription tier | N | R-20 | Y 10 · N 8 |
| Open source | N | Y — Apache-2.0 | Y 4 · P 1 · N 13 |
| Account required | N | R-19 (none) | Y 5 · P 3 · N 10 |
| Fully offline | Y | Y — local-first; no server | Y 12 · P 5 · N 1 |

## B. Design & modelling

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| 2D vector draw/edit | N | P — placed items (rect, circle, slot, polygon, border, frame, vector), no freehand editor (`engraveJobSchema.ts`) | Y 7 · N 10 · ? 1 |
| 3D modelling | N | P — a parametric case compiler and 3D cut-away primitives (#435); not a modeller | Y 2 · P 3 · N 12 · ? 1 |
| Parametric / constraint-based | N | Y — the whole app | Y 1 · N 17 |
| Text tool + multi-font | N | Y — opentype outlines, font registry (#169, #170) | Y 8 · N 10 |
| Import SVG | ? | Y (#217) | Y 10 · N 8 |
| Import DXF | ? | Y (#217, #294, #453) | Y 9 · N 7 · ? 2 · tier 1 |
| Import STL / 3D mesh | Y | Y — STL/3MF as stock or as the goal (#418, #533); PrusaSlicer 3MF design (#410) | Y 8 · N 10 · tier 2 |
| Import STEP / CAD | N | R-13 | Y 2 · N 16 |
| Import Gerber / PCB | N | R-12 | Y 2 · P 1 · N 15 · tier 1 |
| Image trace (raster→vector) | N | Y (#252) | Y 7 · P 1 · N 10 |
| Stock/blank definition | P | Y — stock shelf with layers/finish/flatness (#413), vendor sizes (#446), laminates (#492) | Y 11 · P 4 · N 2 · ? 1 |

## C. Toolpaths (CAM)

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| 2D pocket | Y | Y (#172) | Y 9 · P 3 · N 6 |
| 2D contour / profile | Y | Y — with holding tabs (#218) | Y 9 · P 3 · N 6 |
| Drilling / peck | Y | Y (#220) | Y 7 · P 3 · N 8 |
| V-carve / engraving | P | Y — floor-correct at the colour plane (#221, #405, #408) | Y 7 · P 4 · N 7 · tier 2 |
| Chamfer | Y | N — chamfer bit as a V profile only, no edge operation | Y 4 · P 1 · N 13 |
| 3D relief (rough+finish) | Y | P — heightfield roughing + ball finishing (#534); UI open (**#535**) | Y 8 · P 1 · N 9 · tier 3 |
| 4th axis / rotary | Y | N — designed, nothing reaches the IR (**#545**) | Y 6 · P 5 · N 5 · ? 2 · tier 1 |
| Laser image / vector | Y | R (decision 4; `capabilities.laser: false`) | Y 5 · P 4 · N 9 · tier 1 |
| Thread milling | Y | Y (#445) — supersedes R-14 | Y 3 · P 1 · N 14 |
| Nesting (multiple parts) | N | R-15 | Y 3 · N 15 · tier 3 |
| Tabs / bridges | ? | Y (#218) | Y 6 · N 9 · ? 3 |
| Ramping / helical entry | ? | P — adaptive metal pockets only (#433); engraving plunges (R-16) | Y 6 · N 6 · ? 6 · tier 2 |
| Stock-to-leave / finish pass | ? | Y (#250) | Y 5 · P 1 · N 7 · ? 5 |
| Custom tool library | Y | Y — clones, typed cutters, box-code/QR registration (#212, #311, #309) | Y 14 · ? 4 |
| Feeds & speeds database | Y | Y — catalogue tier clamped to the machine, measured rows win (#310); none measured yet (**#284**) | Y 14 · N 2 · ? 2 |
| Material library | Y | Y (#413, #456) | Y 13 · ? 5 |
| Toolpath templates / presets | ? | R-7 — the job file is the template | Y 5 · P 1 · N 2 · ? 10 · tier 2 |
| Post-processors / machine profiles | ? | P — one post, one profile (Z1) with calibration (#184, #279) | Y 14 · P 1 · N 1 · ? 2 |
| Plugin / scripting API | N | R-11 — a CLI and a read-only MCP server instead (#485) | Y 5 · P 3 · N 8 · ? 2 |

## D. Preview & simulation

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| 2D toolpath preview | Y | Y | Y 18 |
| 3D toolpath preview | Y | Y (#197) | Y 15 · P 1 · N 1 · ? 1 |
| Material-removal simulation | P | Y — exact sweep + dexel route (#182, #531) | Y 10 · P 5 · N 1 · ? 2 |
| Machining-time estimate | ? | Y — one trapezoid estimate (#242); rapid rate awaits a timed run (**#281**) | Y 6 · N 3 · ? 9 |
| Collision / gouge check | ? | Y — fixture, holder, gouge, envelope as errors (#204, #396) | Y 3 · N 14 · ? 1 |
| Before/after stock compare | Y | Y (#182, #551) | Y 9 · P 1 · N 4 · ? 4 |

## E. Machine setup & control

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| First-run / machine setup wizard | N | P — start wizard (#280), "Cut this blank" (#573); the bed wizard is open (**#512**); no flow owns machine facts (R-1) | Y 13 · P 2 · N 3 |
| Homing / limit config | ? | P — `$H` in every flow; soft endstops are read, never written (#279; console refuses `config-set`) | Y 12 · P 1 · N 5 |
| On-screen jog | ? | R-10 | Y 14 · P 1 · N 3 |
| Keyboard jog | ? | R-10 | Y 13 · N 3 · ? 2 |
| Gamepad / pendant | ? | R-10 | Y 8 · N 10 |
| Touch probe / touch plate | P | Y — wired probe, `M119` check, `M491`, `G38.3` touches (#598–#600) | Y 12 · P 1 · N 3 · ? 2 · tier 1 |
| 3D probing / auto-level | Y | P — plane fit against tilt (#608); 3D probe unread (**#525**); `G32` unproven (**#501**) | Y 7 · P 2 · N 7 · ? 2 |
| Work-origin setting (XY/Z) | Y | Y — `G10 L2 P1` from the found stock; laser point-to-origin (#431) | Y 16 · N 2 |
| Tool-length measurement | P | Y — `M491` per probe and per cutter | Y 9 · P 1 · N 3 · ? 5 · tier 3 |
| Tool-change prompts | P | Y — bit-change pause with cutter confirm and Z0 (#469, #516) | Y 8 · N 4 · ? 6 |
| Workholding / fixture library | P | Y — accessories with measured records (#597, #601), vise and bracket mounts (#427), bed profiles (#510) | Y 6 · P 5 · N 3 · ? 4 |
| Feed / spindle override | Y | R-10 | Y 12 · N 4 · ? 2 |
| Pause / resume / start-from-line | ? | P — no pause; restart from a step as a generated file (#249) | Y 11 · N 3 · ? 4 |
| Multiple machine profiles | N | P — many machine records, one profile (Z1) | Y 14 · N 3 · ? 1 · tier 1 |

## F. Job & workflow

| Capability | MKS | CM | Field (18) — derived |
|---|---|---|---|
| Job queue / multiple jobs | N | R-9 — a multi-program release is one job (#469) | N 12 · ? 6 |
| Remote / network control | N | Y — LAN browser (#571), CLI (#485); MCP read-only | Y 11 · N 6 · ? 1 |
| Camera / vision | P | P — bench harness only (`tools/z1/camera.mjs`); app tab and metrology open (**#530**, **#286**) | Y 3 · P 1 · N 14 |
| Built-in G-code viewer/editor | ? | P — read-only pane (#245); editing refused (R-8) | Y 11 · N 6 · ? 1 |
| Console / MDI / macros | ? | P — a guarded one-line console (#302); no macros (R-11) | Y 11 · P 3 · N 2 · ? 2 |
| Job history / statistics | ? | P — run record files, history region, finished hashes, tool runtime (#277, #419, #414); no statistics view | Y 2 · P 2 · N 13 · ? 1 |
| Error recovery messaging | N | Y — coded diagnostics, every one a guide row; stop wording in progress (**#587**, **#588**) | Y 2 · P 12 · N 2 · ? 2 |
| Setup sheet / operator run sheet | N | Y (#207) | Y 2 · N 15 · ? 1 |
| Undo / redo | ? | Y — project history (zundo temporal store, `projectStore.ts`), per-item removal undo in the job (#411) | Y 10 · N 2 · ? 6 |
| Keyboard shortcuts | ? | P — Ctrl/⌘-Z, -Y, -Shift-Z for undo/redo (`AppShell.tsx`); no wider shortcut set verified | Y 10 · N 1 · ? 7 |
| Localisation (non-English UI) | ? | R-18 | Y 8 · N 1 · ? 9 |

## Scorecard

Counts are the `CM` column against the `Field` majority; "ahead" means Case Maker has a `Y` where
fewer than half the field does, "behind" means an `N`/`P` where more than half has `Y`.

| Group | Ahead of the field | At parity | Behind | Refused (reason) |
|---|---|---|---|---|
| **A** Platform | browser (5/18), open source (4/18), no account | Windows, free, offline | macOS (8/18), Linux (5/18) — deferred #322/#323 | paid tier R-20; account R-19 |
| **B** Design | parametric (1/18), mesh as goal/stock | text, SVG/DXF, trace, stock | 2D editor (7/18) is placed items only | STEP R-13 (B-rep kernel), Gerber R-12 (a different product) |
| **C** CAM | V-carve at the colour plane, thread milling (3/18), finish pass, feeds with measured provenance | pocket, contour, drill, tabs, tool/material libraries | chamfer op (4/18), rotary (6/18), 3D relief UI (8/18), one machine profile | laser (dec. 4), nesting R-15, templates R-7, scripting R-11, engrave ramping R-16 |
| **D** Simulation | collision (3/18), time estimate (6/18), oracle (0/18) | previews, before/after, removal sim | — | — |
| **E** Control | probe records, mount datum, `G38.3` no-alarm touches, Z-only edge finding | origin, tool length, tool-change prompts, fixtures | pause/resume (11/18), 3D probe/auto-level (7/18), setup wizard (13/18) partial | jog, overrides, pendant R-10; machine facts owned by no wizard R-1 |
| **F** Workflow | run sheet (2/18), run records with provenance, remote control via browser/CLI | viewer, console | camera in-app (3/18 — but load-bearing where it exists), history view | job queue R-9, G-code editing R-8, macros R-11, i18n R-18 |

## Positioning

Case Maker is the only product in the sample that is **open source (Apache-2.0), runs in a
browser, needs no account and works offline** at once — the four `A` rows where the field is
thinnest (`Y` in 4, 5, 10-of-18 `N`, 12 respectively). Its design side is **parametric**, which only
Autodesk Fusion offers, and its CAM reads the compiler's own profiles rather than re-inferring them
from a mesh. On the simulation group it is **ahead of every column**: an exact sweep, collision and
gouge checks that are errors rather than warnings (3/18 have any check), a machining-time estimate
(6/18) and a **volumetric oracle** nobody else has, gating the file before it can be uploaded. Its
machine model is **measured-provenance** throughout — every feed, fixture dimension, probe reading
and bed datum carries a source and a date, and a catalogue number can never read as a measurement.
The honest limit is **scope: one machine (the Makera Z1), one post, one profile**, where 14/18 of the
field ship multiple machine profiles; the `MachineProfile` seam exists (#184, decision 25) but
nothing beyond the Z1 is supported, by decision (`/Makera-Parity.md` §10, §13).

## Top five market-facing gaps

| # | Gap | Field | Issues |
|--:|---|---|---|
| 1 | **Pause/resume and a live position readout.** `abort` is the only stop; there is no DRO and no jog. The field pauses and resumes (11/18) and shows position everywhere. | E | **#519**, **#527** (live tool/WPos in the viewport); pause itself has no issue — R-10 decides what the bridge exposes |
| 2 | **XY probing with the 3D probe and grid auto-levelling.** Edges are found with the Z-only wired probe; the 3D probe is a record nobody reads; `G32` is unproven. | E | **#525**, **#501** |
| 3 | **macOS and Linux builds, and an updater.** Windows-only desktop (8/18 and 5/18 of the field ship the others); no update channel; the installer reads a static version. | A | **#322**, **#323**, **#565**, **#403**, **#290**, **#566** |
| 4 | **Rotary and the 3D relief UI.** Both strategies the incumbent ships; ours are a design and a backend. | C | **#545**, **#535**, **#536** |
| 5 | **The camera in the app, and a first-run bed wizard.** The live stream and time-lapse replay exist only in the bench harness; the bed wizard (one physical instruction per step) is designed, not built. | F, E | **#530**, **#286**, **#512** |

## How to keep this current

Derived `Field` cells change only when `FEATURE-MATRIX.md` §2 changes (the study is closed; re-run
the count if a cell is corrected). The `CM` column is dated to `main` ffd997fe: re-verify it on every
k3 publish, cite the commit or issue, and move a row's `R-n` only when the refusal is withdrawn on
the record. Every `CM` cell was settled from the code or the tracker, none from memory; a cell that
cannot be settled that way is `?`, as the grid's own convention requires.
