# Case Maker — the CNC job workflow, end to end

**Status: design document, draft 2, 2026-10-15.** Written for the maintainer to review before any
issue is filed. Nothing in here is built unless a section says so; every "today" statement is a
reading of the code at `aa1343b` with its path, and nothing is a measurement unless it names the
bench day. Draft 2 applies the review of draft 1: the document is now written for **general CNC work
on the Makera Z1** — aluminium, brass, copper, acrylic, polycarbonate, ABS, Delrin, PCB, wood, MDF,
foam, tooling board and printed plastics; plates, blocks, rods, tubes and offcuts; held by tape, the
anchor bracket with clamps, the vise, the vacuum bed or the rotary. The two-colour badge blank that
the bench has cut so far is one worked example in Appendix C, beside a second that is not a badge
(an aluminium plate with pockets, holes and a tabbed cut-out, Appendix B). The new §3 describes the
**location** — the shop, its machines, accessories, tools, stock and consumables — because a job is
resolved against a place, and the brief's first question ("what stock will you work with") is really
"what is on the shelf".

Landmarks, used throughout: "front" is where you stand; on the vise the **fixed jaw is on the left**
and the jaws run front to back; on the anchor bracket the stock's corner sits in the bracket's
inner corner at the **front-left** of the bed (Makera's "lower-left corner").

---

## Contents

1. [Summary, goals, principles](#1-summary-goals-principles)
2. [Today's flow; keep / change / add / remove](#2-todays-flow)
3. [The location: machines, accessories, tools, stock, consumables](#3-the-location)
4. [What the field does: Makera and the competitors](#4-what-the-field-does)
5. [The proposed workflow, step by step](#5-the-proposed-workflow)
   - 5.0 [The spine](#50-the-spine) · 5.1 [Start: location, machine, stock](#51-start) ·
     5.2 [Mounting](#52-mounting) · 5.3 [Design: what we cut away, and the operations](#53-design) ·
     5.4 [Setups](#54-setups) · 5.5 [Tools](#55-tools) · 5.6 [Design → Cut](#56-the-mode-switch) ·
     5.7 [As-cut preview](#57-the-as-cut-preview) · 5.8 [Run plan](#58-the-run-plan) ·
     5.9 [Registration](#59-registration) · 5.10 [Running](#510-running)
6. [Save and reload](#6-save-and-reload)
7. [Gaps, mapped to issues](#7-gaps)
8. [Decisions (2026-10-15)](#8-decisions-the-maintainer-2026-10-15)
9. [Sources](#9-sources)
- [Appendix A: Makera Studio, read from the install](#appendix-a-makera-studio-0120-read-from-the-install-static-2026-10-15)
- [Appendix B: worked example — an aluminium plate on the anchor bracket](#appendix-b-worked-example-an-aluminium-plate-on-the-anchor-bracket)
- [Appendix C: worked example — the two-colour badge blank in the vise](#appendix-c-worked-example-the-two-colour-badge-blank-in-the-vise)

---

## 1. Summary, goals, principles

### What this document proposes

A **location** that knows what it has, and **one job document** that is resolved against it and goes
from a blank slate to a cut part through eight questions, in the maintainer's order, saveable at any
point:

| # | Question | Who answers it |
|---|---|---|
| 0 | **Where, and on which machine?** The location is the shop; its machine is preselected (one Z1 today). | the app, from the location |
| 1 | **What stock?** Material first; then the location's own shelf (purchased sizes and offcuts, in stock), then purchasable sizes from the synced catalogue, then a loaded STL/3MF, then a shape by dimensions. Layered (two-colour) stock is a stock property, not a job type. | the person |
| 2 | **How is it held, and which way round?** Tape, anchor bracket + clamps, vise, vacuum bed, rotary — what the location owns; plus which face is up and which edge is against the reference. | the person |
| 3 | **What do we cut away?** Operations (facing, pockets, profile cut-outs with tabs, holes, threads, chamfers, engraving, 3D relief on the roadmap) over negative volumes and imported geometry, or a target object the app subtracts from the stock. | the person; the app maps and checks |
| 4 | **From which directions?** Setups, one per cutting direction; planned from the geometry, overridable; remount instructions with a picture and a confirmation; re-registration per setup. | the app; the person overrides |
| 5 | **Which cutters?** From the location's inventory and the machine's collets: largest reach first, a smaller cutter for the rest, every lost region counted. | the app; the person overrides |
| 6 | **Switch to Cut.** The gate (generate → verify → simulate → oracle, across tools and setups) freezes a cut package and the screen becomes a run plan. | the app |
| 7 | **Preview as cut, then the plan.** The stock as it will come out; design-minus-cut drawn and counted; every phase with its time and its source. | the app |
| 8 | **Run it.** Upload, play, poll; registration by the method the stock and the mount call for; vacuum on by default; machine features as phases, not file flags. Stock consumed, offcuts recorded. | the app, with the person at the machine |

### Goals

- A person with a 100 × 100 × 5 aluminium plate from the shelf reaches a run plan that says what will
  happen and how long it takes before anything moves, having answered material, mount, geometry and
  nothing the app could have known.
- Every number says where it came from — a measurement with a date, a catalogue row, a shipped
  default, a planning estimate (decision 28, `FieldSource`).
- The location is the single home for what the shop owns, and a job binds to it by reference with
  snapshots, so a job survives a tool being lost or a machine being replaced.
- The transition from designing to cutting is one deliberate act with one screen that explains the
  run in physical words.

### Principles

1. **Fix the default before adding a control** (`feedback_defaults_over_knobs`).
2. **Measure, don't guess**; product constants are measured once and shipped, per-unit numbers are
   measured per unit, and provenance says which (decision 28; §3.2).
3. **Every number shows its source**, times included.
4. **The app loads the object and queries it** — setups, reach, registration plans are derived.
5. **Nothing vendor-derived is committed** (#347 Route A): vendor stock sizes, feeds and names stay
   in the user's synced catalogue and are read at runtime.
6. **The physical stop is the stop** (`Fabrication.md` §8): nothing moves without a person at the
   machine, and every phase that moves says so.
7. **Landmarks, not coordinates**, in anything an operator reads.
8. **Demand-driven**: what nobody owns or has asked for is named as not offered, not built.
9. **Minimise required operator steps** (maintainer, 2026-10-15: "we don't need to make the job
   require even more user interaction"). A step the machine can do, it does; a step that is only
   sometimes wanted is a **toggle, off by default** — never a prompt in the way. The one question
   the plan asks is the position check the maintainer asked for (#391); everything else optional in
   this document (laser frame, laser point-to-origin, 3D-probe confirm, air run on a repeat) is a
   switch the user turns on.

---

## 2. Today's flow

What exists at `aa1343b`. Paths are under `casemaker-app/src/`. The CNC sections sit behind
`featureSim` (`?BETA=yes` on the web build); everything that touches the machine is desktop-only.

### 2.1 The screens, in order

**A. Welcome → "Set up a cutting job…" → Start wizard** (`components/welcome/StartWizard.tsx`): (1)
machine — a select over `MACHINES` (one entry, Makera Z1) with a desktop-only network check; writes
`machineId`, the probe result and the frame calibration; (2) job — `badge-blank` or `blank`, which
builds a project and seeds the stock; (3) hands over to the setup wizard.

**B. Setup wizard "Set up this job"** (`components/panels/EngraveSetupFlow.tsx`,
`engine/cnc/engrave/setupFlow.ts`): holding (vise; rotary shown, disabled; sacrificial none / board
/ strips / custom), material (feeds-table materials ∪ the machine profile's ten), blank (L × W × T,
provenance, the stock-proud fix box), cutter (one select over the tool registry). One write on
Finish, every field `source`-tagged; "Same as last job". No step gates.

**C. The Engrave panel** (`components/panels/EngravePanel.tsx`), one long form: Stock (Use the badge
blank / Use the blank; L × W × T; material) · Voids under the face · Items (labels, shapes,
combined, traces, holes, vectors; "+ Add…" with Import outline SVG/DXF and Trace image) · Depth
margins · Tool (select, recommendation with "Why?") · Vise (six fields, save / measured) ·
Sacrificial material · Cutting (feeds with source and clamp tags, overrides) · Findings · Generate
(toolpath / verified / simulated / oracle rows, acknowledgement, Save .nc…, Upload…, Run sheet…,
Open run record…). The viewport's `EngravePreview` draws the opened region per item, floors by depth
or by the colour they land in, jaws, sacrificial bodies, voids, the origin.

**D. Run sheet** (`RunSheetView.tsx`, `engine/cnc/engrave/runSheet.ts`): nine sections with a
top-view diagram; §2/§4/§5 tagged "not yet confirmed on the machine (#208)"; the material-position
scan (#391) written and tested but held.

**E. Upload** (`EngraveMachineUpload.tsx`): verified program → `/sd/gcodes/`; "does not start the
job". **F. Simulate panel** (`SimPanel.tsx`): any `.nc`, sweep, transport, restart-from-step (#249).
**G. Manage mode**: Tools (the house inventory) and Machines (the Z1 card, calibration, "my machine"
export/import, vacuum switch, console); Materials disabled, "later".

**H. Outside the app.** Play / poll / abort are `tools/z1/z1.mjs run` (Windows). Probing (`G38.2`)
and tool length (`M491`) are typed. The 3MF design import is `scripts/engrave-job.ts --from-3mf`.
The job lives in localStorage only; the project file deliberately excludes it.

### 2.2 Where the brief's items land

| Brief item | Today | Gap |
|---|---|---|
| 1 stock library / load / make | typed L×W×T, two template routes; material list = table ∪ profile | no shelf, no sizes, no STL/3MF stock, no rod/tube/disc; Materials "later" |
| 2 mounting | vise only; sacrificial board/strips; orientation a fixed sentence (#383) | tape, bracket + clamps, vacuum bed, rotary; orientation as a question |
| 3 cut-away | 2.5D items with typed depth; SVG/DXF/raster; 3MF script-only (#410) | facing, cut-outs with tabs (#218), finish passes (#250), threads, chamfer, adaptive, 3D (#222); target object |
| 4 save/reload | localStorage autosave; `.job.json` by script | no Save/Open in the app |
| 5 switch to cutting | Generate rows inside the same panel | no mode, no transition screen |
| 6 preview as cut | opened region; sweep result; `item-detail-lost` numbers | one tool, one setup; lost region not drawn; V oracle (#408) |
| 7 phases with times | one cutting + rapids estimate (#242/#281) | no phases, no per-tool split (#278) |
| 8 machine features | vacuum in the file + a switch (#390); nothing for light, air run, auto-level | a home in the run plan |

### 2.3 Keep / change / add / remove

| Verdict | What | Why |
|---|---|---|
| **KEEP** | the setup questions and `applyAnswers`; `FieldSource` on every answer; "Same as last job" | #254's shape is right; this design extends it |
| **KEEP** | the gate (generate → verify → simulate → oracle); Save disabled with the reason; the acknowledgement | #206 is the safety spine |
| **KEEP** | the derived run sheet, the diagram, record blanks, run records; the Simulate panel; Manage › Tools / Machines, the console, the vacuum switch | they become the location's and the plan's surfaces |
| **CHANGE** | Start wizard step 1 → **the location and its machine** (§5.1); step 2 → **stock from the shelf** | the maintainer's item 1 and the location model |
| **CHANGE** | "What is holding the part?" → **mounting with orientation** over what the location owns (§5.2) | #383 |
| **CHANGE** | the item list → **one line per item**, Remove at the front beside show/hide, undoable (§5.3) | #411 |
| **CHANGE** | one `toolKey` → **a tool list per setup**, auto-picked with rest machining (§5.5) | #410, #278 |
| **CHANGE** | Generate → **the Design → Cut switch** with a preflight page (§5.6) | item 5 |
| **CHANGE** | one estimate → **phases with times and sources** (§5.8) | item 7 |
| **CHANGE** | Upload "does not start the job" → **Run** in Cut mode (§5.10) | #386 settled the path |
| **CHANGE** | localStorage job → **a saved job file**, autosave, Open/Save/Save as (§6) | item 4 |
| **ADD** | the location model (§3): machines with serials and per-unit calibration, accessories with provenance, the stock shelf and offcuts, consumables | the maintainer's second point |
| **ADD** | operations: facing, cut-outs with tabs, finish passes, threads, chamfer; adaptive and 3D on the roadmap (§5.3) | "the 99 %" |
| **ADD** | generic registration chosen by stock and mount (§5.9) | the fast scan was vise- and badge-specific |
| **ADD** | setups with remount instructions (§5.4); the lost layer (§5.7); the machine strip (§5.8) | — |
| **REMOVE** | the run sheet preamble "uploaded through Makera Studio" (`runSheet.ts:51-53`); "X runs between the vise jaws" as a constant; "Use the badge blank" as a headline button (it becomes a shelf entry) | stale / badge-first |
| **REMOVE (do not build)** | first-run machine wizard, job queue, override sliders, G-code editor | `Makera-Parity.md` §14.4 R1/R8/R9/R10 |

---

## 3. The location

A **location** is a physical place — a home shop, a makerspace bench, a shared workshop — and a user
may have more than one. Everything a job needs that is not the job itself belongs to a location:
the machines, what is bolted to them, the cutters in the drawer, the stock on the shelf, the tape and
boards, the calipers. A job **binds** to a location and resolves its machine, tools and stock from
it (§3.4). Today the app has one of these things built (the cutter inventory, decision 29's "house")
and the rest are scattered or absent (§3.3).

### 3.1 What a location holds

```
 Location "Kazoo shop"
 ├─ Machines ──────────── Z1 #Z1012601F010290  (profile: Makera Z1 · firmware 1.1.2.0.1.13 · 192.168.10.43 · plug switch.makera_cnc)
 │   ├─ per-unit calibration: tool-length sensor at (−9.890, −12.830) · clearance −3.0 · anchor1 (−190.89, −193.83) · soft limits · measured offsets
 │   ├─ accessories & fixtures: low-profile vise (owned, measured 2026-10-13/15) · rotary module (owned, unmeasured) · anchor bracket + top clamps (owned, in the box) ·
 │   │                          wired probe V2 (owned, tip measured) · 3D Probe Rod (in the box, conductive only) · Makera 3D Probe (owned, unused on the bench) ·
 │   │                          vacuum bed (not owned) · laser (not owned, never) · dust: AeroDust port, external collector (?)
 │   ├─ holders & collets: 1/8" (fitted) · 1/4", 6, 4, 3 mm (owned?)   · bit collars (box of 30)
 │   └─ wasteboard: MDF 2 mm, state: cut into at (…), replaced on (date)
 ├─ Tools ─────────────── the house inventory (37 boxes / 28 codes today): definition · quantity · condition · runtime · shank · which machine/slot it is in
 ├─ Stock shelf ───────── purchased sizes and offcuts: material · shape · dims · qty · finish/condition · layers (colour stack) · where it came from
 ├─ Consumables ───────── double-sided tape (20 mm roll, how much left) · sacrificial boards (MDF 100×100×2 ×n) · spoilboard
 ├─ Measuring tools ───── calipers (resolution 0.01) · dial gauge (?) · the wired probe counts here too
 └─ People & roles ────── not needed for a one-person shop; see §3.6
```

**Machines.** Each is a physical unit: serial (`Z1012601F010290`, from `M482.5` / the UDP announce),
model profile (`MACHINES.Z1`: envelope, spindle ceiling, feed ceilings, no ATC), firmware version,
network address and how it is found (discovery, a typed address), **power control** (the HA plug
`switch.makera_cnc` — a physical act, shown as state, switched only on request), and **per-unit
calibration**: the tool-length sensor's XY, the clearance position, the anchor coordinates, the soft
limits, the rapid model (#281), measured offsets — the `config-get sd` reads of 2026-10-07 and the
"my machine" file (#247) are this record today.

**Product constants vs per-unit measurements (§3.2)** decide where a number lives: the vise's jaw
widths and ledge step are the product's (measured once, shipped as `DEFAULT_VISE`), the sensor's
position is this unit's.

**Accessories and fixtures, per machine.** Vise, rotary module, vacuum bed, anchor bracket, top and
side clamps, the probes, the laser module, the dust path — each with **owned / not owned** and
**measured / default / unmeasured** with provenance and a date. A mount that is not owned is still
listed (greyed, "not owned — ask if you have one") so the shape of the question is right; a mount
that is owned but unmeasured is offered and refused at the gate by name (the rotary today).

**Tools.** The cutter inventory that exists (`house.json`: `inv:` possessions with quantity, box
codes, notes, pointing at a definition in the `cat:` / `user:` / built-in tiers). To add: **condition**
(new / used / worn / broken, with a date and a note), **runtime** per copy (#381), **shank** and
therefore **collet compatibility per machine** (a 6 mm-shank cutter needs the 6 mm collet the location
may not own), and **where each copy is** (in the drawer, in machine X's spindle, in ATC slot n on a
machine that has one).

**Materials and the stock shelf.** What is on the shelf, as purchased sizes and as offcuts:
material (the same words the feeds use), shape (plate / block / rod / tube / disc / sheet), dims,
quantity, finish (raw / faced / sawn), **layers** (a colour stack with thickness per layer — the
bicolour sheet Makera sells, a two-colour print, laminated acrylic), source (purchased: the catalogue
spec; printed: the print spec; offcut: the job it came from). **Offcuts are created from a job's
leftovers**: when a run finishes, the app proposes the remaining stock (the part cut out of a plate
leaves a plate with a hole; a block faced and pocketed leaves a thinner block) as a new shelf entry
with the job's name on it. Stock is **reserved** by a job in Cut mode and **consumed** when the run
records a finished cut.

**Consumables.** Tape (roll length left, as a note), sacrificial boards (count, thickness), the
spoilboard / wasteboard state (what has been cut into it, when it was last surfaced or replaced).

**Holders, collets and measuring tools.** Collets owned per machine (they gate which cutters can be
fitted); bit collars; calipers and their resolution (which decides what "measured" can mean on a
saved number); the probes are both accessories and measuring tools.

**People and roles.** Not for a one-person shop. A makerspace location would want who measured what
and who may run the machine; that is a later layer on the same model, not a V1 field.

### 3.2 Product constants vs per-unit measurements

| Kind | Example | Where it lives | Provenance |
|---|---|---|---|
| Product constant | the vise's jaw tops 10 mm, ledge step 3.1, bar length 100; the rotary's envelope ⌀80 × 150; the Z1's envelope 200 × 200 × 100 | code with a comment naming the bench day (`fixture.ts`, `machine.ts`) | `source: 'default'`, measured once on the reference unit |
| Per-unit measurement | this Z1's sensor XY, clearance Z −3.0, anchor1 XY, rapid model, the cutter length of the bit in the spindle | the location's machine record ("my machine" file, #247; `settingsStore.machineCalibration` today) | `measured`, dated |
| Per-setup measurement | how far this blank stands proud today; this blank's dome; where the stock really is | the job (per setup) | `measured` / `probed`, dated |
| Vendor data | catalogue cutters, feeds, stock sizes, material names | the synced `catalogue.json`, read at runtime, never committed | `catalogue`, with the sync date (#366) |

The rule the UI follows: a product constant is editable only by cloning ("your vise differs?
Save as my vise"), a per-unit value is a measurement with a date and a button to re-measure, and a
vendor value is read-only with its sync date beside it.

### 3.3 Where each lives today, and what is missing

| Thing | Today | Missing |
|---|---|---|
| The location itself | nothing — one implicit shop | the entity, its name, more than one |
| Machines | one profile (`MACHINES.Z1`); `machineStore` keeps the last probe (name, address, state); calibration in `settingsStore` and the "my machine" file (#247); power control only in `tools/z1/power.sh` | a machine **record** with serial, firmware, address, plug, calibration together; more than one machine; power state shown |
| Accessories / fixtures | vise: `DEFAULT_VISE` + saved/measured in settings; sacrificial presets; rotary, probes, bracket, clamps: documented in `Fabrication.md` §1 only | an accessories list with owned / measured / provenance; the bracket and clamps as modelled mounts |
| Tools | **built**: `house.json` (`inv:` with qty, codes, notes; `user:` clones), `catalogue.json`, Manage › Tools, box-code scan (#309, #377–#380) | condition, runtime (#381), collet compatibility per machine, which machine/slot |
| Materials | names: table ∪ profile (#347); feeds: house rows + catalogue tier (#310) | a materials scope (Manage rail says "later") |
| Stock shelf | nothing (two template routes: badge, plank) | the shelf, offcuts, reservation/consumption; vendor sizes via the sync (`t_MaterialSpecs`) |
| Consumables | sacrificial board/strips as job fields (#213) | an inventory of them; wasteboard state |
| Collets / holders | `Tool.handleDiameter`; `Z1.holder` null | collets owned per machine; the holder measured |
| Measuring tools | the probe's tip in `PROBE_SPEC` | calipers' resolution as a stated input to "measured" |
| Export / sync | `house.json` export/import; `casemaker-my-machine.json`; the house service on `/api/v1` (decision 31) | one location export; the LAN sync already exists for the house |

### 3.4 How a job binds to a location

- A job carries `location.id` and `machine.serial`, plus the profile id (`Z1`) that the gate clamps
  to. It references tools by possession (`inv:` key) and stock by shelf item id, and **snapshots**
  each (the `Tool` record, the stock's dims/material/layers) so the job generates the same `.nc`
  after the drawer changes (the rule `jobTool` follows today).
- **Resolution at open**: the location is looked up; each reference is checked — the cutter still
  owned and not marked broken, the stock still on the shelf (or consumed by this job), the mount still
  owned. A missing reference is a finding with a fix ("the 2 mm O-flute is marked broken; the same
  definition is owned ×1 under another box — use it?"), never a silent substitution.
- **Moving a job to another location or machine**: re-resolve. Same profile → tools matched by
  definition (not by possession), stock by material + dims (or the user picks from the new shelf),
  fixtures by kind; the package goes stale and the gate reruns. Different profile → the stock is
  checked against the new envelope, feeds re-clamped, mounts re-offered; everything that was per-unit
  (sensor, anchors) comes from the new machine's record. A job never carries another machine's
  per-unit numbers.
- **What a job writes back**: run records, measured values the operator typed (the proud height, a
  calipered depth), the consumed stock and the offcut, tool runtime.

### 3.5 Export and sync

The house service (decision 31) already serves `house.json` and `catalogue.json` on the LAN with
`If-Match` concurrency; the location is the next document beside them (`location.json`: machines,
accessories, shelf, consumables), exported as one file with the house, and imported with provenance
intact. The "my machine" file becomes the machine record inside it. The hosted web build keeps the
built-ins and no location (as with the house today).

### 3.6 How the field models this

| Product | Machines | Tools | Materials / stock | Inventory on the shelf | Source |
|---|---|---|---|---|---|
| Fusion | machine library (optional per setup) | Local / Fusion Library (read-only) / Cloud / Document / Vendor libraries | no material library; stock is a per-setup box or solid | none | MFG-TOOL-LIB-TYPES, MFG-CREATE-SETUP |
| Carbide Create | machine chosen in Job Setup | libraries "for each machine as well as specific materials", custom tools | material = a category key for feeds | none | guides.carbide3d.com/create/tool-library |
| VCarve | Machine Management dialog | Tool Database: geometry tree × materials × machines → cutting data | material = appearance + feeds key | none | Tool Database V12.5 |
| Makera Studio / DB | `t_MachineType`, `t_MyDeviceList` (name, IP), `t_MachineResourceParameters` (named XYZ per model) | `t_MakeraCutterList` + custom clones, **`t_CutterInventoryList` (qty)**, `t_SkuMapping` (shop URL) | `t_MaterialCategory` → `t_MaterialList` → **`t_MaterialSpecs` (sized stock, R/C)** + customer twins | cutters: yes (qty); stock: the purchasable list, not what is owned | Appendix A.3 |
| xTool XCS | device-bound | n/a | EasySet material library by machine/power/mode; custom materials via a camera-read test grid | none | support.xtool.com/article/1717 |
| Glowforge | one printer | n/a | Proofgrade QR on the stock itself | implicitly: the sheet in the bed | glowforge "Proofgrade Material Not Detected" |
| LightBurn | device profiles | n/a | material library `.clb` per device: name › thickness › settings; Material Test | none | docs.lightburnsoftware.com MaterialLibrary |
| Bantam | one machine | custom tool library (json import/export) | "standard size or custom" stock, fixturing dropdown, tape thickness | none | support.bantamtools.com Software-Overview |
| **Case Maker proposed** | records with serial, calibration, accessories, plug | house inventory + condition, runtime, collets, where | shelf of owned stock with layers and offcuts, plus the vendor's sizes at runtime | **yes**, reserved and consumed by jobs | §3 |

Nobody in the field keeps **owned stock** or **offcuts**; Makera's DB is the closest (cutter
quantities, purchasable sizes, a device list) and its UI does not use the sizes. The location model
is the one place this design is ahead of every product reviewed, and it costs little: the house
service, the sync and the provenance discipline already exist.

---

## 4. What the field does

Sources are in §9. "unverified" marks what the researcher could not confirm from an official page.
Makera's wiki is JS-rendered; what we know of it is the seven cached pages plus Appendix A's read of
the installed Studio.

### 4.1 Makera's own flow, and what it sells

**Makera CAM** (Carvera / Air): `3 AXIS` / `4 AXIS` presets; `.mkc` projects; stock = material (a
Material Library) + L/W/H, 4-axis adds Square / Round; WCS tabs on 10 stock control points (a
second WCS is how a two-sided job is done); import image / DXF-SVG / STL-STEP / Gerber, **no 3MF**;
2D contour-pocket-drill-thread-chamfer, 3D relief-contour-pocket, rotation relief, laser; no
dedicated V-carve; pocket and relief with **multi-tool clearing**; the tool number is the
tool-change identity (prompts a manual change on no-ATC machines); a toolpath line preview; one `.nc`
out; no machine link.

**Makera Studio** (Z1), from Appendix A: process modes per project (2D Vector, 3D Model, 3-Axis
Relief, Custom 3-Axis, Custom 4-Axis, Laser) with a **Guided Mode** of scheme steps that calculates
tools (Main Tool by diameter, one roughing tool, a Clearance Tool for 3D pockets, finishing), and a
per-run **Machining Wizard**: *Set Stock → Set Origin → Auto Probe → Assist Options → Run*, on a map
of the bed with the anchor bracket, the toolpath area, the origin, the Z-probe point and the
levelling grid; Run sends one `M495` macro and plays. The Monitor shows progress, elapsed and
remaining time, pause / stop / STOP, a jog pad, and G-code / MDI tabs. Its project is a workblank =
material + material spec (a sized stock) + L×W×H + chuck diameter.

**What Makera sells** (sizes only where the page shows them): 6061 aluminium block 35×35 or 50×50 ×
100 / 200; acrylic 3 / 4 / 5 / 10 × 100×150 or 150×200; 1.5 mm PCB 100×150 or 150×200; brass sheet
1 / 3 / 5 / 10 × 100×100 or 100×200; epoxy tooling board 10 / 20 × 100×100 / 100×150 / 150×200;
copper, Delrin, carbon fibre, Bakelite, synthetic stone and **bicolour stock** (sizes not captured;
100×100×1.3 in the Z1 box); no wood. In the box: epoxy 100×100×10, aluminium 100×100×5, MDF
100×100×2, bicolour 100×100×1.3. Accessories: vise ($99, no dimensions published), vacuum bed ($149),
top clamp set, side clamps, L-bracket, 20 mm double-sided tape, collars and installer, collets 1/4"
/ 6 / 4 / 3 mm, wired probe V2, 3D wired probe ($99), 4th axis ($299, ⌀80 × 150), laser 5 W. The
Studio library holds 15 materials and **189 purchasable sizes** (137 rectangular, 52 round).
Speeds-and-feeds page: 1/8"-shank bits × Aluminum / Brass / Carbon Fiber / Copper / Hardwood / PCB /
Plastic / Softwood, RPM / feed / plunge / DOC per cell, "start the test from the lower limit"; no
PLA.

### 4.2 Eight competitors, side by side

| | Stock library with sizes | Mounting as an input | Design in: SVG · DXF · STL · 3MF · text | Tools: library · owned · multi-tool · rest | As-cut preview | Time estimate | Probe / zero | Tool-change length | Dust/air/light in the job flow | Run monitor · pause · restart from point | Two-sided | Project file |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Carbide Create + Motion** | no | no | Y·Y·Pro·N·Y | Y·N·Y·Pro | animated simulation | CC and CM disagree 30–40 % | BitZero corner/Z | BitSetter on every Z-zero | door interlock | Y · Y · from start | manual mirror + jig | `.c2d` + `.nc` |
| **Easel** | no | no | Y·Y·Y·N·Y | Y·N·two-stage·N | "Uncut Area" | quick + full | Z-plate; "USE LAST XY" | re-probe | spindle confirm | Y · ? · ? | mirror + dowels | cloud |
| **VCarve** | no | no | Y·Y·N·N·Y | Y·N·Y·Pro | **per-tool fill, animate, step** | feeds + rapid + scale; V12.5 accel | none | n/a | n/a | n/a | **Double Sided, flip direction, per-side sheet** | `.crv` |
| **Fusion** | no (stock modes) | fixtures as collision bodies | Y·Y·Y·N·Y | Y·N·Y·**Y** | yes + model comparison | under-estimates | industrial only | n/a | n/a | n/a | **setups, stock carried** | `.f3d` |
| **Luban** | no | no | Y·Y·Y·N·Y | profiles·N·N·N | toggle | none | paper-feel; Run Boundary | re-zero | none | Y · Y · power-loss Resume | no | Save/Open |
| **xTool** | material library | n/a | Y·Y·N·N·Y | n/a | video; cut-through | some models | auto-focus; framing | n/a | **air levels, exhaust run-on** | Y · Y · ? | no | `.xcs` |
| **Glowforge** | **QR on the stock** | n/a | Y·N·N·N·Y | n/a | none | yes | Set Focus | n/a | fans run on | lid = abort | no | cloud |
| **LightBurn** | settings library, no sizes; Material Test | n/a | Y·Y·N·N·Y | n/a | path + time slider | parameters exposed | n/a | n/a | exhaust delays | Y · Y · **Start Here** | no | `.lbrn2` |
| **Bantam** | **standard size or custom** + fixturing | **yes** | Y·N·G-code·N·Y | Y·Y·Y·N | collision warnings | not found | bracket Locate; conductive XYZ; Z-only; manual | **touch-off on Install Tool** | — | pause at tool change | PCB flip with pictures | none |
| **Makera CAM / Studio** | sized specs in the DB | anchor bracket as datum | Y·Y·Y·**N**·Y | Y·qty·Y·clearing | lines (as-cut unverified) | vertex-based | anchor + Auto Z Probe; Scan Margin; Auto Leveling | sensor after every change | Auto Vacuum / Blow / Bed Clean / Anti-Static / Time-Lapse | progress + remaining; pause saves position; resume at line | second WCS; pins | `.mks` |
| **Case Maker today** | templates | vise, sacrificial | Y·Y·N·script·Y | tiers·**owned + scanned**·N·N | opened region + exact sweep + oracle | trapezoid, unmeasured | prose; held scan | prose | file + switch | upload only | no | localStorage |
| **Case Maker proposed** | **shelf + vendor sizes + load + make** | **tape · bracket+clamps · vise · vacuum bed · rotary, with orientation** | Y·Y·Y·**Y**·Y + target object | house·owned·**auto multi-tool with rest** | as-cut across tools and setups, **lost layer** | **phases with sources** | by stock and mount (§5.9) | M491 as a phase | vacuum default on, air run, auto-level, light — in the plan | play/poll in-app, restart from step, resume at setup | **setups with remount instructions** | job file + autosave + records |

What the columns teach: stock as a thing you pick exists only at Bantam and Glowforge; mounting as an
input only at Bantam and Makera; as-cut preview at VCarve and Fusion; nobody shows **phases** (tool
changes are at best markers on a bar); machine features in the job at xTool and Makera; timeline
restart only at LightBurn; two-sided declared at VCarve, carried at Fusion, pictured at Bantam.
Studio's weaknesses (`Makera-Parity.md` §8.1) remain our requirements, and its community tracker's
asks — one-step send-and-run, run state that survives a cancel, a margin preview without a laser,
collision checks before export — are all in §5.

### 4.3 Two-sided and multi-setup, product by product

| Product | Sides declared | Side 2 aligned by | Operator instructions | Stock after side 1 | Time per setup |
|---|---|---|---|---|---|
| Fusion | one Setup per side; WCS flipped; Stock *From preceding setup* + *Continue rest machining* | the user's WCS + modelled fixture; forum: centre-symmetric dowels, zero to a modelled pin | Setup Sheet per setup (image, WCS, stock, time); no flip wording | carried; origin-drift complaints, STL workaround | per setup |
| Carbide Create | none: double-height stock with a mirrored copy, one group per side (staff workaround) | centre dowels ("doubles any error"), a cut flip frame (staff preference), a through-hole, a corner square; Nomad Flip Jig | none | none | per file |
| VCarve | **Job Setup › Double Sided**; flip direction; Z-zero per side or shared; Toggle Side; toolpaths per side | "keep a common registration position"; dowels are lore | job sheet per side names the side and the flip direction | *Preview All Sides* combined; no rest | per toolpath |
| Makera CAM | a second WCS tab on a bottom-plane control point; "draw holes for alignment pins" | anchor corner + re-probe Z; pins; 3D probe centre-finding; Scan Margin by eye | none found | none found | none found |
| Bantam (PCB) | Top/Bottom toggle | **same corner of the board** against the bracket | step-by-step prose with photos and a troubleshooting table | n/a | n/a |
| Kiri:Moto | `flip` op | a `registration` op drills holes from the stock parameters; v4.4 notches tabs to show the flip | tabs show orientation | unverified | — |
| **Case Maker proposed (§5.4)** | setups planned from the geometry; override | by mount: bracket corner (XY from the machine), vise fixed jaw (X, rotation), probe for the rest; features cut in setup 1 as references | exact instruction with picture and a confirmation question | **carried**: setup N+1 simulated on setup N's result | remount + re-probe phases with times |

The forum failure modes §5.4 refuses or names: re-zeroing XY after the flip, the physical flip not
matching the CAM mirror, stock not matching the CAM block, centre-referenced doubling of error, pin
slop, re-homing between sides.

---

## 5. The proposed workflow

### 5.0 The spine

```
  LOCATION (§3) ─ machines · accessories · tools · shelf · consumables
       │ resolves
   ┌───▼──────────── DESIGN MODE ─────────────┐     ┌──────────── CUT MODE ────────────┐
   │ 1 Stock → 2 Mount → 3 Cut-away → 4 Setups│ ──▶ │ 6 Gate → 7 As-cut + Plan → 8 Run │
   │          (5 Tools: picked, overridable)   │ ◀── │  any Design edit marks Cut stale │
   └──────────────────────────────────────────┘     └──────────────────────────────────┘
                    one job document  <name>.cutjob.json  (autosave · Save / Open)
```

One job document (§6), reachable with no case project open. Two modes, one header toggle; the switch
is the gate (§5.6). Setups are a list inside the job, one per cutting direction (§5.4); a
single-setup job shows one line. Tools are chosen per setup by the app (§5.5). The Start wizard is
the door, not a gate: it asks §5.1 and §5.2 in two screens and lands in Design mode; every answer is
also a section of the Design panel.

### 5.1 Start

**Purpose.** Name the place and the machine (the location's, preselected), then the stock —
**material first**, as the maintainer asked, then where it comes from.

```
 ┌─ New cutting job ──────────────────────────────────────────────────────────────────┐
 │ Location  [ Kazoo shop ▾ ]   Machine  [ Makera Z1 · Z1…010290 ▾ ]  ● Idle · homed    │
 │                                                                                     │
 │ Material  [ 6061 aluminium ▾ ]      (table ∪ profile; feeds: catalogue row ✓)        │
 │                                                                                     │
 │ Stock                                                                               │
 │  ┌ On the shelf (3) ──────────┐ ┌ Makera sizes (synced 10-08) ─┐ ┌ Load ──┐ ┌ Make ─┐ │
 │  │ ● plate 100×100×5  ×2      │ │ block 35×35×100              │ │ STL /  │ │ plate │ │
 │  │ ○ offcut 60×100×5 (job 12) │ │ block 50×50×200              │ │ 3MF    │ │ block │ │
 │  │ ○ block 35×35×100 ×1       │ │ (12 sizes for 6061, filter ▾)│ │        │ │ rod   │ │
 │  │ [ add to the shelf… ]      │ │                              │ │        │ │ tube  │ │
 │  └────────────────────────────┘ └──────────────────────────────┘ └────────┘ │ disc  │ │
 │                                                                              └───────┘ │
 │ plate 100×100×5 · 6061 · raw (sawn faces) · measured 2026-10-16: 5.02 thick            │
 │ layers: none      finish: raw ▸ face it first (default for raw metal)                  │
 │                                                              [ Cancel ]  [ Next: mount ]│
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

**Four doors, in this order.** (1) **On the shelf** — the location's own stock for this material:
purchased sizes with quantity and offcuts with the job they came from; "add to the shelf" is how a
new purchase or a printed blank gets in (its dims typed or taken from a catalogue spec, its layers
if any, its finish). (2) **Makera sizes** — the synced catalogue's `t_MaterialSpecs` for this
material, read at runtime (names and dims, nothing committed; absent with the reason when no
catalogue is present); picking one offers "add to the shelf" too. (3) **Load** — an STL or 3MF as
the stock: a prism (identical slices) cuts as a block of that outline; a non-prismatic mesh is 3D
stock and is offered but refused by name until #222; a PrusaSlicer 3MF with negative volumes is
recognised and offered as **stock + design** in one step (#410). (4) **Make** — plate / block (L ×
W × T), rod (⌀ × L), tube (⌀o × ⌀i × L), disc (⌀ × T). **Sphere is not offered** (nothing we own
holds one; nothing cuts one; nobody asked).

**Stock properties, general.** Material; shape; dims with source; **finish** (raw / faced / sawn —
raw metal and wood default to a facing operation, §5.3); **layers** (a colour stack with thickness
per layer and the print grid when it was printed — the bicolour sheet, a two-colour print, laminated
acrylic; it makes `reveal` / `surface` depth intents available and drives the preview's colours);
**flatness** (flat / domed n mm / unknown — drives auto-level, §5.9); **conductive** (yes for
metals, PCB copper; no for plastics, wood — drives which probe can find XY, §5.9); **voids** (known
pockets under the face, from a loaded model or a saved entry).

**Validation.** Stock outside the machine's envelope refused by axis; a material with no feeds row is
allowed here and refused at tools, naming the row (#347); a non-watertight mesh refused with its open
edge count; a shelf item with quantity 0 is shown and refused ("consumed by job 12").

**Saved:** `location.id`, `machine.serial`, `machineId`, `stock { shape, dims, material, finish,
layers?, flatness, conductive, voids?, source: { kind: shelf|catalogue|file|user, id|path+hash },
snapshot }`.

### 5.2 Mounting

**Purpose.** How the stock is held and **which way round**, over the mounts the location owns.

```
 ┌─ How is it held? ────────────────────────────────────────────────────────────────┐
 │ ● Anchor bracket + top clamps   (owned · the Z1's own kit · bracket at anchor 1)  │
 │ ○ Double-sided tape on the wasteboard  (owned · tilt needs auto-level)            │
 │ ○ Low-profile vise              (owned · measured once · ±0.5)                    │
 │ ○ Rotary chuck                  (owned · not characterised — #238)                │
 │ ○ Vacuum bed                    (not owned — ask if you have one)                 │
 │                                                                                   │
 │ Which way round?                            ┌──────── top view ────────┐          │
 │  Face up:        ( the sawn face ▾ )        │ bracket│  plate 100×100  │          │
 │  Into the bracket's corner: ( front-left ▾ )│   ┘    │  clamps ▪  ▪    │          │
 │  Nearest you:    ( the short edge ▾ )       └──────────────────────────┘          │
 │  → XY datum: the bracket (machine-known, ±0.1); rotation: the bracket's face       │
 │ Clamps: 2 top clamps on the back edge, 15 mm in ▸ obstacle footprints drawn        │
 │ Sacrificial: ( MDF 2 mm board under, from the shelf ×4 ▾ )  needed for the cut-out │
 │                                                    [ Back ]  [ Next: cut-away ]    │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

**The mounts, and what each one fixes** (decision 26's four questions, answered per kind):

| Mount | Fixes without a probe | Obstacles the tool must miss | Needs | Best for |
|---|---|---|---|---|
| **Anchor bracket + top/side clamps** | XY and rotation from the machine's anchor (`coordinate.anchor1_x/y` + offsets; Makera: "detect the lower-left corner as the machining origin") | the bracket's two arms, each clamp's footprint (`top-clamps` variant in `setup.ts`) | clamps clear of the toolpath; a sacrificial board for through-cuts | plates and blocks; the Z1's default |
| **Tape on the wasteboard** | nothing (the probe finds XY and rotation; auto-level finds tilt, #191) | nothing above the stock | a flat, clean wasteboard; tape thickness recorded | sheet, PCB, thin plates, anything a clamp would mark |
| **Vise** | X and rotation from the fixed jaw (±0.05) | the two jaws (measured product constants) | stock proud of the jaws; ledge seat | small blocks and blanks; parts cut on more than one face |
| **Rotary chuck** | the axis (A); radius and run-out probed | chuck body and jaws (Studio's own clearance warning) | round or squared stock within ⌀80 × 150 | wraps, indexed faces (#223, #240) |
| **Vacuum bed** | nothing (as tape) | nothing above | the Cyclone collector | sheet work — not owned, not built |

**Orientation is three landmark choices** that redraw the picture: which face is up, which edge or
corner is against the reference (bracket corner / fixed jaw / the bed's front edge for tape), which
end is nearest you. The job frame follows: work X and Y from the reference, Z0 on the up face.

**Defaults.** Bracket + clamps for plates and blocks on this machine (it is what Makera ships and what
its software assumes); tape for sheet ≤ 3 mm; the vise when the stock is narrower than the jaw
opening and taller than the ledge; the rotary for rods. Stock proud in the vise defaults to the
seated value (`min(4, t/2, t − 3.1)`, #391 review); the thin-stock case is #406.

**Validation.** Clamp footprints inside the toolpath (`clamp-in-path`, error, with "move it to the
back edge" as the fix); stock larger than the bracket's arms hold (warning); `vise-grip-shallow`,
`stock-proud-too-small`, `vise-jaw-short`, `vise-opening-unmeasured` (the opening is published
nowhere); a rotary stock outside ⌀80 × 150; a mount the location does not own (refused, with the
sentence).

**Saved:** `mount { kind, orientation { faceUp, againstReference, nearestYou }, params with source, clamps[], sacrificial }`.

### 5.3 Design

**Purpose.** State the removal as geometry the app can measure, choose the operations that make it,
and let the app say what a real cutter makes of it.

#### What a removal is

- **Negative volumes** placed in the stock: today's items (labels, shapes, combined, traces, holes,
  SVG/DXF outlines, raster traces), **3D primitives** (box, cylinder in any axis, tube, sphere as a
  dimple), **3MF negative volumes** (#410), any number from any files.
- **A target object**: an STL/3MF of the finished part; the removal is `stock − object`, mapped into
  the stock automatically (largest face up, centred, top flush; or as the file positions it) and
  movable. Everything outside the object is removed, which is a cut-out — so this mode depends on
  profile cutting with tabs (#218) and says so when chosen.

**Boolean semantics.** Removal = union of every item's volume, clipped to the stock. Overlaps are
fine. Each 2.5D item has a depth (typed, or `reveal` / `surface` when the stock has layers); a 3D
primitive's depth is its geometry. Floors keep clear of every known plane (a void's ceiling, a layer
boundary, the underside) by the boundary margin (#345); a through-cut is the exception and needs a
sacrificial board (#218).

#### Operations: what V1 covers and what is roadmap

| Operation | What it is | State | Issue |
|---|---|---|---|
| **Facing / surfacing** | parallel passes over the stock's top at a set depth, so the top is true and Z0 is known; the stock's finish becomes `faced` and the carried stock is thinner by that depth | **missing entirely**; default **on** for raw metal and wood, off for sheet with a finished face | **NEW** |
| Pocket (flat floor) | contour-parallel clearing to a depth | built (#172) | — |
| Pocket with **finish pass and stock-to-leave** | roughing leaves n mm on walls/floor; a finishing pass takes it at a lighter cut | planned | #250 |
| **Profile cut-out with tabs**; through pocket | follow an outline outside/inside through the stock onto the board, tabs hold the piece; loose-piece check | planned, blocked by #213 (done) and #204 (done) | #218 |
| **Rest machining**, two tools | the second cutter cuts only what the first could not reach | planned | #410 (two files), #278 (one file with `M6`) |
| Holes: plunge-drilled at the cutter's diameter, pecked | built | #220 | — |
| Holes: **drilled with a drill bit**; **thread milling** (M3–M5 with Makera's thread mills) | the drill and thread-mill shapes exist in the inventory and the catalogue; no CAM and no simulation | planned | #382 (simulate every owned cutter) + **NEW** CAM |
| **Chamfer** | a V or chamfer bit along an edge at a fixed offset and depth | planned | #221 (piece) |
| Engraving: single-line traces, V traces, V text | built (#219, #405, #409) | V groove oracle pending | #408 |
| V-carve (medial axis), flat-depth clearing | planned | #221 | — |
| **Adaptive / HSM clearing** for metals | constant-engagement pocketing (trochoidal), the strategy a 150 W spindle wants in aluminium and brass | **roadmap**, after #250; Studio has none (unverified), Fusion does | **NEW** |
| Ramped / helical entry | refused for the engraving scope (`Makera-Parity.md` §14.4 R16) | **reopened as a question** for metals (§8) | — |
| **3D relief and sloped surfaces** | the dexel engine; Studio has it (3D Relief, 3D Pocket Rough/Finish) | **roadmap phase**, not just "refused": refused by name today, with the preview showing the designed shape hatched "needs 3D" | #222 |
| Rotary wrap / indexed faces | planned, R-3 / R-4 | #240, #241, #223 |
| Laser | never on this machine | decision 4 | — |

**V1 scope, stated:** 2.5D on flat-floored stock — facing, pockets, holes at cutter diameter,
engraving and V traces, SVG/DXF/3MF geometry, rest machining with two flats, profile cut-outs with
tabs once #218 lands — on the bracket, tape and the vise. Everything below the line is roadmap in the
order shown: finish passes → cut-outs → threads/drills/chamfer → adaptive → 3D → rotary.

#### The item list (one line per item, #411)

```
 ┌─ Cut-away (5 items)                              [ collapse all ] [ + Add ▾ ] ─┐
 │ ✕  ◉  ▸ ▭  Face  0.30 mm            T1 · whole top                              │
 │ ✕  ◉  ▸ ▢  Pocket A  12×8  4.0 mm   T1 · finish 0.2 (#250)                      │
 │ ✕  ◉  ▾ ⌖  Holes ×4  ⌀3.2  thru     T1 plunge · pecked                           │
 │           pattern  rect 4 ▾   pitch 80 × 80   at  (10,10)   through ☑  peck 1.0  │
 │           reach: 3.175 flat 100 %                                                │
 │ ✕  ◉  ▸ ◫  Logo (SVG)  1.0 mm       T2 0.6 corn · lost 2 % ⚠                     │
 │ ✕  ○  ▸ ◯  Cut-out  tabs 4          T1 · needs board ✓   (hidden: cut by nothing)│
 │ ─ Voids under the face (0) ─                                                     │
 │ Depth margins  0.2 mm · for this stock 0.2 ✓                                     │
 └──────────────────────────────────────────────────────────────────────────────────┘
   after a remove:  ┌ "Logo (SVG)" removed.   [ Undo ]  ┐   (8 s, Ctrl-Z, or until the next edit)
```

The collapsed line, identical for every kind: **Remove (✕, with its tooltip and keyboard access) at
the front, beside show/hide (◉ cut / ○ hidden — kept, drawn ghosted, cut by nothing)**, then the
chevron, the kind glyph, the name, the depth with its intent word, the tool it will be cut with, and
`⚠` when the item has a finding. New items open expanded and the rest collapse; the last edited stays
open; collapse/expand all; per-item state kept for the session; a click in the viewport expands and
scrolls to the row. **Remove is undoable** (undo stack, toast 8 s, Ctrl-Z) with no dialog; `Remove
all` keeps its confirmation. Ten items fit at 1440 × 900 (#411's acceptance) and the phone/tablet
layouts get the same rows (#134). #411 is this list for the current panel; the design keeps it.

Each expanded item carries its **reach** per candidate cutter and its **lost** share, live, in the
words `item-detail-lost` uses; those numbers are what §5.5 ranks on.

**Validation.** As today (`item-depth-bound`, `depth-exceeds-stock`, `cut-too-deep`, reach into
jaws or clamps) plus `cuts-clamped-face` (error: an item removes a face the mount holds in this
setup), `through-needs-board`, `loose-piece` (#218), `clamp-in-path` (§5.2), and `face-first`
(warning: pockets on raw stock with facing off).

**Saved:** `items[] { kind, operation, source { file, volume|layer, hash }, geometry, depth|intent, placement, enabled, hidden }`, `targetObject?`.

### 5.4 Setups

**Why.** A 3-axis tool comes straight down; material on the back, a side or the far end is reachable
only after the part is turned, and turning it is a re-clamp and a re-find. Maintainer, 2026-10-15:
cut from one direction, and when needed have the user remount after rotating, under our direction.

**Definitions.** A **setup** is one held position: a mount + orientation, the items reachable from
above in it, their tools, a registration plan. A job is an ordered list of setups; the stock entering
setup N+1 is the simulated result of setup N.

#### Planning from the geometry

1. Classify each removal face by its outward normal in the stock frame (top, bottom, left, right,
   front, back); a pocket is reachable from the face its opening is in; a through feature from
   either; a target object's removal is split by the face each region opens to.
2. Choose directions greedily: the direction reaching the most volume first (ties: the chosen
   face-up), then the next for what is left; what no direction reaches is reported lost.
3. Turn each direction into a mount the location can hold: on the bracket, the bottom means a flip
   with the **same corner** into the bracket (Bantam's rule, Makera's anchor); on the vise, top and
   bottom are flips keeping the same edge on the fixed jaw, a side or end means standing on an edge
   (needs the opening and a flat face); on tape, a flip onto fresh tape with two edges re-found. A
   direction the mount cannot hold is `unholdable` with the reason and the rotary offered.
4. Order: the chosen face first, then the one leaving the most grip for the next.

**Manual override.** The list is editable: add a setup (face-up and reference edge), drag items
between setups (only where reachable), reorder, merge; validated the same way.

```
 ┌─ Setups (2) ────────────────────────────── planned from the geometry · [ edit ] ┐
 │ 1 ▸ sawn face up · front-left corner in the bracket · short edge nearest you    │
 │     face · pocket A · holes ×4 · logo              T1 3.175 flat, T2 0.6 corn    │
 │     cut 14 min · 1 tool change                                                   │
 │ 2 ▸ FLIP SIDEWAYS (left edge goes to the right): faced face DOWN on the board ·  │
 │     the SAME front-left corner into the bracket · the short edge still nearest   │
 │     back chamfer · cut-out with tabs                T1 3.175 flat                │
 │     cut 6 min · remount ~3 min · re-register ~2 min (bracket XY + Z touch)       │
 │     registration: XY from the bracket ±0.1 · Z touch · expect ≤ 0.15 mm step     │
 │     grip after setup 1: clamps land on uncut margin ✓ · board under ✓            │
 │ Alternative: rotary chuck — needs round stock; not for a flip                    │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

#### The remount page (between setups)

```
 ┌─ Remount for setup 2 of 2 ─────────────────────────────────────────────────────┐
 │  BEFORE                                  AFTER                                   │
 │   ┌──────────┐ ← back                     ┌──────────┐ ← back                    │
 │   │ sawn     │  clamps ▪  ▪               │ faced    │  clamps ▪  ▪              │
 │   │ face up  │                     ───▶   │ face     │  the SAME corner sits     │
 │   │          │  corner in the bracket ┘   │ DOWN     │  in the bracket ┘         │
 │   └──────────┘ ← front                    └──────────┘ ← front                   │
 │  1. Loosen both clamps. Lift the plate off. Brush the board and the bracket.     │
 │  2. Turn it over SIDEWAYS: the left edge goes to the right; the faced side goes  │
 │     down onto the board. The corner that was in the bracket is STILL the corner  │
 │     in the bracket (it is now the plate's front-right corner, mirrored).         │
 │  3. Push it into the bracket's corner on both faces. Refit the clamps on the     │
 │     back edge, on the uncut margin (the preview shows where).                    │
 │  4. Tighten. Check it does not rock.                                             │
 │  Confirm: which edge of the plate is against the bracket's long arm now?         │
 │           ( the edge with the four holes nearest it ▾ )        [ It is mounted ] │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

The confirmation asks for a landmark the app can check against the planned orientation, and
refuses to continue if the answer describes the other flip — the mistake every forum records.

#### Registration between setups

| What | Established in setup 2 by | Accuracy | Source |
|---|---|---|---|
| XY and rotation, bracket | the same corner in the bracket; the machine's anchor numbers | ≤ 0.1 mm (bracket fit; unmeasured on our unit) | `ControllerConfig.txt` anchors; Makera's own default |
| X and rotation, vise | the fixed jaw, same edge kept | ±0.05 mm, ±0.027° | run sheet §5 |
| XY, tape / vacuum | 3D probe edge finds on conductive stock; the Z-only stepped scan otherwise | probe: unmeasured; scan: ±0.3 mm | §5.9 |
| Z0 | one touch on the new up face at the job's Z0 point | 0.001 mm repeat; flatness adds its dome | §11.7 |
| Better | **a feature cut in setup 1**: a through hole or slot read by the 3D probe (bore centre) or by the stepped scan (a wall as a depth change) | 3D probe: unmeasured; scan ±0.3 | §5.9 |

The preview draws a **registration band** on every feature spanning two setups (a translucent step
of the combined uncertainty), so the seam is visible before cutting.

#### Work-holding consequences, checked per setup

Grip on setup N's result: clamps must land on uncut margin (`clamp-on-cut`, error, with a suggested
position); the face that goes down must be flat where it rests (a pocketed face on tape or the
vise's ledge band → `rests-on-cut`, error unless a board or strips carry it); a clamped face must not
be removed (`cuts-clamped-face`); a part thinned below the mount's minimum grip warns; after a
cut-out only the tabs hold the part (setup 2 on a cut-out piece needs the board and tape or a jig);
chips on the seat are a remount-step instruction. Stock proud in the vise is recomputed from what
remains at the ledge.

#### The rotary as the alternative

Round or squared stock in the chuck turns side/end setups into indexed faces (`Rotary.md` class I):
A rotates, the chuck is the reference, one registration. Offered whenever a job needs ≥ 2 non-flip
directions on stock that fits ⌀80 × 150 ("3 remounts (~15 min handling, ±0.3 mm between faces) or
1 mount in the rotary (run-out to be probed; needs #238, #223)"). A top/bottom flip is not a rotary
job unless the part is chucked by its ends.

**Saved:** `setups[] { orientation, mount, itemIds, tools, registration { method, plan, expected }, remount { instruction, confirm } }`.

### 5.5 Tools

**Purpose.** Pick cutters per setup from the **location's inventory and this machine's collets**, so
the most reachable detail is cut with the fewest changes, and say what is lost.

1. Candidates = owned cutters, not marked broken, whose shank fits an owned collet on this machine,
   suited to the material: the metal line refused for plastics by name (#407), non-metal cutters
   refused for metals (`metalDuty`), non-flat shapes only where an engine simulates them (#405,
   #382), a feeds row present (house or catalogue, Route A) or a stated placeholder with our own
   provenance.
2. Reach per item per candidate (opened region for flats; groove profile for V).
3. **Tool 1** = the largest flat reaching the most volume at full depth (for facing and pockets);
   **Tool 2** = the smallest owned cutter reaching the most of the **rest** (design − tool 1's
   simulated removal), with a stated overlap; a third only above a stated threshold (default 2 %, a
   chosen number). Drills and thread mills are their own tools for their own items.
4. What no tool reaches is lost, counted per item and drawn (§5.7).

The Tool section is a per-setup list with the recommendation **applied**, "change" opening the
candidate list with reach and time per cutter; the user's choice is kept and the recommendation
offered back (#211). Catalogue cutters nobody owns appear under "could buy" with their reach and the
shop link the catalogue carries (`t_SkuMapping`), never picked. Two tools reach the machine as one
program per tool (#410, proven) until #278's `M6` observation.

**Saved:** per setup `tools[] { invKey, snapshot, role: face|rough|rest|drill|thread|single, overlap, feeds with sources }`.

### 5.6 The mode switch

A two-state control top centre on every CNC screen — `[ Design ] [ Cut ]` — Cut greyed with the
first blocking reason as its tooltip. Pressing Cut runs the gate for every (setup, tool) in order,
each later sweep on the earlier result; red rows open the **preflight page** with the failing row
expanded and "Back to Design" jumping to the cause; all green **freezes the cut package** (programs,
frame files, plan, hashes) and reserves the stock on the shelf. Any Design edit marks the package
stale.

```
 ┌─ Cut: plate-pockets-v3 ──────────────────────────────────── package 9c1e42aa ─┐
 │ 2 setups · 2 tools · 1 remount · about 36 min (8 min of it is you)             │
 │ ✓ generated 2/2   ✓ verified 3/3 programs   ✓ simulated   ✓ predicted           │
 │ ⚠ carried: corn-bit feeds are a placeholder row; bracket fit unmeasured (±0.1)  │
 │ ☐ I have checked clearance to the clamps and the tool's reach myself.           │
 │ Machine  Z1 …010290 · 192.168.10.43 · Idle · homed · T:1 · vacuum: unknown       │
 │ Stock    plate 100×100×5 6061 (shelf, reserved) · board MDF 2 mm (shelf ×4)      │
 │ To hand  wired probe · 3D probe · T1 3.175 flat (metal) · T2 0.6 corn · 2 clamps │
 │   [ Print the sheet ]     [ Preview as cut ]     [ Start the run plan ▶ ]        │
 └────────────────────────────────────────────────────────────────────────────────┘
```

Why a mode: cutting has different furniture (machine state, phase list, live strip), the frozen
package is only honest when the editor is closed, and Studio's run button beside editable fields is
the failure mode (#231's dogfood found the same).

### 5.7 The as-cut preview

The stock after every setup and tool, cumulative, from the gate's sweeps (a per-setup scrubber and
the final state); floors by depth or by layer colour; the **lost layer** (design − as-cut, hatched
amber, counted per item, click → the smallest owned cutter that would reach it); the **registration
band** across setups; **not-cut regions** hatched grey with the issue (sloped faces → #222); the
fixture, clamps and sacrificial stack; the sentence naming what the sweep did not see (#243); a
design ↔ as-cut slider. Beside it, the numbers: removed volume per tool, lost area per item, deepest
floor per item vs its bound, the oracle's band and verdict, the engine per sweep. Not modelled, said
on screen: deflection, runout, Z-chain error, the cone mesh (cylinder drawn, provisional), placement
until the registration phase has run.

### 5.8 The run plan

#### The phase model

Every job is the same sequence, unrolled per setup and per tool; each phase shows its time **and its
source**:

| Phase | Who | Time | Source |
|---|---|---|---|
| Power-up, auto-home | machine | ~30 s + network join (plug cycle on failure, #304) | observed |
| **Home** `$H` | machine | 20–30 s | measured 2026-10-12..15 |
| Fit the probe (manual) | you | ~45 s | default (recorded the first time) |
| `M491` on the probe | machine | ~32 s | measured 2026-10-15 |
| Laser frame — the probe's dot traces the job's outline over the stock (**option, off by default**) | machine | ~30 s | estimate; Makera's Scan Margin ran its rectangle in ~4 s at F1000 (A.4) |
| **Registration** (§5.9): bracket datum + Z touch / 3D probe corner / laser point (option) / stepped scan | machine | 15 s / ~1 min / ~20 s / ~1.5–3 min | measured per touch; laser: estimate |
| Auto-level `G32` grid | machine | ~10 s per point | estimate; Studio defaults 3 × 3 |
| Home before a bit change (rule) | machine | 20–30 s | measured |
| Fit cutter Tn; `M491`; set Z0 (#387's order) | you + machine | ~60 s + 32 s | default + measured |
| **Air run** (frame file or raised program) | machine | ≈ the cut | measured (41 s air vs 52 s cut) |
| Vacuum on `M331`; **cut Tn** | machine | the CAM estimate (trapezoid, #242/#281; D3 to calibrate) | planning estimate |
| Vacuum off, clearance | machine | ~10 s | observed |
| **Remount** (next setup) | you | ~3 min | default |
| Re-register | you + machine | 2–5 min by method | sum of the rows |
| **Done**: `M332`, spindle off, `G28`, `M370` if a grid was set; **record the offcut** | machine, you | ~15 s + a question | observed |

Defaults become measurements through the record's wall clocks (§5.10); no scale-factor knob
(`Makera-Parity.md` §14.2 A1). Appendix B has a worked plan for the aluminium plate; Appendix C for
the badge.

#### Where the machine's features live

| Feature | Kind | Where | Default | Code / status |
|---|---|---|---|---|
| Vacuum during a cut | property of the program | in every cut `.nc` (`M331` … `M332`), a phase; per-job toggle in the strip | **on** (maintainer) | measured 2026-10-12 |
| Vacuum now (cleaning) | machine state | the machine card's switch (#390) and the Cut screen's strip; hands-off while a program runs | off | `M331`/`M332` |
| Air run | a phase | on for a program the machine has never run (no record with this hash), off after a clean run | on for new | frame file (#244) |
| Auto-level `G32` | a phase | on when the stock's flatness is domed/unknown and the shallowest cut is under 0.5 mm (Studio's own rule), or on tape/vacuum; off for faced stock | by stock and mount | `G32 R1` + `M370`, unverified sequence (#176) |
| Facing | an operation, not a feature | §5.3; its depth moves Z0 and the carried stock | on for raw metal/wood | NEW |
| Registration | a phase with a yes/skip at the moment it is reached | §5.9 | ask | #391, #387 |
| Light | machine state | the strip | on while a job runs | `M821`/`M822`: listed for all machines in Studio's own config (Appendix A.7); unobserved from our console |
| Spindle air `M7` | nothing | not shown: Carvera-only per Studio's config; a no-op here (§11.10) | — | — |
| Bed clean / blow / ioniser | Studio's `M331.x` sub-modes | the strip reserves the slot; offered when #283/#289's bench rows map them | — | inferred |

The machine strip (desktop): `Z1 …010290 · 192.168.10.43 · Idle · homed · T:1 · P: — · vacuum
[off] · light [on] · plug [on] · console ▸` — states are what the machine last answered, dated;
vacuum reads **unknown** after a reconnect; the plug is shown, switched only on request.

#### The operator checklist

The run sheet's sections become the plan's phases in order, with the remount pages between setups;
the mount instructions are per mount kind (bracket: "push the stock into the bracket's corner on
both faces, clamps on the back edge at the marked places"; tape: "clean both faces, two strips,
press for ten seconds, note the tape thickness"; vise: today's §3); the record asks for wall clocks
per phase, measurements per item, and **what is left** (the offcut).

### 5.9 Registration

**Purpose.** Find where the stock is, by the method the stock and the mount call for; one design,
not one per blank.

**The instruments the location has**

| Instrument | Finds | Works on | Status |
|---|---|---|---|
| **Wired probe** (in the box; a mechanical tip, 2.0 mm hollow cylinder, no ball) | Z; and XY edges by stepped touches (a Z-only scan) | any material (triggers on PLA, 0.001 mm repeat) | the bench's touch-off probe; tip measured 2026-10-15 |
| **3D Probe Rod** (in the box) | X, Y, Z by side touches | **conductive stock only** (electrically connected to the table) | never used on the bench |
| **Makera 3D Probe** (separate accessory, owned) | X, Y, Z; corner / bore / edge | both conductive and non-conductive per Makera's accessory page (`Fabrication.md` §1); the researcher's read of the store page says conductive — **settle at the bench** | never used on the bench |
| **The probe's laser** — a red pointing dot (~2 mm, seen by the maintainer) in the wired probe's hollow tip; `M831`/`M832` on the CA1/Z1/Z1Pro per Studio's own config (A.7) | nothing by itself: it is a pointer, not a distance sensor, and the controller gets no signal when the dot crosses an edge; it lets the **operator** see where the tool will go | any material | **unobserved from our console** — a bench row: send `M831`, look for the dot |
| **The anchor bracket** | XY and rotation without a probe (`coordinate.anchor1_x/y`, `anchor_width/length`) | any stock with two square faces | Makera's default; our unit's anchor numbers read 2026-10-07 |
| **The vise's fixed jaw** | X and rotation | any stock with a flat face | measured product constants |
| **Auto-level `G32`** | a height map over the cut area | any; needs the wired probe | unverified sequence on this machine (#176) |
| Calipers | the stock's dims, its proud height, a cut depth | — | the operator's |

**The probe's laser: what it can and cannot do.** The maintainer asked why the laser is not used
to find edges. Because it cannot: nothing says the dot is a distance sensor, and the machine has no
input that changes when the dot leaves the stock — an edge found "by laser" is an edge found by a
person looking at the dot. That still buys three things, ranked, every one of them a **user option,
off by default** (principle 9):

1. **Frame the job** — the dot traces the job's outline (or bounding box) at a safe height before
   any touch, so the operator sees the cut lands on the stock and clear of the clamps. No contact,
   ~30 s; it is Makera's own `Scan Margin` (A.4) and the laser cutters' "frame" (LightBurn, xTool).
   Toggle on the plan's registration phase; it replaces nothing and refuses nothing.
2. **Point to set the origin** — jog the dot onto a corner or an edge, confirm, and that becomes XY.
   Works on any material, including the non-conductive stock the 3D probe cannot touch; accuracy is
   the dot (~2 mm spot, parallax at height), so it is **rough placement**, followed by touches where
   the job's margin needs better. Toggle on the registration phase; the sheet prints the
   uncertainty it carries (±1 mm, a chosen band until measured).
3. **Camera-assisted** — the head camera already yields frames (`z1.mjs camera`, #189/#286). Seeing
   the stock's edges, and the dot against them, could find XY without contact. Research-grade: it
   needs the camera's calibration to machine coordinates (#189's grid stitch), a lighting and
   exposure that shows the dot on dark and on shiny stock, a test that the camera can see the dot at
   all (the coordinator is testing this next), and a stated accuracy before it becomes a method.
   Not in the plan until those are measured.

**The method, chosen by stock and mount** (the app picks; the sheet says why; the laser steps are
toggles beside it):

1. *(option)* frame with the laser;
2. XY: the anchor bracket (machine-known) · the vise's fixed jaw (X, rotation) · the 3D probe
   (conductive stock) · *(option)* the laser point (any stock, ±1 mm) · the Z-only stepped touch
   (any stock, the precise fallback);
3. Z touch;
4. auto-level when the stock's flatness and the cut depth call for it.


| Mount | Conductive stock | Non-conductive stock |
|---|---|---|
| Anchor bracket + clamps | XY from the bracket; **Z touch** (wired probe); *(option)* 3D-probe corner confirm | XY from the bracket; Z touch; *(option)* a stepped-scan confirm on one edge |
| Tape / vacuum bed | **3D probe corner** (XY + rotation) + Z touch; auto-level if thin or domed | *(option)* laser point for rough XY, then the **stepped scan** on two edges (position + rotation) + Z touch; auto-level for tilt (#191) |
| Vise | X/rotation from the fixed jaw; Y by one 3D-probe touch on an end; Z touch | X/rotation from the jaw; **Y by the stepped scan** on the front end (or *(option)* the laser point when ±1 mm is enough); Z touch (Appendix C) |
| Rotary | the chuck axis; radius by probe; run-out by two touches 180° apart | the same with the wired probe on a flat; `Rotary.md` §6 |

*(option)* = a toggle the user turns on, off by default (principle 9). The laser frame is available
on every row.

**Z touch-off, anywhere.** One `G38.2` fast + slow at the job's Z0 point (default: the centre of the
cut area, or the faced surface after facing), with the travel cap, the lift after, and the result
written as the cutter's Z0 in #387's order (probe reading + (cutter `M491` − probe `M491`)); ~15 s.

**The anchor-bracket datum.** The work origin = anchor1 + the stock's offset in the bracket (0,0 for
a corner pushed home) — Studio's own default ("Work Origin relative to Anchor 1"); the app writes it
with `G10 L2` from the machine record's numbers and marks the rotation as fixed by the bracket's
face; one Z touch follows. A confirming touch (one edge) is offered, not forced.

**XY by the 3D probe** (conductive stock; non-conductive if the accessory proves to): two touches on
one straight edge (position and rotation) and one on the perpendicular edge, planned from the
compiled outline (decision 26's planner, `probePlan.ts`), avoiding clamp footprints and radiused
corners; each touch a `G38.2` along X or Y with a cap; ~1 min. Bore/boss centre on a feature cut in
the previous setup, when one exists. All of it **unverified on this bench** — a rows in §7.

**The Z-only stepped scan** (any stock, the wired probe): for each edge to find, a coarse pair
(inside / outside the expected edge) then a both-ways bisection to the job's edge margin, every touch
one capped `G38.2 Z−` with `$X` on a predicted miss and a lift to clearance before any XY move,
stopping at the first reading that is not one of the expected surfaces (stock top, fixture top, a
capped miss). Bias: the tip's rim reads one radius (1.0 mm) past the edge, as an assumption on the
sheet until the rim is characterised (#391 re-review). Cost: ~13 s per touch at the bench's pace;
one edge ≈ 5–6 touches ≈ 1.2 min; two edges + rotation ≈ 3 min; the old four-edge 0.5 mm raster was
8–12 min. The generic version of #391's `materialScan.ts`, and what Appendix C runs in the vise.

**Auto-level.** `G32 R1` over the cut area + the cutter radius, `M370` at the end; on when flatness
is domed/unknown and cuts are shallow, or on tape; the grid points are drawn on the preview.

**After the method runs:** the found position vs the job's origin — within the edge margin:
"confirmed, Y off by 0.2 (within margin)"; outside: offer "set the origin from the measurement"
(`G10 L2`, cutter Z0 recomputed) or "stop and re-seat". Numbers the mount already fixes (bracket XY,
vise X) are never rewritten from a touch; they are confirmed.

### 5.10 Running

**Start.** #386's path: pre-poll `?`, refuse unless `Idle` with no alarm; upload the verified
program; `play`; `?` every 2 s on one connection; finished at `P` = 100 and `Idle` (a mid-job `Idle`
is not the end); `P` vanishing after being seen also ends it; three silent polls end the watching
with "the physical stop is the stop".

```
 ┌─ Running: setup 1 · T1 3.175 flat · pockets ──────────────────────────────────┐
 │  ▶ phase 11 of 19   cut T1    Run · line 612 / 1 480 · 41 % · 5:50 elapsed      │
 │    ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░   est. 8:20 left (planning estimate · last run 13:40)  │
 │  viewport: the stock at the current step · camera frame                        │
 │  machine: Run · T:1 · vacuum on (M331 5:50 ago) · light on · plug on            │
 │  [ ■ Stop (abort) ]   pause: not available from here (#303)                     │
 │  the physical stop is the stop: the front button / the plug                    │
 └────────────────────────────────────────────────────────────────────────────────┘
```

Phases tick as they complete; operator phases show one button and the confirmation where one
exists; the viewport follows the machine's line through the transport (#198); elapsed vs estimate
per phase; "last run" beside the estimate once a record exists.

**Stop.** One button: `abort` (Studio's grey Stop; the spindle stops at once, queued moves drain,
`M332` only after `Aborted playing` or three Idle polls — #386 A). Never `!`/`~`. The red STOP and
the front button remain the real stops.

| Interruption | What the app does | Path |
|---|---|---|
| Stop mid-cut | phase ends `stopped at line N`; **Restart from step** (the gated restart `.nc`, #249/#392) or "redo this tool's program" | surface #249 here |
| Network silence | "silence is not stopped"; last state and time; keeps polling; never sends `M332` blind | #304, #386 |
| Power cycle | the machine re-homes; the work offset is lost → rewind to the registration phases, then resume at the stopped line | #387 order; Studio's `goto`/resume unverified here |
| Alarm | attributed by the carried-frame rule; run ends; `$X` only with the person at the machine; a probe alarm on a predicted miss is not an alarm | #386 item 3 |
| Tool broke / stock moved | stop; mark the cutter's condition (§3.1); re-register; redo the program | — |
| Stopped between setups | the job remembers completed setups; reopening offers "resume at setup 2 (remount)" | §6 |

**After the run.** The record (`<job>-run.json`, #277) takes the wall clocks per phase and the
measurements the sheet asks for; the stock is **consumed** and the **offcut** proposed to the shelf
("plate 100×100×5 with a 60×40 cut-out — keep as offcut?"); tool runtime added (#381); "last run"
shows beside the estimate next time.

---

## 6. Save and reload

**The job is a file**, `<name>.cutjob.json`: `EngraveJob` v2 grown to v3 with `location`,
`machine.serial`, `stock` (shape, finish, layers, flatness, conductive, source + snapshot),
`mount.orientation`, `items[].operation` and `.source`, `setups[]`, per-setup `tools[]`, `plan`, and
a `package` block after Cut (hashes of every program and frame file, oracle verdicts, engine per
sweep, run records by hash, the stock reservation). Zod mirrors every field
(`reference_board_zod_schema_strips`); v2 → v3 maps `toolKey` → `setups[0].tools[0]`, the vise
sentence → an orientation, the badge/blank templates → shelf entries; a saved v2 job generates the
same `.nc` (the byte-identical rule).

**Sources travel with the job**: SVG/DXF/image/3MF embedded up to 4 MB, else path + hash with "the
file this job was made from is missing or changed" as a refusal at generate; derived geometry stored
so the job renders without the file.

**Save / Open / Save as** in the toolbar via the project's File System Access path; **autosave** to
localStorage on every edit and to the file when one is bound (dirty marker, Ctrl-S). A job saved
after step 1 is a stock and a machine and opens at step 2.

**Versioning.** `schemaVersion` + migrations; `package.hash` moves when anything a program depends
on moves; records attach by hash. The case project keeps excluding the job. **The location** keeps
what outlives a job (§3.5): tools, accessories, shelf, consumables, machine records.

---

## 7. Gaps

Mapped to issues where they exist; **NEW** otherwise; not filed. S: a day; M: days; L: weeks.

| Area | Gap | Issue | Size |
|---|---|---|---|
| Location | the entity: name, machines (serial, firmware, address, plug state, calibration together), accessories with owned/measured provenance, consumables, collets, measuring tools; `location.json` beside `house.json`; export | **NEW** (builds on #247, #306, #311) | L |
| Location | the stock shelf: entries with layers/finish/flatness/conductive, quantities, offcuts from jobs, reserve/consume; Manage › Materials | **NEW** | M |
| Location | vendor sizes at runtime: the sync reads `t_MaterialSpecs` into `catalogue.json` | **NEW** under #308/#347 Route A | S |
| Location | tool condition, runtime, collet compatibility per machine, where each copy is | #381 + **NEW** | M |
| Location | the plug's state on the machine record (switch only on request) | **NEW** (`power.sh` exists) | S |
| Stock | STL/3MF as stock; rod/tube/disc; sphere refused | **NEW**; 3D needs #222 | M |
| Mount | orientation as a question; derived frame | **#383** | M |
| Mount | anchor bracket + clamps as a modelled mount with clamp footprints; `clamp-in-path` | **NEW** (`top-clamps` variant exists in `setup.ts`) | M |
| Mount | tape with tilt (#191's sheet), vacuum bed (not owned: listed only) | #191 | S |
| Mount | rotary offered, refused until characterised; chuck clearance warning | #238, #223, #240 | — |
| Mount | jaw opening measured; thin-stock proud rule | **NEW** (calipers); #406 | S |
| CAM | **facing / surfacing** op with stock-state carry and Z0 move | **NEW** | M |
| CAM | profile cut-outs with tabs, through pockets, loose-piece check | **#218** | L |
| CAM | finish pass and stock-to-leave | **#250** | M |
| CAM | drill-bit holes and thread milling CAM; simulate every owned cutter | #382 + **NEW** | L |
| CAM | chamfer; V-carve medial axis; V groove oracle | #221, **#408** | M–L |
| CAM | adaptive/HSM clearing for metals; ramped entry reopened | **NEW** (after #250) | L |
| CAM | 3D relief / sloped surfaces (roadmap phase) | #222 | L |
| CAM | 3MF negative volumes in the panel; 3D primitives; target object | **#410**; **NEW**; **NEW** (+#218) | M / M / L |
| Design | one-line item list, Remove at the front beside show/hide, undo | **#411** | M |
| Setups | planning from normals, override, remount pages with pictures and confirmation, grip/seat/clamped-face checks, stock carried between setups | **NEW** (maintainer's addition) | L |
| Setups | setup-1 features as references | **NEW**, on #391's physics | M |
| Tools | auto-pick with rest, two programs per setup | **#410** (+#278) | L |
| Tools | tool-change allowance in the estimate; per-tool sheet break | #278 | S |
| Tools | metal-line and non-metal duty refusals | #407, #398 | S |
| Mode | Design/Cut header, preflight, frozen package, stale across setups, stock reservation | **NEW** | M |
| Preview | lost layer, slider, registration band, cone mesh | **NEW** | M |
| Plan | phase model with sources; the machine strip; defaults for vacuum, air run, auto-level, light | **NEW** | M |
| Plan | rapid model calibrated (D3) | #281 | bench |
| Plan | wall clocks per phase; "last run" | #277 ext. | S |
| Plan | light `M821`/`M822` observed | **NEW** (bench) | S |
| Plan | bed-clean / blow / ioniser mapping | #283, #289 | bench |
| Registration | the generic planner: method by stock and mount; bracket datum written by the app; 3D-probe corner/edge/bore cycles; the stepped scan executed by the app; origin write in #387's order | **#391**, **#387**, #188 | L |
| Registration | the probe's laser: `M831` observed from our console, the dot's size at height; the laser frame and point-to-origin as off-by-default toggles | **NEW** (bench + S) | S |
| Registration | the rim's contact model | #391 (open) | bench |
| Registration | auto-level as a phase | #176 | bench |
| Run | play/poll/finish in the app; phase progress; viewport follows `P` | **NEW** on #386 | M |
| Run | stop (`abort`); silence; power-cycle rewind; restart in the run screen; resume at setup | #303, #304, #249, **NEW** | S–M |
| Run | consume stock, propose the offcut, add tool runtime | **NEW** | S |
| Run | vacuum switch outside a job | #390 | S |
| Save | `.cutjob.json` v3, Save/Open, autosave to file, embedded sources, package hashes | **NEW** | M |
| Docs | run sheet preamble stale; guide chapter 5 becomes the eight questions | **NEW**; #210's successor | S / M |

Not reopened: a first-run machine wizard (R1), a G-code editor (R8), a job queue (R9), overrides
(R10), nesting (R15), a vendor feeds row in the repo (#347 Route B).

---

## 8. Decisions (the maintainer, 2026-10-15)

The 21 open questions of draft 2, answered one at a time. Where the answer differs from the draft's
recommendation, the maintainer's words are quoted.

**The location**
1. **Build the location entity now**, with one location and one machine in it.
2. **The shelf lives inside the location**: one `location.json` holds machines, accessories, tools
   and materials, with one export. `house.json`'s tools move into it.
3. **Offcuts are proposed at the end of a run "only if there is leftover stock that has some size to
   it."** A minimum usable size decides; it ships as a chosen default (labelled chosen, not measured).
4. **Tool condition is new / used / worn / broken, set by the operator.** Runtime (#381) only warns
   ("check this bit") past a threshold; it never retires a cutter.
5. **The plug: "full control, but don't assume that there is a controllable switch, most people will
   not."** A controllable power switch is an optional integration on the machine record (Home
   Assistant is one provider, not the model). With one, the app may switch on at job start and off
   at the end, never off while running, off only after Idle and home. Without one, nothing in the
   flow depends on it.

**Stock and operations**
6. **Facing: the stock's finish decides.** Rough or unknown → on; finished sheet or printed blank → off;
   always overridable.
7. **The Z1's MDF wasteboard counts as the sacrificial board**, tracked in the location (thickness,
   scarred areas, last resurfaced), with a warning before a cut reaches it.
8. **Roadmap order as drafted**: finish passes → cut-outs with tabs → drill/thread/chamfer → adaptive
   → 3D → rotary.
9. **Ramped / helical entry reopens for metal pockets**, delivered with adaptive clearing. Engraving
   keeps straight plunges.

**Mounting and registration**
10. **Plate default: anchor bracket + clamps, the bracket's XY as the datum**; a confirming touch is
    offered, optional.
11. **The 3D probe is the default registration method now.** No separate repeatability bench row.
12. **The app may write a corrected origin after confirmation**: show the measured offset, then on OK
    write `G10 L2` and recompute the cutter's Z0 (#387's order).
13. **Auto-level is off until #176 proves `G32 R1` / `M370` here**, then on by default by the stock's
    flatness and the mount (domed/unknown, thin cuts, tape).
14. **Air run defaults on only for a program this machine has not run** (package hash); identical
    repeats default off.

**Tools and running**
15. **One program per tool now** with a directed bit change; one file with `M6` once #278 observes it.
16. **A Stop button now**, sending `abort`, labelled honestly (stops the program; the machine's button
    is the emergency stop). #303 refines it.
17. **"I am at the machine": once per job.** Directed physical steps (bit change, remount, probe in/out)
    still each need their own "done" before the job continues — the one confirmation does not cover
    them.
18. **The light (`M821`/`M822`) is in the machine strip from the start**, after a one-line bench check.
19. **The 2 % third-tool threshold and the rest overlap ship as defaults labelled chosen**, updated
    from the first two-tool cut. *Revised the same day:* the measured `single.3mf` pair left 3.4 % standing
    at 0.1 mm, so the overlap is **"~0.5 mm, worked out per job"** from the cutters (#436).
20. **Vacuum bed and sphere stock stay out.** A vacuum bed is listed only if the location owns one;
    sphere stock is refused with a reason.
21. **The probe laser: the laser frame and laser point-to-origin ship as user options, off by default.
    No camera work** — camera-assisted edge finding is not pursued (the 2026-10-15 frames stay as a
    record only).

Badge-specific questions are in Appendix C (the badge is about 1 % of CNC jobs; not prioritised).

---

## 9. Sources

**Local.** `/Fabrication.md` §1, §2, §4, §5.7, §7.3, §9; `/Makera-Parity.md` §5, §7, §8, §9, §12,
§14; `/Z1-Firmware-Dialect.md` §2, §11.3, §11.7–11.11; `/Z1-Bridge-Protocol.md` §6, §8;
`/Rotary.md` §1.4, §2, §6; `docs/bench/2026-10-bench-plan.md`; `docs/bench/2026-10-bench-day-1.md`;
`docs/bench/2026-10-07-config-sweep.json`; `docs/bench/single-barrel-run-sheet.md`;
`docs/bench/traces/2026-10-15-console.log`, `2026-10-15-185-air.log` / `-cut.log`,
`2026-10-12-cut-rowA.log`; `casemaker-app/src/docs/cnc-guide.md` §2, §3, §5–7;
`casemaker-app/src/components/panels/{EngravePanel,EngraveSetupFlow,EngraveMachineUpload,RunSheetView,SimPanel}.tsx`;
`casemaker-app/src/engine/cnc/engrave/{setupFlow,runSheet,materialScan,recommendTool}.ts`;
`casemaker-app/src/engine/cnc/{fixture,feeds,probePlan,setup,machine}.ts`;
`casemaker-app/src/store/{engraveJobStore,engraveRunStore,engraveRunGate,engraveJobSchema,houseStore,machineStore,settingsStore}.ts`;
`casemaker-app/tools/z1/{z1.mjs,power.sh}`; `casemaker-app/scripts/engrave-job.ts`;
`samples/badge-blank/single.3mf`; `tool-labels/kazoo-house.json` (local). Issues: #166, #176, #185,
#188, #191, #208, #213, #218, #220, #221, #222, #223, #238, #240, #241, #242, #243, #244, #247,
#249, #250, #254, #272, #277, #278, #280, #281, #283, #289, #303, #304, #306, #311, #347, #366, #381,
#382, #383, #386, #387, #390, #391, #398, #405, #406, #407, #408, #409, #410, #411.

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
`ev_cf580cbe…`, `ev_318dc173…`); `docs/bench/img/D0-wizard-*.png`, `docs/bench/img/D1-*.png`;
REA: `rea doctor --client claude_code --json`, `rea capabilities`.

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
anywhere in this document (#347). `docs/bench/img/D0-*.png` and `D1-*.png` are the maintainer's
screenshots of the same screens, 2026-10-07.

**The REA toolkit** (rea-agents 6.5.0): `rea doctor --client claude_code --json` reports Node 24.21
healthy and **no native analysis engine** (Hopper, Ghidra, IDA and JADX all `missing_analysis_engine`);
nothing was installed. No decompilation was done, and none was needed for a workflow read. REA
supplied the database inspector: `rea inspect-sqlite-database` on the copied `makera_library.db`
(sha256 `70ed4e86…3e3173`, SQLite 3.53.4) with evidence ids `ev_662e5862…` (full schema),
`ev_e2174548…` (`t_MaterialCategory`), `ev_cf580cbe…` (`t_MaterialList`), `ev_318dc173…`
(`t_SystemParameters`). Everything else is `strings` on the binary (275 895 ASCII and 13 914 UTF-16
strings), the JSON files, the logs and the screenshots. There are **no `.qm` translation files**: the
only language file is `data/lang/lang_us_EN.json` (239 strings, the diagnostic panel alone); the
workflow strings live in the binary.

### A.1 The project model

`Roaming/config/ProjectDefault/default_3d_cnc.json`:

```
emMachineType, emSchemeType, version,
vecClamDiameter: [ … ],                       ← the chuck/collet diameters the project may use
workblank: { material: { materialInfoId, materialObjId, materialSpecId }, size: { length, width, height } }
```

A Studio project is **machine type + scheme (process mode) + a workblank**, and the workblank is a
material **and a material spec** — the vendor's sized stock — plus dimensions. Strings confirm the
names (`emMachineType`, `emSchemeType`, `workblank`, `widgetWorkblank`, `vecClamDiameter`,
`lstClamDiameter`) and the refusals built on them: *"Project information is incomplete. Please set
chuck diameter and workpiece material first."*, *"No tools found for the current chuck diameter and
workpiece material. Please check project settings or add tools in the tool library."* Projects are
`*.mks`. `PrjPathConfig/` is empty and `config.ini` has `STR_RECENT_JSON=`: no Studio project has
been saved on this PC.

### A.2 Process modes and the guided scheme

Strings `SchemeInfo2DCNC`, `SchemeInfo3DCNC`, `SchemeInfo3DRelief`, `SchemeInfo4DRelief`,
`SchemeInfo2DLaser`; mode cards **2D Vector Machining**, **3D Model Machining** ("Supports STEP, STP
files"), **3-Axis Relief Carving** ("STL, STEP, STP, OBJ"), **Custom 3-Axis Machining**, **Custom
4-Axis Machining**, **Laser Engraving & Cutting**; `Select Processing Mode`, `Guided Mode`, `Custom
Mode`. Import filters: `*.step *.stp *.stl *.obj`, `*.dxf *.svg`, `*.jpg *.jpeg *.png *.bmp`, a Gerber
list. **No 3MF.** Guided Mode is a sequence of scheme steps (`SchemeStepWidget`,
`lblSchemeStepName/Image/Detail`, `pushButton_PrePage/NextPage`) with `Calculate Tools` /
`Recalculate`: a **Main Tool** by diameter (*"No recommended Main Tool diameter can machine all
selected models"*), **one roughing tool** (*"Rough machining can use at most one tool"*), a
**Clearance Tool** for 3D pockets, **finishing** (*"No suitable finishing tool found"*), and the guard
*"Continuing may machine stock that has not been roughed. Continue to the next step?"*; tools
filtered by material duty (`metalDuty`) and chuck diameter. Operation defaults are one JSON per
strategy in `data/configure/` (15 files) with `depth`, `safe`, `Ramping_clear`, `pocket_strategy`,
`direction`, `pathOrder` and a full `tools[]` record.

### A.3 The material and stock library (structure only)

`makera_library.db` (REA `ev_662e5862…`): `t_MaterialCategory` (`materialCategoryName`,
`materialPic`, `metalDuty`) → `t_MaterialList` (`materialSubcategoryName`) → **`t_MaterialSpecs`**
(`materialName`, `materialShape`, `length`, `width`, `height`, `diameter`, `g_ID`), with customer
twins; cutters `t_CutterCategory` → `t_MakeraCutterGroup` → `t_MakeraCutterList` (stick-out, shoulder,
flute, tip, half angle, thread fields, `sellProduct`, `metalDuty`, `g_ID`) with `t_CustomCutterList`;
feeds `t_MakeraCutterProperties` / `t_CustomerCutterProperties`; **`t_CutterInventoryList` (`cutterID`,
`qty`)**; `t_SkuMapping` (shop SKU/URL per `g_ID` per region); `t_MachineType`;
`t_MachineResourceFiles` / `t_MachineResourceParameters`; `t_MyDeviceList` (`strDeviceName`, `strIP`);
`t_SystemParameters`; `t_DeletionQueue`. UI: `MaterialLibDialog`, `Material Library`, `Material
Name`, `Material Specifications:`, `new material specifications`, `max thickness =`. For §5.1: the
vendor's sized stock is first-class in Makera's own model and already in the database the house
service syncs; a round shape exists in it.

### A.4 The Machining Wizard, step by step

| Step | What the screen shows | What it sends |
|---|---|---|
| **Set Stock** | the 200 × 200 bed with the L-bracket and its screws; a stock rectangle in the bracket's corner; `Anchor1` / `Custom`; *"Place the stock on the work bed and secure it firmly. We recommend using the anchor system and L-Bracket for quick and accurate positioning."* | nothing |
| **Set Origin** | `Relative to: Anchor1`, X/Y offsets, `Same As CAM`, `Set Origin with 3D Probe`, `Apply Settings` ("Work origin will be set immediately when clicking OK"); **Auto-Scan Machining Area (Before Machining)** + `Scan Now`; *"Set the work origin when starting a new job, changing the workpiece, or re-fixturing…"* | `Scan Now` (2026-10-07): `M492.3 → M494.2 → M493.2 T0 → M497.4 → M494.0 → G53 G0 Z-3 → G90 G0 X10 Y8 → G1 … F1000` round the toolpath → `Done ATC`; a **Tool Change Required** dialog ("Please change to: Probe / Then press Confirm to continue." Confirm / Ignore) first |
| **Auto Probe** | **Auto Workpiece Leveling** (Clearance Height 5, X/Y Points 3, *"Enable Auto Leveling for uneven surfaces or shallow cuts (<0.5 mm), especially for fine machining such as PCB and engraving bi-color sheet."*); **Auto Z-Height Probing** (`Relative to: Path Origin`, X 20, Y 7, `Recommended`; *"Run Z Height Probe when starting a new job or re-fixturing…"*); the red Z-probe dot on the map | nothing yet |
| **Assist Options** | Auto Vacuum, Auto Blow, Auto Bed Clean, Anti-Static, Auto Time-Lapse, each with one line | each sends its mode code at once (§11.3) |
| **Run** | the summary (origin from Anchor1, Scan Margin, Auto Leveling, Auto Z Probe `(20, 7) from Path Origin`, the assists); *"Confirm all settings before starting machining. You can stop the job at any time, adjust parameters, and restart if needed."*; red STOP on every step | `buffer M495 X<ox>Y<oy>[C<xmax>D<ymax>][O<px>F<py>][P1]` then `play`: `M495 X10Y8C50D22O20F7` (10-07) and `M495 X10Y8P1` (10-12, ×4); firmware: `Goto path origin first`, `G53 G0 Z-3.000`, `G90 G0 X10 Y8`, `Done ATC`, then the file |

Copy: the **map** and the one-sentence why under every option. Avoid: a modal per run that
remembers nothing.

### A.5 Tool changes and probing, as the firmware runs them for Studio

Manual change inside a program (10-12 log): `M497.2` → `M490.1` (wait: "Please change to: Tool
T1(3.175 flat) / Then press Confirm to continue.") → ~90 s → `M493.2 T-1` → `M497.3` → `G53 G0 Z-3`
→ `G53 G0 X-9.890 Y-12.830` → `G38.6 Z-108 F500` → `[PRB]` → `G91 G0 Z1` → `G38.6 Z-2 F100` →
`[PRB]` → `M493.1` → `G53 G0 Z-20` → `M493.2 T1` → `M494.2` → `Done ATC` — §2 of
`Z1-Firmware-Dialect.md` end to end, the sequence §5.8's tool-change phase reproduces with `M491`.
Studio's Z touch (10-07): `G38.2 Z-108 F500` → `[PRB]` → `G91 G0 Z1` → `G38.2 Z-2 F100` → `[PRB]` →
**`G10 L20 P0 Z0`** → `G91 G0 Z1` → `M494.2` — the `G10 L20` that #387 found resets the tool-length
reference. Pause/resume: `Suspending, waiting for queue to empty… / now save current pos… /
Suspended, resume to continue playing`, `Resuming playing… / Restoring saved XYZ positions and
state…`. Stop: `Aborted playing or paused file.`; red STOP: `Aborted by halt / ALARM: Abort during
cycle`. Other dialogs: `Set Origin with 3D Probe` (*"the detected corner position will overwrite the
current work origin"*), the carbide-rod variant, `Probing completed. The work origin has been
updated.` / `…not completed…`; rotary: *"closer to the rotary chuck than the recommended
clearance…"*, *"In 4-axis mode, the Y-axis offset will automatically reset to 0."*, *"For stock size
under 20 mm, Standard Jaw Setup…; 20-35 mm, Reverse Jaw Setup with Inner-Tooth Clamping; over 35 mm,
Reverse Jaw Setup with Outer-Tooth Clamping."* (`Stock holding length`, `Stock Shape`).

### A.6 The Monitor panel

A 3D toolpath view with a transport; **Processing progress** (file, Scan Margin / Auto Z Probe /
Auto-Level dots, `Progress: n%`, `Elapsed time`, `Remaining time`, pause / stop / STOP / Start); a
**Control** card (WPos and MPos per axis, feed/spindle/override readouts, `Probe TLO`, a jog pad,
Home, QuickMove, Unlock, Set Origin, Reset, 3D Probe, Auto Probe); **Operation Details** with
`G-Code` / `MDI` tabs and `Enter Command…`. `EstimatedProcessingTimeFromPathvertex:` names the
estimate's method. §5.10 keeps progress, elapsed vs remaining and the current line, adds the phase
list, leaves out jog and overrides (R10).

### A.7 Machine switches and settings, from Studio's own config

`install/config/interface_config.json`:

| Switch | On / off | Machines | Note |
|---|---|---|---|
| Spindle | `M3S10000` / `M5` | all | |
| SpindleFan | `M811S20` / `M812` | all | |
| Vacuum "Dust Collection" | `M801S20` / `M802` | **C1 only** | |
| PowerFan "Control Box Fan" | `M801S20` / `M802` | CA1, **Z1, Z1Pro** | same code, different name |
| Laser | `M3S0.05` / `M5` | all | |
| Extend output | `M851S5` / `M852` | all | the external-collector port |
| **Light** "Work Light" | **`M821` / `M822`** | **all** | so the Z1 has it; unobserved from our console |
| Air "Air Blast" | `M7` / `M9` | **C1 only** | consistent with `M7` doing nothing here |
| ToolSensorPWR "Tool Sensor Power" | `M831` / `M832` | **C1 only** | |
| **Probe Laser** "Probe Laser ON/OFF" | **`M831` / `M832`** | **CA1, Z1, Z1Pro** | the same code the Carvera uses for its tool sensor; on the Z1 it is the pointing dot in the wired probe's tip — a pointer, not a sensor (§5.9) |
| WP charge, Anti-Static | … | | |

plus a status monitor (limits, probe, tool sensor, E-stop, **cover switch**, temperatures, RSSI).
`install/config/config.json` ↔ `ControllerConfig.txt`: vacuum power, **`switch.light.startup_state`**,
`light.turn_off_min`, **`stop_on_cover_open`**, auto-sleep, **`main_button_long_press_enable` = None /
Sleep / Repeat** ("Repeat Last Job"), anchor and clearance coordinates, soft limits, feed and
acceleration ceilings, ATC/probe speeds, the Z-probe group (`zprobe.slow_feedrate`, `fast_feedrate`,
`return_feedrate`, `probe_height`, `max_z`), spindle cooldown, wireless-probe voltages. Our reads:
`docs/bench/2026-10-07-config-sweep.json`, #281.

### A.8 What the read changed in this document

Vendor sizes are Makera's own model (`materialSpecId`), not an invention (§5.1); Studio already
auto-picks a main tool and offers a clearance tool, so #410's rest pick is the 2.5D equivalent and the
lost accounting is where we go past it (§5.5); the light is a Z1 switch and `M7` is Carvera-only
(§5.8); draw the probe point, scan points and levelling grid on the map before anything moves
(§5.7/§5.9); Studio's pause saves and restores position while our stop is `abort` and `M600` is
unobserved here (§5.10, #303); the anchor-bracket datum is Makera's default registration (§5.9).

---

## Appendix B. Worked example: an aluminium plate on the anchor bracket

The in-box stock: **6061 aluminium, 100 × 100 × 5 mm**, sawn faces. The part: two pockets 12 × 8 ×
4 mm, four ⌀3.2 through holes on an 80 × 80 pattern, a chamfer on the back edge, and the finished
part cut out of the plate as a 60 × 40 outline with four tabs. Held on the **anchor bracket with two
top clamps** on the back edge, on an **MDF 2 mm board** from the shelf (the in-box MDF) because the
cut-out goes through. Conductive stock, so XY can be confirmed by the 3D probe.

**Step 1 — stock.** Material 6061 (catalogue feeds row present for the 3.175 flat; Route A). Shelf:
plate 100×100×5 ×2 → pick one; finish `raw` → facing on by default; flatness `unknown` (sawn);
conductive yes; no layers; no voids. Measured thickness typed from calipers: 5.02 (source
`measured`, date).

**Step 2 — mount.** Bracket + clamps (default for a plate). Orientation: sawn face up, front-left
corner into the bracket, a short edge nearest you. Clamps: two, on the back edge, 15 mm in; the
preview draws their footprints and `clamp-in-path` is clear. Sacrificial: board under, MDF 2 mm,
from the shelf (×4 → reserves one). XY datum: the bracket (anchor1 + 0,0); rotation: the bracket's
face.

**Step 3 — cut-away.** Items: Face 0.3 mm (whole top) · Pocket A, Pocket B 4.0 mm · Holes ×4 ⌀3.2
through (plunge at cutter diameter needs ⌀3.2 ≥ cutter: the 3.175 flat gives ⌀3.175 holes — the item
says so; a ⌀3.2 drill, if owned, is offered) · Chamfer 0.5 × 45° on the back edge (roadmap #221 —
shown hatched "needs chamfer CAM" today) · Cut-out 60 × 40, tabs 4 × 4 × 1 mm (#218 — hatched today).
What is cuttable at `aa1343b`: facing (NEW), pockets, holes; the rest is the roadmap in order.

**Step 4 — setups.** One: everything opens to the top; the chamfer on the back *edge* is reachable
from the top. (If the chamfer were on the underside, the planner would add a sideways flip with the
same corner in the bracket, as §5.4's sketch shows.)

**Step 5 — tools.** T1 = `flat-3.175x12-metal` (owned; a metal-line single flute; 1/8" shank in the
fitted collet) for facing, pockets, holes, cut-out; no rest pass needed (nothing narrower than
3.175 mm). Feeds: the catalogue's 6061 row for this cutter, clamped to the Z1, tagged `Makera —
not measured`; step-over ours (45 %).

**Step 6 — Cut.** Gate green for facing + pockets + holes; cut-out and chamfer red with their
issues; the preflight says so and offers "cut what is ready" (the package then holds the three
operations and the plan stops before the cut-out). Stock reserved.

**Run plan (what can run today; cut times are the CAM's planning estimates, not measured):**

```
  #  phase                                        who      time     source
  1  home                                         machine  0:25     measured
  2  fit the wired probe; M491                    you+mach 1:15     default + measured
  3  origin from the bracket (G10 L2, anchor1)    app      0:01     machine record
  4  Z touch at the plate's centre                machine  0:15     measured
  5  (option, off) 3D-probe corner confirm         you+mach 2:00     default (unverified method)
     (option, off) laser frame over the plate      machine  0:30     estimate (M831 unobserved)
  6  home; fit T1 3.175 flat; M491; set Z0        you+mach 2:00     measured + default
  7  air run (first time this program)            machine  ≈ cut    measured ratio
  8  vacuum on; face 0.3 mm                       machine  CAM est. planning estimate
  9  pockets A, B                                 machine  CAM est. planning estimate
 10  holes ×4, pecked                             machine  CAM est. planning estimate
 11  (cut-out — held: #218)                       —        —        —
 12  done: vacuum off, clearance; record offcut   machine  0:15     observed
```

**After the run.** Record: wall clocks, calipered pocket depth, hole diameter. Shelf: the plate is
consumed; offcut proposed "plate 100×100×4.7, faced, two pockets and four holes" — kept or not. Tool
runtime added to T1's copy.

---

## Appendix C. Worked example: the two-colour badge blank in the vise

Everything badge-specific from draft 1 lives here. The blank is a printed PLA plate, 76.2 × 38.1 ×
3.82 mm (calipered 2026-10-15; designed 3.81), **layered**: bottom colour 0–3.0, top colour
3.0–3.81 (0.81 mm), a magnet pocket underneath, domed ~0.33 mm across its width (probed 2026-10-08),
non-conductive. Held in the **low-profile vise**, long side along the jaws (38.1 across the jaws,
#383), seated on the 3.1 mm ledges, standing 0.72 mm proud. The design is the maintainer's
`samples/badge-blank/single.3mf`: two text volumes and an SVG logo, each ~1.0 mm deep, i.e. through
the top colour into the bottom one (#410).

**Stock.** A shelf entry "badge blank" (from the badge template, with its print spec, layers, void
and flatness) — the old "Use the badge blank" button becomes this entry. Loading `single.3mf` through
the Load door recognises stock + design in one step.

**Layered stock, in general.** Depth intents `surface` / `reveal` (#170) exist for any stock with
layers; the preview colours floors by the layer they land in; the boundary margin is re-read as one
printed layer when the stock states its print grid (#345); the depth recommendation quotes the
layer boundary. The bicolour sheet Makera sells gets the same treatment with its two layers typed.

**Mount.** Vise; top colour up; a long edge against the fixed jaw; the logo end nearest you (reading
direction is #410's parameter). Proud defaults to the seated value `min(4, t/2, t − 3.1)` = 0.72 (#391
review); the thin-stock rule is #406. `vise-opening-unmeasured` does not fire (38.1 is the measured
clamping).

**Cut-away.** The three negative volumes as items (names from the file); `reveal` intent, 1.0 mm;
reach per owned cutter: the 2 mm O-flute clears the title but little of the subtitle and the logo's
tips; the 0.6 corn reaches most of the rest; lost ≈ 2 % counted and drawn. Alternative: the V-trace
route (#405/#409) for single-stroke text, which needs #408's oracle to save from the panel.

**Setups.** One for this design. If text were wanted on the back as well: a second setup, **flipped
end for end** (the same long edge stays on the fixed jaw, so X and rotation stay the vise's ±0.05;
only Y and Z are re-found), seated on the ledges — the engraved face goes down, and the cuts are
clear of the 1.9 mm ledge band on both long edges, so it sits flat; the magnet pocket is in the
middle, clear of both ledges. A sideways flip would move the reference to the moving jaw, whose top
width still has a contradicting probe witness (2026-10-08 miss 6 mm out vs the calipered 10 mm) —
offered only when the geometry needs it.

**Tools.** T1 `C1-BIT-O-FLUTE-2-12` (rough), T2 `C1-BIT-CORN-0.6-3` (rest, 0.1 mm overlap; feeds a
placeholder row with our provenance, #410 item 3). One program per tool; Z0 for T2 from the
tool-length difference (#387).

**Registration (the vise, non-conductive).** X and rotation from the fixed jaw; **Y by the stepped
scan on the front end** (no jaw under it → a miss beyond the edge, capped `stockProud + 1` below the
top); Z touch at the cut area's centre. The seven-touch plan that replaces the 8–12 min raster:

| # | Touch | Expected | Settles |
|---|---|---|---|
| 0 | Z at the centre, fast + slow | the blank's top | Z0; seating vs the stated proud |
| 1 | 1.5 mm left of the expected left edge | the fixed jaw's top, `−proud` ± 0.5 | the X reference holds; the real proud |
| 2 | 2 mm inside the expected front edge | the blank | not further back |
| 3 | 2 mm outside it | a capped miss | not further forward |
| 4–6 | bisect both ways to ≤ the edge margin (0.5) | — | Y to ±0.3 (rim bias 1.0 mm, assumed) |
| 7 (optional) | 1.5 mm right of the expected right edge | moving jaw's top — or a miss | the moving-jaw contradiction |

≈ 1.5 min at ~13 s per touch (trace 2026-10-15). The 2026-10-15 scan read the front edge 2.5 mm
forward and the left edge 0.5 mm left of the origin: a Y correction, not a refusal. Auto-level: on
(domed 0.33 vs a 0.2 margin), pending #176's sequence proof.

**Run plan, first run of this program (one setup, two tools):** home 0:25 · probe in + M491 1:15 ·
Z touch 0:15 · position check 1:30 · home + T1 + M491 + Z0 2:00 · air run T1 ≈ 4:10 · vacuum on, cut
T1 ≈ 4:10 · home + T2 + M491 + Z0 2:00 · air run T2 ≈ 5:40 · cut T2 ≈ 5:40 · done 0:15 — about 27 min,
4 min of it the operator's, 10 min of air runs skipped on a repeat. Cut minutes are the CAM's
trapezoid estimates (#281's model, D3 still to calibrate); the rest are measured or defaults as
§5.8 marks them.

**Badge-specific open questions** (moved here from draft 1): the flip preference (end for end vs
sideways); whether touch 7 is in the default scan; the Z-probe point (the centre, where the dome is
highest, vs Studio's `(20, 7) from Path Origin` default); whether a V-cut colour stroke is wanted on
the badge at all (#278's gate, "decide after first chips"); the seated-proud rule the maintainer wants
a new vise job to start from (`min(4, t/2, t − 3.1)` shipped as the safer half).
