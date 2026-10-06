# Technical Reference

For developers extending Case Maker. Audience: TypeScript + React + a passing acquaintance with mesh CSG.

## Architecture

```
+---------------------------------------------------------------+
|  UI Layer (React + R3F)                                        |
|  Sidebar (params/ports/joints) | Toolbar | <Canvas> (Z-up)     |
|         │                 │          │                          |
|         └─────────────────┴──────────┴── selectors / actions ──▶|
+----------------------------┬----------------------------------+
                             ▼
|  Store (Zustand) — single source of truth                      |
|   project (parametric model) | meshCache | jobState | history  |
+----------------------------┬----------------------------------+
                             │ subscribe(project) → debounce(200ms)
                             ▼
|  Engine (main thread, thin)                                    |
|   ProjectCompiler → BuildPlan → JobScheduler → SceneSync       |
+----------------------------┬----------------------------------+
                             │ Comlink (transferables)
                             ▼
|  Geometry Worker (Manifold WASM) — cancellable via gen counter |
|  Export Worker (STL bin / ASCII / 3MF zip) — separate, stateless|
+---------------------------------------------------------------+
```

**Key rule:** the parametric `Project` is the single source of truth. The rendered scene and exported meshes are derived state, recomputed in the geometry worker. Never mutate a mesh — always edit the `Project` and let the worker rebuild.

## Coordinate system

- **Units:** millimeters everywhere.
- **Up axis:** Z. `THREE.Object3D.DEFAULT_UP.set(0, 0, 1)` is enforced on app boot.
- **Origins:**
  - **World origin** (0, 0, 0) is the bottom-front-left corner of the case.
  - **PCB origin** in PCB-local frame is the bottom-left corner of the board (X+ along long edge, Y+ along short edge, Z+ out of the board face).
  - **PCB-to-world transform:** `(wallThickness + internalClearance, wallThickness + internalClearance, floorThickness)`.

## Module API

### Engine compiler — `src/engine/compiler/`

The compiler is 43 modules. Grouped by what they build:

**Core pipeline**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `ProjectCompiler.ts` | `compileProject(project) → BuildPlan` | Top level: turn a Project into a serializable op tree |
| `buildPlan.ts` | `BuildOp`, `cube`, `cylinder`, `extrude`, `revolve`, `hull`, `axisCylinder`, `union`/`difference`/`intersection`, `collectMeshTransferables` | Op constructors + transferable-buffer enumeration for Comlink |
| `profile.ts` | `poly`, `rectProfile`, `circleProfile`, `roundedRect`, `pOffset`, `pHull`, `lightenPocket` | 2D cross-sections (Clipper2). Nearly every feature here is prismatic — draw the outline, then extrude it |
| `connectivity.ts` | `bboxOfOp`, `checkBuildPlanShape` | Shape and connectivity sanity checks over a finished plan |

**The case itself**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `caseShell.ts` | `buildOuterShell`, `computeShellDims`, `computeStackedHatHeight` | Outer hollow box + cavity dims |
| `lidMode.ts` | `isClamshell`, `lidIsRecessed`, `lidCavityHeight`, `CLAMSHELL_MIN_CAVITY` | The one answer to "which closure is this?" — see **Closure modes** below |
| `lid.ts` | `buildLid`, `buildFlatLid`, `buildSnapFitLid`, `buildSlidingLid`, `buildScrewDownLid`, `computeLidDims`, `computeRecessDims` | All four joint variants, including the sliding rails |
| `bosses.ts` | `computeBossPlacements`, `buildBossesUnion`, `resolveInsertSpec`, `getScrewClearanceDiameter` | Mounting boss geometry + insert variant resolution |
| `ports.ts` | `buildPortCutoutOp`, `buildPortCutoutsForProject` | Per-port wall-piercing cutouts |
| `portFactory.ts` | `autoPortsForBoard` | Populate `project.ports` from a board's `components` array |
| `roundCutout.ts` | `buildAxisAlignedCutout` | Round/oval cutouts on any face |
| `customCutouts.ts` | `buildCustomCutouts` | User-placed cutouts that belong to no component |
| `ventilation.ts` | `buildVentilationCutouts` | Slot, hex or chevron patterns through a wall |
| `textLabels.ts` | `buildTextLabelOps` | Embossed / engraved text |

**Joints and fixings**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `fasteners.ts` | `FASTENERS`, `screwHole`, `screwStarter`, `threadTool`, `clearanceDiameter`, `pilotDiameter`, `headRecessDiameter`, `preThreadPrintable` | The fastener table and the one screw-hole mechanism — see **Screw holes** below |
| `snapCatches.ts` | `defaultSnapCatchesForCase`, `buildSnapCatch`, `buildSnapCatchOps` | Cantilever arm + barb, and the mating pockets |
| `latches.ts` / `latchProtection.ts` | `buildLatchOps`, `protectiveRibPositions` | Draw latches, and the ribs that stop them snagging |
| `hinges.ts` | `buildHingeOps` | Knuckle-and-pin hinges |
| `seal.ts` | `computeChannelAndTongue`, `computeSealRing`, `buildSealChannel`, `sealFitNote`, `MIN_SEAL_WEB` | Gasket channel + tongue, and the clamp that stops the channel eating the wall (#264) |
| `alignmentFlange.ts` | `buildAlignmentFlange` | Lip that locates the lid on the shell |
| `boardSnap.ts` | `buildBoardSnapOps` | Two-jaw clips that hold a PCB without screws |
| `validation.ts` | `validateScrewDownAlignment` | Refuse joints whose fixings cannot line up |

**Interior organisation**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `holeGrid.ts` | `holeGridPocket(outline, opts) → Profile`, `holeGridCentres`, `holeGridProblem` | Issue #150 — the interior socket lattice: square sockets on a fixed pitch, clipped inside a margin and kept clear of bosses. Pure profile math. See **Interior grids** below |
| `dividerPegs.ts` | `buildDividerPegOps`, `buildDividerPegOp`, `pegWidth`, `dividerPegProblem` | Issue #150 — drop-in divider pegs sized to a grid: one wall plate with a tenon under each end, width quoted in hole spans |

**Boards and add-ons**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `hats.ts` / `hatOrientation.ts` | `computeHatBaseZ`, `buildHatCutoutsForProject`, `applyMountingPosition` | Stacked HATs: height, rotation, and their cutouts |
| `displays.ts` | `buildDisplayCutoutOps` | Screen windows and their retention shoulders |
| `antennas.ts` | `defaultAntennasForBoard`, `buildAntennaOps` | Antenna bores + counterbores |
| `fans.ts` | `buildFanMountOps` | Fan opening, bolt circle and mounting pad |
| `externalAssets.ts` | `buildExternalAssetOps` | Imported STL/3MF turned into mesh ops with transforms |
| `secondaryMounts.ts` | `buildSecondaryMountOps` | A second board or module carried in the same case |

**Whole-product archetypes**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `rack.ts` | `buildRackNodes`, `computeRackDims`, `accessorySpaces`, `cableNotchGeometry` | The parametric mini-rack: sides, plates, shelves, trays, faceplates. See [Mini-Rack.md](https://github.com/SlyWombat/CaseMaker/blob/main/Mini-Rack.md) |
| `rackFit.ts` | `rectFitsBed`, `resolvePrinter`, `rackPartFootprints`, `maxRackWidthForBed`, `PRINTER_PRESETS` | Printer-fit checks: does every rack part land on the bed? Also the one place the project's bed is read (`resolvePrinter`) and the test every split layout is judged by |
| `stand.ts` | `computeStandDims`, `buildEdgeChannels`, `standModulePlacement`, `computePocketDims`, `buildPocketOp` | Desk and bench stands — and (issue #151) the `mount: 'pocket'` wall shelf: one part, a back plate with a screw ear each side, a floor and two walls the finished module nests into, sized from the module's own envelope and sharing `rack.ts`'s wall-fixing sizes |
| `insert.ts` | `buildInsertNodes`, `buildInsertOp`, `insertGrid`, `insertLayout`, `insertProblem`, `pocketRadius`, `roundPocketCutter` | Issue #158 — the tool-insert holder: one plate of round (socket-OD) and hex (across-flats) pockets on a centred uniform grid, sized to the user's own tools. Plate 120 × 80 × 6 by default, with `clearance`, `chamfer`, `floor` and `pitchGap` all exposed; the pocket layout is pure and wasm-free, so only the subtracted solid needs an evaluator. `roundPocketCutter` is the round pocket as a standalone primitive, so the `insert-pocket` fit coupon cuts the shipped pocket instead of a copy of it |
| `rugged.ts` | `buildRuggedOps` | Corner bumpers and impact ribs |
| `mountingFeatures.ts` | `buildMountingFeatureOps`, `endFlangesPreset`, `fourCornerScrewTabs`, `extrusionMountPreset` | How the finished case attaches to the world: tabs, flanges, VESA, and (issue #151) bolt holes for a T-nut captive in 20-series T-slot extrusion — through-holes only, so no printed part changes |

**Layout and guards**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `splitPart.ts` | `planSeams`, `splitBySeams`, `seamScrewCount`, `seamScrewSites`, `jointClearanceHole`, `jointStarterHole`, `jointHoleDiameters` | Issue #148 — where to cut a part too big for the bed, the cut itself, and both halves of the bolted joint. Archetype-blind. See **Print bed, alternatives and split parts** below |
| `shellSplit.ts` | `planShellJoint`, `buildShellSplit`, `canSplitShell`, `pieceId`, `LUG_DROP`, `LUG_LAP`, `DEFAULT_SPLIT_SCREW` | Issue #148 — the case shell's half: the joint as arithmetic (`planShellJoint`), the same joint as geometry (`buildShellSplit`), and the refusal to cut a sealed shell |
| `placementValidator.ts` | `validatePlacements` | Overlapping cutouts, off-PCB holes, HAT collisions — surfaced as a `PlacementReport` on the plan |
| `smartCutoutLayout.ts` | `applySmartCutoutLayout` | Nudge crowded cutouts apart rather than merging them |
| `featureScale.ts` | `clampLatch`, `clampHinge` | Keep features printable as the case shrinks |
| `applyCasePatch.ts` | `applyCasePatch` | The ONE way to mutate `project.case` — direct assignment skips auto-population |

### Geometry worker — `src/workers/geometry/`

`ManifoldRuntime.ts` exposes `buildOp(op, check)` which executes a `BuildOp` against the Manifold WASM kernel. The `check` callback is called between ops and throws `CancelledError` when the build's generation has been superseded.

> **Note:** Mesh ops dedupe vertices at 1e-5 mm precision before constructing the Manifold. Without dedup, per-triangle STL vertex copies fail Manifold's 2-manifold check.

### Export worker — `src/workers/export/`

| File | Output |
| :--- | :--- |
| `stlBinary.ts` | `buildBinaryStl(meshes) → ArrayBuffer` |
| `stlAscii.ts` | `buildAsciiStl(meshes, solidName) → string` |
| `threeMf.ts` | `buildThreeMf(meshes, opts?) → ArrayBuffer` (fflate-zipped). Parts carrying `material` become one multi-material object plus a `Metadata/Slic3r_PE_model.config` sidecar (#168); with none, the output is byte-identical to a plain object-per-mesh file. |

### State stores — `src/store/`

| Store | Responsibility |
| :--- | :--- |
| `projectStore.ts` | The parametric `Project`. Wrapped in zundo `temporal` for undo/redo. |
| `jobStore.ts` | Latest build status, mesh nodes, mesh stats, last error, last diag, and the compiler's `splitOffer` (#148). |
| `viewportStore.ts` | UI-only viewport state (showLid/Grid, selectedPortId). |
| `settingsStore.ts` | App settings (port, bindToAll). localStorage-persisted. |

### Test API — `window.__caseMaker`

Activated by `VITE_E2E=1` or `MODE=test`. The full surface is documented in `src/testing/windowApi.ts`. Highlights:

- `getProject()`, `setProject(p)`, `patchCase(patch)`, `loadBuiltinBoard(id)`
- `getMeshStats(node)`, `getSceneGraph()`, `getLastDiag()`, `getJobError()`
- `triggerExport(format)` — triggers a download; intercept with `page.waitForEvent('download')`
- `serializeProject()` / `loadSerializedProject(json)` for save/load round-trips
- `undo()` / `redo()`, `cloneBoardForEditing()`, `addMountingHole()`, `patchPort(...)`
- `getSettings()` / `setPortSetting(port)` / `selectPort(id)`

> **Note:** Worker `console.log` does not reliably reach Playwright's page console. For worker-side observability use `getLastDiag()` and `getJobError()` instead.

## Adding a board template

Goal: ship a new built-in board (e.g. Teensy 4.1) so users can pick it from the dropdown.

1. **Create** `casemaker-app/src/library/boards/teensy-41.json`. Copy the structure from `rpi-4b.json` and fill in:
   - `pcb.size` from the manufacturer's mechanical drawing.
   - `mountingHoles[]` — each `{ id, x, y, diameter }` in PCB-local mm.
   - `components[]` — each port with `kind`, PCB-local `position`, AABB `size`, `facing` direction (`+x`/`-x`/`+y`/`-y`/`+z`).
   - `defaultStandoffHeight`, `recommendedZClearance`.
   - `source` — **mandatory for built-ins** — link to the datasheet PDF.
   - `builtin: true`.
2. **Register** the JSON in `casemaker-app/src/library/index.ts`:
   ```ts
   import teensy41Raw from './boards/teensy-41.json';
   const validated: BoardProfile[] = [..., teensy41Raw].map(...)
   ```
3. **Test:** `npm test` runs the zod schema validation. The strict schema rejects built-ins missing `source`. Add an E2E entry in `tests/e2e/board-swap.spec.ts` to confirm the board loads and produces a non-empty mesh.
4. **Document** the addition in `CHANGELOG.md` under the next phase.

## Adding a joint variant

1. Add a case to `JointType` in `src/types/case.ts`.
2. Add a `case 'your-joint':` branch in `buildLid` (`src/engine/compiler/lid.ts`).
3. (Optional) Add additive geometry in `ProjectCompiler.ts` if the joint needs shell-side features (sliding rails, screw posts, etc.).
4. Add a radio entry in `JOINT_OPTIONS` in `src/components/panels/CasePanel.tsx`.
5. Extend `tests/unit/joints.spec.ts` with an op-tree-shape assertion and `tests/e2e/joints.spec.ts` with a bbox/triangle delta assertion.

## Closure modes

Two ways for the lid to meet the case, selected by `seal.mode` (issue #117):

| `seal.mode` | Lid | Where the lid sits | Gasket |
| :--- | :--- | :--- | :--- |
| `'recess'` (default, and what an absent `mode` means) | a plate, `lidThickness` tall | drops into a pocket in the case rim, flush | channel in the rim, tongue on the lid underside |
| `'clamshell'` | a hollow box, same `outerX × outerY` footprint, `lidThickness + lidCavityHeight` tall | sits **on** the rim; assembled height is `outerZ + lid.z` | same channel/tongue, straddling the plane where the halves meet |

**`lidMode.ts` is the only place that decides.** Ten compiler modules used to ask
`params.lidRecess` directly, and `lidCavityHeight` separately; both readings now come
from one leaf module that imports nothing but `@/types`, so no two of them can
disagree. When `seal.mode` is absent — every project written before v13 — the helpers
return exactly what each module computed on its own before, which is why the change is
inert for legacy projects.

**A clamshell lid is a box by definition.** Asking for `'clamshell'` overrides
`lidRecess` (the two contradict) and floors the cavity at `CLAMSHELL_MIN_CAVITY`
(3 mm) when the user has not set one — otherwise `lidCavityHeight: 0` would quietly
produce the thin plate the mode exists to avoid. The existing `lidCavityHeight` control
*is* the lid-depth knob; there is no second one.

**A hollow lid moves the surfaces that attach to it.** Anything hung off the lid —
clamping posts, hinge knuckles, latch arms — must reach the inner ceiling at
`lidLocal.z = lidCavityHeight`, not `0`. Geometry that only *touches* its host is not
fused by Manifold and comes back as a separate body; both runs at this were #121 (lid
knuckles) and #125 (cavity-mode snap-fit), and clamping posts were the third (#117).

**The case side of that list (#263).** A case knuckle's centreline sits
`knuckleOuterDiameter/2` out from the wall, so its cross-section is *tangent* to the
outer face — a line, not a volume. On a clamshell the alignment flange happens to sit
behind that line and Manifold fuses the run; on a recessed lid the rim is a thin
upstanding band with nothing behind the knuckles, and the shell decomposed into the
body plus one loose knuckle per case position. `buildKnuckleCaseFairing` adds the
case-side mirror of #121's tab: a cube spanning exactly the knuckle's own u-length,
reaching `min(1 mm, wall/2)` into the wall and out to the knuckle axis, banded
±`knuckleOuterDiameter/4` about that axis. Each of those three bounds is load-bearing —
half a wall is what keeps the pad out of the cavity, half a radius is what keeps it
inside the cylinder's own silhouette, and the u-length is what keeps it from bridging
across the gap to the neighbouring knuckle. By construction the pad's top lands
`knuckleR/2` below the lid's seating plane, so it cannot foul the closed lid on any wall.

**The channel may not consume the wall it is cut into (#264).** A gasket as wide as
the wall leaves no material outboard (or inboard) of the cut, and on a recessed-lid
case that cut is the only thing joining the rim band to the body — the shell compiled
to a body plus a floating ring. `computeSealRing` now clamps the requested width to
`wall − 2 × MIN_SEAL_WEB` (0.4 mm, one nozzle width) and centres the ring in what is
left, so a channel always has a web on each side. The gasket body and the lid tongue
are built from that same clamped `ringWidth`, so all three stay consistent. 0.4 mm and
not a larger web because `wallThickness` defaults to 2: a bigger floor would clamp the
default gasket to nothing and put the feature back to being silently inert.

The clamp also fixed a second silence: with the stock 2 mm wall and the 4 mm gasket
`defaultSeal()` used to return, the ring was null and ticking "Waterproof gasket" cut
no channel at all with nothing on screen saying so. It now cuts a 1.2 mm channel and
says so.

**The panel reads the same arithmetic.** `sealFitNote()` answers "what will this
gasket actually be?" — `null` when the request fits as asked and the tongue survives
the clearance, otherwise the requested vs delivered width, the web, the wall that would
deliver the request, and whether the tongue was eaten. `CasePanel` renders it as an
amber note under the field; the geometry consults the same functions, so the sentence
and the solid cannot disagree.

## Print bed, alternatives and split parts

**The bed lives on the `Project`** (`project.printer?: PrinterVolume`), not on an
archetype. Until #148 the only copy was `case.rack.printer`, which meant a case or a
badge could not be fit-checked at all. Read it through `resolvePrinter(project)`
(`rackFit.ts`), which falls back to `case.rack.printer` so projects saved before the
move keep working; never read `project.printer` directly. A preset stores its numbers
(`x`/`y`/`z` are authoritative, `preset` is only "which row filled them in"), so a
project keeps its bed when a preset's figures change. The picker is one component
(`components/ui/PrinterField.tsx`) rendered in both RackPanel and the export modal, so
the two homes cannot drift; `DEFAULT_PRINTER` (the XL a fresh rack starts on) lives
next to `PRINTER_PRESETS` in `rackFit.ts`, derived from the table rather than restated.

**`NodeVariant` marks a node as an ALTERNATIVE**, not a part of its own
(`types/variant.ts`): `{ replaces: string[]; label: string }`. Two things produce one —
the rack welded into a single piece (`isAssembledNodeId` predates the flag and is kept
as a fallback) and a shell cut into bed-sized pieces. `isAlternativeNode(node)`
(`exporters/parts.ts`) is the single predicate: the viewport (`SceneMeshes`,
`viewportCamera`), the parts list (`PartsMenu`) and Save All (`exportTrigger`) all skip
alternatives — they sit exactly on top of the part they replace — while the export
modal still lists them by name. The uncut part is never removed.

**The offer is the ENGINE's answer.** Every compile in which the shell does not fit
the bed — in footprint or in height — reports `plan.splitOffer`
(`{ state, pieces?, screws?, screwLabel? }`), which the JobScheduler carries to
`jobStore.splitOffer` and the export modal renders. `state` is one of `available`,
`tooTall`, `sealed` or `blocked`. This is the fourth state that matters: the box can
overrun the bed and still have **no legal seam** — the rpi-4b on a 60 × 60 bed is
exactly that, its board bosses leaving no line across the depth — so the modal is
forbidden from deriving the offer from the mesh bounds it can see. Measuring the box
only says "over the bed"; whether a seam exists depends on the case's own keep-outs,
which only the compiler holds. **Deciding is cheap and building is not**: the whole
decision — bounds (`aabbOfOp` never evaluates Manifold), keep-outs and seam placement
— is metadata arithmetic, so it runs on every compile, while the cuts and laps stay
behind `case.splitForPrint`. The heights are reported even when the footprint fits: a
body that will not print is worth saying out loud.

**Splitting is offered, never automatic.** `compiler/splitPart.ts` is
archetype-blind: given a solid in print orientation, its `Aabb`, the bed and a list of
keep-out `Aabb`s, `planSeams()` decides *where* to cut and returns null rather than
guessing. It refuses a part taller than the bed (a seam is vertical — Z is not ours to
cut), cuts the axis that overshoots more when one seam will do, goes to a quadrant only
when a half still will not fit, and walks the seam off a keep-out by `KEEP_OUT_MARGIN`
while keeping both pieces at least `MIN_PIECE_SPAN` long. Each candidate layout is
checked with `rectFitsBed`, the rack's own fit test, so a piece that only fits
diagonally is accepted exactly as the rack accepts one. `splitBySeams()` does the cut
with one intersection per grid cell and returns each piece's `cell` and `ranges`.
`seamScrewCount()` is `ceil(length / SPLIT_SEAM_PITCH)` with a floor of two — the
reviewed systems' own counts track the seam (7 on a ≈250 mm housing seam) and so does
this. Both halves of a joint go through `jointClearanceHole` / `jointStarterHole`, so
the clearance, the pilot and the head seat are always the shared table's.

**The archetype supplies the joint's material**, because only it knows which side of
its own solid is free air. `compiler/shellSplit.ts` is the case shell's half, and it is
split in two for the same reason the compiler is: `planShellJoint()` answers *what the
joint would be* — seams, pieces and one `LugSite` per screw per piece — with no
geometry at all, and `buildShellSplit(req, plan?)` turns that plan into the ops. The
compiler calls the planner on every compile to decide what to offer and hands the plan
to the builder when the split is actually asked for, so the offer and the geometry
cannot disagree about where a screw goes. The joint itself: a row of
lugs on the **underside of the floor**, each straddling the seam — the low piece
carries the clearance hole with a flush head seat, the high piece a blind pilot, and
one M3×16 socket cap pulls them together (16 mm under the head = 8 through + 8
engaged, and `minEngagement('M3') = 6 ≤ 8`). Under the floor is the only side of a
shell that is always empty: the cavity is the board's, and the walls hold the PCB to
within a hair. The lap therefore hangs `LUG_DROP` below the floor and is embedded
`LUG_EMBED` into it so the union has real volume (the #119 lesson). **The whole thing
is PROVISIONAL** — every number in that module is CHOSEN and unmeasured, which is why
the split is behind `case.splitForPrint` and refused outright for a sealed shell
(`canSplitShell`): the seam cuts the gasket channel and gives away the drop resistance
#107/#108 were for. Pieces print **as modelled** — floor on the bed, laps hanging
below, support from the build plate — which the part's own row in the export list
says; it is a `PRINT_PATTERNS` entry, not a `PRINT_TABLE` key, because split ids are
dynamic. The lid is not offered a split yet: its underside faces the board, so "which
side is free" depends on the board's height.

## Op tree shape

The compiler produces a top-level `BuildPlan = { nodes: [{ id, op }] }`. Each `BuildOp` is one of:

| Kind | Shape |
| :--- | :--- |
| `cube` | `{ size: [x,y,z], center? }` |
| `cylinder` | `{ height, radiusLow, radiusHigh?, segments?, center? }` |
| `translate` | `{ offset: [x,y,z], child }` |
| `rotate` | `{ degrees: [x,y,z], child }` |
| `scale` | `{ factor, child }` |
| `mesh` | `{ positions: Float32Array, indices: Uint32Array }` |
| `union`/`difference`/`intersection` | `{ children: [...] }` |

`mesh` ops carry transferable typed-array buffers; the worker client uses `collectMeshTransferables` to enumerate them so Comlink can pass them zero-copy.

## Screw holes

Every screw hole in the project comes from `fasteners.ts`. Before it, each
compiler module hand-rolled cylinders and carried its own constants, which is
how the same M5 ended up with two head-recess depths by two rules and a
byte-identical duplicate of its own clearance diameter.

A screw hole has three parts, and they are not interchangeable:

| Part | Function | Sized to |
| :--- | :--- | :--- |
| Head recess | `screwHole({ head, recess })` | The head — counterbore for cap/button, a 90° cone for countersunk |
| Clearance hole | `screwHole({ through })` | Pass the **thread**, and no more |
| Receiving hole | `screwStarter({ depth })` | **Hold** — a starter hole to tap, or a modelled thread |

Confusing the last two is the classic way to build a joint that assembles
perfectly and holds nothing.

### The table

Keyed on size (M2–M6). Major diameter and coarse pitch are ISO 261; the basic
internal minor is D1 = D − 1.0825 × P from the ISO 68-1 form; clearance grades
are ISO 273; head geometry is ISO 4762 / 7380-1 / 10642 / 14583. Two things are
ours rather than a standard's:

- **A `located` clearance grade**, tighter than ISO close (M5 → 5.2, not 5.3).
  These holes locate as well as pass; slack in them is a shelf sitting crooked.
- **Measured head dimensions** where they differ from nominal. The M5 button
  heads in hand are 9.2 × 3.0 against a 9.5 × 2.75 nominal, and 0.3 mm of head
  diameter is most of the wall left outboard of a counterbore.

**Pilots have two columns, not one.** `pilotMachine` is for a 60° metric machine
screw driven into plastic; `pilotForming` is the ~0.8 × major rule for
thread-forming screws (Delta PT and friends). Collapsing them into a single
"pilot for M5 in PLA" is exactly the mistake that produced the original bug in
issue #140: the 0.8 rule predicted 4.0–4.3, and a printed coupon came back at
**4.8**. A machine screw at 4.0 does not form thread in PLA, it splits the boss —
the failure mode is the part cracking, not the thread shearing. `npm run
pilot:coupon -- M3` prints the ladder for another size; M5 is the only one that
has been driven.

### Modelled threads

`screwStarter({ mode: 'pre-threaded' })` cuts a real helical thread instead of a
starter hole, so the screw turns into an existing thread rather than cutting
one — which is what survives repeated assembly.

It needs no new primitive. `extrude` already carries `twistDegrees`, so a 2D
profile of "circle at the minor radius, plus one tooth" traced through 360° per
pitch sweeps the whole thread in one op. The tooth is drawn in POLAR form, angle
standing for axial position, which makes the 60° flank exact rather than
approximated. Positive twist is a right-hand thread — pinned by test, because a
left-hand one passes every volume and bounding-box check ever written.

**It is not available at every size, and the limit is PITCH, not diameter.** The
female thread's crest is a wedge about a quarter-pitch wide; below roughly two
nozzle widths there is nothing for the slicer to lay down, and the "thread"
prints as a smooth bore at the major diameter — which holds *less* than the
starter hole it replaced. `preThreadPrintable()` gates it at pitch ≥ 2 × 0.4 mm,
so M5 and M6 qualify and M4 down does not; asking for `pre-threaded` below the
line quietly gets you `self-tap`.

`THREAD_FIT` — the radial clearance between the modelled thread and the screw —
is the one number here that has **not** been printed. `npm run thread:coupon`
prints a ladder of fits for exactly that reason. Until one comes back, no
structural joint should move from `self-tap` to `pre-threaded`.

## Interior grids

`holeGrid.ts` draws a lattice of square sockets into any 2D outline;
`dividerPegs.ts` builds the drop-in parts that land in it (#150). Both are
primitives — they take an outline and parameters and return a `Profile` or a
`BuildOp`, with no host of their own.

**The numbers are measured, not chosen.** The reviewed ToolStack system's
drawer floors carry **5.0 × 5.0 mm sockets on a 12.0 mm pitch**, both axes,
measured on a physical unit (`/Toolbox.md`, "Interface 3 of 3"). Pitch and
socket are dimensions of that part, so copying them is fair.

**The fit is not measured, and it is labelled as such.** `PEG_TENON_FIT`
(0.3 mm, socket minus tenon) and `PEG_TENON_BOTTOM_GAP` (0.4 mm) are ours, and
neither has been printed here. They are the two numbers in `dividerPegs.ts`
marked PROVISIONAL; #153's fit variants are where they should get a measured
value. Everything else in the module is derived from the grid.

**Widths are quoted in hole spans**, which is how the source system quotes
them. `pegWidth(spans, pitch, ear)` is `(spans − 1) × pitch + 2 × ear`, with
`PEG_WIDTH_EAR = 4.8` derived from the measured pegs — 21.6 spanning 2 holes and
33.6 spanning 3 both give 4.8. The 5-hole peg measures 56.6, which the same rule
would put at 57.6; the 1.0 mm discrepancy is recorded in the constant rather
than averaged into it, and pinned by a test.

**Anchor the lattice at the outline's bbox, never its centre.** A bbox-anchored
lattice is stable: growing a cavity by a few millimetres adds sockets at the far
edge and leaves every existing one exactly where it was, so a divider printed
for it yesterday still fits. A centred lattice shifts by half a pitch whenever
the cavity grows an odd number of millimetres.

**Host status.** Neither module has a caller yet, deliberately. The two hosts
the issue names are both blocked: the rack cable tray is 4 mm and already fully
drained by its lightening lattice, and the case floor is auto-sized to the PCB,
so the board footprint and its bosses leave only the `internalClearance` margin
— on a stock 0.5 mm there is nowhere to put a socket. The host that actually
wants a bare gridded floor is the toolbox archetype, which is still a go/no-go
(#155); shipping the host-less primitive is what lets that decision be made
with something in hand.

## Fit coupons

Every fit-critical interface can be printed on its own before the part that uses
it — the lesson of #140, where arithmetic sent the M5 pilot to 4.0–4.3 mm and a
printed coupon came back at 4.8. `fitCoupons.ts` is the registry;
`npm run fit:coupon` renders all of it, `npm run fit:coupon -- <id>` one of it,
and `--list` prints the ids.

| id | settles |
| :--- | :--- |
| `magnet-6x2`, `magnet-8x3`, `magnet-10x2` | the magnet pocket diameter, as a clearance ladder cut in two print orientations |
| `board-snap` | the two-jaw board clip, with a PCB-edge gauge as a second printed body |
| `insert-pocket` | the tool-insert pocket's `clearance` and `chamfer`, as two ladders of Ø10 pockets in one bar |

**A coupon is not a redrawing.** Each one is built from the same builder the
compiler uses — `magnetPocket`, `buildBoardSnapOps`, `roundPocketCutter` — so a
coupon cannot certify a feature the compiler no longer draws. That is also why
the coupon geometry lives in `src/` rather than in the script that writes it.

**Printing one is the measurement.** The code does not adopt the winning rung;
the operator prints, drives or measures, reports back, and a follow-up flips that
number to measured. Every coupon therefore carries a PROVISIONAL note naming what
is still a guess.

## CI

Three workflows in `.github/workflows/`:

- `ci.yml` — lint + typecheck + Vitest + production build, matrix Node 20/22 on ubuntu-latest. Triggered on every PR + push to main.
- `playwright.yml` — E2E suite with chromium + SwiftShader for deterministic WebGL. Uploads HTML report on failure.
- `windows-installer.yml` — runs on `windows-latest`, installs Rust, generates platform icons, builds Tauri MSI + NSIS bundles, uploads as artifacts.

## Performance notes

- **Manifold ops are synchronous inside WASM.** Cancellation via the generation counter only fires *between* ops. A single very large boolean still blocks until done.
- **Worker count:** one geometry worker, one export worker. A pool wouldn't help since rebuilds are latest-wins.
- **Bundle:** main app code is ~53 KB; Three.js is the bulk at 896 KB (gzip 239 KB). Code-splitting is configured in `vite.config.ts` `build.rolldownOptions.output.manualChunks`.
- **Debounce:** slider drags are 200 ms trailing-debounced. Discrete actions (button clicks, board swap, port drop) dispatch immediately.
