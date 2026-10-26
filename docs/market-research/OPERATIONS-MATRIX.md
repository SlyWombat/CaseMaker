# Operations matrix — CAM operation types across the category, and what Case Maker posts and offers

Status as of 2026-10-25, Case Maker `main` ebd9a28f (GitHub issue #663). Companion to
`MAKERA-VS-CASEMAKER.md` (§G "CAM & output") and `/Makera-Parity.md` §2 (the 14 Studio strategy types).

The maintainer's words: "operation palettes we need to track and make sure that we offer the same
matrix of operations in the UI." This file is that tracking table. Rows are CAM operation types;
columns are the nine platforms of the category, then two Case Maker columns that are deliberately
separate: the **engine** (what `workers/sim/engraveGenerate.ts` and `engine/cnc/cam/*` can post to
G-code today) and the **UI** (whether an operator can reach it from the app's job panel, wizard or
setups without hand-editing a `.cutjob.json` or using the CLI). An operation the engine posts but the
UI cannot reach is a UI gap; one neither has is a feature gap.

How to read a cell: the platform's own name for the operation, with a source key that resolves in
Sources. `—` means the product's own list of operations (cited) does not include it (laser-only
LightBurn; Fusion personal-tier exclusions). `not established` means no source I could open settled it
— it is NOT a claim of absence. A dagger (†) means the name came from a search-result snippet of the
cited vendor page and the page itself returned 403 or was not opened; treat it as probable, not
confirmed. Several vendor help sites (Snapmaker, Bantam, Easel, Carbide manual) blocked the fetcher,
so those columns lean on †.

## 1. Matrix

Column key: **CC** Carbide Create (Core/Pro), **VC** Vectric VCarve Desktop, **FU** Autodesk Fusion
Manufacture (personal tier), **ES** Easel, **BT** Bantam Tools Desktop CNC (Bantam software + Conversational CAM),
**KM** Kiri:Moto, **LB** LightBurn, **MK** Makera Studio / Makera CAM Beta, **LU** Snapmaker Luban,
**CM-E** Case Maker engine, **CM-UI** Case Maker UI.

| Operation | CC | VC | FU | ES | BT | KM | LB | MK | LU | CM-E (engine) | CM-UI |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2D contour / profile (inside, outside, on the line) | Contour (inside/outside) [CC1] | 2D Production Profiling [VC1] | 2D Contour [FU9]† | Outline: on path / inside / outside [ES1][ES3]† | not established | Outline (internal or external edges); Trace (on/inside/outside) [KM1] | Line [LB1] | 2D Contour (type 1) [MK1] | Vector: Path / Outline [SM1]† | YES: `cutout` outside/inside of an item or the blank, plus `inset` (`cam/profile.ts`); on the line as a `line` trace, authored or imported — a file's open paths and open polylines import as Engrave (line) operations (`engine/import/svgOutline.ts`, `dxfOutline.ts`, `cam/trace.ts`, #664) | YES: `EngraveCutoutRow.tsx`, cut-outs menu, and “Import outline or lines…” adds one line row per open path (`EngravePanel.tsx`, #664) |
| Holding tabs / through cut | "3D tabs" under profiling noted, not a toolpath [VC1]; CC not established | 3D tabs (under profiling) [VC1] | not established | not established | not established | tabs: forum mention only [KM1]† | Tabs/Bridges on Line [LB2] | `supportTabs…` fields [MK2] | Vector tabs [SM1]† | YES: `cutout.tabs` count/width/height, tab = vertical retract (`cam/profile.ts`, `cam/tabSettings.ts`) | YES: tab count/width/height in `EngraveCutoutRow.tsx` |
| Pocket (with islands) | Pocket toolpath [CC1] | Fast and Efficient Pocketing [VC1] | 2D Pocket†, 2D Adaptive Clearing [FU1] | Fill [ES1]† | rectangular pocket [BT1]† | Pocket; Trace "clear" type [KM1] | Fill; Offset Fill [LB1] | 2D Pocket (type 0) [MK1] | Vector: Fill [SM1]† | YES: contour-parallel pocket (`cam/pocket.ts`); rect/circle/slot/polygon, `vectors`, `combined` border/frame/cutaway; islands via `cutaway.islands` (`types/engraveJob.ts` ~590) | YES: Add menu shapes, Border/Frame/Cut-away, Import outline (SVG/DXF), Trace image (`EngravePanel.tsx`, `EngraveCombinedRow.tsx`) |
| Slot | not established | not established | Slot† [FU11] | not established | not established | not established | — | not established | not established | PARTIAL: slot-shaped pocket (`EngraveSlotShape`); a cutter-width slotting pass is a `line` trace | YES: "Slot" in the Add menu (`EngravePanel.tsx` `ADD_KINDS`) |
| V-carve | VCarve [CC2]† | Precision V-Carving [VC1] | not established | not established | not established | Pocket "contour" option approximates a v-bit carve [KM1] | — | type 5 is a hypothesis; `VCarvePath.json` ships nowhere [MK1 §2.1] | not native [SM2]† | YES: V-bit region carve, floor/plane/surface outlines, step-over, groove oracle (`VCarveRegion` in `cam/engraveJob.ts`, `engine/cnc/vCarveGeometry.ts`, `vCarveFindings` in `engraveGenerate.ts`) | YES, by cutter choice: choosing a V cutter turns regions into V-carve and shows its facts (`EngravePanel.tsx` ~784) |
| Advanced V-carve (variable depth / flat-bottom) | Advanced VCarve [CC2]†; Pro "advanced engraving" [CC1] | strategies under Precision V-Carving, flat-bottom not stated [VC1] | not established | not established | not established | not established | — | not established | not established | NO: only a constant-floor V region; no medial-axis variable-depth carve found in `cam/` (roadmap: #609 doc) | NO |
| Engrave text (outline font) | Basic engraving; Advanced engraving (Pro) [CC1] | Quick Engrave; Production Plate Engraving [VC1] | not established | not established | Conversational CAM text [BT1]† | not established | Fill/Line on text (no separate op name read) [LB1] | text subsystem (Parity §8) [MK1] | not established | YES: `EngraveLabel` outline fonts, bold/condensed, per-label depth (`workers/sim/engraveGenerate.ts`, `partPlan.ts`) | YES: "Label" (`EngraveLabelRow.tsx`) |
| Single-line trace / stroke-font text | not established | not established | not established | not established | not established | Trace [KM1] | Line [LB1] | not established | Vector: Path [SM1]† | YES: `line` and `stroke-label` traces, flat or V bit (`cam/trace.ts`) | YES: "Line", "Single-line text" (`EngraveTraceRow.tsx`) |
| Drill / peck drill | Drilling, styles full depth / peck [CC3]† | Drilling Toolpath [VC1]; peck option† | Drill [FU10]† | Convert Circles to Drill Holes; pecking drill [ES2]† | holes (helical) [BT1]† | Drill (pecks) [KM1] | — | 2D Drilling (2), 3D Drilling (10) [MK1] | not established | YES: `drill`, `drill-array`, through; pecks from shop settings, no canned cycles (`cam/drill.ts`, `cam/drillBit.ts`) | YES: "Hole", "Hole array" (`EngraveDrillRow.tsx`); no per-item peck control found |
| Bore (helical hole to size) | not established | not established | Bore [FU5] | not established | holes use a helical path [BT1]† | not established | — | not established | not established | YES: `bore` mode on a hole — helical ramp at the wall, the core cleared LEVEL BY LEVEL (spiral to the cutter's radius plus a hub lap at each Z), a full-depth final lap; pitch = the feeds row's step-down or the shop's `bore.rampAngleDeg` (`cam/drill.ts` `boreMoves`/`boreLevels`, #668) | YES: “Bore to size” in the operation picker, hole ⌀ and helix pitch in the row (`EngraveDrillRow.tsx`, #668) |
| Thread mill | not established | Thread Milling Toolpath [VC1] | Thread [FU7]† | not established | not established | not established | — | 2D Thread mill (9), 3D (12) [MK1] | not established | PARTIAL: internal ISO-metric helical thread in an existing pilot, one hole per item (`cam/threadMill.ts`) | YES: `EngraveThreadRow.tsx` |
| Chamfer (edge) | not established | not established | 2D Chamfer [FU6]† | not established | not established | not established | — | 2D Chamfer (13), 3D Chamfer (14) [MK1] | not established | NO (a chamfer bit is modelled as a V profile only; `engine/cnc/vProfile.ts`) | NO |
| Texture | Texture toolpath [CC2]† | Efficient Texture Toolpath [VC1] | not established | not established | not established | not established | — | not established | not established | NO | NO |
| 3D roughing (adaptive / trochoidal / raster) | 3D rough machining (Pro) [CC1] | 3D Roughing and Finishing [VC1] | 3D Adaptive† (community only), 2D Adaptive Clearing [FU1] | not established | not established | Rough [KM1] | — | 3D Relief / 3D Pocket (types 6, 7) [MK1] | Relief: Carve; 3-axis Model [SM1]† | YES: step-down raster roughing of a goal heightfield, layered down to the deepest surface + allowance (`cam/surface3d.ts` `roughingMoves`, posted by `generateGoalProgram`); the goal operation states its own step-down and step-over (`targetObject.surface`, #535). NOT adaptive/trochoidal: `cam/adaptive.ts` exists but nothing in `src/` imports it except its own grid — only `tests/unit/camAdaptive.spec.ts` | YES: the goal row’s Technical fold sets the cutter, roughing step-down and step-over (`EngraveTargetObjectRow.tsx`, #535) |
| 3D finishing — parallel / raster | 3D finish machining (Pro) [CC1] | 3D Roughing and Finishing [VC1] | 3D Parallel [FU2] | not established | not established | Contour (X/Y raster) [KM1] | — | 3D Contour (type 8) [MK1] | Relief: Carve [SM1]† | YES: ball-nose raster finish, gouge-safe drop (`cam/surface3d.ts`) | YES: the goal row’s Technical fold sets the finishing step-over and the ball/bull cutter that runs it (`EngraveTargetObjectRow.tsx`, #535); the feeds row’s step-over is the default and its source is stated |
| 3D finishing — scallop / pencil | not established | not established | 3D Scallop [FU3], Pencil [FU4] | not established | not established | not established | — | not established | not established | NO | NO |
| Rest machining | Rest machining (Pro; Pocket only per community) [CC1][CC4]† | Rest Machining [VC1] | Rest Machining option, with Scallop [FU3]† | not established | not established | not established | — | Main Tool + Clearance Tool (Guided Mode, Workflow A.2) [MK2] | not established | YES for 2D regions: rough + measured rest pair per setup (`engine/cnc/engrave/restPass.ts`, `engraveGenerate.ts` `generateRestPair`, #472); not for 3D | YES: a region row's Technical fold says “Finish the corners with a smaller cutter”, sets the setup's second cutter and states that the pass is measured from program 1's simulated stock (`RestCutterControl.tsx`, `EngraveLabelRow.tsx`, `engraveJobStore.ts` `setRestCutter`, #667); the pair is chipped on the row and named on the setups line and the run sheet. A Profile row states that a contour has no rest region |
| Surface a mesh (STL / 3MF) | 3D toolpaths from an imported model (Pro) [CC1] | STL/OBJ model, 3D Roughing and Finishing [VC1]† | 3D toolpaths on a model [FU8] | not established | not established | Rough + Contour on the model [KM1] | — | 3D Relief (type 6) imports STL (RE 06) [MK5] | Relief / 3-axis Model [SM1]† | YES: `role: 'goal'` mesh → heightfield → rough + finish (`cam/surface3d.ts`, `generateGoalProgram`) | YES: the operation picker’s **Surface a mesh** imports an STL/3MF with `role: 'goal'` and the wizard offers it on an empty job (`operationTypes.ts`, `EngravePanel.tsx`, #662); the row’s Technical fold carries the operation’s cutter, step-down/step-overs, grid pitch and stock-to-leave (`EngraveTargetObjectRow.tsx`, #535); the goal program freezes into the Cut package and uploads through the one screen’s press under its dexel check (`engraveGenerate.ts`, `EngraveCutSurface.tsx`, #535); a mesh imported as a reference stays one |
| Laser line / fill | — | — | not established | — | — | Laser Operations (machine-specific) [KM1] | Line, Fill, Offset Fill, Image [LB1] | Laser Vector (4), Laser Image (3) [MK1] | Luban is 3-in-1 incl. laser; mode names not established [SM3]† | NO — refused, decision 4 (`/Makera-Parity.md` §2). Laser dot positioning only | NO (`EngraveLaserFrame.tsx`, `EngraveLaserPoint.tsx` position only) |
| Rotary / 4th axis | not established | Wrapped Rotary Axis Toolpaths [VC1] | — (4-axis paid tier only) [FU8] | not established | 4th-axis text; 4th Axis accessory [BT1]† | Indexed Operations (not called rotary) [KM1] | Rotary Mode [LB3] | Rotation Relief (11) [MK1] | 4-axis Model [SM1]† | NO — designed (`/Rotary.md`, #545); column engine parameterised (#239); nothing reaches the IR | NO |
| Facing / surfacing the stock | not established | not established | Face† (page not opened) | not established | facing [BT1]† | Level [KM1] | — | not one of the 14 types [MK1] | not established | YES: raster skim to Z0, wood/metal only (`cam/facing.ts`, `engine/cnc/engrave/facingTool.ts`) | YES: facing switch + depth (`EngravePanel.tsx`, `setFacing`) and the start wizard's seed |
| Image to relief (greyscale to depth) | not established | PhotoVCarve Strategy [VC1] | not established | not established | not established | not established | Image [LB1] | Trace Image (tutorial) [MK3]; Laser Image | Relief: Carve (greyscale) [SM1]† | NO as such: image trace gives a thresholded cut region only (`import/rasterOutline.ts`) | PARTIAL: "Trace image…" |
| Inlay | Pro inlays (advanced V-carve) † [CC1] | Auto-inlay Toolpaths; VCarve Inlays (Pro) [VC1] | not established | not established | not established | not established | — | not established | not established | NO | NO |
| Fluting / prism / moulding | not established | Fluting; Raised Prism Machining; moulding named [VC1] | not established | not established | not established | not established | — | not established | not established | NO | NO |

## 2. Case Maker gaps

Tracking: umbrella **#676** (the matrix to 90 % YES in both Case Maker columns — 21 of the 23 non-refused rows), with the
per-row issues: #535/#536 surface a mesh (unlocks 3D roughing and parallel finishing), #667 rest pass, #664 open paths,
#668 bore (landed), #669 chamfer, #665 advanced V-carve, #671 scallop/pencil, #673 inlay, #672 image relief, #670 texture,
#674 fluting/prism, #675 per-hole peck; rotary wrap stays #545.

Refusals checked first (`MAKERA-VS-CASEMAKER.md` §G, `/Makera-Parity.md` §14.4): laser modules (decision 4),
R-7 toolpath template library, R-12 Gerber, R-13 STEP, R-15 nesting/tiling, R-16 ramping (reopened for metal
pockets only), R-14 thread milling (superseded, shipped #445). None of the items below are refused ones.

### A. The engine posts it; the UI cannot reach it

- **A1. Goal-mesh 3D surfacing (`role: 'goal'`). — CLOSED by #662, cuttable through the app since #535.** Engine:
  `generateGoalProgram`, `cam/surface3d.ts` rough + ball finish. UI: the operation picker's **Surface a mesh**
  imports the mesh with `role: 'goal'` and is offered on an empty job, where the engine posts it as the whole
  program; the program is a release source like any other (the package freezes it, the one screen's press uploads
  it under the surface check); a reference import is unchanged. Demand: the 3D relief row of
  `MAKERA-VS-CASEMAKER.md` §G (PARTIAL).
- **A2. Rest pass is implicit. — CLOSED by #667.** Engine: measured rest pair (`restPass.ts`, #472). UI: the region
  row's "Finish the corners with a smaller cutter" disclosure sets the setup's second cutter; the pair is chipped on
  the row and named on the setups line and the run sheet. A contour (Profile) has no floor area to measure, so it is
  its own follow-up row (#676).
- **A3. Per-item peck control.** Engine: `drillBit.ts` pecks (`drill.peckDiameters`, `drill.peckClearanceMm`) are shop
  settings; the Hole row exposes depth/through only. Low priority: the shop-default path is the stated design
  (`feedback_thresholds_setting_plus_recommendation`).
- **A-adjacent (engine gap, listed here because the module exists).** `cam/adaptive.ts` is tested but not imported by any
  job path in `src/`. `MAKERA-VS-CASEMAKER.md` §G row "Ramping / adaptive entry" says "wired into the job (#442)";
  my grep found no such import and the #442 commits I saw concern upload context and tool condition. Resolve before the
  next update of that row.

### B. Offered by three or more platforms; neither engine nor UI has it

- **B1. Rotary / 4th-axis wrap.** VC, MK, LB, LU, BT (†) — five. Demand: `/Rotary.md` design, #545 (engine), #239;
  Makera ships only axis-crossing relief, so wrap is the open gap.
- **B2. Open-path profile / trace from imported vectors. — CLOSED by #664.** The SVG and DXF importers now return a
  file's open paths and polylines as `OutlineImport.paths` (stroke-only open subpaths, `<polyline>`/`<line>`, open
  `LWPOLYLINE`s, unclosed `LINE`/`ARC` chains), and the dialog accepts a lines-only drawing; accepting adds one
  Engrave (line) row per path at the drawing's own scale and position, cut by the trace engine. A FILLED open path
  still does not import (SVG closes it to fill; the importer names it rather than guessing), and a stroke-only CLOSED
  shape remains a line-drawing case that is out of this slice.
- **B3. Variable-depth V-carve incl. flat-bottom (advanced V-carve).** CC (Advanced VCarve), VC, MK (type 5, hypothesis).
  Case Maker has the constant-floor V region only. Demand: #609 guilloché / rosette roadmap
  (`docs/design`, 90-degree-bit groove geometry), #268 (Makera §G "Next" for V-carve).
- **B4. Greyscale image relief.** VC (PhotoVCarve), LB (Image), LU (Relief), MK (Trace Image; Laser Image) — four. The
  goal-mesh route (A1) is the nearest engine path; there is no image-to-heightfield step. Demand: none in the repo.
- **B5. Scallop and pencil 3D finishing.** Only Fusion established; below the three-platform bar, kept here because it
  extends A1 once surfacing is in the UI. Demand: none.

Below the three-platform threshold (watch, do not file yet): edge chamfer (FU, MK — 2; MK §G marks it ABSENT), texture
(CC, VC — 2), inlay (CC, VC — 2), fluting/prism/moulding (VC — 1), bore (FU — 1). Many `not established` cells could move
a row above the line; re-count after the next source pass.

## 3. Sources

- [CC1] https://carbide3d.com/carbidecreate/core-vs-pro/ — Core vs Pro feature list (fetched).
- [CC2] https://my.carbide3d.com/pdf/carbide-create-v5.pdf — manual; table-of-contents names (Contour, Pocket, Texture, VCarve, Advanced VCarve) seen via search snippet only; body not read.
- [CC3] https://carbide3d.com/blog/carbide-create-527/ — drilling styles in release 527 (snippet only).
- [CC4] https://community.carbide3d.com/t/rest-machining-in-carbide-create/73436 — community, secondary: rest machining sits in Pocket.
- [VC1] https://www.vectric.com/products/vcarve — toolpath names (fetched); "peck" and STL/OBJ import are from retailer listings only (e.g. https://rockler.com/vcarve-desktop-10-software-for-cnc), marked †.
- [FU1] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/2D-ADAPTIVE-STEPS.htm
- [FU2] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/3D-PARALLEL-STEPS.htm
- [FU3] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/3D-SCALLOP-STEPS.htm (rest use named in search summary)
- [FU4] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/GUIDD7ECF22F-BEAA-4B6A-A2CE-DA6F2C08D787.htm — Pencil reference.
- [FU5] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/2D-BORE-STEPS.htm
- [FU6] https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/GUID-D1F8BDCF-9A4E-4636-AB22-B1721A3CE5FE.htm — 2D Chamfer reference.
- [FU7] https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-2D-THREAD-CMD
- [FU8] https://www.autodesk.com/products/fusion-360/blog/changes-to-fusion-360-for-personal-use/ — personal tier: 2/2.5/3-axis kept, 3+2/4/5-axis paid, no automatic tool change, rapids limited to cutting feed (2020 statement; re-check).
- [FU9] https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-2D-CONTOUR-CMD
- [FU10] https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-REF-DRILL-CMD
- [FU11] https://help.autodesk.com/view/fusion360/ENU/?contextId=MFG-TOOLPATH-MODIFY-LIMITATIONS — names "Slot" in a list of operations.
- [ES1] https://support.easel.com/hc/en-us/articles/44533653861139-Outline-Bit — outline / fill, on / inside / outside (snippet only; 403).
- [ES2] https://support.easel.com/hc/en-us/articles/34669367969683-Drilling-Holes-with-Easel (snippet only; 403).
- [ES3] https://forum.easel.com/t/inside-on-the-line-or-outside/45052 — community thread.
- [BT1] https://support.bantamtools.com/hc/en-us/articles/1500000623321-Conversational-CAM — facing, rectangular pocket, holes, text; Pro feature (snippet only; 403). Bantam stopped selling CNC mills 2025-11-11 per SOURCES.md (toolguyd.com pivot article).
- [KM1] https://docs.grid.space/kiri-moto/CAM/ops/ — Outline, Level, Rough, Contour, Register, Drill, Trace, Pocket; Laser Operations; Indexed Operations (fetched).
- [LB1] https://docs.lightburnsoftware.com/latest/Explainers/LayerModes/ — Line, Fill, Offset Fill, Image (fetched).
- [LB2] https://docs.lightburnsoftware.com/latest/Reference/CutSettingsEditor/LineMode/ — Tabs/Bridges (search summary).
- [LB3] https://docs.lightburnsoftware.com/latest/Reference/CutSettingsEditor/SharedSettings/ — "Rotary Mode" entry (navigation only).
- [MK1] `/Makera-Parity.md` §2 (14 strategy types), §2.1 (V-carve hypothesis), §8 (text).
- [MK2] `docs/market-research/MAKERA-VS-CASEMAKER.md` §G — type numbers, `supportTabs…`, Guided Mode, Workflow A.2.
- [MK3] https://wiki.makera.com/en/software/MakeraCAM_userguide and .../MakeraCAM_tutorials — 2D Contour/Pocket/Drilling/Thread Milling/Chamfer, 3D menu, Laser Vector/Image, Trace Image (search summary; page body did not load). The Intro page (https://wiki.makera.com/software/MakeraCAM_Intro) says 3D and Rotary are "coming soon" and conflicts with the guide.
- [MK5] `docs/reverse/makera-studio/06-toolpath-cam.md` (RE 06) — import formats, dexel tool; not re-read in this pass.
- [SM1] https://support.snapmaker.com/hc/en-us/articles/4417390934167-5-Generate-G-code — Vector: Path/Outline/Fill, tabs; Relief: Carve; 3-axis Model, 4-axis Model (search summary; 403).
- [SM2] https://forum.snapmaker.com/t/can-we-get-luban-to-do-v-carving/31313 — community: no native V-carve.
- [SM3] https://github.com/gentili/Luban — "3-in-1" (printing, laser, CNC); a fork, not the vendor repo.

Case Maker evidence (read in this pass): `casemaker-app/src/types/engraveJob.ts`, `workers/sim/engraveGenerate.ts`,
`engine/cnc/cam/{pocket,profile,trace,drill,drillBit,threadMill,facing,surface3d,adaptive,engraveJob}.ts`,
`engine/cnc/engrave/restPass.ts`, `engine/import/svgOutline.ts`, `components/panels/EngravePanel.tsx`
(`ADD_KINDS`, `ADD_COMBINED_KINDS`, `ADD_TRACE_KINDS`, `ADD_DRILL_KINDS`, cut-outs, import buttons, target object),
`Engrave{Cutout,Drill,Thread,TargetObject,Setup}Row.tsx`, `components/welcome/StartStockStep.tsx`, `store/engraveJobSchema.ts`.

## How to keep this current

- **Dated cells.** Each Case Maker cell is true of `main` 085b7bc8. Re-verify CM-E and CM-UI when an `engrave`/`fabrication`
  issue closes; a UI slice usually lands after its engine slice (A1 is the live example).
- **Closed is not shipped; open is not absent.** Check `git log --grep '#NNN'` and the last issue comment before changing a cell.
- **`not established` is a to-do, not an absence.** Turn each into a name plus a URL, or into `—` only when the vendor's own list
  excludes it. Re-count Gap B after every pass; a row crossing three platforms becomes an issue.
- **Dagger cells.** Re-open the cited page (use a browser if the fetcher gets 403) and drop the dagger once the name is confirmed.
- **Check refusals before proposing.** Read `MAKERA-VS-CASEMAKER.md` §G and `/Makera-Parity.md` §14.4 first; laser, templates,
  Gerber, STEP, nesting stay refused.
- **Engine vs UI.** Grep the importers before saying "wired": `adaptive.ts` was documented as wired and was not.
- **Add a row only with a source.** A new row needs one URL per platform it claims, or `not established`.
