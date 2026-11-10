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
| `magnets.ts` | `buildMagnetOps`, `resolveMagnets`, `magnetFactsForProject`, `buildNameplateLocal`, `nameplateNodeId` | Issue #152 — `case.magnetPockets` (a row of `count` pockets at (u, v) on a face, `+z` into the lid) and `case.nameplate` (a separate `nameplate-<face>` part carrying text through `textLabels.ts`' `centredTextOutline`, with pockets on its back at the same world centres as the case pockets behind it). A wall thinner than skin + pocket + 1 mm backing gets an inside boss (pocket Ø + 3.2). `captured` closes the pocket with a 0.6 mm skin and states the pause height; it is only possible where the pocket axis is vertical as printed (floor, lid), so a side-wall `captured` is cut open for glue and says so. Every list is empty for a project without magnets, so its plan is byte-identical |

**Whole-product archetypes**

| Module | Exports | Purpose |
| :--- | :--- | :--- |
| `rack.ts` | `buildRackNodes`, `computeRackDims`, `accessorySpaces`, `cableNotchGeometry` | The parametric mini-rack: sides, plates, shelves, trays, faceplates. See [Mini-Rack.md](https://github.com/SlyWombat/CaseMaker/blob/main/Mini-Rack.md) |
| `rackFit.ts` | `rectFitsBed`, `resolvePrinter`, `rackPartFootprints`, `maxRackWidthForBed`, `PRINTER_PRESETS` | Printer-fit checks: does every rack part land on the bed? Also the one place the project's bed is read (`resolvePrinter`) and the test every split layout is judged by |
| `stand.ts` | `computeStandDims`, `buildEdgeChannels`, `standModulePlacement`, `computePocketDims`, `buildPocketOp` | Desk and bench stands — and (issue #151) the `mount: 'pocket'` wall shelf: one part, a back plate with a screw ear each side, a floor and two walls the finished module nests into, sized from the module's own envelope and sharing `rack.ts`'s wall-fixing sizes |
| `insert.ts` | `buildInsertNodes`, `buildInsertOp`, `insertGrid`, `insertLayout`, `insertProblem`, `pocketRadius`, `roundPocketCutter`, `retentionOf`, `magnetDepth`, `magnetFloorThickness` | Issue #158 — the tool-insert holder: one plate of round (socket-OD) and hex (across-flats) pockets on a centred uniform grid, sized to the user's own tools. Plate 120 × 80 × 6 by default, with `clearance`, `chamfer`, `floor` and `pitchGap` all exposed; the pocket layout is pure and wasm-free, so only the subtracted solid needs an evaluator. `roundPocketCutter` is the round pocket as a standalone primitive, so the `insert-pocket` fit coupon cuts the shipped pocket instead of a copy of it. Issue #262 — `retention: 'magnet'` cuts a disc pocket under every pocket with `fasteners.ts`'s `magnetPocket` (#152), downward from the pocket's floor so the disc finishes flush with the surface the tool rests on. `magnetFloorThickness` (deepest pocket + disc + a 1 mm web) is the budget `insertProblem` reports, and a plate too thin for it skips the cut rather than breaking through its underside |
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

`exportTrigger.ts::exportFitGrade` decides whether a name carries a print-fit grade (#153, step 6). It mirrors `compileProject`'s dispatch — a rack reads its own `rack.fit`, a shell reads `case.fit` and only when a relieved snap interface is in play — so a name can never claim a grade the export does not have (`tight` is silent, and a stand/badge/insert never carries one). The same grade reaches the `-PRINT-NOTES.txt` sidecar, which spells out what it means.

### State stores — `src/store/`

| Store | Responsibility |
| :--- | :--- |
| `projectStore.ts` | The parametric `Project`. Wrapped in zundo `temporal` for undo/redo. |
| `jobStore.ts` | Latest build status, mesh nodes, mesh stats, last error, last diag, and the compiler's `splitOffer` (#148). |
| `viewportStore.ts` | UI-only viewport state (showLid/Grid, selectedPortId). |
| `settingsStore.ts` | App settings (export format/layout, fixtures, house margins, tool picks, machine calibration). localStorage-persisted. **Not** the server port or LAN bind (#372): those are read by `lib.rs` from `config.rs`'s `config.json`, so the settings dialog reaches them over `/api/v1/config` (`platform/houseClient.ts`) instead of keeping a copy here nothing on the Rust side could see. |

### CNC machine, fixtures, beds and 3D surfacing

The CNC side keeps its own records, and the rule is the same as the compiler's: **a number that a
machine or an accessory owns lives on its record, never hard-coded in a screen** (#448/#451).

| Module | Purpose |
| :--- | :--- |
| `engine/cnc/machine.ts` | `MillProfile` and the `MACHINES` table (the Z1 today): the work `envelope` (machine coordinates), the spindle `maxRpm`, `safeZ`, the rapid model and the holder geometry. Every clamp, ceiling and lift a screen or the post reads comes from here — `insideEnvelope`, `one(...)`'s clamps and `rapidEstimate` included. |
| `engine/cnc/fixture.ts` | The Z1 low-profile vise as a set of **labelled constants** (jaw bar, ledge step/width, body/floor depth) plus the per-record read (`num(fixture.unit, …)`) a `FixtureRecord` can override. The two PROVISIONAL numbers (body floor depth, the finishing step-over's source) are named as such, not dressed as measurements. |
| `platform/locationClient.ts` | The location document's typed records: `MachineRecord` (address, bed profiles, finished programs), `FixtureRecord` (an accessory's `constants` vs this unit's `unit` measurements, with `provenance`), `BedProfile` and its four `datums` (`surfaceTopZ`, `viseJawTopZ`, `bracketSeatZ`, `rotaryAxis`), each `MeasuredDatum` carrying value, date and instrument. |
| `platform/bedProfiles.ts` | `switchActiveProfile` and `changedBedProfile` — the Machines card's Bed block actions: switching names a different saved description, "I changed the bed" copies the active profile into a new dated one with its dependent datums cleared and listed. Neither ever sends a machine command. |
| `engine/cnc/engrave/goalHeightfield.ts` | `sampleGoalHeightfield` turns a **goal mesh** (#534) into a top-Z heightfield — one top-Z per cell, undercuts unrepresentable. Planning now goes through `cam/model` (#966); this sampler survives as the goal-check/coverage/thumbnail machinery's own measurement of the mesh, not a CAM stage. |
| `engine/cnc/engrave/runProgress.ts` | The run's progress words, shared by the status strip and the Cut step: `remainingSeconds` (elapsed × (100 − percent) / percent — in land15 the `P:` figure it reads is NOT true seconds, so the time is a rough guide and #1145 corrects the read), `runningProgramWords` (the controller's percentage and its approximate time; "finishing" at 100 %; a paused run states the time is what is left when it resumes; no percentage yet says so), and `nextBitChange` (the next program in cut order needing a different cutter, skipping the machine's finished ones). |
| `engine/cnc/rendererBits.ts` | The planner's memory guard (#1124): bitness `32` is refused immediately with `BROWSER_32_BIT_SENTENCE` before any probe; a startup address-space probe that fails is retried once after 2 s, and both failing keeps the verdict `checking` with Generate available (never a refusal on a healthy browser); a Generate pressed after a failed probe re-probes and WARNS (`BROWSER_MEMORY_SHORT_WARNING`) rather than refusing. The run's own allocation failure maps through `components/panels/runErrorWords.ts` to `PLANNER_OUT_OF_MEMORY_SENTENCE`. |
| `engine/cnc/bedScene.ts` | The viewport's machine-frame picture of the bed + fixtures (the `BedScene` the Bed block renders), drawn from the same records and constants — not hand-placed. |
| `platform/machineVacuum.ts` | The machine's own outputs had a bench test on 2026-11-09 (the nozzle, one code at a time): the **vacuum** is the direct output `M851`/`M852` and the **air at the spindle** `M811`/`M812`; the program's `M331`/`M332` are inert *auto modes* that follow the spindle. `VACUUM_ON`/`BLOW_ON` name the direct pair; the antistatic keeps `M331.4`/`M332.4`. Only an Idle machine with no running job (the `P:` percent read off the same status line) is switched. |
| `components/manage/machineOutputs.ts` | Which output rows the machine card shows, from the PROFILE: on the Z1 the external output drives the vacuum (one row, named for both), and the wireless-probe charger row is hidden — nothing is wired to it. |

### The model engine — `src/engine/cnc/cam/model/`

The CNC planner is the model-driven engine (#956/#966): a goal mesh or STEP is planned from a
cutter-location surface, never from a heightfield. The design record is
`docs/design/cam-model-engine.md`; `plan.ts` is the one entry point.

| Module | Purpose |
| :--- | :--- |
| `cam/model/plan.ts` | The one entry point, `planModelCam`: features → CL surface → ops → sequence → linking → post, per setup (§3.0 of the design record). |
| `cam/model/types.ts` | The `ModelPlanInput`/`ModelPlanOutput` fields with no other home; `CutterCandidates` stays `sequence.ts`'s. |
| `cam/model/features.ts` | Planar-face recognition (#958): pockets, islands, contour, rims and the curved remainder from a STEP or mesh. |
| `cam/model/clsurface.ts` | The cutter-location surface by drop-cutter (#957) — the surface every op reads. |
| `cam/model/dropcutter.ts` | The exact CL height a flat, ball, bull or V cutter reaches at one (x, y) against the triangles. |
| `cam/model/triangleBins.ts` | The spatial bin that keeps the drop-cutter's triangle query cheap. |
| `cam/model/rowDropper.ts` | Adaptive drop-cutter sampling along a raster row (the path side of §2). |
| `cam/model/ops/` | The operation set: `pocket.ts`, `contour.ts`, `rough.ts`, `rest.ts`, `finish.ts`, `pencil.ts`, `chamfer.ts`, and `rasterMask.ts` (the grid→loop stitching both masks need). |
| `cam/model/finishMask.ts` | The finish's per-point leftover rule and its ball footprint (#970). |
| `cam/model/sequence.ts` | The cutter sequence chosen by cost (#961), with the rank row's stated key. |
| `cam/model/linking.ts` | Stay-down linking, the region tour and the shared op/material contract (#962). |
| `cam/model/rideTest.ts` | The ride test a join uses over a cut surface (#962). |
| `cam/model/pickAmongEquals.ts` | The ball rank's tie: the reach-margin gate first, then the canonical key (#1111). |
| `cam/model/settings.ts` | The engine parameters the stages read as settings, not constants (#959/#960). |
| `cam/model/setups.ts` | Multi-setup planning on the model engine (#965). |
| `cam/model/twoPlans.ts` | The owned plan and the ideal plan, each planned from its own set (#975). |
| `cam/model/tradeoff.ts` | The owned-versus-ideal tradeoff line, stated only when it is material (#975). |
| `cam/model/wholeSurface.ts` | The whole-surface union across `perSetup` (#965). |
| `cam/model/planMeta.ts` | The plan's per-op recorded metadata, checked against its own moves (#1025). |

### The goal check — SIMULATOR_VERSION 8

A posted program is **stamped** onto the goal's heightfield and the gate reads two numbers side by
side: the **raw** share cut deeper than 0.01 mm and the **adjudicated** share after the cells a
heightfield cannot judge are excused **on proof** — every excused class counted and printed beside
the verdict (#948/#964/#970/#996/#1064/#1086/#1092). v8's proofs are the **per-cell relief bound**
(no excuse may forgive deeper than the goal's own local relief), the **silhouette proof** with its
**inward witness** (every covered part-side neighbour untouched) or the CL-distance test, the v6
straddling proof for wall and border cells, and the edge-break band seeded from the design
silhouette ∪ the grid border. There is **one oracle**: the receipt's goal block is the verdict;
`goal_check.py` is a diagnostic and is never quoted as the number. The rule and its version ladder
are frozen on `docs/design/goal-check-gate.md`; `tests/unit/goalRuleFreeze948.spec.ts` pins the
fingerprint, and `cncGuide.spec.ts` holds every diagnostic code to its guide row.

### Program files and the owned set

`releaseFileName(stem, index, total)` (`engine/cnc/engrave/runSheet.ts`) is the **one** naming
function — Save, Save all, the run sheet, the release store, the run record and the CLI all read
it. A single-program run keeps `<stem>.nc`; a multi-program run is `<stem>-p<n>.nc` with the index
**zero-padded to the width of `total`** (`p1…p5`, `p01…p19`), so the machine's file list sorts in
cut order. The owned plan is planned from the owned set — `inv:` + `user:` + the chosen tool,
built-ins only when the inventory is empty, `cat:` never (#1041) — and both the app and the CLI
see one list in a canonical order (#1111). A **bit change is priced from the program before it** (#1114, the
maintainer's decision): `bitChange.attendedMinutes` (rec. 5), `attendedChangeSeconds` (rec. 120),
`walkAwayMinutes` (rec. 30) and `returnMinutes` (rec. 15), with a smooth 3t² − 2t³ rise between —
plans compete on the priced cycle. Ties after price go the **reach-margin gate**
(`fluteLength − deepest cut ≥ reachMarginMm`, shop setting, recommendation 1.0 mm), then the
shortest sufficient flute, the larger diameter, the lower priced stage and the key — ONE
`pickAmongEquals` at every site, and every same-diameter pick states its decider.

### The Cut step — the run's package, checklist and records

| Module | Purpose |
| :--- | :--- |
| `engine/cnc/engrave/package.ts` | The FROZEN package the Cut step runs. **Staleness is a comparison, not a timer**: a program is stale only when something that changes its BYTES has changed (the design, the stock, the cutter). `fingerprintView` strips the non-byte job fields (`planChoice`, `blowWithVacuum`, and #1127's `cutterChecklist`) and fingerprints the RESOLVED setups minus their registrations, so an implicit setup and the same setup materialised by an approval are one plan; `setupApprovalDrift` detects a package whose frozen setups lag the job's registrations while the bytes still match, and the store re-freezes them at the write (same programs, same key, no worker). A stale package is kept, not deleted: it says what reserved it and when, and the card names the run's moved input before the press. `lastGenerateMs` rides the run record so the Cut card can say "Regenerate (the stock changed)" with no number until a Generate has been posted. |
| `job.cutterChecklist` | The run's cutter checklist (#1127): keyed by the frozen package's hash (one checklist per run), then by cutter key, with `located` or `replaced` (another OWNED cutter of the same shape and cutting diameter; the shank is stated when it is not the machine's ⌀3.175 standard). It is **not a byte input** — stripped from `fingerprintView`, so a tick never stales a program and never calls a worker. The gate is the **first Load**, in all three places it happens (the one-press Cut, the single-file upload, the multi-program release), and it joins each chain LAST so a more specific registration or facing sentence speaks first. `replaceCutter` IS a byte input: it writes the job's tool and every setup's tool list, clears the substitution and stales the package, so Generate re-posts the WHOLE run with its cost before the press; `migrateCutterChecklist` follows that regenerate. |
| `machines[].registrations` | The registration survives a reload on the MACHINE record (#1123 item 40): one memo per job setup (the #1088 setup id and the Cut screen's 1-based index) carrying the plan, the outcome, `measuredAt` and the G54 X/Y the `G10` wrote. The Register card restores it only while the controller's live work offset (`MPos − WPos`, #933) still matches the written X/Y within 0.01 mm; a moved G54, an unreachable machine, a line without both positions or another machine's answer restores nothing and says **register again**. Z is not checkable honestly (the written Z is the cutter's PRB reading; the live offset's Z carries TLO), so the restored line states its scope: *G54 X/Y verified at ⟨time⟩; Z as written then*. The field is `Option<serde_json::Value>` in `location.rs`'s machine record (as-sent, omitted while absent), and `house.rs` keeps a stored memo when a later machine PUT omits the key. |
| `store/engraveReleaseStore.ts` | The release step's ONE owner of a multi-program run: it names every file in cut order (marking the ones the machine's record says it finished), uploads the whole list before the first cut, plays them one at a time through `machineRunStore`, stops between files for the bit change, and keeps the resume point. After a reload `releasePrograms` reads the finished hashes again, so the next press names the program still to cut. |
| `engine/cnc/registration/plan.ts` / `summary.ts` | A BRACKET job registers on **one top touch at the cut area's centre** (#1133): the bracket fixes X, Y and rotation (repeat 0.05 mm, fit 0.1 mm), so XY is the anchor plus the bracket's offset and nothing scans an edge (`bracketConfirm` is accepted and ignored). `summarizePlan` drops the whole "then scan … — bracketing each edge and bisecting …" clause when `plan.scans` is empty: the narration is the surface touch and the homing, and the old "no edge scan" word list is gone. |

### Test API — `window.__caseMaker`

Activated by `VITE_E2E=1` or `MODE=test`. The full surface is documented in `src/testing/windowApi.ts`. Highlights:

- `getProject()`, `setProject(p)`, `patchCase(patch)`, `loadBuiltinBoard(id)`
- `getMeshStats(node)`, `getSceneGraph()`, `getLastDiag()`, `getJobError()`
- `triggerExport(format)` — triggers a download; intercept with `page.waitForEvent('download')`
- `serializeProject()` / `loadSerializedProject(json)` for save/load round-trips
- `undo()` / `redo()`, `cloneBoardForEditing()`, `addMountingHole()`, `patchPort(...)`
- `setExportLayout(mode)` / `selectPort(id)`

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

## Stacking connector

`stackConnector.ts` (#149) joins two separately printed parts — one case
stacked on another, or a case on a base plate that carries the same socket. It
is clean-room: the behaviours come from the ToolStack review in `/Toolbox.md`
("Interface 2 of 3"), the numbers are ours (`types/stackConnector.ts`), and no
compatibility with any reviewed product is claimed.

**The socket** is a pad standing `STACK_PAD_PROUD` (4.2 mm) off a side wall,
`STACK_PAD_W` (22 mm) wide, with a vertical 45° dovetail channel cut into it:
3.0 mm deep, 14.0 mm across the floor, 8.0 mm across the mouth. The channel's
floor is 1.2 mm of pad backing, so nothing the socket cuts reaches the wall.
Bottom to top on a wall of exterior height H:

| z | what | why |
| :--- | :--- | :--- |
| 0 → 12.5 mm | receiving pocket, open at the bottom | takes the key half standing proud of the part below |
| 3.0 mm | over-insertion stop | a key pushed home bottoms here, flush with the top |
| → H | storage channel, open at the top, one key long + 0.5 mm | the key enters here, parks half-proud, or stores flush |

H is the shell's height plus the lid's when the lid sits ON the rim (the pad and
channel continue through the lid's edge); a recessed lid leaves the socket in the
shell. A short wall loses the flush storage first (stated, with how far a stored
key stands proud), then the pocket (stated: the case can only be the lower part),
and only below 15.5 mm is no socket cut. Both open ends carry a 1 mm 45° lead-in
on the lips and a seam notch in the floor backing; two stacked parts' notches make
one V-groove at the seam, which is where the key's bump clicks.

The channel is vertical, so the joint locks the parts against sliding apart and
against peeling off the wall; lifting off is resisted only by the detent. That
is also why a lid the socket spans still lifts straight off. Registration — the
stack sitting square — is a separate feature, not the key's job.

**The key** (`stack-key-N` nodes, category `fastener`) is the socket's section
moved `clearance` off the floor and both flanks, with a web through the mouth
standing 1.5 mm past the pad face as the grip. `short` is 24 mm (12 mm in each
part); `long` adds 16 mm between the halves to bridge a gap such as rugged feet.
The leaf spring is a 1.0 mm beam over a 2.0 mm window with 1 mm slits either
side, so it is held only at its ends; a 0.8 mm bump with 45° flanks sits 12 mm
from each end (one bump at the middle of the short key). The beam's free span is
20 mm; the fixed-fixed estimate of its peak strain at full deflection is 2.4 %,
inside PETG's elastic range and near the edge of PLA's — an estimate, not a test.
The key is built lying flat, grip face on the bed: the flanks lean out at 45°
going up and the beam bridges its window, so it needs no supports.

**Fit.** The gap per face is `STACK_SLIDE_CLEARANCE` (0.15 mm, ours, unprinted)
plus the fit rung's relief (`tight` 0, `standard` 0.10, `loose` 0.25 mm), from
`stackConnector.fit` or, when that is absent, the case's `fit`. The relief goes on
the KEY — the reverse of the snap catches — because a socket is part of a printed
case and a key is a 2 g reprint: one socket serves every rung. A relieved key's
bump grows by the same amount, so its tip still reaches 0.8 mm past the floor and
the click still lands. All of it is PROVISIONAL until the `stack-connector` fit
coupon is printed.

**Inform, don't refuse.** Each socket — its pad (with the half-wall embed) and
the key's grip out of the mouth, as real solids — is checked through the shared
clash check (below) against the features already on that wall: port cutouts,
vents, bosses, the hinge, latches, magnet pockets and their bosses, the
nameplate, the floor grid, mounting features, fans, the display opening, labels,
antennas, snap catches, the rugged ribbing, the alignment brim, custom cutouts
and the board clips. A clash is stated and the socket is still cut where it was
put; the statement offers the nearest shift along the wall (0.5 mm steps) that
clears everything. The shifts are found in one test per keep-out: each socket box
is swept along the whole wall, intersected with the keep-out, and the overlap's
pieces are projected back onto the wall as blocked intervals. When only the brim
or ribbing blocks every shift, the offer is a pad cut-out instead
(`StackSocket.cutThrough`, `stackPadCutouts`): the pad's width plus 0.5 mm each
side is subtracted from the brim and rib ops — never the shell — so the wall and
the seal are untouched. Statements travel on `BuildPlan.connector` to
`jobStore.connector` and the Features panel.

### The shared clash check

`interiorClash.ts` answers "does feature A intersect feature B, how much, and
where" on the real geometry, for the magnets, the dividers and the connector
(`caseClashes.ts` assembles the case's features and writes the statements).

- **Solids.** Each BuildOp becomes convex polyhedra: cubes, cylinders and cones,
  extrusions of convex outlines (rectangles, circles, rounded rectangles, hulls,
  offsets), small 3D hulls and convex meshes, through every translate, rotate and
  scale. A union is its pieces; a difference subtracts exactly (P∖C as disjoint
  convex pieces, one per face plane of C), so a ring is a ring. Two solids clash
  when the clipped intersection still has volume ≥ 0.01 mm in every axis. Circles
  are at most 48-sided (≤ 0.02 mm on an 8 mm radius).
- **Footprints.** Flat features (a divider's foot, a HAT board beyond the host)
  are convex outlines between two Z heights; two footprints are tested in 2D.
- **Stand-ins.** What cannot be read exactly — a non-convex outline, an
  intersection op, a twisted or unevenly tapered extrusion, a revolve, a large
  hull or a non-convex mesh — becomes its bounding box. Every answer carries
  `method: 'solid' | 'footprint' | 'bounds'`, shown in the panel's tooltip.
- **Speed.** Shapes are cached by op content and pair answers by the two shapes'
  keys (LRU, 512 shapes and 4096 pairs); boxes that do not meet are never
  intersected; a magnet move search's trial shapes are kept out of the caches and
  its answer is memoized. On the protective case with four sockets, a magnet row,
  the floor grid and two dividers the pass takes about 20 ms cold and 2–3 ms warm;
  `interiorClash.spec.ts` holds it under 100 ms and 25 ms.

Magnet statements (pocket and boss against the board, standoffs, latches, the
hinge and the lid; the pocket against port cutters) and divider statements
(against a snap-fit lid's lip, the vents, HATs beyond the host and the
split-for-print seam) travel on `BuildPlan.clashes`, present only when there is
something to say, to `jobStore.clashes`. The divider offers come from
`caseDividerFacts`'s `extraClash` hook, so a **Move to row N** or **Shorten to N
sockets** clears the grid's own clashes too.

A project with no connector — the field absent, or no sockets and no keys —
compiles to a byte-identical plan and mesh; `stackConnectorUnchanged.spec.ts`
pins the hashes taken on main before the feature landed.

## Fit coupons

Every fit-critical interface can be printed on its own before the part that uses
it — the lesson of #140, where arithmetic sent the M5 pilot to 4.0–4.3 mm and a
printed coupon came back at 4.8. `fitCoupons.ts` is the registry;
`npm run fit:coupon` renders all of it, `npm run fit:coupon -- <id>` one of it,
and `--list` prints the ids.

| id | settles |
| :--- | :--- |
| `magnet-6x2`, `magnet-8x3`, `magnet-10x2` | the magnet pocket diameter, as a clearance ladder cut in two print orientations (`npm run magnet:coupon -- <size>` renders the same ladder for any of the seven table sizes) |
| `magnet-sizes` | one pocket of every `MAGNETS` row (6×2, 6×3, 8×2, 8×3, 10×2, 10×3, 12×3) at the table's glue fit, labelled with the size's digits (`62` … `123`): does each row take its disc at all |
| `board-snap` | `boardSnap.ts`'s `CLIP_FIT` (the spine-to-PCB-edge gap) laddered by #153's `fitRelief`, one clipped two-jaw clip per rung, plus a gauge cut to the board's own thickness to check the Z jaw opening accepts it |
| `snap-catch` | `snapCatches.ts`'s hook socket, laddered by #153 — the tab and the socket wall are both the compiler's geometry, the barb pocket is measured off the mesh |
| `rack-tab` | `rack.ts`'s `TAB_SLACK` (plate tab in its ledge), laddered by #153; both halves are the compiler's own parts cut with a slab, so the tab prints counterbore-up |
| `stack-connector` | `STACK_SLIDE_CLEARANCE`, the stacking connector's sliding gap per face: three sockets in one bar, each opened by one fit rung, and one shipped key that should slide into the right one |
| `insert-pocket` | the tool-insert pocket's `clearance` and `chamfer`, as two ladders of Ø10 pockets in one bar |

The three #153-laddered coupons (`board-snap`, `snap-catch`, `rack-tab`) each print
**one mating half per rung** and a shared other half, because the relief moves only
the cut side: the tight rung is the shipped part byte-for-byte, and each later rung
carries exactly `fitRelief(fit)` more clearance than it.

**A coupon is not a redrawing.** Each one is built from the same builder the
compiler uses — `magnetPocket`, `buildBoardSnapOps`, `roundPocketCutter` — so a
coupon cannot certify a feature the compiler no longer draws. That is also why
the coupon geometry lives in `src/` rather than in the script that writes it.

**Printing one is the measurement.** The code does not adopt the winning rung;
the operator prints, drives or measures, reports back, and a follow-up flips that
number to measured. Every coupon therefore carries a PROVISIONAL note naming what
is still a guess.

## CI

GitHub only reads workflows from the repository root's `.github/workflows/`, and only the Windows installer lives there (#290). That is why it is the only one that has ever run.

- `windows-installer.yml` (root) — on a `v*` tag or a manual dispatch: `windows-latest`, Rust, checks `icon.ico` carries all eight Windows sizes (`npm run icons`; it never regenerates the set), builds the **x64** NSIS bundle (#403 — NSIS only), signs the setup `.exe` when the maintainer's `WINDOWS_CERT_PFX_BASE64`/`WINDOWS_CERT_PASSWORD` secrets exist, and attaches it to the GitHub Release. Without the secrets a tag build **fails** rather than publishing an unsigned installer; a manual run still produces an unsigned test artifact. Secrets are the maintainer's and are never created by the repo.
- `ci.yml` — lint + typecheck + Vitest + production build, matrix Node 20/22 on ubuntu-latest. **Has never run**: it is still under `casemaker-app/.github/workflows/`, where GitHub does not look. Moving it would start Actions minutes on every push — a separate decision.
- `playwright.yml` — E2E suite with chromium + SwiftShader. Same location and status: never run.

## Performance notes

- **Manifold ops are synchronous inside WASM.** Cancellation via the generation counter only fires *between* ops. A single very large boolean still blocks until done.
- **Worker count:** one geometry worker, one export worker. A pool wouldn't help since rebuilds are latest-wins.
- **Bundle:** main app code is ~53 KB; Three.js is the bulk at 896 KB (gzip 239 KB). Code-splitting is configured in `vite.config.ts` `build.rolldownOptions.output.manualChunks`.
- **Debounce:** slider drags are 200 ms trailing-debounced. Discrete actions (button clicks, board swap, port drop) dispatch immediately.
