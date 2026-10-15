# Case Maker — the CNC job workflow, end to end

**Status: design document, first draft, 2026-10-15.** Written for the maintainer to review in
several passes before any issue is filed. Nothing in here is built unless a section says so, and
every "today" statement is a reading of the code at `aa1343b` (the file paths are given so it can be
checked). Nothing in this document is a measurement unless it names the bench day it was measured on.

The machine is the Makera Z1 in the low-profile vise. The part is the printed two-colour PLA badge
blank: 76.2 × 38.1 × 3.82 mm (calipered 2026-10-15; designed 3.81), top colour 0.81 mm thick, magnet
pocket underneath. "Front" is the side of the machine you stand at; the **fixed jaw is on the left**,
the moving jaw on the right, and the jaws run front to back (`Z1-Firmware-Dialect.md` §11.8,
`docs/bench/2026-10-bench-plan.md`).

---

## Contents

1. [Summary, goals, principles](#1-summary-goals-principles)
2. [Today's flow, screen by screen; keep / change / add / remove](#2-todays-flow)
3. [What the field does: Makera and eight competitors](#3-what-the-field-does)
4. [The proposed workflow, step by step](#4-the-proposed-workflow)
   - 4.0 [The spine: one job, two modes, N setups](#40-the-spine)
   - 4.1 [Start: machine and stock](#41-start-machine-and-stock)
   - 4.2 [Mounting](#42-mounting)
   - 4.3 [Design: what we cut away](#43-design-what-we-cut-away)
   - 4.4 [Setups: cutting from more than one direction](#44-setups)
   - 4.5 [Tools: pick, rest, inventory](#45-tools)
   - 4.6 [Design → Cut: the mode switch](#46-the-mode-switch)
   - 4.7 [The as-cut preview](#47-the-as-cut-preview)
   - 4.8 [The run plan: phases, times, the checklist, the machine strip](#48-the-run-plan)
   - 4.9 [Probing, fast](#49-probing-fast)
   - 4.10 [Running: monitoring, interruption, restart](#410-running)
5. [Save and reload](#5-save-and-reload)
6. [Gaps, mapped to issues](#6-gaps)
7. [Open questions for the maintainer](#7-open-questions)
8. [Sources](#8-sources)
9. [Appendix A: Makera Studio, read from the install](#appendix-a-makera-studio-0120-read-from-the-install-static-2026-10-15)

---

## 1. Summary, goals, principles

### What this document proposes

One job document that goes from a blank slate to a cut part through eight questions, in this order,
and can be saved and reopened at any point:

| # | Question | Who answers it |
|---|---|---|
| 1 | **Which machine, what stock?** A stock library (house stock, vendor sizes from the synced catalogue, a loaded STL/3MF, or a shape by dimensions), with material. | the person |
| 2 | **How is it held?** Vise (measured), rotary chuck (owned, unmeasured), anchor bracket + top clamps (the Z1's own kit), tape-down. And which way round: which edge against the fixed jaw, which face up. | the person |
| 3 | **What do we cut away?** Negative volumes placed in the stock: primitives, text, SVG/DXF outlines, PrusaSlicer 3MF negative volumes, or a target object the app subtracts from the stock. | the person, the app maps and checks |
| 4 | **From which directions?** Setups — one per cutting direction. Planned by the app from the geometry, overridable. Between setups the operator remounts under exact instructions and re-probes. | the app, the person overrides |
| 5 | **Which cutters?** The app picks from the house inventory: largest reach first, a smaller cutter for the rest, with every lost region counted. | the app, the person overrides |
| 6 | **Switch to Cut.** The gate runs (generate → verify → simulate → oracle, now across tools and setups) and the screen changes from a design editor to a run plan. | the app |
| 7 | **Preview as cut, then the plan.** The stock as it will really come out, with the design-minus-cut shown and counted; then every phase with its time and its source: home, probe, tool change, air run, cut, remount, done. | the app |
| 8 | **Run it.** Upload, play, poll; vacuum on for every cut by default; the standalone vacuum switch on the machine card; air run and auto-level as phases, not file flags. | the app, with the person at the machine |

The maintainer's requested flow (items 1–8 in the brief) is kept in that order. Where this document
departs from it, it says so and why: the biggest departure is that **"what are we going to cut away"
and "where is it held" are asked once per *setup*, because a job that cuts from two directions is
two held positions**, and that fact is the whole reason setups exist (§4.4).

### Goals

- A person can take `samples/badge-blank/single.3mf`, say "cut this", answer three questions
  (stock: the badge blank; held: the vise, long side along the jaws; cutters: the house's), and
  reach a run plan that says what will happen and how long it takes, before anything moves.
- Every number on screen says where it came from — a measurement with its date, a catalogue row, a
  default, or a planning estimate — the rule the app already follows (`FieldSource`, decision 28).
- The transition from designing to cutting is one deliberate act, with one screen that explains the
  whole run in physical words before the first command goes out.
- The run plan is a list of phases with times, and the plan is what the app then executes, phase by
  phase, with the operator doing only the physical steps the app cannot.

### Principles (the house rules this design is written against)

1. **Fix the default before adding a control** (`feedback_defaults_over_knobs`). Vacuum is on for
   every cut; the air run is on for a program the machine has never run; nothing here is a slider.
2. **Measure, don't guess** (decision 28; `feedback_measure_fixtures`). Fixture and stock numbers are
   default → saved → probed, with provenance. A planning estimate is labelled as one.
3. **Every number shows its source.** Times in the run plan carry `measured 2026-10-15`,
   `planning estimate (#281 model)` or `default` beside them.
4. **The app loads the object and queries it** (`feedback_derive_from_geometry`). Setups, probe
   plans, reach and lost detail are derived from the geometry, never hand-placed.
5. **Nothing vendor-derived is committed** (#347 Route A). Vendor stock sizes and feeds come from the
   user's synced catalogue at runtime, and the design says so where it depends on them.
6. **The physical stop is the stop** (`Fabrication.md` §8). The app never moves the machine without
   a person at it; every phase that moves says so and waits for the "I am at the machine" state.
7. **Landmarks, not coordinates** (`feedback_landmark_geometry_comms`). Operator instructions say
   "the edge against the fixed jaw", "the end nearest you", never "X = 0".
8. **Demand-driven** (`feedback_demand_driven_features`). Things nobody owns or has asked for
   (a vacuum bed, a fixture plate, a sphere stock) are named as not offered, not built.

---

## 2. Today's flow

What exists at `aa1343b`, screen by screen. Paths are under `casemaker-app/src/`. Two gates apply
throughout: the CNC sections are behind `featureSim` (`?BETA=yes` on the web build,
`components/layout/Sidebar.tsx:31-47`), and everything that touches the machine is desktop-only
(`canDriveMachine`).

### 2.1 The screens, in order

**A. Welcome → "Set up a cutting job…" → the Start wizard** (`components/welcome/StartWizard.tsx`).
Three steps. (1) *Machine*: a select over `MACHINES` (one entry, Makera Z1), and on the desktop a
network check / address / connect; result shown as found / not-found / unavailable / error; writes
`machineId`, the probe result and, when the frame was read, the calibration. (2) *Job*: `badge-blank`
or `blank`; builds the project and seeds the stock from it (`seedStockFromProject`). (3) *Setup*: hands
over to the setup wizard. Next is never disabled.

**B. The setup wizard "Set up this job"** (`components/panels/EngraveSetupFlow.tsx`,
`engine/cnc/engrave/setupFlow.ts`). Four steps: holding (vise; rotary chuck shown but disabled;
sacrificial material none/board/strips/custom), material (the starting feeds table's materials plus
the machine profile's — ten on the Z1, #347), blank (length X, width Y, thickness, provenance note,
the "set stock proud" fix box), cutter (one select over the tool registry). "Same as last job" fills
all four. One write on Finish (`applyAnswers`), every field `source`-tagged. **No step gates**: it
shows the findings its filter selects and lets you continue.

**C. The Engrave panel** (`components/panels/EngravePanel.tsx`), one long form: Set up this job… ·
Stock (Use the badge blank / Use the blank; L×W×T; material with source tag; "X runs between the vise
jaws. The fixed jaw is on the left.") · Voids under the face · Items (labels, shapes, combined,
single-line traces, holes, vectors; "+ Add…" with Import outline (SVG/DXF) and Trace image) · Depth
margins · Tool (select, recommendation with "Why?") · Vise (six fields, Save as my vise / I just
measured these) · Sacrificial material (presets, board, strips) · Cutting (feeds with source and
clamp tags, overrides) · Findings · Generate (toolpath / verified / simulated / oracle rows,
acknowledgement checkbox, Save .nc…, Upload to machine…, Run sheet…, Open run record…). Every edit
goes through `engraveJobStore`, persists to localStorage, and marks the run stale.

The viewport shows `EngravePreview`: floors coloured by depth or by the colour they land in,
translucent jaws, sacrificial bodies, voids in amber, origin axes, a depth legend. It draws the
**opened** region (glyph grown and shrunk by the cutter radius), so it already is a tool-limited
preview for flat cutters.

**D. The run sheet** (`components/panels/RunSheetView.tsx`, built by
`engine/cnc/engrave/runSheet.ts`): nine sections — what you need, mount the vise, load the blank,
fit the cutter and M491, set the work origin (derived from the workholding plan, #272), dry run
(the `<job>-frame.nc` air trace at 20 mm), cut, warnings, record afterwards — with a top-view SVG of
stock, jaws and origin, and a side view when sacrificial material is declared. Sections 2, 4 and 5
are tagged "not yet confirmed on the machine (#208)". The material-position check (§5's scan, #391)
is written and tested but held: nothing prints it.

**E. Upload** (`components/panels/EngraveMachineUpload.tsx`): "Upload to machine…" → a confirmation
naming the file, bytes and host → `/sd/gcodes/`. It says, correctly, that it "does not start the job".

**F. The Simulate panel** (`components/panels/SimPanel.tsx`): open any `.nc`, confirm stock and tool,
sweep, read diagnostics, scrub the transport, restart-from-step as a gated `.nc` (#249). The column
backend sweeps a V-bit as a cone since #405; the drawn tool is always a cylinder.

**G. Manage mode** (`components/manage/`): Tools (house inventory: owned / yours / catalogue /
built-in; register by scan, catalogue or form; clone; sync; export/import `house.json`) and Machines
(the Z1's card: check / connect / forget, calibration, "my machine" export/import, the **vacuum
switch** and the one-line **console**, desktop only). Materials is in the rail, disabled, "later".

**H. Outside the app.** Starting a job, watching it and stopping it are `tools/z1/z1.mjs run` from
Windows (`play`, `?` every 2 s, finish at `P` = 100 and `Idle`, Ctrl-C sends `abort` then `M332`).
Probing (`G38.2`) and tool length (`M491`) are typed into the console or the harness. The PrusaSlicer
3MF import is `scripts/engrave-job.ts --from-3mf` (desktop script only). The job itself is saved only
in localStorage (`casemaker.engraveJob.v1`); `.job.json` files are written and read by scripts only;
the project file deliberately excludes the engrave job (`types/engraveJob.ts:8-12`).

### 2.2 What is strong today, and what the brief's eight items hit

The pipeline below the UI is further along than the UI: exact 2.5D sweep, fixture and holder
collision as errors, the oracle, the derived run sheet, provenance everywhere, the verified upload
with a live Idle check, the house inventory with box-code scanning. The brief's items land on the
UI, and on the few places where the pipeline still stops short:

| Brief item | Today | Gap |
|---|---|---|
| 1 Stock library, load a shape, make one by dimensions | three stock routes: typed L×W×T, "Use the badge blank", "Use the blank"; material from the table ∪ profile | no library of sizes; no STL/3MF as stock; no tube/rod/sphere; Materials scope "later" |
| 2 Mounting | vise only (rotary disabled); sacrificial board/strips; orientation fixed "X between the jaws" and **wrong for the bench** (#383) | rotary, anchor bracket + clamps, tape; orientation as clamped |
| 3 Cut-away | labels, shapes, combined, traces, holes, SVG/DXF vectors, raster trace — all 2.5D with a typed depth | 3MF negative volumes (script only, #410); a target object; 3D shapes (#222); multiple sources is fine already |
| 4 Save/reload | localStorage autosave; scripts' `.job.json` | no Save/Open in the app; the project excludes the job |
| 5 Switch to cutting | Generate → three gate rows → Save/Upload, all inside the same long panel | no mode; no transition screen |
| 6 Preview as cut | opened-region preview; sweep result in the viewport; `item-detail-lost` numbers | one tool, one setup; the lost region is a number, not a drawn layer; V groove has no oracle (#408) |
| 7 Phases with times | one estimate (cutting + rapids, trapezoid, #242/#281) on the Generate row, the sheet and the `TIME` header | no phases: no home, probe, tool change, air run, remount, done; no per-tool split (#278) |
| 8 Machine features | vacuum in the file (`M331`/`M332`) and a manual switch (#390 proposed, `MachineVacuum.tsx` exists); nothing for lights, air run, auto-level in the app | a home for them in the run plan |

### 2.3 Keep / change / add / remove

| Verdict | What | Why |
|---|---|---|
| **KEEP** | the four setup questions and their one `applyAnswers` write; `FieldSource` on every answer; "Same as last job" | #254's shape is right; this design reorders and extends it, it does not replace it |
| **KEEP** | the gate (generate → verify → simulate → oracle), Save disabled with the reason, the acknowledgement | #206 is the safety spine; Cut mode wraps it |
| **KEEP** | the run sheet's derived origin section, the top-view diagram, record blanks, run records | it becomes the Cut mode's printable form of the run plan |
| **KEEP** | the Simulate panel as the bare-`.nc` door | unchanged; the engrave sweep feeds the same viewport |
| **KEEP** | Manage › Tools, Machines, the console, the vacuum switch | the house is where cutters and machines live, not the job |
| **CHANGE** | Start wizard step 2 ("badge-blank / blank") → **stock from a library** (§4.1) | the brief's item 1; the template route stays as the house stock's "badge blank" entry |
| **CHANGE** | setup step 1 "What is holding the part?" → **mounting with orientation** (§4.2): which edge against the fixed jaw, which face up | #383 is a bug today because orientation is a sentence in the panel, not a question |
| **CHANGE** | the single `toolKey` → a **tool list per setup**, auto-picked with rest machining (§4.5) | #410's scope addition; #278's model |
| **CHANGE** | Generate row → **the Design → Cut switch** (§4.6) with its own screen | the brief's item 5 |
| **CHANGE** | "estimated cutting time" → **a phase list with per-phase times and sources** (§4.8) | the brief's item 7 |
| **CHANGE** | Upload "does not start the job" → **Run** in Cut mode: upload, play, poll, phase by phase (§4.10) | #386's policy is settled; the harness proves the path |
| **CHANGE** | the engrave job in localStorage only → **a saved job file** with Open/Save/Save as, plus autosave (§5) | the brief's item 4 |
| **ADD** | setups (§4.4), the remount instructions and the per-setup re-registration | the maintainer's addition, 2026-10-15 |
| **ADD** | the as-cut preview's "what was lost and where" layer (§4.7) | the number exists; the picture does not |
| **ADD** | the fast position check (§4.9), executed by the app with the person at the machine | #391, redesigned for ~1.5 min instead of 8–12 |
| **ADD** | machine strip: vacuum (default on), air run (default on for a new program), auto-level (default from the stock's flatness), light | item 8 |
| **REMOVE** | the run sheet preamble "V1 does not talk to the machine … uploaded through Makera Studio" (`runSheet.ts:51-53`) | stale since #255 |
| **REMOVE** | the panel sentence "X runs between the vise jaws" as a fixed truth | it becomes the orientation answer |
| **REMOVE (do not build)** | a first-run machine wizard, a job queue, feed/spindle override sliders, a G-code editor | refused in `Makera-Parity.md` §14.4 (R1, R8, R9, R10); nothing here reopens them |

---

## 3. What the field does

Sources for every row are in §8. "unverified" means the researcher could not confirm it from an
official page. Makera's wiki is JS-rendered; what we know of it is the seven cached pages in
`docs/market-research/raw/makera/` plus the Carvera Community Controller's source, which is a fork of
Makera's own client.

### 3.1 Makera's own flow, and what it sells

**Makera CAM (Carvera / Carvera Air).** Launch: `3 AXIS` / `4 AXIS` presets stock and WCS; project
file `.mkc`. Stock panel: material (from a Material Library of named materials), Length/Width/Height,
and for 4-axis a Shape = Square / Round. Origin: WCS tabs, each picking one of 10 control points on
the top or bottom plane of the stock; a second WCS is how a two-sided job is done. Import: image
(JPG/PNG/BMP), 2D (DXF/SVG), 3D (STL/STEP), PCB (Gerber/Excellon). **No 3MF** (MakeraCAM#25 is a
crash on `.3mf`). Operations: 2D contour/pocket/drill/thread/chamfer, 3D relief/contour/pocket,
rotation relief, laser; no dedicated V-carve (V-bits go through contour/chamfer with the Engraving
tool group); pocket and relief support multi-tool clearing (large tool first, then smaller — "combine
tools with the same shank diameter"). Tool library: per-tool, per-material cutting data; **the tool
number is the tool-change identity** — on an ATC machine the slot, on the Air/Z1 "different tool
number assignments will prompt pausing and manual tool change operations". Preview is a toolpath line
preview; an as-cut result and a time estimate are not documented (unverified). Export writes one
`.nc`; Makera CAM does not talk to the machine. (`software-MakeraCAM_userguide.txt`,
`software-MakeraCAM_tutorials.txt`.)

**Makera Controller (Carvera / Air) — the pre-run dialog.** From the community client's `makera.kv`:
Background (fixture image), Auto Vacuum, Auto Ext. Out, **Work Origin** (relative to Anchor 1 or 2 with
X/Y offsets, or Set By XYZ Probe), **Scan Margin** (the probe's laser traces the job rectangle),
**Auto Z Probe** (point relative to the work or path origin, default 10,10), **Auto Leveling** (points
and height), **Resume at line**, Run. The toggles emit one `M495 X Y C D O F I J H` macro, and the
firmware reports its sub-states (drop tool, pick tool, calibrate, margin, Z probe, autolevel, done).
Tool change mid-job on a no-ATC machine: pause, popup, swap, Confirm or the front button, then the
machine measures the new tool on its sensor. Pause is `M600`; resume is `goto <line>`. The community
fork replaced the line-count time estimate with a motion-based one, added tool-change markers on the
progress bar, and set Scan Margin / Auto Z Probe to default **off** "to encourage novice users to not
one-shot setup". Power-loss recovery: nothing documented.

**Makera Studio (Z1).** The Z1 is driven by Studio + the Makera App. `Z1-QuickStart.txt` "Your First
Job": Start → enable **Auto Vacuum, Auto Blow, Auto Bed Clean** → Work Origin relative to Anchor 1
(X 0, Y 0) → Scan Margin → Auto Leveling (3 × 3 points, probe height 2 mm) → Run. The wired probe is
loaded into the collet like a tool when prompted; the anchor L-bracket supplies X/Y ("the system will
automatically detect the lower-left corner as the machining origin"). Studio's device page shows
toolpath preview, positions, jog, origin setting, Auto Probe / 3D Probe, start/stop, progress, elapsed
and remaining time (cnx-software review). One review's friction note: "You have to pick a process
mode in Studio whenever you create a new project" (All3DP). Our own read of the install
(`Makera-Parity.md` §8): 25 minidumps, uninitialised doubles persisted as settings, and the three
dialogs that establish where the part is logging null-parameter errors.

**Read from the install itself (Appendix A).** Studio's real per-run flow is a five-step **Machining
Wizard** — *Set Stock → Set Origin → Auto Probe → Assist Options → Run* — with a top-view map of
the bed, the anchor bracket, the toolpath area, the work origin, the Z-probe point and the levelling
grid; its design side is a **process mode** chosen per project (2D Vector, 3D Model, 3-Axis Relief,
Custom 3-Axis, Custom 4-Axis, Laser) with a **Guided Mode** of scheme steps that calculates tools
(a Main Tool, one roughing tool, an optional Clearance Tool, finishing); its project holds a
**workblank** = material + material spec (a vendor size) + L×W×H + chuck diameter. The appendix
gives the evidence file for each of those statements and the commands the wizard actually sends.

**What Makera sells** (US store; sizes only where the page shows them): 6061 aluminium block 35×35 or
50×50 section × 100 / 200 mm; clear acrylic 3 / 4 / 5 / 10 mm × 100×150 or 150×200; 1.5 mm PCB blanks
100×150 or 150×200; brass sheet 1 / 3 / 5 / 10 mm × 100×100 or 100×200; epoxy tooling board 10 / 20 mm
× 100×100 / 100×150 / 150×200; copper, Delrin, carbon fibre, Bakelite, synthetic stone and bicolour
stock with no sizes captured; **no wood stock at all**. In the Z1 box: epoxy board 100×100×10,
aluminium plate 100×100×5, MDF 100×100×2, bicolour 100×100×1.3. Accessories: the low-profile vise
($99, no dimensions published anywhere), vacuum bed ($149), top clamp set, side clamps, L-bracket,
double-sided tape 20 mm, bit collars and installer, collets 1/4" / 6 / 4 / 3 mm, wired probe V2, 3D
wired probe ($99, conductive stock only), 4th axis ($299, ⌀80 × 150), laser 5 W ($149). Makera's own
Studio library holds 15 materials and **189 purchasable stock sizes** (137 rectangular, 52 round) in
`t_MaterialSpecs` (`Makera-Parity.md` §5) — the sizes the picker in §4.1 reads at runtime.

**Speeds and feeds** (`speeds-and-feeds.txt`): one table for 1/8"-shank bits × Aluminum / Brass /
Carbon Fiber / Copper / Hardwood / PCB / Plastic / Softwood, each cell RPM / Feed / Plunge / DOC, with
"start the test from the lower limit". The non-metal single-flute rows are identical across
diameters: per group, not per cutter. No PLA.

### 3.2 Eight competitors, side by side

| | Stock library with sizes | Mounting as an input | Design in: SVG · DXF · STL · 3MF · text | Tools: library · owned · multi-tool · rest | As-cut preview | Time estimate | Probe / zero | Tool-change length | Dust/air/light in the job flow | Run monitor · pause · restart from point | Two-sided | Project file |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Carbide Create + Motion** | no (L×W×T + material category) | no | Y·Y·Pro·N·Y | Y·N·Y·Pro | animated simulation | CC and CM disagree 30–40 % | BitZero corner/Z | BitSetter, measured on every Z-zero (CM 623+) | door interlock pause | Y · Y · from start only | manual mirror, user jig | `.c2d` + `.nc` |
| **Easel** | no (material dropdown + L×W×T) | no | Y·Y·Y·N·Y | Y·N·two-stage·N | "Uncut Area" shaded | quick + full "machine-specific" | Z-probe plate; "USE LAST XY" | re-probe each change | spindle-on confirm | Y · ? · ? | mirror + dowels, forum lore | cloud; ZIP export not re-importable |
| **VCarve** | no (job size + material appearance) | no | Y·Y·N·N·Y | Y·N·Y·Pro | **yes**: per-tool fill, animate, step | feeds + rapid rate + scale factor; V12.5 acceleration | none (CAM only) | n/a | n/a | n/a | **first-class**: Double Sided, flip direction, Preview All Sides, per-side job sheet | `.crv` |
| **Fusion Manufacture** | no (stock modes: fixed/relative box, from solid, from preceding setup) | fixtures as collision bodies | Y·Y·Y·N·Y | Y·N·Y·**Y** (source selectable) | yes, with model comparison | statistics; under-estimates without a machine model | industrial only | n/a | n/a | n/a | **setups** with stock carry-over (most complained-about feature) | `.f3d` cloud |
| **Snapmaker Luban** | no (work size, no thickness) | no | Y·Y·Y·N·Y | profiles·N·N·N | toolpath / simulation toggle (fidelity unverified) | none found | paper-feel Z; Run Boundary | re-zero | none | Y · Y · power-loss Resume on the controller | no | Save/Open (ext. unverified) |
| **xTool XCS / Studio** | material library (laser params), thickness by auto-measure | n/a | Y·Y·N·N·Y | n/a | video-style preview; Studio shows cut-through | yes on some models | auto-focus; framing | n/a | **air assist levels, exhaust run-on, purifier** per job | Y · Y · ? | no | `.xcs` |
| **Glowforge** | **QR on the stock** sets material + settings | n/a | Y·N·N·N·Y | n/a | none | yes, in the sidebar | Set Focus (camera) | n/a | fans run on | button pause; lid = abort | no | cloud |
| **LightBurn** | material library of settings (name › thickness), no sizes; Material Test grid | n/a | Y·Y·N·N·Y | n/a | path preview with time slider | parameters exposed; "Read From Controller" | n/a | n/a | start/end delays for exhaust | Y · Y · **"Start Here"** at any timeline point | no | `.lbrn2` |
| **Bantam Tools** | **"standard size or custom"** + fixturing dropdown + tape thickness | **yes** (bracket, placement) | Y·N·via G-code·N·Y | Y·Y·Y·N | collision warnings on the summary tab | not found | bracket Locate; conductive XYZ; Z-only; manual | **touch-off on every Install Tool** | — | Mill Single / All; pause at tool change | PCB flow: flip with same-corner rule and pictures | none |
| **Makera CAM + Controller / Studio** | material library; stock L×W×H; 189 sizes in the DB | anchor bracket as datum | Y·Y·Y·**N**·Y | Y·N·Y (tool numbers)·Y (clearing) | toolpath lines (as-cut unverified) | line-count (official) / motion (community) | anchor + Auto Z Probe; Scan Margin; Auto Leveling | sensor after every change | Auto Vacuum, Auto Blow, Auto Bed Clean, light | progress + remaining; `M600`; resume at line | second WCS tab; pins; no mirror | `.mkc` |
| **Case Maker today** | house: badge blank, blank; material ∪ profile | vise, sacrificial | Y·Y·N·script·Y | house tiers·**owned + scanned**·N·N | opened region + exact sweep + oracle | cutting + rapids, trapezoid, unmeasured | prose on the sheet; held scan | prose: M491 | vacuum in file + switch | upload only; harness runs | no | localStorage |
| **Case Maker proposed** | house + vendor sizes at runtime + loaded shape + by dimensions | vise · rotary · bracket + clamps · tape, **with orientation** | Y·Y·Y·**Y**·Y + target object | house·owned·**auto multi-tool with rest** | as-cut across tools and setups, **lost layer drawn and counted** | **phases with sources** | app-driven fast scan, Z0 in #387's order | M491 as a phase | vacuum default on, air run, auto-level, light — in the run plan | play/poll in-app, phase progress, restart from step, resume at setup | **setups** with remount instructions and re-registration | job file + autosave + run records |

What each column taught us, in one line each:

- **Stock as a thing you pick, not type**: only Bantam ("standard size or custom") and Glowforge (QR)
  do it. Makera's DB has the sizes and its UI does not use them. Cheap for us because the catalogue
  sync already reads that database.
- **Mounting as an input**: Bantam and Makera (the anchor) are the only ones that ask. We already
  decided this (decision 26); the UI just has to ask it with orientation.
- **As-cut preview**: VCarve and Fusion are the bar; Easel's "Uncut Area" is the cheapest honest
  version. We have the number; §4.7 draws it.
- **Time estimates**: nobody publishes accuracy; everybody admits it is feed arithmetic unless
  acceleration is modelled (VCarve V12.5, LightBurn, Easel). Nobody shows **phases** — tool changes
  appear as markers on a progress bar at best (community Carvera client). §4.8 is better than all of
  them because the phase list is the plan the app executes.
- **Tool-change length**: Carbide ties it to Z-zero, Bantam to Install Tool, Makera to the sensor
  after every change. Ours is `M491` as a phase with its own time (~32 s measured).
- **Machine features in the job**: xTool (air assist levels, exhaust run-on) and Makera (the three
  "Auto" toggles in the pre-run dialog) are the models. Neither separates "this program's setting"
  from "the machine right now"; §4.8 does, and #390 is the "right now" half.
- **Restart**: LightBurn's "Start Here" is the only timeline restart. #249 already gives us a gated
  restart `.nc` from a step; §4.10 puts it in the run screen and extends it to "resume at setup N".
- **Two-sided**: VCarve declares it (flip direction, per-side sheet); Fusion carries stock between
  setups and users fight its origin drift; Bantam's PCB flow gives the only operator pictures ("same
  corner of the board on both sides"). Nobody plans setups from geometry; §4.4 does, and tells the
  operator which edge goes against the fixed jaw.
- **Studio's weaknesses are our requirements** (`Makera-Parity.md` §8.1): never trust a persisted
  number, clamp to the machine, the viewport must not take the app down, simulate and show it, one
  spelling one place. And from the community tracker: one-step send-and-run, run-dialog state that
  survives a cancel, a margin preview that needs no laser, collision checks before export.

### 3.3 Two-sided and multi-setup, product by product

| Product | How sides are declared | How side 2 is aligned to side 1 | Operator instructions | Stock state after side 1 | Time per setup |
|---|---|---|---|---|---|
| Fusion | one **Setup** per side; WCS flipped (Flip Z); Stock = *From preceding setup* + *Continue rest machining* | none built in: the user's WCS + modelled fixture; forum practice is centre-symmetric dowels or zero to a modelled pin | Setup Sheet per setup: screen image, WCS, stock, time; no "flip it this way" | carried (simulated in-process stock); known origin-drift complaints, STL workaround | per setup sheet |
| Carbide Create | none: staff workaround is a double-height stock with a mirrored copy in the lower half, one group per side | physical: centre dowels ("doubles any error"), a machine-cut flip frame (staff preference), a through-hole, a corner square; a $120 Nomad Flip Jig | none | none (per-toolpath preview) | per file |
| VCarve | **Job Setup › Double Sided**; flip direction horizontal/vertical (data auto-mirrored); Z-zero per side or shared; XY datum shared; Toggle Side `1`/`2`; toolpaths listed per side | "keep a common registration position when turned over"; dowel practice is community lore | job sheet per side names the side and the flip direction | *Preview All Sides* combines both; no rest from the other side | per toolpath on each side's sheet |
| Makera CAM | a second **WCS tab** on a bottom-plane control point; "draw holes for alignment pins" | anchor bracket corner + re-probe Z; pins; the 3D probe's centre-finding; Scan Margin by eye | none found | none found | none found |
| Bantam (PCB) | Top/Bottom toggle | **same corner of the board** against the bracket, left corner then right corner; software mirrors and shifts the bottom | step-by-step prose with photos and a troubleshooting table (wrong corner, tape, debris) | n/a (PCB layers) | n/a |
| Kiri:Moto | `flip` op rotates the model 180° about X or Y | a `registration` op **drills registration holes from the stock parameters**; v4.4 notches the tabs so the flip orientation is visible | tabs show the orientation | unverified | — |
| **Case Maker proposed (§4.4)** | **setups planned from the cut-away geometry**, one per direction; manual override | the vise: X and rotation from the fixed jaw (±0.05), Y and Z from the fast scan (±0.3–0.5); features cut in setup 1 as references when the scan can read them; the rotary chuck as the no-remount alternative | **exact physical instructions with a picture**: which face up, which edge against the fixed jaw, what is now at the front; what to check before tightening | **carried**: setup N+1 is simulated on setup N's result, so the preview and the gouge checks see the real stock | **yes**: remount and re-probe phases with times, per setup |

Recurring failure modes from the forums, which §4.4 is designed to refuse or name: re-zeroing XY
after the flip (we keep X on the fixed jaw and re-find only Y); the physical flip not matching the
CAM mirror (we give the instruction and the picture and ask one confirmation question); the stock not
matching the CAM block (we measure the stock in §4.1 and probe it in §4.9); centre-referenced
doubling of error (we reference the fixed jaw, an edge); pin slop (no pins: the vise is the jig);
re-homing between sides (homing is fine on this machine — `$H` repeats; it is the work offset that
must not be re-typed).

---

## 4. The proposed workflow

### 4.0 The spine

```
   ┌───────────────── DESIGN MODE ─────────────────┐     ┌──────────────── CUT MODE ────────────────┐
   │ 1 Stock  → 2 Mount → 3 Cut-away → 4 Setups    │ ──▶ │ 6 Gate → 7 As-cut + Run plan → 8 Run     │
   │           ↑           ↑            ↑           │     │   ▲                                      │
   │     (5 Tools: picked by the app, overridable)  │ ◀── │   └── any edit in Design marks Cut stale │
   └───────────────────────────────────────────────┘     └──────────────────────────────────────────┘
                     one job document: <name>.cutjob.json  (autosaved; Save / Open / Save as)
```

- **One job document** holds everything (§5). It is reachable with no case project open; the badge
  and blank templates are entries in its stock library, not projects it has to create first (#274's
  second criterion, settled here as "the job is its own document").
- **Two modes, one header toggle.** Design is the editor (today's panel, reorganised around the
  questions). Cut is the run plan and the machine. The switch is the gate (§4.6).
- **Setups are a list inside the job**, one per cutting direction (§4.4). A single-setup job — the
  badge — shows no setup UI beyond one line ("1 setup: face up, long side along the jaws").
- **Tools are chosen per setup** by the app and shown as a consequence, with override (§4.5).

The wizard is kept as the **door**, not as a gate: the Start wizard asks the questions of §4.1 and
§4.2 in two screens and lands in Design mode with the job seeded; every answer is also a section of
the Design panel and can be changed there. "Same as last job" stays.

### 4.1 Start: machine and stock

**Purpose.** Name the machine (a statement about the job, not a connection — #347) and the stock, so
every later number has an envelope, a material and a shape to be clamped to.

**Screen.**

```
 ┌─ New cutting job ─────────────────────────────────────────────────────────────┐
 │ Machine   [ Makera Z1 ▾ ]   ● found at 192.168.10.43 · Idle · homed  (desktop) │
 │                                                                                │
 │ Stock                                                                          │
 │  ┌ House ───────────────┐ ┌ Makera (synced 2026-10-08) ─┐ ┌ Load ────┐ ┌ Make ┐ │
 │  │ ● Badge blank        │ │ 6061 Al block 35×35×100     │ │ STL/3MF  │ │ Block│ │
 │  │   76.2×38.1×3.82 PLA │ │ Acrylic 3 mm 100×150        │ │ …        │ │ Rod  │ │
 │  │   two-colour, pocket │ │ PCB 1.5 mm 100×150          │ │          │ │ Tube │ │
 │  │ ○ Plank 100×60×12    │ │ Brass sheet 1 mm 100×100    │ │          │ │ Round│ │
 │  │ ○ Last job's stock   │ │ (189 sizes, filter ▾)       │ │          │ │ stock│ │
 │  └──────────────────────┘ └─────────────────────────────┘ └──────────┘ └──────┘ │
 │                                                                                │
 │ Badge blank   L 76.2  W 38.1  T 3.82 ▸ measured 2026-10-15   Material PLA      │
 │  Two-colour: top 0.81 mm (layer-aligned, 0.2 mm layers · provisional)          │
 │  Voids: magnet pocket (from the badge)   Flatness: domed 0.33 mm (probed 10-08) │
 │                                                     [ Cancel ]  [ Next: mount ] │
 └────────────────────────────────────────────────────────────────────────────────┘
```

**Four doors onto the stock, in this order:**

1. **House stock** — committed entries we own: the badge blank (from `badge.ts`, with its magnet
   pocket, its print spec and its colour split), the demo plank, and "last job's stock". A house
   entry can be **saved from any job** ("Save this stock to the house"), which is how a user's own
   offcuts and blanks become one-click choices. Stored in `house.json` beside the tools (decision 29:
   the house owns consumables as well as cutters; Manage › Materials stops being "later").
2. **Vendor stock** — the 189 sizes from the synced catalogue, read at runtime from `catalogue.json`
   (`t_MaterialSpecs`: name, shape R/C, L/W/H or diameter). **Not committed** (#347 Route A: names
   and numbers stay in the user's data directory). On the web build or with no catalogue the column
   is absent with the sentence that says why, like the Tools scope. Picking one copies the size into
   the job with `source: 'catalogue'`; the material maps through the existing exact-name map, and a
   material the app has no word for is offered as stock but its feeds refuse by name, as today.
3. **Load a shape** — an STL or 3MF **as the stock**. The app reads the mesh, reports its bounding
   box and whether it is a prism (every Z slice identical → cut as a block of that outline) or not
   (then it is 3D stock, which needs the dexel engine, #222: offered, refused by name with the
   issue). A PrusaSlicer 3MF whose object has negative volumes is recognised here and offered as
   **"stock + design"** in one step: the model parts become the stock, the negative volumes become
   the cut-away items (§4.3, #410). For `single.3mf` that is the whole of steps 1 and 3.
4. **Make one** — by dimensions and material: **block** (L×W×T), **rod** (⌀ × length; rotary stock,
   class W/I in `Rotary.md`, and the only shape the rotary chuck takes), **tube** (⌀outer × ⌀inner ×
   length; rotary or on-end in the vise), **round stock on its face** (a disc: ⌀ × T, held in the
   vise on parallels or on the anchor bracket). **Sphere: not offered.** Nothing we own can hold one,
   nothing in the pipeline can cut one (it is 3D everywhere, #222), and nobody has asked; the picker
   says so rather than greying a button.

**Inputs and defaults.** Dimensions carry their source (house: `measured` with the date; vendor:
`catalogue`; loaded: `file`; made: `user`). The material list stays the table ∪ profile list (#347).
Two-colour, print spec and voids come with a house entry or a 3MF; a block has none.

**Validation.** Stock outside the machine's envelope (200 × 200 × 100) is refused at this screen,
naming the axis. A vendor material with no feeds row is allowed here and refused at the tool step
with the row named. A loaded mesh that is not watertight is refused with the count of open edges.

**Saved:** `stock { shape, dims, material, source, origin: { kind: house|catalogue|file|user, id|path+hash }, print?, voids?, flatness? }`.

**Next:** Mounting.

### 4.2 Mounting

**Purpose.** How the stock is held and **which way round**. Decision 26 made workholding an input;
#383 showed that orientation is half of that input and has been a silent constant.

**Screen.**

```
 ┌─ How is it held? ──────────────────────────────────────────────────────────────┐
 │ ● Low-profile vise   (measured once on the reference unit, ±0.5 — #208)         │
 │ ○ Rotary chuck       (owned; not characterised yet — #238)        [why? ▾]      │
 │ ○ Anchor bracket + top clamps  (the Z1's own kit; not modelled yet)             │
 │ ○ Tape on the wasteboard       (#191 run sheet exists; tilt needs G32)          │
 │   Fixture plate / vacuum bed: not owned, not offered — ask if you have one.     │
 │                                                                                 │
 │ Which way round?                                   ┌───────── top view ──────┐  │
 │  Face up:     ( top colour ▾ )                     │ fixed │   blank   │ mov │  │
 │  Against the fixed jaw (left):  ( a long edge ▾ )  │ jaw   │  76.2 ↕   │ jaw │  │
 │  Nearest you (front):           ( a short end ▾ )  │ 10 mm │  38.1 ↔   │     │  │
 │  → the blank stands 0.72 mm proud (seated on the   └─────────────────────────┘  │
 │    3.1 mm ledge)  · grip 3.1 mm  · jaw opening 38.1                             │
 │                                                                                 │
 │ Sacrificial material: ( none ▾ )   board under · strips beside · custom         │
 │                                                     [ Back ]  [ Next: cut-away ] │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

**The orientation question is three landmark choices**, and the picture redraws as they change:
which face is up (for a two-colour blank: top colour / bottom colour; for a block: a named face),
which edge is against the fixed jaw, which end is nearest you. The app then knows the job frame:
work X runs from the fixed jaw across the gap, Y along the jaws toward the back, Z0 on the up face.
The run sheet's "X runs between the jaws" sentence becomes a *derived* statement.

**Defaults.** The badge blank: top colour up, a **long edge against the fixed jaw** (the bench's
clamping, #383: 38.1 across the jaws, 76.2 along them), the end with the logo nearest you (reading
direction is a parameter #410 asks for). `stockProud` defaults to the seated value `min(4, t/2,
t − 3.1)` (#391 review, shipped) — and the thin-blank case (#406) is shown as the finding it is.

**Validation (as today, now visible here):** `vise-grip-shallow`, `stock-proud-too-small`,
`vise-jaw-short` (the 100 mm jaw vs the stock's along-jaw length), and a new one: **jaw opening**.
The vise's maximum opening is published nowhere and unmeasured; until it is, a stock wider across
the jaws than the measured 38.1 mm clamping carries `vise-opening-unmeasured` (warning) — a one-line
caliper job (§7).

**Rotary chuck.** Offered, not greyed: a rod or tube stock switches the frame to the cylinder
(`Rotary.md` §3.6) and the setup list to one setup with "faces" instead of remounts (§4.4). Until
#238 characterises the module it is refused at the gate by name, not hidden at this step: the shape
of the question has to be right before the geometry is.

**Anchor bracket + top clamps.** The Z1's native datum ("the system will automatically detect the
lower-left corner as the machining origin", `Z1-QuickStart.txt`). Not modelled today; it is the
right mount for a disc or a plate wider than the vise opens, and the obstacle model for it is the
clamp footprints (decision 26's `top-clamps` variant already exists in `setup.ts`). Listed so the
gap is visible (§6).

**Saved:** `mount { kind, orientation { faceUp, againstFixedJaw, nearestYou }, vise|chuck|clamps|tape params with source, sacrificial }`.

### 4.3 Design: what we cut away

**Purpose.** State the removal as geometry the app can measure, then let the app say what a real
cutter makes of it.

**Two ways to say it, both allowed in one job:**

- **Negative volumes** placed in the stock (the brief's "cube, tube, rod, sphere, text"): every item
  today (labels, shapes, combined, traces, holes, vectors) plus **3D primitives** — a box, a cylinder
  (a rod-shaped void, axis in any of the three directions), a tube (an annular void), a sphere (a
  dimple), **and 3MF negative volumes** (#410) with their names, footprints and depths read from the
  file. Any number of items from any number of files.
- **A target object**: load an STL/3MF of the *finished part*, and the removal is `stock − object`.
  The app maps the object into the stock automatically (largest face up, bounding box centred in XY,
  top face flush with the stock's top; or, for a 3MF that already positions the part inside the
  blank, exactly as the file has it) and the user can move and rotate it. Everything outside the
  object is to be removed, which almost always means a **through-cut and a cut-out** — so this mode
  depends on #218 (tabs, loose-piece check, sacrificial board) and says so at the moment it is
  chosen.

**Boolean semantics, stated once.** Removal = union of every item's volume, clipped to the stock.
Overlapping items are fine. Each 2.5D item has a depth from the up face (typed, or `surface` /
`reveal` on a two-colour blank, #170). A 3D primitive's depth is its geometry. The **as-designed
removal** is what the preview compares against; the **as-cut removal** is what the chosen tools
reach (§4.7). The floor rule stands: every floor keeps clear of every plane the job knows about
(the void ceiling, the colour split, the underside) by the boundary margin (#345); a through-cut is
the single exception and needs a board (#218).

**2.5D and 3D.** Flat floors and constant-depth V traces are what the engines cut today. A sloped or
curved removal (a sphere dimple, a target object with a curved face, a 3MF text volume cut on a
slant) is **refused by name with the issue** (#222) rather than approximated — the same rule as the
V-bit-as-flat refusal. The preview still shows the designed shape, hatched, labelled "not cut:
needs 3D".

**Screen.** Design mode is the Engrave panel's Items section promoted to the whole right rail, with
the viewport as the canvas (drag, rotate, snap to the up face, nudge by typed numbers):

```
 ┌─ Cut-away ────────────────────────────────────────────┐
 │ from single.3mf (3 volumes)            [ re-read file ]│
 │  ▣ Single Barrel      text, Segoe UI Black  1.00 mm ▾  │
 │      reach: 2 mm O-flute 71 % · 0.6 corn 99 % · lost 1 %│
 │  ▣ (Like the Whiskey) text, Segoe UI       1.00 mm ▾  │
 │      reach: 2 mm 23 % · 0.6 corn 94 % · lost 6 % ⚠     │
 │  ▣ br                 SVG outline          1.00 mm ▾  │
 │ + Add ▾   text · box · cylinder · tube · sphere ·      │
 │           outline (SVG/DXF) · image · 3MF · object     │
 │ Depth margins  0.2 mm · for this blank 0.2 ✓            │
 └───────────────────────────────────────────────────────┘
```

Each item row carries its **reach** per candidate cutter and its **lost** share, live, in the same
words `item-detail-lost` already uses. The numbers come from the opened region (flat) or the groove
width (V) and are what §4.5's auto-pick ranks on.

**Validation.** As today (`item-depth-bound`, `depth-exceeds-stock`, `cut-too-deep`, jaw reach), plus:
an item that cuts a face the jaw clamps on in this setup (`cuts-clamped-face`, error) — the reason
a side cut forces a new setup (§4.4).

**Saved:** `items[] { kind, source { file, volume|layer, hash }, geometry, depth|intent, placement, enabled }`, `targetObject?`.

### 4.4 Setups

**Why.** Cutting is from one direction per mount: a 3-axis tool comes straight down. When the
cut-away needs the back face, a side, or the far end, that material is only reachable after the part
is turned, and turning it means re-clamping and re-finding it. The maintainer's rule (2026-10-15):
support cutting from one dimension, and if needed have the user remount after rotating, under our
direction.

**Definitions.** A **setup** is one held position: a mount + orientation (§4.2), the items reachable
from above in that position, the tools for them, and a registration plan. A **job** is an ordered
list of setups. The stock entering setup N+1 is the simulated result of setup N.

#### Planning setups from the geometry (automatic)

1. **Classify every removal face by its outward normal in the stock frame**: top (+Z as mounted),
   bottom, left (fixed-jaw side), right, front, back. A pocket is reachable from the direction its
   opening faces; a through-feature from either of its two openings; a target object's removal is
   split by which stock face each region is open to.
2. **Choose directions greedily**: the direction that reaches the most volume first (ties: the
   current face-up), then the next direction for what is left, until nothing remains or what remains
   is unreachable from any face (reported as lost, never dropped).
3. **Turn each direction into a mount the fixture can hold.** In the vise: top and bottom are the
   two flips; a side or an end means standing the part on an edge, which needs the opening (≥ the
   part's height when on edge) and a flat face to clamp — both checked, and the ledge note below
   applies. If the fixture cannot hold that orientation, the setup is marked `unholdable` with the
   reason and the user is pointed at the rotary (below) or sacrificial material.
4. **Order**: top first (the face the user chose up), then the one that leaves the most grip for the
   next. The classic case — a badge engraved on the top and a text on the back — is two setups: face
   up, then flipped end for end.

**Manual override.** The setup list is editable: add a setup (choose its face-up and against-the-jaw
edges), drag items between setups (an item only accepts a setup it is reachable from), reorder,
merge. A manual plan is validated the same way; a wrong one shows exactly which item is unreachable
in its setup.

**Screen.**

```
 ┌─ Setups (2) ─────────────────────────────── planned from the geometry · [ edit ] ┐
 │ 1 ▸ Top colour up · long edge on the fixed jaw · logo end nearest you            │
 │     items: Single Barrel, (Like the Whiskey), br        tools: 2 mm O-flute,     │
 │     0.6 corn                                            cut 9 min · 2 tool changes│
 │ 2 ▸ FLIP END FOR END: bottom colour up · SAME long edge stays on the fixed jaw · │
 │     the logo end now at the BACK                                                  │
 │     items: back text                                    tools: 2 mm O-flute      │
 │     cut 3 min · remount ~3 min · re-probe ~2.5 min                               │
 │     registration: X from the fixed jaw ±0.05 · Y from the front-edge scan ±0.3   │
 │       → expect up to 0.4 mm offset between the two faces' features               │
 │     grip after setup 1: 3.1 mm ledge seat intact ✓ · clamped faces untouched ✓   │
 │ Alternative: rotary chuck — 0 remounts, needs a rod stock (#238, #223)            │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

#### The remount instruction (what the operator sees between setups)

A page in the run plan (§4.8) and the printed sheet, written from the two orientations:

```
 ┌─ Remount for setup 2 of 2 ────────────────────────────────────────────────────┐
 │  BEFORE                                  AFTER                                  │
 │   ┌──────────┐ ← back                     ┌──────────┐ ← back  (logo end)       │
 │   │ top      │                            │ bottom   │                          │
 │   │ colour   │  fixed jaw on this  ───▶   │ colour   │  the SAME edge stays     │
 │   │ up       │  edge                      │ up       │  on the fixed jaw        │
 │   └──────────┘ ← front (logo end)         └──────────┘ ← front                  │
 │                                                                                 │
 │  1. Loosen the moving jaw. Lift the blank out.                                  │
 │  2. Turn it over END FOR END: the logo end goes to the back, the engraved face  │
 │     goes down. The long edge that was against the fixed jaw is STILL the edge   │
 │     against the fixed jaw.                                                      │
 │  3. Seat it on both ledges. The engraved face is now underneath: the cuts are   │
 │     clear of the 1.9 mm ledge band on both long edges, so it sits flat.         │
 │  4. Push the front end to 10 mm behind the front of the jaws, as before.        │
 │  5. Tighten. Check it does not rock. Blow the chips off the top.               │
 │  Confirm: which end is nearest you now?  ( the plain end ▾ )   [ It is mounted ] │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

The **confirmation question** is the one that catches the flip-axis mistake every forum records:
the app asks for a landmark it can check against the orientation it planned, and refuses to
continue if the answer describes the other flip.

**Which flip the app prefers in the vise, and why.** End for end (rotation about the across-jaw
axis) keeps the **same long edge on the fixed jaw**, so X and rotation stay referenced to the vise
(±0.05 mm, the run sheet's own figure) and only Y and Z need re-finding. A sideways flip (rotation
about the along-jaw axis) moves the reference edge to the moving jaw — the side whose top width still
has a contradicting probe witness (bench plan, 2026-10-15) — so it is offered only when the geometry
needs it, and the sheet says the X reference changed.

#### Registration between setups

| What | How it is established in setup 2 | Accuracy | Source |
|---|---|---|---|
| X and rotation | the fixed jaw (unchanged if the same edge is kept) | ±0.05 mm, ±0.027° | run sheet §5, derived from the vise |
| Z0 | one Z touch on the new up face, at the job's Z0 point | 0.001 mm repeatability; the dome adds up to 0.33 across the width | §11.7, §11.8 |
| Y | the fast front-edge scan (§4.9) | ±0.3 mm (bracket) — the Z-only probe's rim, bisected to the job's edge margin | §4.9 |
| Y, better | a **feature cut in setup 1 as the reference**: if setup 1 cut a through-slot or a pocket whose wall is at a known Y, the same stepped-touch scan reads that wall from the other side (a depth change instead of a miss), with the same ±0.3 | #391's physics |
| X/Y, best | the 3D probe (owned, in reserve) centre-finding a bore or slot cut in setup 1 | unmeasured; conductive stock only for the rod, non-conductive with the separate Makera 3D Probe | `Fabrication.md` §1 |

The preview (§4.7) draws the **registration band** on every feature that spans both setups: a wall
cut from both faces shows a translucent step of the combined uncertainty (±0.4 mm for Y, ±0.05 for
X) so the user sees where a seam can land before cutting.

#### Work-holding consequences, checked per setup

- **Grip after the previous setup.** The jaws clamp the two long faces; the ledges carry the two
  long edges' underside (1.9 mm deep). Setup N+1's grip is computed on setup N's result: a removal
  that cut into a clamped face (`cuts-clamped-face`) or into the **ledge band** of what will be the
  underside (`cuts-ledge-seat`: within 1.9 mm of a long edge on the face that goes down) is an error
  for a flipped setup unless sacrificial strips or a board carry it. A part thinned below 3 mm of
  grip raises `vise-grip-shallow` as today, now with "after setup 1" in the sentence.
- **Seating on the ledge after a flip.** The face that goes down must be flat where the ledges
  touch it. The badge's magnet pocket is in the middle, clear of both ledges: fine. A 3MF text
  volume near a long edge is not.
- **Stock proud after a flip** is recomputed from the thickness that remains at the ledge band.
- **Sacrificial material**: a flipped part with an uneven underside gets the "strips between the
  jaws" preset suggested; a cut-out gets the board (#213, #218).
- **Chips**: the remount step says to clear the ledges before seating; a chip under a ledge is a
  tilt the single Z touch cannot see.

#### The rotary as the automatic alternative

A rod or tube in the chuck turns the "stand it on its side / end" setups into **indexed faces**
(`Rotary.md` class I): the A axis rotates, the chuck is the reference, no remount, one registration.
The setup planner offers it whenever a job needs ≥ 2 non-flip directions and the stock is round or
can be: "3 remounts in the vise (~15 min handling, ±0.4 mm between faces) or 1 mount in the rotary
(no remount, run-out to be probed; needs #238, #223)". A top/bottom flip is **not** a rotary job
unless the part is chucked by its ends — the planner says so. The rotary's own registration (chuck
axis, probed radius, run-out) is `Rotary.md` §6 and #240's run sheet.

**Saved:** `setups[] { orientation, mount, itemIds, tools, registration { plan, expected }, remount { instruction, confirm } }`.

### 4.5 Tools

**Purpose.** Pick the cutters per setup from what the house owns, so that the most reachable detail
is cut with the fewest changes, and say what is lost.

**Auto-pick with rest machining** (#410's scope addition, #278's model):

1. Candidates = owned cutters (`inv:` tier) that suit the material: the metal line is refused for
   PLA by name (#407), non-flat shapes only where an engine simulates them (V traces since #405;
   chamfer/drill/thread per #382), nothing below the feeds table's smallest band unless a placeholder
   row with our own provenance exists (#410 item 3).
2. For every item compute reach per candidate (the opened region for a flat; the groove profile for
   a V).
3. **Tool 1 = the largest flat that reaches the most volume** across the setup's items at full depth.
4. **Rest region = design − what tool 1 actually removed** (from tool 1's simulated result, not its
   offset). **Tool 2 = the smallest owned cutter that reaches the most of the rest**, cutting only
   the rest with a stated overlap into tool 1's boundary. Stop at two tools unless a third adds more
   than a threshold the sheet states (default 2 % of the design's area, a chosen number).
5. What no tool reaches is **lost**, counted per item and drawn (§4.7).

**Screen** — the Tool section becomes a per-setup list with the recommendation applied, not offered:

```
 ┌─ Tools, setup 1 ──────────────────────────────── picked by the app · [ change ] ┐
 │ T1  Spiral 'O' single flute 2 × 12  (C1-BIT-O-FLUTE-2-12, owned ×1)             │
 │     clears 71 % of the design · 4 min 10 s                                       │
 │ T2  Corn 0.6 × 3  (C1-BIT-CORN-0.6-3, owned ×2)                                  │
 │     the rest: +27 % · overlap 0.1 mm · 5 min 40 s · feeds: placeholder row ⚠     │
 │ lost: 2 % — the tips of "br", the counters of "e" in Whiskey      [ show ]      │
 │ Why? ▾  every owned cutter, its reach and its time                               │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

"Change" opens today's candidate list with reach and time per cutter; a user's choice is kept and
the recommendation offered back (#211's behaviour). **Owned inventory is the only source**: a
catalogue cutter nobody owns is shown under "could buy" with its reach, never picked.

**How two tools reach the machine.** One program per tool (#410's recommendation: proven on the
bench; the verifier and upload gate accept single-tool files; Z0 for tool 2 from the tool-length
difference in #387's order). A single file with `M6` waits for #278's bench observation of what an
`M6` to a *different* number does on this machine. The run plan (§4.8) is the same either way; only
the "load file" phases differ.

**Saved:** per setup `tools[] { key, snapshot, role: rough|rest|single, overlap, feeds with sources }`.

### 4.6 The mode switch

**Purpose.** Make "I am done designing, now cut it" one deliberate act with one explanatory screen.
The maintainer asked for help designing this transition; here is the proposal.

**The header.** A two-state segmented control, top centre, on every CNC screen:

```
            [ Design ]  [ Cut ]            ← Cut is greyed with the first blocking reason as its tooltip
```

**What pressing Cut does.**

1. Runs the gate for every setup and tool, in order: generate → verify → simulate (tool 2 on tool 1's
   result; setup 2 on setup 1's result) → oracle. Progress is one row per (setup, tool) with the
   three ticks; this is today's Generate block, multiplied.
2. If anything is red, Cut mode still opens — on the **preflight page**, with the failing row
   expanded and a "Back to Design" that jumps to the item or field. The maintainer's point in #254
   applies: a gate that throws you back is a worse panel.
3. If all green, it opens on the **run plan** (§4.8), and the job is **frozen**: the setups, the
   `.nc` files, the frame files and the plan are hashed and written to the job document as the
   *cut package*. Any edit in Design marks the package stale; Cut shows the stale banner and the
   one button that regenerates.

**The preflight page** (the first screen of Cut mode) answers "what is going to happen" before
anything is sent:

```
 ┌─ Cut: Single Barrel badge ───────────────────────────────── package 2be0c0b9 ─┐
 │ 2 setups · 3 tools · 2 remounts · about 31 min (9 min of it is you)           │
 │                                                                               │
 │ ✓ generated 2/2 setups   ✓ verified 3/3 programs   ✓ simulated   ✓ predicted  │
 │ ⚠ 2 warnings carried: vise defaults (reference unit); corn-bit feeds are a    │
 │   placeholder row (unmeasured)                                                │
 │ ☐ I have checked clearance to the vise and the tool's reach myself.           │
 │                                                                               │
 │ Machine  Makera Z1 · 192.168.10.43 · Idle · homed · T:1 · vacuum: unknown      │
 │ Before you start:  wired probe to hand · cutters C1-BIT-O-FLUTE-2-12,         │
 │   C1-BIT-CORN-0.6-3 to hand · blank measured 76.2 × 38.1 × 3.82 ✓             │
 │                                                                               │
 │   [ Print the sheet ]      [ Preview as cut ]      [ Start the run plan ▶ ]   │
 └───────────────────────────────────────────────────────────────────────────────┘
```

**Why a mode and not a step.** Cutting has different furniture from designing: the viewport shows the
machine's state, not an editable canvas; the right rail is the phase list, not the item list; the
machine strip is live. Showing both at once is how Studio ends up with a run button next to an
editable field (and our #231 dogfood found the same: a long panel where the load-bearing fields look
like the others). The mode is also what makes the **frozen package** honest — what you are about to
run is what was checked.

### 4.7 The as-cut preview

**Purpose.** Show the part the way it will come out of the machine, with the actual tools on the
actual stock, and make everything that was lost visible and countable.

**What it draws** (the viewport in Cut mode, and the "Preview as cut" button in Design):

- **The stock after every setup and tool**, cumulative, from the sweeps the gate already ran: a
  per-setup scrubber ("after setup 1 · after T1 · after T2 · after setup 2") and the final state.
  Flat floors in their depth colour or, on a two-colour blank, the colour they land in (#170).
- **The lost layer**: design − as-cut, drawn on the surface in hatched amber, with a count per item
  ("Whiskey: 6 % lost — counters of e, a; the tail of y"). Clicking a hatched region names the
  smallest owned cutter that would reach it, or "no owned cutter reaches this".
- **The registration band** across setups (§4.4): a translucent step where two setups' cuts meet.
- **Not-cut regions** (refused by name: a sloped face, a V-carve region before #221) hatched in grey
  with the issue.
- **The fixture and the sacrificial stack**, as today; the collet nut where the sweep modelled it;
  the sentence that names what the sweep did not see (#243).
- A **design ↔ as-cut slider** (two renders, one handle) because the difference is the point.

**What it says in numbers**, in a panel beside it: removed volume per tool; lost area per item and
total; deepest floor per item vs its bound; the oracle's band and verdict; the engine used per sweep
(exact / column) and its resolution.

**What it does not do**, stated on screen: no deflection, runout or Z-chain error (`Fabrication.md`
§7.6); the drawn tool is a cylinder even for a cone until the mesh is built (SimMeshes, provisional);
the placement on the bed is the plan's, not a measurement, until the probe phase has run.

### 4.8 The run plan

**Purpose.** The brief's item 7: every phase with a time, and item 8: the proper place for the
machine's features. The plan is a list the app executes; the person's phases are the ones it waits
on.

#### The phase model

Every job is the same sequence, unrolled per setup and per tool. Times are what the bench measured
where it has, planning estimates where it has not, and each phase shows which:

| Phase | Who | Time | Source |
|---|---|---|---|
| Power-up, auto-home | machine | ~30 s + network join (sometimes never: plug cycle, #304) | observed |
| **Home** `$H` | machine | 20–30 s | measured 2026-10-12..15 |
| Fit the wired probe (manual swap) | you | ~45 s | default (operator), to be recorded |
| Tool length `M491` on the probe | machine | ~32 s | measured 2026-10-15 (16:34:41 → 16:35:13) |
| Z touch, fast + slow `G38.2` | machine | ~15 s | measured 2026-10-15 |
| **Position check** (fast scan, §4.9) | machine | ~1.5 min (7 touches × ~13 s); 8–12 min for the old full scan | measured per touch 2026-10-15 |
| Auto-level `G32 R1` grid | machine | n × ~10 s per point (3×3 ≈ 1.5 min) | estimate; Studio's default 3×3 at 2 mm (`Z1-QuickStart.txt`) |
| Home before a bit change (rule) | machine | 20–30 s | measured |
| Fit cutter Tn (manual) | you | ~60 s | default |
| `M491` on the cutter | machine | ~32 s | measured |
| Set Z0 (`G10 L2` in #387's order) | app | <1 s | observed |
| **Air run** (the program raised 10 mm, or the frame file) | machine | ≈ the cut's time (41 s air vs 52 s cut on the V-grooves) | measured 2026-10-15 |
| Vacuum on `M331` | app | <1 s | measured 2026-10-12 |
| **Cut, tool Tn** | machine | the CAM estimate (trapezoid model, #242/#281; D3 still to calibrate) | planning estimate |
| Vacuum off `M332`, head to clearance | app/machine | ~10 s | observed |
| **Remount** for the next setup | you | ~3 min | default |
| Re-register (probe in, M491, Z touch, scan, probe out, M491) | you + machine | ~4–5 min | sum of the rows above |
| **Done**: `M332`, spindle off, `G28` clearance, `M370` if a grid was set | machine | ~15 s | observed |

The sheet names the rows that are defaults, and §9's record asks for the wall clock of each phase the
first time, which is how the defaults become measurements (`feedback_verification_medium`: the
estimate is corrected by the record, not by a scale-factor knob — `Makera-Parity.md` §14.2 A1).

**Worked example: `single.3mf`, one setup, two tools, first run of this program.**

```
  #  phase                              who      time     source
  1  home                               machine  0:25     measured
  2  fit the wired probe                you      0:45     default
  3  M491 (probe)                       machine  0:32     measured
  4  Z touch at the job's Z0 point      machine  0:15     measured
  5  position check — yes / skip        machine  1:30     measured per touch
  6  home; fit T1 2 mm O-flute          you      1:30     measured + default
  7  M491 (T1); set Z0                  machine  0:32     measured
  8  air run T1 (new program)           machine  4:10     ≈ cut estimate
  9  vacuum on; cut T1                  machine  4:10     planning estimate
 10  home; fit T2 0.6 corn              you      1:30
 11  M491 (T2); set Z0                  machine  0:32
 12  air run T2 (new program)           machine  5:40
 13  vacuum on; cut T2                  machine  5:40     feeds: placeholder row ⚠
 14  done: vacuum off, clearance         machine  0:15
     ──────────────────────────────────────────────
     about 27 min · 4 min of it is you · 10 min is air runs you can skip next time
```

#### Where the machine's features live

The maintainer's item 8. Three different kinds of switch, three different homes:

| Feature | Kind | Where | Default | Code |
|---|---|---|---|---|
| **Vacuum during a cut** | a property of the program | in every cut `.nc` (`M331` … `M332`), shown as a phase; a per-job toggle in the plan's machine strip with "on for every cut" as the default | **on** (maintainer, 2026-10-12) | `M331`/`M332`, measured |
| **Vacuum right now** (cleaning) | a machine state | the machine card's switch (#390), and the same switch on the Cut screen's machine strip; hands-off while a program runs | off | `M331`/`M332` |
| **Air run** | a phase | the plan: on for a program the machine has never run (no run record with this hash), off after a clean run; the toggle sits on the phase row | on for new | the frame file (#244) or the raised program |
| **Auto-level** `G32` | a phase | the plan: on when the stock states a dome ≥ the boundary margin (the badge: 0.33 vs 0.2), off for flat stock; the grid extent is the cut area + the cutter radius | from the stock | `G32 R1 …` + `M370` at the end (#176; unverified sequence) |
| **Position check** | a phase | the plan, as a yes/skip question at the moment it is reached (#391: "ask first") | ask | §4.9 |
| **Light** | a machine state | the machine strip | on while a job runs | `M821`/`M822`: Studio's own diagnostic panel lists the work light for `machine: "all"` (Appendix A.7), and the controller's config carries `switch.light.startup_state` — so it is a Z1 feature; **unobserved from our console** — a one-line bench row |
| **Spindle air `M7`** | nothing | not shown: a no-op on the Z1 (`Z1-Firmware-Dialect.md` §11.10), and Studio's own panel config lists the `M7`/`M9` "Air" switch for the Carvera (`C1`) only (Appendix A.7) | — | — |
| **Bed clean / auto-blow / ioniser** | Studio's `M331.x` sub-modes | not offered until #283/#289's bench rows map them; the machine strip reserves the slot and says so | — | `M331.1/.2/.4` (inferred) |

**The machine strip** on the Cut screen (desktop only):

```
 Makera Z1 · 192.168.10.43 · Idle · homed · T:1 · P: —     vacuum [ off ]  light [ on ]   console ▸
```

Its state is what the machine last answered, dated; after a reconnect the vacuum reads **unknown**
(there is no read-back, #390).

#### The operator checklist (the printed sheet)

The run sheet's sections become the plan's phases, in the plan's order, with the remount pages
(§4.4) inserted between setups. Sections that are the same for every job (mount the vise) print once
at the top; the record section asks for the wall clock per phase and the measurements per item. The
sheet names the package hash on every page, as today.

**Saved:** `plan { phases[] { kind, who, estimate, source, setup, tool, options }, machineStrip { vacuumDuringCut, light } }`.

### 4.9 Probing, fast

**Purpose.** Validate the blank's position before any cut (maintainer, 2026-10-12) in a minute and a
half, not ten, and never drive the probe body into the blank again.

**Facts the plan is built on.** The wired probe is Z-only: a 2.0 mm hollow cylinder tip, no ball
(A8, 2026-10-15). The vise fixes X and rotation: the blank's left edge is the fixed jaw's face.
Y is free along the 100 mm jaw. Jaw tops are 10 mm wide, 3.1 mm above the ledge; on the seated badge
blank the jaw top stands 0.7–1.2 mm below the blank's top. The front and back edges have **no jaw
under them**: a touch past them is a miss. One stepped touch costs ~13 s round trip at the bench's
pace (`G91 G38.2 Z-5 F150`, lift, move; trace 2026-10-15 16:35–16:39). The 2026-10-15 full scan
stepped 0.5 mm across all four edges and took 8–12 min; an earlier scan that did not stop at the
first miss drove the probe body into the blank and stalled Z.

**The plan: seven touches, two of them optional.**

| # | Touch | Expected reading | What it settles |
|---|---|---|---|
| 0 | Z at the job's Z0 point (the cut area's centre) — fast, then slow | the blank's top | Z0; and, against the stated proud, whether it is seated (a reading 0.3+ mm high says a chip or a lift) |
| 1 | 1.5 mm **left** of the expected left edge, mid-length | the fixed jaw's top: `−stockProud` ± 0.5 | the X reference holds; reads the real proud height directly |
| 2 | 2 mm **inside** the expected front edge | the blank | the front edge is not further back than expected |
| 3 | 2 mm **outside** the expected front edge | **a miss** at the cap (2 mm below the top) | the front edge is not further forward |
| 4–6 | bisect between the last blank reading and the first non-blank reading, in either direction, until the bracket ≤ the job's edge margin (0.5 mm): at 0, then ±1, then ±0.5 | — | Y to ±0.3 mm (the rim's step is at a 1.0 mm overhang: the reading changes when the tip centre is one radius past the edge, so "the edge is 1.0 mm inside where the reading changed") |
| 7 (optional) | 1.5 mm right of the expected right edge | the moving jaw's top — or a miss | settles the moving-jaw contradiction; off by default until it is |

**Rules that make it safe.**

- Every touch is one `G38.2` with a **travel cap**: 2 mm below the expected surface for a blank or
  jaw reading, `stockProud + 1` for a predicted miss, and never more — the `[PRB:…:0]` miss flag is a
  normal reading, `$X` clears the alarm, and the app lifts to `G53 G0 Z-3` **after every touch**
  before any X/Y move (#391 review items 1 and 5).
- **Stop at the first reading that is not one of the expected surfaces** (not blank, not jaw top,
  not a capped miss): refuse to continue, say what was read, leave the head up.
- The bisection is both-ways and bounded (six touches max); a pass that never brackets the edge
  steps 2 mm out or in once, then refuses.
- The result is compared with the job's origin: within the edge margin → "position confirmed, Y
  off by 0.2 mm (within margin)"; outside → offer **"set Y from the measured edge"** (a `G10 L2` write
  in #387's order, with the cutter's Z0 recomputed from the tool-length difference), or "stop and
  re-seat". The 2026-10-15 scan read the front edge **2.5 mm** forward of the origin: that is a
  correction, not a refusal.
- X is **never** rewritten from a touch: the vise sets it, and the X touch only confirms.

**Time.** 7 touches × ~13 s ≈ 1.5 min, plus the two probe swaps the sheet already counts. Each
touch could be shorter (a smaller travel, a fast touch only for the edge finds, where 0.3 mm is the
target), which the bench can time.

**Where the contact model still needs the bench** (the open re-review on #391): the rim's reading
across a square edge, the hollow's inside diameter, and what "resolution" means for a tip with no
curvature. The plan above assumes the near-step at one radius; the sheet prints that assumption
above the first number, as #391 item 2 requires.

**Executed by the app**, not typed: the console gate already pins every line this sequence sends
(`G91 G38.2 Z-… F…`, `$X`, `G53 G0 Z-3`, `G90`, `G10 L2 P1 …`). The person is at the machine
(the "I am at the machine" state), the phase row shows each touch and its reading as it lands, and
the late-frame rule (#386 item 3) is what lets an `ALARM` tens of seconds later be attributed to the
right touch.

### 4.10 Running

**Purpose.** Start the job, show where it is, stop it, and get back into it after an interruption.

**Start.** The path #386 settled and the harness proves: pre-poll `?` and refuse unless `Idle` with
no alarm; upload the verified program (as today, with the live Idle check); `play /sd/gcodes/<file>`;
poll `?` every 2 s on the same connection; finished at `P` percent 100 **and** `Idle` (a mid-job
`Idle` of 3–4 s at `M05` is not the end); the `P` field vanishing after a seen `P` also ends it; three
silent polls end the watching with "the physical stop is the stop".

**The run screen.**

```
 ┌─ Running: setup 1 · T1 2 mm O-flute · cut ────────────────────────────────────┐
 │  ▶ phase 9 of 14   cut T1    Run · line 212 / 398 · 54 % · 2:14 elapsed       │
 │    ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░   est. 1:56 left (planning estimate)              │
 │  viewport: the stock at the current step (the transport follows line 212)     │
 │  machine: Run · T:1 · vacuum on (M331 sent 2:14 ago) · light on               │
 │                                                                               │
 │  [ ■ Stop (abort) ]   [ pause: not available on this machine — #303 ]         │
 │  the physical stop is the stop: the front button / the plug                   │
 └───────────────────────────────────────────────────────────────────────────────┘
```

- The phase list on the right ticks phases as they complete; the operator phases show a single
  button ("It is fitted" / "It is mounted") and the confirmation question where one exists.
- The **viewport follows the machine's line** through the existing transport (#198): the stock at
  the step the `P` line reports, which is what makes "is it where I think it is" answerable from the
  desk, with the camera frame beside it (`z1.mjs camera`, #189's feed) when the bench has it.
- **Elapsed vs estimate** per phase, and at the end the record asks nothing — it already has the
  wall clocks.

**Stop.** One button: `abort` (what Studio's grey Stop sends — the spindle stops at once, queued
moves drain, `M332` goes out only after the controller says `Aborted playing` or three polls read
Idle; #386 A). Never `!`/`~` (refused at the sink, #303). The button's label says what it is and
what it is not. The red STOP in Studio and the front button remain the real stops.

**Interruption cases, each with a named path:**

| What happened | What the app does | Path |
|---|---|---|
| Stop pressed mid-cut | ends the phase as `stopped at line N`; offers **Restart from step** — the gated restart `.nc` (#249: head lifts, spindle starts after the lift #392, Z0 unchanged) — or "redo this tool's program" | exists in the Simulate panel; to be surfaced here |
| Network dropped (silence) | says "silence is not stopped": the job may be running; shows the last state and time; polls until it answers; offers `power.sh status` wording; **never** sends `M332` blind | #304, #386 |
| Power cycled | the machine re-homes; the work offset is **lost** → the plan rewinds to the re-register phases (probe in, M491, Z touch, scan) and then **resume at the stopped line** | #387's order; `goto <line>` is Studio's resume and is unverified here — the restart `.nc` is ours |
| Alarm (`ALARM:`, `H:`) | the carried-frame rule attributes it; the run ends; `$X` is offered only with the person at the machine; a probe alarm on a predicted miss is not an alarm | #386 item 3 |
| Tool broke / blank moved | Stop; "redo this tool from the start" (same file) after a re-probe; the record notes it | — |
| Stopped between setups | the job remembers which setups completed; reopening it offers "resume at setup 2 (remount)" | §5 |

**After the run.** The record (`<job>-run.json`, #277) gets the wall clocks per phase and the per-item
measurements the sheet asks for; the next run of the same package reads "last run 2026-10-16: 26 min
(est. 27)" beside the estimate (`Makera-Parity.md` §14.2 A1, Tormach's pattern).

---

## 5. Save and reload

**The job is a file.** `<name>.cutjob.json` — the `EngraveJob` document (schema v2 today) grown to v3
with: `stock.origin` (house id / catalogue row / file + hash / user), `mount.orientation`,
`items[].source` (file, volume or layer name, hash), `setups[]`, per-setup `tools[]`, `plan`, and a
`package` block when Cut has run: the hash of every `.nc` and frame file, the oracle verdicts, the
engine per sweep, and the run records attached by hash. Zod mirrors every field (the trap in
`reference_board_zod_schema_strips`), with a v2 → v3 migration that maps `toolKey` → `setups[0].tools[0]`
and the fixed orientation → the badge's as-clamped one — a saved v2 job loads and generates the same
`.nc` (the byte-identical rule #278 and #409 both kept).

**Imported sources travel with the job.** An SVG, DXF, image or 3MF is embedded (base64) up to a cap
(4 MB; `single.3mf` is 146 KB) and otherwise referenced by path + hash, with "the file this job was
made from is missing or changed" as a refusal at generate, never a silent re-read. The geometry
derived from it is stored too, so a job renders without the file.

**Save / Open / Save as** in the toolbar, the same File System Access path the case project uses
(`persistence.ts`), with the download fallback on the web. **Autosave** stays localStorage on every
edit (today's `casemaker.engraveJob.v1`, renamed with the schema) and is what "resume where I was"
reads; a job that was saved to a file autosaves to that file too (a dirty marker and Ctrl-S, like
the project). **The job can be saved at any point**: a job saved after step 1 is a stock and a
machine and nothing else, and opens at step 2.

**Versioning.** `schemaVersion` with migrations; a `package.hash` that changes whenever anything the
`.nc` depends on changes (today's stale rule, extended to setups and tools); run records keyed by
that hash, so a record never attaches to a program it was not cut from. The case project keeps
excluding the job (`types/engraveJob.ts:8-12`) — the job references the project's badge by id for
"Use the badge blank" and otherwise stands alone.

**The house** keeps what outlives a job: cutters and inventory (today), **stock entries** (new:
"Save this stock to the house"), the saved vise and sacrificial setups (today, in settings; they
move to the house with the "my machine" file as the carrier, #247).

---

## 6. Gaps

Mapped to existing issues where they exist; **NEW** where not. Not filed: the maintainer files after
review. Sizes are relative (S: a day; M: days; L: weeks).

| Area | Gap | Issue | Size |
|---|---|---|---|
| Stock | library picker: house entries, "save this stock to the house", Manage › Materials | **NEW** (touches #347's `materialOptionsFor`) | M |
| Stock | vendor sizes at runtime: the sync reads `t_MaterialSpecs` into `catalogue.json` (names + dims, no numbers committed) | **NEW**, under #308/#347 Route A | S |
| Stock | STL/3MF as stock (prism detection; 3D stock refused by name) | **NEW**; 3D needs #222 | M |
| Stock | rod / tube / disc shapes; sphere refused | **NEW**; rod stock joins #240 | S–M |
| Mount | orientation as a question (face up, edge on the fixed jaw, end nearest you); derived frame; the badge as clamped | **#383** | M |
| Mount | jaw opening measured and `vise-opening-unmeasured` until then | **NEW** (bench, calipers) | S |
| Mount | anchor bracket + top clamps as a modelled mount | **NEW** (decision 26's `top-clamps` variant exists in `setup.ts`) | M |
| Mount | tape-down as an offered mount with the tilt run sheet | #191 | S |
| Mount | rotary chuck offered, refused at the gate until characterised | #238, #223, #240 | — |
| Mount | thin-blank proud rule | #406 | S |
| Cut-away | 3MF negative volumes in the panel (script exists) | **#410** | M |
| Cut-away | 3D primitives (box, cylinder, tube, sphere) as removals; sloped/curved refused by name | **NEW**; 3D cutting is #222 | M |
| Cut-away | target object = stock − object; depends on through-cuts and tabs | **NEW**; #218, #213 | L |
| Cut-away | `cuts-clamped-face` finding | **NEW** | S |
| Setups | setup planning from face normals; manual override; per-setup items, tools, registration; the remount page with picture and confirmation question; ledge-seat and grip-after checks; stock carried between setups in the sweep | **NEW** (the maintainer's addition, 2026-10-15) | L |
| Setups | features cut in setup 1 as references for the scan | **NEW**, on #391's physics | M |
| Setups | the rotary as the alternative (indexed faces, class I) | #223, #241 | — |
| Tools | auto-pick with rest machining, two programs per setup, simulated together | **#410** (+ #278 for the single-file route) | L |
| Tools | tool-change allowance in the estimate; a per-tool break in the sheet | #278 items 5 | S |
| Tools | metal-line refusal for flats; corn/O-flute shapes read from the box code | #407, #379 | S |
| Tools | simulate every owned cutter (chamfer, drill, thread) | #382 | L |
| Tools | the V-groove oracle so V jobs save and upload | **#408** | M |
| Tools | legible V text (spacing after narrow glyphs) | #409 (closed-loop cosmetic left) | — |
| Mode | Design / Cut header, the preflight page, the frozen package and the stale rule across setups | **NEW** | M |
| Preview | the lost layer drawn and counted; the design ↔ as-cut slider; the registration band; a cone mesh for V-bits | **NEW** (numbers exist: `item-detail-lost`); cone mesh is a SimMeshes provisional | M |
| Plan | the phase model with per-phase times and sources; the machine strip; defaults for vacuum, air run, auto-level, light | **NEW** | M |
| Plan | the cycle estimate's rapid model calibrated by a timed air run (D3) | #281 | bench |
| Plan | wall clocks per phase in the run record; "last run" beside the estimate | #277 extension | S |
| Plan | light `M821`/`M822` on the Z1 (Studio lists it for all machines; unobserved from our console) | **NEW** (bench row) | S |
| Plan | the Z-probe touch point drawn on the preview map, as Studio's wizard does (Appendix A.5) | **NEW** (small) | S |
| Run | "repeat last job" as a one-press affordance (Studio: main-button long press, Appendix A.7) — for the second badge of a batch; relates to #251 | **NEW**, only if asked | S |
| Plan | bed-clean / blow / ioniser mapping | #283, #289 | bench |
| Probe | the fast scan, executed by the app, with the travel cap, stop-at-first-unexpected, both-ways bisection, Y correction via `G10 L2` in the right order | **#391**, **#387** | M |
| Probe | the rim's contact model (re-review items 1–3) | #391 (open) | bench |
| Probe | auto-level `G32 R1` as a phase; `M370` at the end | #176 | bench |
| Run | play / poll / finish in the app (the harness's `run` as a platform module); phase progress; the viewport following the `P` line | **NEW**, on #386's policy; `play` policy (#386 item 5) open | M |
| Run | the stop button (`abort`) and what it is not | #303 | S |
| Run | network drop: "silence is not stopped"; power-cycle rewind to re-register | #304 | S |
| Run | restart from step in the run screen; resume at setup N | #249 (exists in Sim); **NEW** for setups | S–M |
| Run | the vacuum switch outside a job | #390 | S |
| Save | `.cutjob.json` v3 with Save / Open / Save as, autosave to file, embedded sources, package hashes | **NEW** | M |
| Save | house stock entries; vise/sacrificial saved setups move to the house | **NEW**; #247 carrier | S |
| Docs | the run sheet preamble ("uploaded through Makera Studio") is stale | **NEW** (one line) | S |
| Docs | the cnc-guide's chapter 5 becomes the eight questions | #210's successor | M |

What this document deliberately does **not** reopen: a first-run machine wizard (R1), a G-code
editor (R8), a job queue (R9), DRO / pendant / overrides (R10), nesting (R15), ramping (R16), a
vendor feeds row in the repo (#347 Route B).

---

## 7. Open questions

1. **Flip preference.** The design prefers the end-for-end flip in the vise (same long edge stays on
   the fixed jaw). Is that how you would turn the badge over, or do you reach for the sideways flip?
2. **The moving jaw.** Its top reads 10 mm by caliper and a miss 6 mm out by the 2026-10-08 probe.
   The optional touch 7 settles it in one gesture; do you want it in the default scan, or a one-off?
3. **Jaw opening.** The vise's maximum opening is published nowhere and unmeasured. One caliper
   reading decides which setups the planner may offer (a 76.2 mm side across the jaws?).
4. **Y correction by the app.** When the scan finds the front edge off by more than the margin, may
   the app write the corrected Y (`G10 L2`, cutter Z0 recomputed), or do you want "stop and re-seat"
   only, with the write done from the console by you?
5. **Air run default.** "On for a program the machine has never run, off after a clean run" — or on
   for every run until you say otherwise?
6. **Auto-level.** On by default for the badge (0.33 mm dome vs 0.2 margin) or off until #176 proves
   the `G32 R1` / `M370` sequence on this machine?
7. **Two tools, two files.** One program per tool (proven) or wait for the `M6` observation (#278
   step 1) and do one file? The plan's phases are the same; the difference is how many uploads.
8. **Target-object mode.** It is almost always a cut-out, which needs tabs and a board (#218). Do
   you want it in the first cut of this design, or after #410's negative-volume route has cut a badge?
9. **The "I am at the machine" state.** Today it is a tick per console line. For a plan that sends
   dozens of lines (the scan), is one tick at the start of the probing phase enough, with the
   machine strip showing every line as it goes?
10. **Stop button.** `abort` has not been observed on this machine (#303). Ship the button now with
    its honest label, or hold it until the bench records what Studio's grey Stop does?
11. **Where house stock lives.** `house.json` beside the tools (one file, one export) or the
    "my machine" file (fixtures travel there today)?
12. **Sphere.** Confirmed not offered? (Nothing we own holds one; nothing in the pipeline cuts one.)
13. **The 2 % third-tool threshold and the 0.1 mm rest overlap** are chosen numbers. Keep them as
    shipped defaults with their provenance, or set them from the first two-tool cut?
14. **Light.** Studio's own panel config lists the work light (`M821`/`M822`) for every machine and
    the controller carries `switch.light.startup_state` (Appendix A.7). One console line confirms it;
    do you want it in the machine strip from the start?
15. **The Z-probe point.** Studio's wizard defaults it to `(20, 7) from Path Origin` and labels it
    `Recommended` (Appendix A.4); this design probes Z at the cut area's centre, where the dome is
    highest (the conservative Z0 for a reveal depth). Keep the centre, or follow Studio?

---

## 8. Sources

**Local (this repository).** `/Fabrication.md` §1, §2, §4, §5.7, §7.3, §9; `/Makera-Parity.md` §5,
§7, §8, §9, §14; `/Z1-Firmware-Dialect.md` §2, §11.7–11.11; `/Z1-Bridge-Protocol.md` §6, §8;
`/Rotary.md` §1.4, §2; `docs/bench/2026-10-bench-plan.md`; `docs/bench/2026-10-bench-day-1.md`;
`docs/bench/single-barrel-run-sheet.md`; `docs/bench/traces/2026-10-15-console.log` (the probe
cadence), `2026-10-15-185-air.log` / `-cut.log` (41 s / 52 s), `2026-10-12-cut-rowA.log` (103 s);
`casemaker-app/src/docs/cnc-guide.md` §2, §3, §5–7; `casemaker-app/src/components/panels/EngravePanel.tsx`,
`EngraveSetupFlow.tsx`, `EngraveMachineUpload.tsx`, `RunSheetView.tsx`, `SimPanel.tsx`;
`casemaker-app/src/engine/cnc/engrave/{setupFlow,runSheet,materialScan,recommendTool}.ts`;
`casemaker-app/src/store/{engraveJobStore,engraveRunStore,engraveRunGate,engraveJobSchema}.ts`;
`casemaker-app/src/engine/cnc/{fixture,feeds,probePlan}.ts`; `casemaker-app/tools/z1/z1.mjs`;
`casemaker-app/scripts/engrave-job.ts`; `samples/badge-blank/single.3mf`
(`Metadata/Slic3r_PE_model.config`). Issues: #166, #176, #185, #188, #191, #208, #213, #218, #221,
#222, #223, #238, #240, #242, #244, #247, #249, #254, #272, #277, #278, #280, #281, #283, #289, #303,
#304, #347, #383, #386, #387, #390, #391, #405, #406, #407, #408, #409, #410.

**Makera** (cached at `docs/market-research/raw/makera/`): `Z1-QuickStart.txt`,
`software-MakeraCAM_userguide.txt`, `software-MakeraCAM_Intro.txt`, `software-MakeraCAM_tutorials.txt`,
`Z1-Accessories-Low-Profile-Vise.txt`, `speeds-and-feeds.txt`, `supported-codes.txt`. Web:
https://www.makera.com/blogs/cnc-buying-guide/makera-z1-vs-carvera-air ·
https://www.makera.com/blogs/cnc-buying-guide/makera-z1-review ·
https://www.makera.com/blogs/cnc-projects/tips-and-tricks-for-making-multi-sided-cnc-projects ·
https://www.makera.com/software · https://www.makera.com/collections/all ·
https://www.makera.com/products/makera-z1-low-profile-vise · https://www.makera.com/products/makera-3d-wired-probe ·
https://www.makera.com/products/makera-z1-4th-axis-module · https://www.makera.com/products/6061-aluminum-block ·
https://www.makera.com/products/clear-acrylic-sheet-plate · https://www.makera.com/products/1-5mm-blank-pcb-boards-1 ·
https://www.makera.com/products/brass-sheet-plate · https://www.makera.com/products/epoxy-tooling-board-1 ·
https://wiki.makera.com/en/software/MakeraCAM_userguide · https://wiki.makera.com/carvera/manual/software ·
https://wiki.makera.com/carvera/manual/tool-kit · https://github.com/Carvera-Community/Carvera_Controller
(`carveracontroller/makera.kv`, `CHANGELOG.md`, issues #252, #286, #509, #528, #601, #614, #746, #783) ·
https://github.com/MakeraInc/MakeraCAM/issues (#25, #32, #35, #64, #65, #81) ·
https://cnx-software.com/2026/09/01/makera-z1-desktop-cnc-review-smart-milling-4-axis-module-and-5w-laser-engraving ·
https://core-electronics.com.au/makera-common-milling-bits-26-pcs.html ·
https://core-electronics.com.au/makera-cnc-pcb-fabrication-pack.html.

**Makera Studio install and user data (static read, Appendix A; copies, nothing modified):**
`C:\Users\DavidSeaman\AppData\Local\Programs\Makera Studio\MakeraStudio.exe.orig` (strings),
`…\config\config.json`, `…\config\interface_config.json`, `…\data\lang\lang_us_EN.json`,
`…\data\configure\*.json`; `C:\Users\DavidSeaman\AppData\Roaming\MakeraStudio\config.ini`,
`…\ControllerConfig.txt`, `…\config\ProjectDefault\default_3d_cnc.json`, `…\configure\*.json`,
`…\GCodes\TopClamp.nc`, `…\logs\log_2026-10-07-22-54-47.txt`, `…\logs\log_2026-10-12-13-31-39.txt`,
`…\makera_library.db` (REA `inspect-sqlite-database`, evidence `ev_662e5862…`, `ev_e2174548…`,
`ev_cf580cbe…`, `ev_318dc173…`); `docs/bench/img/D0-wizard-{1-set-stock,2-set-origin,
2-tool-change-probe,2-scan-now-mdi-log,3-auto-probe,4-assist-options,5-run-summary}.png`,
`docs/bench/img/D1-{pre-run-options,probe-cycle-mdi-log,tool-confirmation}.png`;
`/Makera-Parity.md` §7, §8, §12; REA: `rea doctor --client claude_code --json`, `rea capabilities`.

**Competitors.** Carbide 3D: https://carbide3d.com/hub/courses/create/job-setup/ ·
https://my.carbide3d.com/pdf/Nomad3_Starter_Project.pdf · https://my.carbide3d.com/pdf/bitsetter-v2.pdf ·
https://carbide3d.com/blog/bitsetter-changes-carbide-motion · https://guides.carbide3d.com/create/tool-library/ ·
https://community.carbide3d.com/t/project-from-beginning-to-end-in-cc816-and-cm644/91395 ·
https://community.carbide3d.com/t/toolpath-time-estimates/104110 ·
https://community.carbide3d.com/t/flip-cut-in-carbide-create/86342 ·
https://community.carbide3d.com/t/accurate-methods-to-two-sided-milling/81987 ·
https://community.carbide3d.com/t/2-sided-machining-guitar/15219 ·
https://community.carbide3d.com/t/consistent-2-sided-alignment-errors-5-pro-fusion-360/69233 ·
https://shop.carbide3d.com/products/nomad-flip-jig. Easel:
https://support.easel.com/hc/en-us/articles/360012848233-Start-Carving-in-Easel ·
https://support.easel.com/hc/en-us/articles/360012453174-Two-Stage-Carves-Roughing-and-Detail-Carves ·
https://support.easel.com/hc/en-us/articles/6190062675219-Adding-a-Z-Probe-to-Easel ·
https://easel.com/features/more-accurate-quick-carve-time-estimates ·
https://support.easel.com/hc/en-us/articles/8698227616531-Export-SVG-and-Project-Details ·
https://forum.easel.com/t/double-sided-carving/20208. Vectric:
https://docs.vectric.com/docs/V12.0/VCarveDesktop/ENU/Help/form/Job%20Setup%20Single ·
https://docs.vectric.com/docs/V12.0/VCarveDesktop/ENU/Help/form/Preview%20Toolpaths ·
https://docs.vectric.com/docs/V12.5/VCarvePro/ENU/Help/form/Toolpaths%20Summary/index.html ·
https://docs.vectric.com/docs/V12.5/VCarveDesktop/ENU/Help/form/Tool%20Database ·
https://docs.vectric.com/docs/V9.0/VCarvePro/ENU/Help/Drawing/..\Interface\Two-Sided%20Machining.html ·
https://docs.vectric.com/docs/V9.5/VCarveProTrialEdition/ENU/Help/Reference%20Manual/Toolpaths/Create%20Job%20Sheet.html ·
https://forum.sienci.com/t/double-sided-machining-always-fail/1067. Fusion:
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-CREATE-SETUP.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-REF-SETUP-STOCK.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-CONTINUE-REST-MACHINING.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-3D-FLAT-REST-MACHINING.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-SIMULATE-OPERATIONS-WITHOUT-MACHINE.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-SETUP-SHEET-OVERVIEW.htm ·
https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-TOOL-LIB-TYPES.htm ·
https://forum.onefinitycnc.com/t/x-offset-problem-with-2-sided-carve-on-fusion-360/35495 ·
https://industrialmonitordirect.com/blogs/knowledgebase/using-previous-setup-output-as-stock-in-fusion-360-cam.
Snapmaker: https://support.snapmaker.com/hc/en-us/articles/4403902806679-5-CNC-G-code-Generator ·
https://support.snapmaker.com/hc/en-us/articles/4417381901591-5-How-to-CNC-Carve ·
https://support.snapmaker.com/hc/en-us/articles/4417387365527-10-Set-Work-Origin-and-Run-Boundary.
xTool: https://support.xtool.com/article/1109 · https://support.xtool.com/article/1303 ·
https://support.xtool.com/article/2067 · https://support.xtool.com/article/1717 ·
https://support.xtool.com/article/1307 · https://support.xtool.com/article/3630. Glowforge:
https://support.glowforge.com/hc/en-us/articles/17395725153691-Your-First-Glowforge-Craft-Series-Print ·
https://support.glowforge.com/hc/en-us/articles/360033633374-Print-a-Catalog-Design ·
https://support.glowforge.com/hc/en-us/articles/360033633714-alignment ·
https://support.glowforge.com/hc/en-us/articles/4605593296027-Non-Proofgrade-Materials-FAQ. LightBurn:
https://docs.lightburnsoftware.com/2.1/Reference/LaserWindow/ · https://docs.lightburnsoftware.com/2.1/Reference/Preview/ ·
https://docs.lightburnsoftware.com/2.1/Reference/MaterialLibrary/ ·
https://docs.lightburnsoftware.com/2.1/Reference/DeviceSettings/AdditionalSettings/. Bantam Tools:
https://support.bantamtools.com/hc/en-us/articles/360052717093-Software-Overview ·
https://support.bantamtools.com/hc/en-us/articles/1500000699621-Fusion-360-Workflows-Setting-Up-G-code-Files-in-the-Bantam-Tools-Software ·
https://support.bantamtools.com/hc/en-us/articles/115001658814-Double-Sided-Boards ·
https://support.bantamtools.com/hc/en-us/articles/360053358433-Low-Profile-Wallet ·
https://learn.adafruit.com/double-sided-pcb-milling. Kiri:Moto: https://forum.grid.space/t/machining-two-sided-parts/59 ·
https://forum.grid.space/t/pattern-registration-for-double-sided-milling/239. MecSoft:
https://mecsoft.com/2-sided-flip-machining-explored/.

---

## Appendix A. Makera Studio 0.1.2.0, read from the install (static, 2026-10-15)

**What was done, and what was not.** Static inspection only, on **copies** in the session scratchpad:
the stock binary `MakeraStudio.exe.orig`, the install's `config/` and `data/` folders, and from the
user's Roaming folder `config.ini`, `ControllerConfig.txt`, `config/ProjectDefault/default_3d_cnc.json`,
`configure/*.json`, `GCodes/`, `PrjPathConfig/` (empty), `logs/` and `makera_library.db`. Studio was
not launched, nothing under the two folders was modified, and no vendor feeds/speeds row is quoted
anywhere in this document (#347). Source paths below are the originals under
`C:\Users\DavidSeaman\AppData\Local\Programs\Makera Studio\` (install) and
`C:\Users\DavidSeaman\AppData\Roaming\MakeraStudio\` (user data); `docs/bench/img/D0-*.png` and
`D1-*.png` are the maintainer's screenshots of the same screens, 2026-10-07.

**The REA toolkit** (rea-agents 6.5.0): `rea doctor --client claude_code --json` reports Node 24.21
healthy and **no native analysis engine** (Hopper, Ghidra, IDA and JADX all `missing_analysis_engine`);
nothing was installed. So no decompilation was done, and none was needed for a workflow read. What REA
did supply is the database inspector: `rea inspect-sqlite-database` on the copied
`makera_library.db` (sha256 `70ed4e86…3e3173`, SQLite 3.53.4) with evidence ids
`ev_662e5862…` (full schema), `ev_e2174548…` (`t_MaterialCategory`), `ev_cf580cbe…`
(`t_MaterialList`), `ev_318dc173…` (`t_SystemParameters`). Everything else is `strings` on the
binary (275 895 ASCII and 13 914 UTF-16 strings), the JSON files, the logs and the screenshots.
There are **no `.qm` translation files**: the only language file is `data/lang/lang_us_EN.json`
(239 strings), and it covers the diagnostic panel alone (`Makera-Parity.md` §7 already read it); the
workflow strings live in the binary.

### A.1 The project model

`Roaming/config/ProjectDefault/default_3d_cnc.json` is the default a new 3D-CNC project is created
from:

```
emMachineType, emSchemeType, version,
vecClamDiameter: [ … ],                       ← the chuck/collet diameters the project may use
workblank: { material: { materialInfoId, materialObjId, materialSpecId }, size: { length, width, height } }
```

So a Studio project is **machine type + scheme (process mode) + a workblank**, and the workblank is a
material **and a material spec** — the vendor's sized stock — plus explicit dimensions. The binary's
strings confirm the same names (`emMachineType`, `emSchemeType`, `workblank`, `widgetWorkblank`,
`vecClamDiameter`, `lstClamDiameter`) and the refusals built on them: *"Project information is
incomplete. Please set chuck diameter and workpiece material first."* and *"No tools found for the
current chuck diameter and workpiece material. Please check project settings or add tools in the tool
library."* Project files are `*.mks` (file-filter string). The user's `PrjPathConfig/` is empty and
`config.ini` has `STR_RECENT_JSON=`: no Studio project has ever been saved on this PC.

### A.2 Process modes and the guided scheme

Strings `SchemeInfo2DCNC`, `SchemeInfo3DCNC`, `SchemeInfo3DRelief`, `SchemeInfo4DRelief`,
`SchemeInfo2DLaser` and the mode cards: **2D Vector Machining**, **3D Model Machining** ("Import 3D
models for planar, surface, contour, and other machining operations… Supports STEP, STP files"),
**3-Axis Relief Carving** ("STL, STEP, STP, OBJ"), **Custom 3-Axis Machining** ("Import 2D or 3D
models and freely configure machining strategies"), **Custom 4-Axis Machining**, **Laser Engraving &
Cutting**; the chooser is `Select Processing Mode` / `ModeSelectorWidget`, with `Guided Mode` and
`Custom Mode`. Import filters: `*.step *.stp *.stl *.obj`, `*.dxf *.svg`, `*.jpg *.jpeg *.png *.bmp`,
and a Gerber list. **No 3MF.**

Guided Mode is a sequence of **scheme steps** (`SchemeStepWidget`, `lblSchemeStepName/Image/Detail`,
`pushButton_PrePage/NextPage`) per mode, each with a `Calculate Tools` / `Calculate` / `Recalculate`
button. The tool logic the strings reveal: a **Main Tool** chosen by diameter (*"No recommended Main
Tool diameter can machine all selected models"*), **roughing limited to one tool** (*"Rough machining
can use at most one tool"*, *"At least one roughing tool is required before generating toolpaths"*),
a **Clearance Tool** for 3D pocketing, **finishing** (*"No suitable finishing tool found"*; *"The tool
will cut directly to the maximum depth, only suitable for finishing passes after roughing"*), and a
guard between steps: *"Continuing may machine stock that has not been roughed. Continue to the next
step?"* Tools are filtered by the project's material duty (*"No tools match the required workpiece
material duty"*, `metalDuty` in the DB) and chuck diameter. Operation defaults are one JSON per
strategy in `data/configure/` (`Pocket2DPath.json`, `Relief3DPath.json`, … 15 files): `depth
{startDepth, endDepth, finishStepDown, enablelastlayer}`, `safe {safeZ, startX, startY, startZ}`,
`Ramping_clear`, `pocket_strategy`, `direction`, `pathOrder`, and `tools[]` carrying the full cutter
record (`toolNumber`, `toolType`, `diameter`, `tipDiameter`, `halfAngle`, `fluteLength`,
`shoulderLength`, `stickoutLength`, `materialPropertyId`, feeds). The Roaming `configure/` copies are
the user-level overrides (`Makera-Parity.md` §8 found the uninitialised doubles there).

### A.3 The material and stock library (structure only)

`makera_library.db` (REA, `ev_662e5862…`): the material side is `t_MaterialCategory`
(`materialCategoryName`, `materialPic`, `metalDuty`) → `t_MaterialList` (`materialID`,
`materialCategoryID`, `materialSubcategoryName`) → **`t_MaterialSpecs`** (`materialSpecsID`,
`materialID`, `materialName`, `materialShape`, `length`, `width`, `height`, `diameter`, `g_ID`), with
user-side twins `t_CustomerMaterialList` and `t_CustomerMaterialSpecs` (same columns plus
`lastUpdateDate`). The cutter side is `t_CutterCategory` → `t_MakeraCutterGroup` →
`t_MakeraCutterList` (geometry incl. `cutterStickoutLength`, `cutterShoulderLength`,
`cutterFluteLength`, `cutterTipDiameter`, `cutterHalfAngle`, thread fields, `sellProduct`,
`metalDuty`, `g_ID`) with `t_CustomCutterList` / `t_CustomerCutterGroup` as the user's clones, feeds in
`t_MakeraCutterProperties` / `t_CustomerCutterProperties` (material × cutter), **`t_CutterInventoryList`
(`cutterID`, `qty`)** — Studio has a quantity-based inventory of its own — `t_SkuMapping` (shop SKU
and URL per `g_ID`, per `shopifyRegion`), `t_MachineType`, `t_MachineResourceFiles` /
`t_MachineResourceParameters` (machine models and named XYZ parameters), `t_MyDeviceList`
(`strDeviceName`, `strIP`), `t_SystemParameters` (sync dates, `dbVersion`) and `t_DeletionQueue`.
The UI over it: `MaterialLibDialog` / `MaterialItemWidget` with strings `Material Library`,
`Material Name`, `Material Specifications:`, `new material specifications`, `max thickness =`.

What this settles for §4.1: the vendor's sized stock is a first-class object in Makera's own model
(`materialSpecId` on the project, `materialShape` R/C with L/W/H or diameter), it is already in the
database the house service syncs, and a round shape exists in it. The picker's "Makera" column is a
read of `t_MaterialSpecs` at runtime, nothing more.

### A.4 The Machining Wizard, step by step (the per-run flow)

Evidence: `D0-wizard-1-set-stock.png` … `D0-wizard-5-run-summary.png`, the strings `Set Stock`,
`Set Origin`, `Auto Probe`, `Assist Options`, `btnTxt_StepAssist`, `Machining Wizard`, `wgtWizard`,
and the Studio log `logs/log_2026-10-07-22-54-47.txt` / `log_2026-10-12-13-31-39.txt`.

| Step | What the screen shows | What it writes / sends |
|---|---|---|
| **Set Stock** | the 200 × 200 bed map with the L-bracket and its three screws drawn, a stock rectangle in the bracket's corner; radio `Anchor1` / `Custom`; the sentence *"Place the stock on the work bed and secure it firmly. We recommend using the anchor system and L-Bracket for quick and accurate positioning."* | nothing to the machine |
| **Set Origin** | `Relative to: Anchor1`, `X Offset`, `Y Offset` (the job's origin from the anchor), `Same As CAM` (copies the CAM's origin), `Set Origin with 3D Probe`, `Apply Settings` ("Note: Work origin will be set immediately when clicking OK"); a toggle **Auto-Scan Machining Area (Before Machining)** and `Scan Now`; the sentence *"Set the work origin when starting a new job, changing the workpiece, or re-fixturing to align the toolpath correctly."* The map shows the Work Origin dot and the Toolpath Area rectangle. | `Scan Now` on 2026-10-07 ran `M492.3 → M494.2 → M493.2 T0 → M497.4 → M494.0 → G53 G0 Z-3 → G90 G0 X10 Y8 → G1 … F1000` round the toolpath's rectangle → `Done ATC` (`D0-wizard-2-scan-now-mdi-log.png`). A **Tool Change Required** dialog ("Please change to: Probe / Then press Confirm to continue." — Confirm / Ignore) precedes it when the probe is not the active tool. |
| **Auto Probe** | **Auto Workpiece Leveling (Before Machining)** with `Clearance Height` (5), `X Points` (3), `Y Points` (3) and the sentence *"Enable Auto Leveling for uneven surfaces or shallow cuts (<0.5 mm), especially for fine machining such as PCB and engraving bi-color sheet."*; **Auto Z-Height Probing (Before Machining)** with `Relative to: Path Origin`, `X Offset` 20, `Y Offset` 7, a `Recommended` button, and *"Run Z Height Probe when starting a new job or re-fixturing a workpiece to ensure accurate Z zero setting."* The map draws the red Z-Probe dot inside the toolpath area. | nothing yet; the choices become `M495` words at Run |
| **Assist Options** | five toggles with one-line descriptions: **Auto Vacuum** "Automatically removes dust during machining", **Auto Blow** "Clears chips from the cutting area", **Auto Bed Clean** "Cleans the work bed after machining", **Anti-Static** "Reduces static dust buildup on non-metal materials", **Auto Time-Lapse** "Automatically records the machining process" | each toggle sends its mode code at once (`Z1-Firmware-Dialect.md` §11.3; `M331.x` / `M951`) |
| **Run** | a summary: Work Origin `(x, y) from Anchor1`, Scan Margin On/Off, Auto Leveling On/Off, Auto Z Probe `On, (20, 7) from Path Origin`, and the five assists; *"Confirm all settings before starting machining. You can stop the job at any time, adjust parameters, and restart if needed."*; a red STOP at every step | `buffer M495 X<ox>Y<oy>[C<xmax>D<ymax>][O<px>F<py>][P1]` then `play`. Observed: `M495 X10Y8C50D22O20F7` (2026-10-07: margin to 50,22 and Z-probe at 20,7) and `M495 X10Y8P1` (2026-10-12, four times). The firmware answers `Goto path origin first`, `G53 G0 Z-3.000`, `G90 G0 X10.000 Y8.000`, `Done ATC`, then the file plays. |

Two things worth copying and one to avoid. Copy: the **map** (origin, probe point, levelling grid and
toolpath area drawn on the bed before anything moves — §4.7 and §4.9 should draw the touch points the
same way) and the **one-sentence why** under every option. Avoid: the wizard is a *modal per run* that
remembers nothing — our run plan is the same information, saved with the job.

### A.5 Tool changes and probing, as the firmware runs them for Studio

The 2026-10-12 log shows a manual tool change inside a program (`T1 M6` with the probe active):
`M497.2` → `M490.1` (wait: **Tool Change Required** — "Please change to: Tool T1(3.175 flat) / Then
press Confirm to continue." in `D1-probe-cycle-mdi-log.png`) → ~90 s of operator time → `M493.2 T-1`
→ `M497.3` → `G53 G0 Z-3` → `G53 G0 X-9.890 Y-12.830` (the sensor) → `G38.6 Z-108 F500` →
`[PRB:…:1]` → `G91 G0 Z1` → `G38.6 Z-2 F100` → `[PRB:…:1]` → `M493.1` (save the offset) →
`G53 G0 Z-20` → `M493.2 T1` → `M494.2` → `Done ATC`. That is §2 of `Z1-Firmware-Dialect.md` observed
end to end from Studio's side, and it is the sequence our tool-change phase (§4.8) reproduces with
`M491` after a hand swap. Studio's Z touch from the wizard (`D1-probe-cycle-mdi-log.png`, 2026-10-07):
`G38.2 Z-108 F500` → `[PRB]` → `G91 G0 Z1` → `G38.2 Z-2 F100` → `[PRB]` → **`G10 L20 P0 Z0`** →
`G91 G0 Z1` → `M494.2` → `Done ATC` — the `G10 L20` that #387 found resets the tool-length reference.
Pause/resume strings in the log: `Suspending, waiting for queue to empty…` / `now save current pos…` /
`Suspended, resume to continue playing` and `Resuming playing… / Restoring saved XYZ positions and
state…` — the firmware saves and restores position across a pause. Stop: `Aborted playing or paused
file.` and, on the red STOP, `Aborted by halt / ALARM: Abort during cycle`.

Other probing dialogs in the strings: `Set Origin with 3D Probe` — *"Make sure the current spindle
tool is the 3D probe. The machine will start probing immediately, and the detected corner position
will overwrite the current work origin."*, the carbide-rod variant (*"Confirm that the current spindle
tool is a 3.175 mm diameter carbide rod"*), `Probing completed. The work origin has been updated.` /
`Probing was not completed. The work origin remains unchanged.`, and for the rotary: *"The work origin
is closer to the rotary chuck than the recommended clearance…"* and *"In 4-axis mode, the Y-axis
offset will automatically reset to 0."* Rotary mounting advice is a string too: *"For stock size under
20 mm, Standard Jaw Setup is recommended; for 20-35 mm, use Reverse Jaw Setup with Inner-Tooth
Clamping; for over 35 mm, use Reverse Jaw Setup with Outer-Tooth Clamping."* (with `Chuck Reverse
Mounting - Inner Side / Middle / Outer Side`, `Front-mounted chuck`, `Stock holding length`,
`Stock Shape`) — the numbers §4.2's rotary mount should quote when #238 characterises the module.

### A.6 The Monitor panel (what Studio shows while a job runs)

`D1-pre-run-options.png`, `D1-probe-cycle-mdi-log.png`: a **Monitor** 3D view of the toolpath with a
transport (first / play / last, a step size), a **Processing progress** card with the file name, three
status dots (Scan Margin, Auto Z Probe, Auto-Level), `Progress: n%`, `Elapsed time`, `Remaining time`,
pause / stop / red STOP / Start; a **Control** card with WPos and MPos per axis (large and small
numbers), feed / spindle / override readouts, `Probe TLO:…`, a jog pad with step sizes, `Home`,
`QuickMove…`, `Unlock`, `Set Origin`, `Reset`, `3D Probe`, `Auto Probe`; and **Operation Details** with
`G-Code` and `MDI` tabs and an `Enter Command…` box. Strings add `Preview started. Total time:`,
`Old total time:` / `New total time:` and `EstimatedProcessingTimeFromPathvertex:` — the estimate is
computed from the path's vertices, with no acceleration model named. §4.10's run screen keeps the
three things that matter here (progress, elapsed vs remaining, the line the machine is on) and adds the
phase list; it leaves out the jog pad and overrides by the standing refusals (R10).

### A.7 Machine switches and settings, from Studio's own config

`install/config/interface_config.json` is the diagnostic panel's declaration of every switch, with the
code it sends and the machines it applies to:

| Switch | On / off | Machines | Note |
|---|---|---|---|
| Spindle | `M3S10000` / `M5` | all | |
| SpindleFan | `M811S20` / `M812` | all | |
| Vacuum "Dust Collection" | `M801S20` / `M802` | **C1 only** (Carvera) | |
| PowerFan "Control Box Fan" | `M801S20` / `M802` | CA1, **Z1, Z1Pro** | the same code, a different name on the Z1 |
| Laser | `M3S0.05` / `M5` | all | |
| Extend output | `M851S5` / `M852` | all | the external-collector port |
| **Light** "Work Light" | **`M821` / `M822`** | **all** | so the Z1 has it; unobserved from our console |
| Air "Air Blast" | `M7` / `M9` | **C1 only** | consistent with `M7` doing nothing on the Z1 (§11.10) |
| ToolSensorPWR | `M831` / `M832` | C1 | |
| Probe Laser, WP charge, Anti-Static | … | | |

and a status monitor of limit switches, probe, calibrate, tool sensor, E-stop, **cover switch**
("Opening the door during machining will trigger a pause if door protection is enabled"), temperatures
and RSSI. `install/config/config.json` is the settings form, keyed to `ControllerConfig.txt`
(`Roaming/`): vacuum default power, **`switch.light.startup_state`** and `light.turn_off_min`,
**`stop_on_cover_open`**, auto-sleep, **`main_button_long_press_enable` = None / Sleep / Repeat**
("Repeat Last Job" on a 3-second press), anchor and clearance coordinates, soft limits, feed and
acceleration ceilings, the ATC/probe speeds (`atc.probe.fast_rate_mm_m`, `slow_rate_mm_m`,
`retract_mm`), the Z-probe group (`zprobe.slow_feedrate`, `fast_feedrate`, `return_feedrate`,
`probe_height`, `max_z`), spindle cooldown and the wireless-probe charge voltages. The bench's own
reads of these keys are in `docs/bench/2026-10-07-config-sweep.json` and #281.

### A.8 What the read changes in this document

- **§4.1**: the vendor-size column is Makera's own model (`materialSpecId`), not an invention; the
  sync already has the table.
- **§4.5**: Studio's guided mode already auto-picks a main tool by diameter, limits roughing to one
  tool and offers a clearance tool for 3D pockets; #410's rest-machining pick is the 2.5D equivalent,
  and the "lost" accounting is where we go past it.
- **§4.8**: the light is a real Z1 switch (`M821`/`M822`, `switch.light.startup_state`); `M7` is
  Carvera-only by Makera's own config; the Z1's "Auto Vacuum" toggle and the bench's `M331` are
  different statements of the same effect (the bench observed chips moved by `M331`; the panel config
  names `M801` as PowerFan on the Z1) — which code the *program* should carry stays the measured one.
- **§4.9 / §4.7**: draw the Z-probe point, the scan points and the levelling grid on the preview map
  before anything moves, as the wizard does.
- **§4.10**: Studio's pause saves and restores position (`Suspended … Restoring saved XYZ positions`);
  our stop is `abort`, and a pause (`M600`) is still unobserved from our console (#303) — a bench row.
- **§6**: two small rows added (the probe point on the map; "repeat last job" if ever asked).
- **Open question 15**: Studio's wizard defaults the Z-probe point to `(20, 7) from Path Origin` and
  calls it `Recommended`; ours is the cut area's centre. Keep the centre (the dome is highest there,
  which is the conservative Z0 for a reveal depth) or follow Studio's corner-ish default?
