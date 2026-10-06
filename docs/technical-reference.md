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

The compiler is 40 modules. Grouped by what they build:

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
| `seal.ts` | `computeChannelAndTongue`, `computeSealRing`, `buildSealChannel` | Gasket channel + tongue for sealed cases |
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
| `rackFit.ts` | `rectFitsBed`, `rackPartFootprints`, `maxRackWidthForBed` | Printer-fit checks: does every rack part land on the bed? |
| `stand.ts` | `computeStandDims`, `buildEdgeChannels`, `standModulePlacement` | Desk and bench stands |
| `rugged.ts` | `buildRuggedOps` | Corner bumpers and impact ribs |
| `mountingFeatures.ts` | `buildMountingFeatureOps`, `endFlangesPreset`, `fourCornerScrewTabs` | How the finished case attaches to the world: tabs, flanges, VESA |

**Layout and guards**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
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
| `jobStore.ts` | Latest build status, mesh nodes, mesh stats, last error, last diag. |
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
