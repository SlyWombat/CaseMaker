# A PCB from its Gerber files, and a round blank milled flat (design v1, 2026-10-28)

*Two jobs the 2026-10-28 real-parts run could not describe (#743): **j09**, the Carvera PCB (isolation, drills,
outline), and **j04**, the CNX coin (a disc milled on its face). This document says what each job needs from
input to run sheet, how it fits the existing job model with the smallest change, and the issue-sized slices
that build it. It follows `first-job-flow.md` (principles, the four wizard steps, §4 vocabulary) and borrows
the shape of `rotary-flow.md`. Where this document is silent, those hold. Status: PROPOSED. No implementation
until the maintainer approves the decisions in §8.*

**Source rule.** Every default names its source: Makera's catalogue (the synced `t_MakeraCutterProperties`
rows, as `feeds.ts` reads them), Makera Studio as read in `docs/reverse/makera-studio/` (untracked), the Carvera
PCB write-up j09 is taken from (raajthakur1.github.io, read 2026-10-28), the machine profile
(`engine/cnc/machine.ts`, `Z1`), or "Case Maker's default". A default shown on screen carries that source in
the Technical fold. §9 lists what this design could not settle, and the default it takes for each.

## 1. What failed, and why

| Job | What the run found | The gap in the model |
|---|---|---|
| **j09 PCB** (`manifest.json` → j09, no job file) | "Cannot be described yet: there is no PCB material and no way to bring in the board's Gerber layout." No stand-in was drawn, because a hand-drawn board tests nothing. | (a) `StockMaterial` has no PCB. `CATALOGUE_MATERIALS` maps Makera's names by exact match and leaves `PCB` out on purpose (`feeds.ts`, `machine.ts` `Z1.materials`), so Makera's PCB rows are never read. (b) No importer reads RS-274X Gerber or Excellon. `engine/import/` reads SVG, DXF, raster, STL and 3MF only. (c) The job needs a V-bit for isolation, a drill and a flat for the outline, in one setup. A later cutter can only cut rest passes today (#746, open). |
| **j04 coin** (`jobs/j04-coin-pla-proxy.json`) | A ⌀30 mm coin had to be described as a 32 × 32 × 3 mm square, with `stockEntry: null`. On that square, "CNX" comes out right. | `stock` is a rectangle or a rod (`shape?: 'cylinder'`). A **disc** writes no shape: its round fact lives only in `stockEntry.form`, which a job file may omit (j04's does). So `toPartPlan`'s `stockOutline` is always `rectProfile(length, width)`. A `border` or a `stock-inset` cut-out follows the square. The preview and the sweep start from a box, and nothing measures the rim. `item-off-round-stock` (`jobSetup.ts`) is the only round check, and it reads `stockEntry.form`. |

Makera's own tools describe both jobs. Studio's file dialogs accept the Gerber set (`*.gbr *.gtl *.gbl *.drl
*.art *.top *.bot …`, `06-toolpath-cam.md`). Its stock specs carry a `materialShape` and a `diameter`
(`t_MaterialSpecs`, `07-library-db.md`). The catalogue has PCB rows for the engraving bits (0.1 mm × 60°:
12 000 rpm, feed 500 mm/min, plunge 200 mm/min, step-down 0.1 mm) and for the corn bits.

## 2. Principles (added to first-job §1 and rotary §1)

15. **Both are first-job jobs.** There is no "PCB mode" and no "coin project". A PCB is a Plate of PCB material
    whose design comes from files. A coin is a Disc. The four wizard steps produce both.
16. **The files are the design.** A PCB's copper, holes and outline come from the Gerber and Excellon files and
    become ordinary job items, which the panel lists and the operator can edit. The files are kept as
    `sourceFiles` (content-addressed), and a re-import replaces exactly the items they made.
17. **Copper is a cap.** A copper-clad board is a laminate: one material over another, with a stated cap
    thickness. The depth rules already written for a two-colour laminate (#492, `depthIntent: 'reveal'`,
    `item-depth-bound`, the surface-plane budget of #608) answer "does the cut go through the copper
    everywhere?" No PCB-only depth rule is added.
18. **A short is a refusal.** Two pieces of copper that the design separates must come out separated. Where
    the cutter cannot open the gap between them, the job is refused at the item, and the sentence says where
    on the board. Unlike thinned engraved text, this is never a warning.
19. **A disc is a stock shape, not a form label.** Round in plan is a fact about the stock, so it lives on
    `stock`, where the outline, the preview, the sweep, the registration and the checks read it. It is not
    read from where the stock came from.

## 3. The PCB job, end to end

### 3.1 Input

- **Where it enters.** Wizard step 4 gains a group **Circuit board** with one whole-job operation,
  **Circuit board from Gerber files**, built the same way as "Surface a mesh". Its one field is the files: pick
  several, a folder's worth, or one `.zip`. The same import is on the panel's `+ Add operation` for a job that
  already has PCB stock, and on the command line, so the bench can build j09 without the app.
- **Which file is which.** Read the Gerber X2 `%TF.FileFunction` attribute first: `Copper,L1,Top`,
  `Copper,L2,Bot`, `Profile,NP`. KiCad and recent Altium write it. If the attribute is missing, use the
  extension or name (`.gtl`/`F_Cu` top copper, `.gbl`/`B_Cu` bottom copper, `.gko`/`.gm1`/`Edge_Cuts` outline,
  `.drl`/`.xln`/`.txt` with an `M48` header for drills). Solder mask, silkscreen, paste and fab layers are
  listed as **not used**, one line each. The import summary is one line per file, for example
  "`blinky-F_Cu.gbr` · top copper · 214 shapes". A file whose role cannot be told is shown with a role picker,
  not guessed.
- **Gerber (RS-274X) subset.** The parser is our own, a pure function beside `svgOutline.ts` and
  `dxfOutline.ts` (decision D3). It reads `FS` and `MO`, the standard apertures `C R O P`, aperture macros with
  primitives 1 (circle), 4 (outline), 5 (polygon), 20/21 (line, centre line) and their arithmetic,
  `D01`/`D02`/`D03`, `G01`/`G02`/`G03` with `G75`, regions `G36`/`G37`, and polarity `%LPD%`/`%LPC%`. It
  writes rings in mm. Arcs are chorded to the shop's `import.dxfChordToleranceMm`. The copper layer is the
  **union** of every dark shape, minus every clear one, made with manifold's `CrossSection` (already a
  dependency). Anything outside the subset is refused by name, with the file and line, for example
  "`F_Cu.gbr` line 412 uses step-and-repeat (`%SR%`), which this import does not read." Nothing is silently
  dropped.
- **Excellon subset.** `M48` header, `METRIC`/`INCH`, `LZ`/`TZ`, `FMAT,2`, tool table `TnnCd.ddd`, and
  coordinates in absolute mode. PTH and NPTH files are both read and their holes merged. Slots (`G85`,
  routed `M15`/`M16`) are refused by name in v1 (Q9).
- **Placement.** The board's outline box is centred on the blank (Q17). The Gerber origin is not used: a
  board's coordinates are wherever the CAD package put them.

### 3.2 Stock and holding

```
 Step 2 of 4 · Stock
 Material   [ PCB (copper-clad FR-4) ▾ ]
 Form       [■ Plate] [▬ Sheet] …       Plate: the board blank, copper side up.
 Size       length X [ 100 ] mm   width Y [ 70 ] mm   thickness Z [ 1.6 ] mm
 Copper     [ 0.035 ] mm on the top face (1 oz)          ▸ Technical: Case Maker's default; check the blank's label
```

- **Material** `pcb` is mapped exactly from Makera's `PCB` (D1). It is offered on the Z1 because the catalogue
  answers it. It has no starting-table row, so a house with no synced catalogue gets today's
  `feedsFor` refusal sentence, unchanged.
- **Copper** is written as `stock.colour = { kind: 'laminate', capMm: 0.035 }` (D2). The preview draws the cap
  in copper, and every depth below reads it.
- **Size.** Common blanks (100 × 70, 100 × 160, 127 × 101 in the Carvera write-up) fit the Z1's 200 × 200 mm
  envelope. The existing envelope check refuses anything bigger.
- **Holding** follows first-job §3.4: the numbers decide. A 1.6 mm board is below the vise's 3.1 mm ledge, so
  the vise's option is "on a waste board between the jaws". The vise is still **not the default**: jaws bow a
  thin board upward, and a 0.1 mm cut cannot follow a bow. The default is **On the bed, taped**: the existing
  tape mount (BM-1, `TapeHold`), with the board under it as `sacrificial.under` (`attach: 'tape'`), because the
  drills and the outline go through. The bracket with clamps is offered as today. The Carvera write-up
  clamped the board and turned on auto-level. The sentence under the tape option says why it is the default:
  "Taped flat on a board — a PCB's cut is 0.1 mm deep and follows the board's top."

### 3.3 Operations: what the files become

Every item below already exists in the job model. The import only creates them.

| From | Becomes | Item (existing type) | Cutter (§3.4) |
|---|---|---|---|
| top copper | **Copper** — the copper the board keeps, reference only | `EngraveVectorShape` (`contours`, `fillRule: 'NonZero'`, `construction: true`, `importedFrom` with the file's SHA-256) | none |
| top copper | **Isolate the copper** — a band around every piece of copper, deep enough to go through it | `EngraveFrameShape` `around: copper`, `gap: 0`, `width` = the isolation width (Q3), `depth` 0.1 mm (Q4), `depthIntent: 'reveal'`, plus the one new flag **`isolation: true`** (D5) | the engraving bit |
| top copper (optional, off by default) | **Clear the copper** — all copper the design does not keep, removed inside the outline (Makera CAM's "2D pocket" route) | `EngraveCutawayShape` `outer: outline`, `islands: [copper]` | a corn bit, rest after the V |
| drill file | **Holes**, grouped by size: one drill item per hole size, or a `drill-array` when the holes form a lattice | `EngraveDrillItem` per hole, `through: true`, `mode: 'drill'` or `'bore'` (§3.4) | a drill or end mill of that size, else bored |
| outline | **Board outline** — reference only | `EngraveVectorShape`, `construction: true` | none |
| outline | **Cut out the board** | `EngraveCutout` `of: outline`, `side: 'outside'`, `tabs` (count by perimeter, today's `CutoutTabs` rule) | a flat/corn bit with a PCB row |

Why a frame works. A frame is `offset(copper, gap + width) − offset(copper, gap)`, built over the **union** of
the copper (`partPlan.ts` `itemProfile`). Where two traces are closer than twice the width, the band between
them is just the gap, and nothing of either trace. So the band never takes copper the design keeps. The
remaining question, whether the cutter fits in the gap, is principle 18's check (§3.8).

Cut order in the one setup: isolation, holes, outline. That is one program per cutter, owned through
`setups[0].toolItems` (#419 J3, #472). This needs #746. The holes go before the outline because a freed board
is held only by its tabs.

### 3.4 Cutters and feeds

- **Isolation.** The recommendation (Route A, `recommendTool.ts`) is the owned engraving bit with the
  **smallest tip** that has a PCB row, so the 0.1 mm × 60° over the 0.2 or 0.3 mm. Feeds come from that row:
  12 000 rpm · 500 mm/min · plunge 200 mm/min · step-down 0.1 mm (Makera's catalogue). The cut's width at
  depth `d` is `tip + 2·d·tan(angle/2)`: **0.215 mm** for 0.1 × 60° at 0.1 mm, 0.254 mm for 0.2 × 30°. The
  Cutter group says that width in one line, because it decides which gaps open.
- **Holes.** For each hole size, in order:
  1. an owned drill or end mill whose ⌀ is the hole's, up to +0.1 mm and never under (Q7). Plunge `mode: 'drill'`.
  2. Otherwise `mode: 'bore'` with the outline cutter when the hole is larger than that cutter. This is what the
     Carvera write-up did with its 0.8 mm corn bit.
  3. Otherwise a refusal at the item: "No cutter for the 0.6 mm holes (4): the smallest you own is 0.8 mm."

  A 1/8" collet takes the common PCB drills, which have 1/8" shanks, so no shank question arises.
- **Outline.** The recommendation is the owned flat or corn bit with a PCB row. A board 1.6 mm thick goes
  through in the row's step-downs, and the breakthrough goes into the board under, as every through cut does.
- **FR-4 is glass-filled.** Its wear is already in Makera's PCB rows. The run log records the material, and no
  extra wear rule is added in v1 (Q19).

### 3.5 Simulation

- **The sweep** (`programSweep.ts`) runs every program in cut order, as for every job: isolation, then holes,
  then outline. The rapid, holder and fixture checks are unchanged. The preview draws the copper cap, so a
  band that opens through to FR-4 shows the base colour.
- **The oracle for a PCB is topology.** The existing `gridSliceAt` (`oracle.ts`) slices the **simulated**
  result at the copper's underside (`capMm`) and gives the copper that is left. That copper is grouped into
  connected pieces, and each piece is matched to the design copper it overlaps. The tick **"matches the design"**
  means three things: every design piece is still there (nothing isolated away), no two design pieces share a
  remaining piece (no short), and no remaining piece lies outside the design copper plus the cut's own
  tolerance (no copper left where the band should be). This oracle reads the swept solid, not the plan, so it
  is independent of the CAM.
- **Budget.** A small board's isolation is thousands of short moves. The fixture pins its time inside
  `SIM_BUDGET_MS`. If it is over, it is a finding against the sweep, not a reason to skip the simulation.

### 3.6 Cut

The four Cut lines are unchanged. What differs is in step 3 (register) and in what step 4's gate reads:

- **Register.** Today's plan: the left and front edges, then the surface touches at the cut area's centre and
  around it (`registration/plan.ts`). The copper is conductive, so the touches are good ones.
- **The surface gate.** The five touches fit a plane (#608), and the programs are posted against it. The
  residual, which is the bow a tilt does not explain, must leave the isolation through the copper everywhere:
  **residual ≤ depth − copper − the job's Z tolerance**. With the defaults that is 0.1 − 0.035 − 0.02 =
  **0.045 mm**. Over that, line 4 refuses with one sentence: "The board's top is uneven by 0.06 mm after its
  tilt is taken out; the 0.1 mm isolation needs it within 0.045 mm. Tape it flat over its whole back and
  register again." This is the same arithmetic as `item-depth-bound` with the measured residual in place of the
  assumed one, so the design check and the Cut gate cannot disagree.
- **Auto-level** stays locked until #501 proves `G32` on the Z1 (`plan/features.ts`). When it is proven, the
  grid's residual replaces the plane's in the same inequality (`depthBounds.ts` already carries
  `gridResidual`). Until then, a board that needs a grid is refused at line 4, not cut shallow (Q11).

### 3.7 Run sheet (sections added)

- **The board.** "PCB 100 × 70 × 1.6 mm, copper 0.035 mm on top, copper side up; taped flat over a 2 mm board."
- **What the files made.** One line per source file, with its role and its SHA-256 prefix, so the cut is tied
  to the exact files.
- **Programs.** "1 Isolate the copper · ⌀0.1 mm 60° engraving bit · 0.1 mm deep, 0.215 mm wide · 2 Holes ·
  ⌀0.8 mm (38), ⌀1 mm (6) · 3 Cut out the board · 3 tabs."
- **After the run.** "Break the tabs and sand the edge. Check for shorts with a meter between neighbouring
  pads before soldering." That is the only advice line, because it is the one thing the oracle cannot see:
  copper burrs.

### 3.8 Checks that refuse a bad PCB job

| Where | Sentence (the shape of it) | Code (never on screen) |
|---|---|---|
| Import | "`F_Cu.gbr` line 412 uses step-and-repeat (`%SR%`), which this import does not read." Also unknown macro primitives, `G74` single-quadrant arcs, image polarity, and malformed coordinates | `gerber-unsupported` |
| Import | "The drill file routes slots (`G85`), which this import does not read." | `excellon-slot` |
| Import | "No copper file among these: pick the top copper (`.gtl`, `F_Cu`)." | `pcb-no-copper` |
| Import | "The bottom copper is a second side; this version mills one side." (Q10) | `pcb-two-sided` |
| Design | "The board is 127 × 101 mm; the blank is 100 × 70 mm." | `pcb-off-blank` |
| Design | "The isolation cannot open the 0.15 mm gap near X 41.2 Y 18.7: the cut is 0.215 mm wide there, so two pieces of copper stay joined. Use a finer bit or widen the gap in the board's design." One finding per joined pair, listing up to five places. | `isolation-short` (new, D5) |
| Design | "The isolation is 0.1 mm deep; the copper is 0.035 mm, and the surface allowance leaves it 0.03 mm short of going through." | `item-depth-bound` (existing, `reveal` side) |
| Design | "No cutter for the 0.6 mm holes (4): the smallest you own is 0.8 mm." | `hole-no-cutter` (new) |
| Design | "4 holes are outside the board outline." | `item-off-board` (new, from the outline) |
| Design | No feeds for the cutter in PCB | existing `feedsFor` refusal |
| Design | A through hole or the outline with no board under | existing `through-needs-board` |
| Cut | The surface residual over the isolation budget (§3.6) | existing surface gate, PCB budget |
| Simulate | The topology oracle fails: a short, lost copper or copper left in the band | `oracle` (existing tick, PCB reading) |

A warning, not a refusal: **"A trace is 0.12 mm wide at X … Y …; a 0.02 mm surface error widens the cut by
0.023 mm on each side."** A thin trace is still a trace, but the operator should know it before soldering.

## 4. The round blank (disc) milled flat, end to end

### 4.1 Input

Wizard step 2's **Disc** form (it already exists, with its size words `diameter ⌀ · thickness Z`) now writes a
round stock. `stockFromMade` and the shelf write `shape: 'disc'` and `diameter` beside the D × D × T box (D6).
A shelf entry or a made piece of form Disc is round. An STL or 3MF used as the stock whose outline is a circle
is accepted as a disc (`meshStock.ts` today refuses it: "covers 78.5 % of its box"). See slice D-3.

The design is whatever step 4 picks. j04's items stay as they are: the text, the field cleared with the text
and the rim left standing. What changes is the stock they sit on.

### 4.2 Stock and holding

- **Size words:** `diameter ⌀ · thickness Z`, `mm` on each, as today. The box is derived and never shown.
- **The vise.** The jaws are planes at the box's front and back. A disc touches them on two lines at its
  centre-line. The jaw-clearance and jaw-collision checks measure the distance from a cut to the jaw plane, so
  they hold unchanged. The ledge, board-between-the-jaws and gripped-as-a-block choices follow the same numbers
  as a plate of that thickness. The picture (`HoldingStep`, `round` already) draws the circle. The caption
  gains one sentence, because two lines of grip resist turning less than two faces: "A disc is gripped on two
  lines; take light cuts, or tape it."
- **On the bed, taped.** Offered as for a plate. The default when the disc is thinner than the ledge and the
  vise is not on the pins.
- **Bracket and clamps.** Shown, not offered, with its reason: "A disc touches the bracket at two points and
  turns under the cutter — tape it or hold it in the vise." Clamps on a small disc's face also cover the face
  being cut.
- **The rotary chuck.** Not offered, as `rotary-flow.md` §3.3 already decided: a disc is cut on its face.

### 4.3 Operations

No new operation. What changes is the **stock outline** that existing operations follow:

- `toPartPlan`'s `stockOutline` (`partPlan.ts`) becomes a circle profile for a disc. Through it, three things
  follow the rim with no code of their own: a **Border** (a ring at an inset from the rim, the coin's raised
  edge), a **stock-inset cut-out** (the disc cut free of a waste ring, or a smaller coin turned from a bigger
  disc), and a **Chamfer** of the rim when it names the stock's outline.
- `item-off-round-stock` reads `stock.shape`, not `stockEntry.form` (D7), so a job file with no stock entry,
  such as j04, is checked too.
- **Facing** on a metal disc plans over the circle plus the cutter's radius, not the box. Today's box plan is
  correct but spends a fifth of its time in air (π/4 of the box is disc).

### 4.4 Feeds

No new rows. Aluminium, brass and PLA discs read the same catalogue rows as a plate of the material (#732
closed the owned-cutter gap that refused j04's aluminium run).

### 4.5 Simulation

- The preview's `placedStock` and the sweep's seed are a **cylinder** (manifold `cylinder`, segments from the
  chord tolerance) instead of a box. Everything downstream works on the mesh it is given, so this is the only
  simulation change.
- The oracle's "matches the design" already measures removed volume against the design over the stock. With
  the round stock, a cut that reaches past the rim removes air, not volume, and the oracle reads the truth.

### 4.6 Cut

- **Register on the rim.** Four edge scans, left, right, front and back, each **along the disc's centre-line**,
  so each touches the extreme point of the circle. An off-line scan by δ misses the extreme point by about
  δ²/2R: on ⌀30, a 1 mm error costs 0.033 mm. The centre is the midpoint of each pair, and the diameter is
  the span. Then the usual surface touches near the centre.
- **The origin does not move.** The job still plans from the box's front-left corner. Registration writes that
  corner as centre − R on each axis, so no program changes frame (Q16).
- **A disc has no rotation to read.** The program is never rotated. If the design must line up with something
  on the disc, a reference feature is #429's case, not this one's.
- **Diameter check.** The touched span is compared with the stated ⌀: "The disc measures ⌀30.42 mm; the job
  says ⌀30 mm. Correct the stock, or register again." The tolerance is the registration's own edge
  tolerance (`registration.*`), so no new shop setting is added.

### 4.7 Run sheet

"Stock: disc ⌀30 × 3 mm, PLA, on a 2 mm board between the jaws." "Register: four touches on the rim, through
its centre; the centre sets the origin." The rest is unchanged.

### 4.8 Checks that refuse a bad disc job

| Where | Sentence | Code |
|---|---|---|
| Stock | A disc states its diameter; its box is D × D × T (schema) | schema |
| Stock | ⌀ wider than the vise opening, or the bed | existing envelope/vise checks |
| Design | "Engrave “Software” reaches past the ⌀30 mm face of the disc …" | `item-off-round-stock` (existing, now read from `stock.shape`) |
| Holding | The bracket option's reason (§4.2) | — |
| Cut | The measured diameter differs from the stated one by more than the edge tolerance | `disc-diameter-mismatch` (new) |

## 5. The model change, smallest form

| Where | Change | Round-trip |
|---|---|---|
| `StockMaterial` | `+ 'pcb'` | new value only |
| `CATALOGUE_MATERIALS` (`feeds.ts`) | `PCB: 'pcb'` (exact name) | — |
| `Z1.materials` (`machine.ts`) | `+ 'pcb'` | — |
| `EngraveJob.stock.shape` | `'cylinder' \| 'disc'`. A disc states `diameter`, and its box is `D × D × T` (schema-checked, as the cylinder is) | absent stays absent. A pre-change job whose `stockEntry.form` is `'disc'` and whose box is square gains `shape: 'disc'` on load, which is the one migration (D6) |
| `EngraveFrameShape` | `isolation?: true`, meaning "this band must separate every piece of the copper it follows" | absent on every existing frame |
| `JobSource.kind` | `+ 'gerber' \| 'excellon'` | — |
| `EngraveVectorShape.importedFrom` | unchanged. It already carries `{ name, sha256 }`. A re-import replaces the items whose `importedFrom.sha256` matches a file of the set | — |

**Not added:** a PCB item kind, a PCB job type, a copper field on `stock` (the laminate cap is it), a drill
table (drills are drill items), a "board origin" (the outline box is placed like any import), a disc
workholding arm (the vise, tape and bracket arms hold it), or a new oracle engine (the slice already exists).

## 6. What is reused

| Need | Existing piece |
|---|---|
| Copper as geometry | `EngraveVectorShape` (`construction`, `importedFrom`); `outlineTypes.ts`'s ring frame and limits (2 000 contours after union, 200 000 points) |
| Isolation band | `frame` (`itemProfile`: ring of offsets over the target's union) |
| V-bit at a fixed depth | the region pipeline's V-bit `vCarveDepth: 'plane'` and the cut-opening measurement that drives `item-detail-lost` (#201) |
| Through the copper, with a budget | `StockColour` `laminate` + `depthIntent: 'reveal'` + `item-depth-bound` (#345, #492); `depthBounds.ts`'s surface terms; `surfacePlane.ts` (#608) |
| Holes | `EngraveDrill` (`drill` / `bore`, `through`, `peckMm`) (#218, #668, #675) |
| Board cut-out with tabs | `EngraveCutout` + `CutoutTabs`; `loose-piece` |
| Several cutters, one setup | `setups[].tools` + `toolItems` (#472), once #746 lands |
| Taped to the bed with a board under | `TapeHold` + `sacrificial.under` `attach: 'tape'` (BM-1, #707) |
| Feeds | Route A catalogue rows (`feedsFor`, #347, #455, #732) |
| Topology oracle | `gridSliceAt` on the simulated result (`oracle.ts`) |
| Disc rim work | `border`, `stock-inset` cut-out, `chamfer`, all through `stockOutline` |
| Off-the-disc check | `item-off-round-stock` (#683) |
| Disc picture | `HoldingStep`'s `round` drawing (#705) |
| Rim registration | `registration/plan.ts` edge scans, with `along` at the centre-line |
| Source files | `JobSource` (#425): embedded at ≤ 4 MiB, else named by hash |

## 7. Vocabulary additions (to first-job §4)

| Thing | Word | Not |
|---|---|---|
| the material | PCB (copper-clad FR-4) | FR4, copper board, CCL |
| the blank | the board blank; after cut-out, the board | PCB stock, panel, substrate |
| the copper the design keeps | copper · a piece of copper | net, polygon, trace layer, F.Cu |
| the band cut around it | the isolation · "Isolate the copper" | isolation routing, trace milling, clearance |
| two pieces left joined | a short · "stay joined" | bridge, net merge, DRC error |
| the files | the copper file · the drill file · the outline file | Gerber layer, aperture, D-code (in the import's Technical fold only) |
| copper thickness | copper `0.035 mm` (1 oz in brackets) | oz alone, µm |
| the round blank | Disc · `diameter ⌀ · thickness Z` | coin blank, round plate, cylinder |
| the disc's edge | the rim | circumference, perimeter |
| the rim touches | "four touches on the rim, through its centre" | circle probe, boss probe |

## 8. Decisions

| | Decision | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | PCB material | `pcb`, mapped exactly from Makera's `PCB` | a generic "FR-4" with typed feeds | Makera has the rows. Exact mapping is the house rule (`CATALOGUE_MATERIALS`), and a typed row would be a guess |
| D2 | Copper thickness | the laminate cap (`stock.colour`, `capMm`) | a new `stock.copper` field | a cap is exactly what copper on FR-4 is, and every depth rule already reads it |
| D3 | Gerber/Excellon parsing | our own pure parsers, subset, refuse the rest by name | an npm Gerber library | matches `svgOutline`/`dxfOutline`, adds no dependency, and every refusal is ours to word. The subset is what KiCad writes |
| D4 | What a PCB becomes | ordinary items: construction vectors, frame, drills, cut-out | a PCB item kind or job type | principle 15. Every check, the preview, the sweep and the run sheet already handle these |
| D5 | Isolation | a frame with `isolation: true`; a gap the cut cannot open is `isolation-short`, an error | a frame with no flag (the lost layer as a warning) | a thinned letter is cosmetic, a short is a broken board (principle 18). The flag is the only way to tell them apart |
| D6 | Disc stock | `stock.shape: 'disc'` + `diameter`, box D × D × T | reusing `'cylinder'` in its standing frame | a standing cylinder already means "a rod in the vise", and `rodDimsOf` and the rotary readers treat it as one. A disc must never be offered the chuck |
| D7 | Where "round" is read | `stock.shape`, everywhere | `stockEntry.form` | the stock entry is provenance and can be absent (j04). Principle 19 |
| D8 | PCB holding default | on the bed, taped, with a board under | the vise | jaws bow a 1.6 mm board, and a 0.1 mm cut cannot follow a bow |
| D9 | Flatness | the #608 plane plus a residual budget from the copper; auto-level waits for #501 | waiting for auto-level before any PCB | the plane covers the common case (a tilted blank). The budget refuses the rest, so nothing is cut shallow |
| D10 | Oracle | topology of the simulated copper slice | removed volume alone | volume cannot see a short. Topology is what a PCB is for |
| D11 | Disc registration | four scans through the centre-line; origin stays at the box corner | a new centre-origin frame | no program changes frame, and the existing scans do it |
| D12 | One side first | single-sided v1; two-sided as a later slice | both at once | two-sided needs a flip and registration on drilled holes (#429). It is a separate piece of work with its own bench proof |

## 9. Questions this design could not settle, and the default it takes

| | Question | Default taken | Why |
|---|---|---|---|
| Q1 | Our own Gerber parser, or a library? | **Our own** (D3) | see D3; revisit if real boards hit the refusals often |
| Q2 | No outline file in the set | **The rectangle around the copper plus 1 mm**, said in the import summary | most hobby sets have one, and a stated rectangle beats a refusal |
| Q3 | Isolation width | **0.4 mm** (two passes of a 0.215 mm cut); where the gap is narrower, the band is the gap | wider isolation solders more easily. The union clips the band to the gap, so it never takes copper |
| Q4 | Isolation depth | **0.1 mm**, one step-down of Makera's row | 0.035 mm copper with a 0.065 mm allowance. The Carvera write-up used 0.05 mm with auto-level on |
| Q5 | Clear all unused copper? | **Off**; offered as "Clear the copper" | it is slow, and isolation alone makes a working board |
| Q6 | Copper thickness | **0.035 mm (1 oz)**, Case Maker's default, typed | the common blank; the label states it |
| Q7 | Hole size tolerance | **Up to +0.1 mm, never under**, a shop setting | a pin needs its hole; a slightly big hole is fine |
| Q8 | A hole with no cutter of its size | **Bore it with the outline cutter if larger, else refuse** | the Carvera write-up bored with its 0.8 mm corn bit |
| Q9 | Excellon slots | **Refused by name** in v1 | rare on hobby boards; a later slice can map them to `slot` pockets |
| Q10 | Bottom copper | **Refused** while a top copper is present. A set with **only** bottom copper is mirrored about the board's X centre and milled from the top, and the summary says "mirrored" | a single-sided board is often drawn on the bottom layer |
| Q11 | Auto-level | **Not waited for**: the plane and the residual budget (D9) | #501 is open. The budget refuses rather than cutting shallow |
| Q12 | The material's word | **"PCB (copper-clad FR-4)"** | Makera's word, plus what it is |
| Q13 | A new colour kind `copper`? | **No**: `laminate` (D2) | it behaves as a laminate. The picture can colour a `pcb` cap copper |
| Q14 | Disc as a new shape value or the cylinder? | **New `'disc'`** (D6) | see D6 |
| Q15 | Disc in the bracket | **Shown, not offered**, with its reason | two points of contact; clamps over the face |
| Q16 | Disc origin | **The box's front-left corner**, as today | no frame change (D11) |
| Q17 | Board placement on the blank | **Centred** | the edges keep equal margins for tabs and tape |
| Q18 | Where PCB enters | **Step 4, "Circuit board from Gerber files"**, a whole-job operation | like "Surface a mesh": the files are the design |
| Q19 | Glass-fibre wear | **Not modelled** in v1 beyond Makera's rows | `fibre: 'gf'` is a printed-filament fact (#464) and would be misread here |
| Q20 | The j09 bench board | **A small board of our own design** (two nets, a 0.3 mm gap, a 0.15 mm gap, eight holes in two sizes, a rounded outline), drawn and exported from KiCad, committed with its Gerbers | the Carvera board's Gerbers were the instructor's and are not published. Ours is free to commit, and every check in §3.8 has a feature on it |

## 10. Slices, in dependency order

Each slice is one issue. *Fixture* is what it is tested with. The unit fixtures go in
`casemaker-app/tests/unit/fixtures/pcb/` and `…/disc/`. The bench jobs go in
`docs/bench/2026-10-28-z1-real-jobs/jobs/`.

| # | Title | Scope | Depends on | Fixture |
|---|---|---|---|---|
| **D-1** | stock: a disc is round stock (`shape: 'disc'`) | type + schema (D × D × T, `diameter`); `stockFromMade` / shelf write; the one load migration; `stockOutline` as a circle; `item-off-round-stock` from `stock.shape`; preview and sweep seed as a cylinder | — | **`j04-coin-disc-pla.json`**: the proxy's items on a ⌀30 × 3 mm PLA disc. A Border at inset 0 follows the circle (the ring's area equals the annulus within chord tolerance). Moving "Software" 2 mm out raises `item-off-round-stock` with `stockEntry` absent. The old 32 × 32 proxy still round-trips byte-for-byte |
| **D-2** | holding and registration for a disc | the vise caption, tape, the bracket's reason; four centre-line rim scans; centre and diameter from the readings; `disc-diameter-mismatch`; run-sheet lines | D-1 | registration plan snapshot for ⌀30 taped; synthetic readings at ⌀30.00 (passes, corner = centre − 15) and ⌀30.42 (refused with the sentence) |
| **D-3** | a disc from a file, and facing that follows the rim | `meshStock` accepts a circular prism as a disc (circle fit within the weld tolerance); facing plans over the circle plus the cutter radius | D-1 | `disc-30x3.stl` (generated, 128 segments) is accepted as ⌀30 × 3. Facing time on ⌀30 is ≤ 0.85 × the box plan's time |
| **P-0** | #746: a later cutter cuts its own items | (the existing issue, unchanged) | — | #746's fixtures (j19, j24, j25), plus a V-bit-then-flat case |
| **P-1** | material: PCB, with the copper cap | `'pcb'` in `StockMaterial`, `CATALOGUE_MATERIALS`, `Z1.materials`; step 2's material and copper field writing the laminate cap; preview colour | — | `catalogue-pcb.json` (three rows: 0.1 × 60° engraver, 0.8 corn, 1 mm drill). `feedsFor` gives 12 000 / 500 / 200 / 0.1 for the engraver. With no catalogue, today's refusal sentence |
| **P-2** | import: Gerber RS-274X subset | pure parser → rings in mm; apertures, macros, arcs, regions, polarity; union with `CrossSection`; refusals by name with file and line | — | hand-written `tiny-F_Cu.gbr` (two round pads, a 0.25 mm trace, an `RoundRect` macro pad, a `G36` pour with an `%LPC%` cut-out, a `G03` arc): expected union area ± 0.5 % and 3 pieces. `sr.gbr` (`%SR%`) is refused at its line. The same board exported in inches parses to the same rings |
| **P-3** | import: Excellon subset | header, units, zero suppression, tool table; PTH + NPTH merge; slot refusal | — | `tiny.drl` (METRIC, `T1C0.8` ×6, `T2C1.0` ×2) and `tiny-inch.drl` (INCH, TZ) give identical holes. `slot.drl` (`G85`) is refused at its line |
| **P-4** | Circuit board from Gerber files: the whole-job import | layer roles (X2, then names), the import summary, placement centred, the items of §3.3 with `sourceFiles`; cutters per §3.4 into `toolItems`; re-import replaces by hash; the command-line door | P-0, P-1, P-2, P-3 | the `tiny-*` set on a 60 × 40 × 1.6 mm blank: an item snapshot (copper, isolation, 2 drill groups, outline, cut-out with 3 tabs); a bottom-only set comes in mirrored; `pcb-off-blank` on a 30 × 20 mm blank |
| **P-5** | isolation: `isolation: true`, the short refusal, the topology oracle | `isolation-short` from the cut opening of the band (places named); the sliced-copper oracle on the simulated result; the thin-trace warning; `hole-no-cutter`, `item-off-board` | P-4 | `gaps.gbr`: pads 0.40 mm apart pass; 0.15 mm apart are refused at the stated X Y. The oracle reports 2 pieces, 2 matched, 0 shorts, and a deliberately posted shallow program (0.03 mm) fails it as copper left in the band |
| **P-6** | Cut and run sheet for a PCB | the surface-residual budget at line 4; tape-flat default (D8); the §3.7 run-sheet sections | P-5 | readings with residual 0.03 mm pass and 0.06 mm are refused with the sentence; a run-sheet snapshot |
| **P-7** | bench: j09 rebuilt on our own board (Q20) | the KiCad board, its Gerbers, `j09-pcb.json`; an air run, then a real cut on FR-4 with the plug procedure in `CLAUDE.md`; manifest verdict | P-6 | the committed board. The verdict compares the cut board with a meter (two nets, no short) and the photo |
| **P-8** | two-sided boards | a second setup flipped about X; registration on two drilled holes (#429 references); bottom copper mirrored | P-7, #429 | `tiny-B_Cu.gbr` on the same drills: setup 2's programs land on the hole centres within the registration tolerance (synthetic readings) |

D-1 to D-3 and P-0 to P-3 can run in parallel. The order of the lines above is the order to land them.

## 11. Acceptance

1. **The coin.** From the door, Disc ⌀30 × 3 PLA, vise, the j04 items, reaches four ticks with no default
   changed. The preview shows a round coin, and a Border follows the rim. `j04-coin-disc-pla.json` passes under
   `casemaker cut --json`.
2. **The board.** From the door, PCB 60 × 40 × 1.6, taped, Circuit board from Gerber files with the `tiny-*`
   set, reaches four ticks with no default changed. "Matches the design" is the topology oracle's verdict.
3. **A short is refused** at the isolation item with the place named, and the job does not generate.
4. **Words.** The walk's transcripts contain no `#\d`, no codes (`isolation-short`, `gerber-unsupported`), no
   Gerber words outside the Technical fold (aperture, D-code, net), no length without `mm`, and no decimal
   past three places.
5. **The bench.** j09 and j04 are run again and recorded in the manifest with verdicts compared to the photo.
