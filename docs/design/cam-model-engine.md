# The model-driven CAM engine — design note (#956)

*B, 2026-11-03. No code in this note. Supersedes plan v2 §4's `cam/model2d/` + `cam/surface3d/` split
(§7 decision 2: one engine, one package, `cam/model/`). To be reviewed by A and the manager; the
maintainer's go closes this issue.*

Numbered to match #956's own list (1 feature recognition … 9 licences). The interface (§3's public
contract plus §4's sequence/program shape) goes to the issue first, ahead of the rest, because A
(#958), C (#961/#962) and D (#963) are blocked on it.

---

## 0. What this replaces, named exactly

`generateGoalProgram` (singular, `engraveGenerate.ts:4778`) calls `generateSurface3dForGoal` (the
rough/finish split) for every 3D goal job — both in `surface3d.ts` (3236 lines) and `rough3d.ts`
(426 lines). **Correction**: the note's earlier line said `generateGoalPrograms` (plural) called a
second function, `generateSurface3dIR`, for an "unsplit path" — checked while wiring the skeleton,
that call is actually inside `generateSurfacePrimitiveProgram` (cone/sphere primitives, #786), a
DIFFERENT caller the note never otherwise discusses. **Open item, for the manager**: is primitive
surfacing in scope for this rebuild (then it needs its own slice and owner), or does it keep a
minimal surface module of its own after #966 retires the goal planners? Default, pending an answer:
the latter — `generateSurfacePrimitiveProgram` is not wired to `cam/model/` by this note. See §8.
`generateOneProgram` (`engraveGenerate.ts:7513`) calls neither today; plan v2 §5.4's "nothing new in
`generateOneProgram`" is already true for the 3D path, not just a rule to keep going forward.

The planning half of both files is built around one object, `GoalHeightfield` (`surface3d.ts:129`): the
goal sampled onto a fixed-pitch grid (`DEFAULT_GRID_PITCH_MM = 0.1`, `:72`), capped in cell count
(`DEFAULT_MAX_CELLS = 4_000_000`, `:79` — above it the pitch is coarsened, silently), and bounded by a
memory budget (`GOAL_MEMORY_BUDGET_MB = {desktop: 640, phone: 256}`, `:167`). Three more caps ride on
top for *planning*: `DEFAULT_MAX_FINISH_TIP_OPS = 300_000_000` (`:100`, the finish/rest tip-field op
cap), `DEFAULT_COMPARE_CELL_BUDGET = 1_000_000` (`:1019`), `DEFAULT_PLAN_BUDGET_CELL_LEVELS = 500_000`
(`:1020`, read live as the shop default `rough3d.planBudgetCellLevels`,
`engraveGenerate.ts:5262`/`:6109`). `rough3d.ts`'s `planLevel` (`:219`) and `roughingAdaptiveMoves`
(`:271`, async) plan per Z-level against the heightfield and these caps.

The `goal-program-too-big` refusal (`engraveGenerate.ts:5198`) fires directly off these caps. A
110 × 140 × 26 mm hardwood tray that Makera Studio cuts in 47.6 minutes is refused by this code before
a single move is planned (plan v2 §1, the Makerables run). **This planning method is what gets
retired, not tuned**: plan v2 §0.2 — sampling the goal into a fixed grid and planning move-by-move
inside a memory budget is not how a drop-cutter CAM works, and no budget number fixes that.

**What does not go with it** (§8 has the full list and why): `sampleGoalHeightfield` and the
`GoalHeightfield` *type itself* are not CAM-planning-private. The same function samples the goal for
the independent gate's own stamp (`goalCheckField.ts`, `designCheck.ts`'s `checkGoalCutInto`, ported
from the bench's `goal_check.py`) — the measurement this engine is judged against. §8 extracts that
sampling into its own module before anything in `surface3d.ts` is deleted.

Nothing in this engine's output IR shape changes: `concatToolpathIR` (`ir.ts:1138`) still assembles
`CamOperation[]` (`:67`: `number/name/labelId/depth/passKind?/depthPasses?/passStepMm?/moves/
estimatedSeconds`) into a `ToolpathIR` (`:126`). The new package's job is to produce that same IR
through a different method, once per cutter in the sequence (§4), and to stop needing the heightfield
to plan with.

---

## 1. Feature recognition (M2) — A's #958 note, read in full

A's #958 (comment, 2026-11-03) is the source for this section. It is a stronger method than this note
first assumed and is adopted here without change to its shape; what follows is this note's own summary
for a reader who has not opened #958, plus the one correction A's note itself asks for.

**The method, in A's own words reduced to one paragraph:** both a STEP and a mesh become **planar
patches** first — one B-rep face is one patch from a STEP; coplanar-triangle clustering (normal within
0.5°, plane distance within 0.005 mm, grown in descending-area order — the fix for Kiri:Moto's
neighbour-to-neighbour drift, see §9) gives the same thing from a mesh. Patch heights give **floor
levels**. At each level the solid is **sectioned** (Manifold's `slice`, falling back to a
triangle–plane section with segment chaining — Kiri:Moto's `sliceZ` is the port source for the
fallback), and the feature tree comes from **booleans on those sections** — this is FreeCAD Path's
lesson (`Path/Op/PocketShape.py`, LGPL-2.1-or-later, algorithm reference only): islands and pockets
come out of a boolean on the solid, not out of walking face adjacency. The result is a `FeatureTree`:
a `contour` (full-depth outline, `frees: boolean` for tabs), a tree of `PocketNode`s (floor, islands,
children, an `open` flag for ledges/shoulders), `RemainderRegion`s (the curved, non-planar parts, with
their slope range), `Rim`s (sharp or modelled-chamfer edges), and an `unreachable` list for undercuts —
each a plain-data shape, carrying a `faceId` sidecar back to the source geometry when the input was a
STEP (`stepMesh.ts` needs to start returning `brep_faces` per triangle for this; it discards them
today — A's §2 point 1).

**A's own interface (#958 §4) is adopted as-is for `ModelPlan`'s features field** (§3): `recogniseFeatures(src: FeatureSource, frame: SetupFrame, tol?) → FeatureTree`, with `FeatureTree`,
`PocketNode`, `RemainderRegion` and `Rim` exactly as A's note defines them. This note does not override
any part of it — A's note says "the interface in §4 is a proposal, B's #956 interface overrides it
where they disagree" (A's #958, opening paragraph); where they don't disagree, A's stands. The one
place this note's interface extends A's is the setup dimension (§3): A's `SetupFrame` is per-call: §3
wraps one `FeatureTree` per entry in `setups[]`.

**How §3's ops consume the tree** (A's own §4, carried forward): each `PocketNode` goes to the existing
`pocket.ts` rings at its `floorZ`, with `region` as-is, rest with the next flat; `contour` goes to
`profile.ts` with tabs when `frees`; each `RemainderRegion` goes to this note's CL surface (§2),
restricted to its footprint grown by the cutter radius; `rims` go to the chamfer op (§3.5).

**Two non-blocking notes from A's review, carried here so §3 doesn't drift from §1's real shape:** (N1)
`Rim` gains an `id` field on A's #958 amendment (`PlannedOp.region` is a `RegionRef`, §3.0.1, and needs
one to point at); the
contour's own id is the literal `'contour'`. An island top below the stock top needs no new node type
— it comes out of the tree as a `PocketNode` at its own level, and `features.ts` exports a
`regionRefs(tree)` helper so C's sequencing/linking derives bounds/`topZ`/`bottomZ` from the tree
instead of re-deriving them. (N2) A `PocketNode.region` may extend below its own `floorZ` where
remainder area continues there (the tray's scoop, deeper than its slot floors) — clearing to `floorZ`
is safe by construction (it is exactly where the part is below that level), and the remainder op (§3.3)
picks up what continues below via the node's own `remainder` ids; §3.1's pocket op must not assume a
node's region is floor everywhere.

**Independence, restated for this note** (A's §5, the same point D and the manager made on #956's
thread): the tree is CAM input only. The gate never reads it — it reads the posted NC through the
Tool-record stamp (§0, §8). The edge-break allowance (A's own V2-2) finds design edges from the goal
heightfield by its own rule (a slope break or a step taller than a cell, inside the chamfer bit's
reach), not from `rims` — a spec may compare the two edge sets as an extra check, never as the gate.

---

## 2. The cutter-location surface (M3)

Drop-cutter against the curved-remainder triangles (A's `RemainderRegion`s), per cutter type (flat,
ball, bull, V), computed at the operation's own tolerance — **never a global 0.1 mm grid.** Method:
OpenCamLib's description (`aewallin/opencamlib`, LGPL-2.1, algorithm reference only — §9) of
`BatchDropCutter`/`PathDropCutter`: a triangle spatial index (kd-tree or equivalent), the cutter's drop
routine evaluated at each sample point against the triangles the index returns as candidates, per
cutter-geometry contact rule (flat: vertical ray; ball: sphere-to-triangle distance; bull: toroid; V:
cone). `Waterline`'s two-pass construction (`BatchPushCutter` + a weave into ordered loops) is the
reference for any constant-Z slice this engine needs (rims, stepped roughing — §3.3) — re-implemented
from its description, not its source.

**The held lesson this section exists to absorb** (Session C's #945 finding, full state on
`held/945-finish-contact`; Review B's F1 on `held/945-guard`, 218b59e2/97ca4974): the old engine's
error class was never the stencil rule in isolation — it was **interpolating a straight line between
two samples across a slope and judging the gouge or leftover on that line, not on the surface the
cutter actually sweeps between them.** C's finding — a ball dropped against a cell's square
neighbourhood read ≈ (pitch/2)·tan θ high on a slope, because the stencil compared a square-distance
rule against a point sampled at the cell centre — and Review B's F1 — a steep diagonal's drop-cutter
candidates collapsed to `t = 0` because the admissible interval was computed from point-centre roots
while candidates were *admitted* by a square-distance rule 40% wider — are the **same defect** stated
two ways: a straight-line (or straight-grid) approximation of a curved contact surface, graded against
a rule that does not agree with how the approximation was built.

The CL surface must not reproduce this class, and a guard added after the fact (which is what both
F1 and C's finding were) is not the fix — the fix is in the sampling method itself:

- **Adaptive subdivision**: a path segment between two drop-cutter samples is subdivided at its
  midpoint whenever the midpoint's own dropped height departs from the straight-line interpolation of
  its endpoints by more than the finish tolerance (`ARC_CHORD_TOLERANCE_MM = 0.005 mm`, the same
  constant `Simulation.md:586-592` already uses for arcs — every bound below uses this same number, not
  a second tolerance), down to a stated `minSpacingMm`. **Correction (A's R6):** the mesh's own
  deflection (A's #958 §2 point 2, 0.01 mm absolute) is a floor on *tolerance*, not on *spacing* — a
  tessellation edge can be far longer than 0.01 mm, so `minSpacingMm` is not derived from it.
  **`minSpacingMm = ARC_CHORD_TOLERANCE_MM` (0.005 mm), stated as a trade-off, not asserted as free of
  one**: at a true discontinuity, subdivision stops at this floor and hands off to the staircase rule
  below, leaving an uncut sliver at most `minSpacingMm` wide at the wall's foot — the same 0.005 mm this
  engine already treats as its finish tolerance everywhere else, so this does not introduce a new,
  separate error class at a wall that the rest of the surface does not also carry.
- **A stated maximum sample spacing, per cutter, independent of the midpoint test — corrected per A's
  R6.** The midpoint test alone misses a feature narrower than the segment — a rib or a groove that
  sits entirely between two samples, where the midpoint also lands beside it and reads no departure.
  OpenCamLib's own `AdaptivePathDropCutter` could not be read for its exact spacing parameters (its
  page returns a doxygen build error, not documentation — checked, not assumed); this note derives its
  own bound from what each cutter's footprint can actually miss — **the sagitta on the cutter's own
  contact radius against a thin peak, not a raw corner-radius guess (the note's first draft used the
  latter and was wrong, per A's review), and, for the V cutter, the flank's own sensitivity to a missed
  lateral feature, not the same sagitta term (also wrong in the first draft, for a different reason —
  below):**
  - **Ball** (radius R): two samples straddling a thin peak under-read its top by about the sagitta
    `s²/(8R)`. Solving for the spacing that keeps this under tolerance: `maxSpacingMm = √(8·R·tol)` —
    for a ⌀6 ball (R = 3 mm) at `tol = 0.005 mm`, ≈ 0.346 mm. This is C's #945 sagitta lesson again,
    now as the sampling bound it should have been from the start.
  - **Bull**: the same `√(8·r·tol)` term, using the corner radius `r`, capped above by the cylindrical
    radius `R` (a bull's corner cannot be wider than its own body).
  - **V, corrected again**: the note's first fix (tip radius in the sagitta formula) is **also wrong**
    — a sharp V-tip's radius is 0, which makes `√(8·0·tol) = 0` and reproduces exactly the "forces
    infinite sampling" defect R6 was raised to remove, just on a different cutter. A V-tip has no
    curvature to under-read; what it can miss is a narrow feature off to one side that its flank would
    have climbed, which a lost sample reads as flat. The bound this note uses instead:
    `maxSpacingMm = 2·tol·tanα`, where `α` is the cutter's half-angle from the vertical axis (for a
    90° included V/chamfer bit, `α = 45°`, giving ≈ 0.010 mm at `tol = 0.005`) — tighter for a narrower,
    more needle-like cutter (small `α`, more sensitive to exact lateral position) and looser as the
    cone widens toward a flat cutter's own behaviour (`α → 90°`). **Stated as a reasoned default, not
    a sourced one** — OpenCamLib's own parameter for this case was not found (same gap as above); F's
    #964 fixtures (§2, §9) are what actually checks it, run against OpenCamLib's real output, not this
    note's derivation.
  - **Flat**: not the sagitta formula (a flat cutter's bottom has no curvature to under-read) and not
    "effectively zero" (the note's first draft, which forces needless sampling on the one cutter that
    needs the least) — the CL surface a flat cutter produces over a thin peak is a flat-topped plateau
    with vertical sides (the cutter's own footprint radius sets the plateau's width), so a spacing of
    `maxSpacingMm = R` (the cutter's own radius) is guaranteed to land at least one sample on the
    plateau over **any** peak, not only one at least as wide as the cutter — the plateau itself is at
    least `2R` wide, twice the spacing — and the staircase rule below carries the sides. (A's review,
    R6 follow-up: the note's first wording of this bound understated what it actually guarantees.)

  Every bound is re-derived per operation from that operation's own cutter and tolerance — never a
  mesh-wide constant.
- **Termination at a real discontinuity, not an infinite subdivision.** Against a vertical wall or any
  step, every midpoint on either side of the step departs from the straight-line interpolation —
  subdivision alone never converges, it just bottoms out at `minSpacingMm` with the gouge or leftover
  from the full step height still present on that last segment (this is F1's 3.5 mm case exactly: a
  segment short enough to pass the midpoint test can still straddle a step taller than the segment
  itself). The rule that closes this: **when a segment's departure still exceeds tolerance at
  `minSpacingMm`, emit a staircase instead of a straight diagonal** — a corner at the higher Z,
  `staircaseCorner`'s own rule (`surface3d.ts:2419`, already on main and carried forward unchanged: a
  near-vertical corner at `prevZ` or `z`, whichever is higher, when the lateral move is smaller than
  the Z change). This makes §2's sampling do, by construction, what the old engine's raster finish did
  as an emitted-move fix (bab37c2c) — the difference is that here it is the *sampling* step that
  recognises the discontinuity and stops trying to approximate it with a line, not a move-emission
  patch after planning. **The staircase's vertical leg is itself a move inside a pass, not inside
  `linking.ts`** — §5's "the one place a vertical move is emitted" is corrected by this: linking emits
  the *retract/stay-down* verticals between regions, the staircase emits a vertical *inside* a region's
  own CL path. Both use `feeds.plungeFeed`, not `feeds.feed` — Review B's F8 found the old engine's own
  `staircaseCorner` call sites still feeding that leg at `feeds.feed` (`surface3d.ts:2300-2312` +
  `:2365-2366`, `:2793-2796`, `:3105-3107`); this engine does not carry that forward.

A vertical wall or a steep ramp gets samples where it needs them from these rules together; a flat
region gets almost none. This is a property of the sampling method, not a check bolted on after —
§7's acceptance line (zero cut-into beyond the edge-break allowance) is the test that this held.

**Placement is a shared definition of the goal, not part of the gate's independence (A's R2).** The
triangles in `ModelPlanInput.geometry` are placed through `placeTarget` (`targetPlace.ts:31`) before
this engine ever sees them — the same function `sampleGoalHeightfield` (§0, §8) and the rim extractor
already share (#829). This is **deliberate sharing, stated as such, not a gap in independence**: the
CAM and the gate agreeing on *where the goal sits* is correct — they must still disagree, independently,
about *what the cutter does once it is there* (§3.6's point 7, amended, below). Because placement itself
is shared, it gets its own check outside the gate's import-independence spec: E's Makerables runs
already find the goal's Z independently of the app (the page checker's `--dz`, the median-deviation
read); the app's own placement must agree with that `--dz` reading within 0.01 mm on the tray and the
organizer (added to §7's acceptance).

**Second implementation, ruled (manager, 2026-11-04, on A's finding): PyCAM joins OpenCamLib.** PyCAM
(`SebKuzminsky/pycam`, GPL-3.0, pure Python) has its own drop-cutter — `PathGenerators/DropCutter.py`
with `Cutters/CylindricalCutter.py`, `SphericalCutter.py` and `ToroidalCutter.py` — covering flat, ball
and bull. Plan v2 §5.1's two-implementation rule is met for those three cutter types; the **V cutter
has OpenCamLib alone** (PyCAM's cutter set has no cone). Both are reference only: F's #964 runs both
programs **offline**, with their scripts and versions committed and only their numeric outputs kept —
no OpenCamLib or PyCAM source enters the tree, under either licence. §9 carries the same ruling.

**Spec note (V2-11):** agreement with both OpenCamLib's and PyCAM's outputs (flat/ball/bull) and
OpenCamLib's alone (V) on three analytic meshes — **a flat plane; a single ramp at a slope within
every reference cutter's own reach (a steeper ramp is a deliberate, separate test of this engine's
`unreachable` classification, §1, not this baseline fixture — a V cutter's reach is bounded by
`90° − half-angle`, so the ramp's slope must stay under that or the fixture itself is wrong, not the
engine); and a step (a vertical wall meeting a floor)** — plus at least one committed non-analytic
mesh (a real figure), within the adaptive grid's own tolerance, per cutter type — F's harness (#964),
flagging any case where the two references disagree beyond tolerance rather than averaging them.

---

## 3. The operation set and the interface — goes to #956 first

**This is the section A, C and D are blocked on.**

### 3.0 What `cam/model/` exposes

No file in `cam/` today has an `index.ts` barrel or a stated public contract — every module is
imported by path (confirmed: `rotaryRelief.ts`, `primitiveSurface.ts` and others import specific named
exports from `surface3d.ts`, not a module object). `cam/model/` is new discipline for this directory,
written down here for the first time.

```
cam/model/
  features.ts    -- §1, A's #958: recogniseFeatures, FeatureTree and its parts, unchanged from A's note
  clsurface.ts    -- §2, B's #957
  ops/            -- §3.1-3.5, B's #959/#960: pocket.ts, contour.ts, rough.ts, finish.ts, pencil.ts
  sequence.ts     -- cutter sequence by cost, C's #961
  linking.ts      -- stay-down + region tour + the shared op/material contract, C's #962
  plan.ts         -- the one entry point, assembles the above
```

**Correction, read against C's #961/#962 comment on #956 (6619787259) in full** — the manager's approval
said this contract was "carried in §3.6/§5"; it was not, because that comment sat in the middle of a
long thread and was missed when this note was first drafted and twice amended. It is a real gap, not a
wording note: without it, #959/#960's ops and #961/#962 have no shared record to build against. §3.0's
types below now include it.

`plan.ts` exports one function:

```ts
function planModelCam(
  input: ModelPlanInput,
  opts: { signal?: AbortSignal; onProgress?: (p: ModelPlanProgress) => void } = {},
): Promise<ModelPlanOutput>
```

replacing both `generateSurface3dForGoal` and `generateSurface3dIR` at their `generateGoalPrograms`
call sites (`engraveGenerate.ts:5232`, `:6088`) — both of which are already `async`, so this is not a
new calling convention for that caller. `async` plus `AbortSignal` is required, not optional: Generate
can be cancelled today, and §6's stall guard needs the same cancellation path to refuse cleanly rather
than hang; `onProgress` is what D's UI reads for a live percentage during a multi-second plan.

Unlike the two functions it replaces, it does not take a single `Tool` — a costed sequence (§4) needs
candidates to choose from, and the figures' setups (§8 note; #965 implements the behaviour, this note
reserves the shape) need more than one frame. Types below are mapped to what already exists where it
exists; a type with no existing equivalent is marked **new**, defined in `plan.ts` or `sequence.ts`:

```ts
interface ModelPlanInput {
  geometry: FeatureSource            // A's #958 shape: triangles (already placed through placeTarget,
                                       // targetPlace.ts:31 — §2) + optional faceId sidecar (STEP only)
  setups: SetupSpec[]                 // length 1 for the tray/organizer today; #898/#914's flip plan
                                       // (held/914-flip-plan: the reach-aware face decision, the
                                       // stock-floor anchor 18f5a366, the band-floor trigger 475d3eb7)
                                       // and #965 fill this to more than one entry — reserved now so
                                       // #965 does not reopen this interface
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material'>   // the job's own
                                       // stock shape (types/engraveJob.ts), not a new type
  fixture: { mount: Mount; envelope: FixtureEnvelope | null }   // CORRECTED, twice. First:
                                       // `bracketMount` answers `null` for a vise job (`jobSetup.ts:
                                       // 1069`'s own comment: a bracket program is checked against its
                                       // arms, a vise program is not), and the tray/organizer are vise
                                       // jobs — #949's jaw-clearance class is exactly what §7's "posts
                                       // as filed, in the vendor's holding" line needs, so that alone
                                       // cannot be the field's only source. Second: a bare
                                       // `ObstacleBox[]` would drop `uncertainty`/`source`/
                                       // `measuredAt` — the sweep INFLATES every box by the envelope's
                                       // own `uncertainty` before checking it (`prepareFixtureBoxes`,
                                       // `sweep.ts:622`), and `source` carries this project's
                                       // default/saved/measured provenance rule — so the field is the
                                       // whole `FixtureEnvelope` (`engine/cnc/setup.ts:149`), the SAME
                                       // resolved object the sweep checks the posted program against
                                       // (`engraveRunStore.ts`'s own words: "the same object gates the
                                       // program AND loads the simulation"), not a value rebuilt here
                                       // from `viseEnvelope` and therefore blind to a saved/measured
                                       // vise. `Mount` is `jobMount(job, setupIndex)`
                                       // (`'vise'|'bracket'|'tape'`, `engine/cnc/setups/types.ts:50`).
                                       // `envelope` is `viseEnvelope(...)` for a vise (`fixture.ts:371`,
                                       // `jobSetup.ts:1207`'s own `defaultFixture` call) or
                                       // `bracketMount(...).fixture` for a bracket (already a
                                       // `FixtureEnvelope`, `bracket.ts:451` — no conversion needed),
                                       // `null` for tape.
  cutters: CutterCandidates           // NEW (sequence.ts): { house: Tool[]; catalogue: Tool[]; pinned?:
                                       // Partial<Record<PlannedOp['kind'], string>> }. `Tool` is the
                                       // existing type (`engine/cnc/tool.ts:24`), not reinvented.
  tolerances: ModelTolerances         // NEW (plan.ts): finish tolerance and §2's adaptive-spacing
                                       // basis (ARC_CHORD_TOLERANCE_MM-derived) ONLY.
  edgeBreak: EdgeBreakSpec             // NEW, from the job directly — the chamfer op (§3.5) needs to
                                       // know how big a break to cut. Per A's R3, this is NOT the
                                       // source the gate's allowance reads: the gate (§7) reads the
                                       // SAME job field independently, through its own path, capped by
                                       // the chamfer Tool record's own geometry — the CAM sizes its
                                       // cut from the job, the gate sizes its allowance from the job,
                                       // and neither derives its number from the other's plan output.
}
interface SetupSpec {
  frame: SetupFrame                   // A's #958 shape: up vector + stockTop
  underside: 'flatOnStockBottom' | 'flippedTabs' | 'plinth'   // #898's three choices
}
interface ModelPlanOutput {
  perSetup: SetupPlan[]               // one per entry in input.setups, same order
}
interface SetupPlan {
  setupIndex: number
  features: FeatureTree               // A's #958 shape, §1 — unchanged
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[]
                                       // renamed from `clSurface` — that name collides with the
                                       // per-slice export `clSurface(cutter, stepOver, region)`
                                       // (§3.0.1); this field is grid resolution, not the function
  ops: PlannedOp[]                    // §3.1-3.5, in execution order
  sequence: { cutterKey: string; cost: CycleCost; pinned: boolean; house: boolean }[]   // §4; the
                                       // PUBLIC `CycleCost` wrapper (§3.0.1): `{terms: CycleTerms,
                                       // toolChangeSeconds, totalSeconds, toolChanges?}` — `terms`
                                       // is #927's EXISTING type (`ir.ts:692`), computed by `plan.ts`
                                       // from the posted IR, not C's #961 internal `CycleCost` (which
                                       // has no `terms` field, just a summed `estimateSeconds`).
  linking: { rapidsCount: number; hopsCount: number; airFractionPct: number }           // §5
  programs: ToolpathIR[]              // one program per cutterKey in sequence[], in sequence order —
                                       // the #419 answer ("one program per tool"); built by grouping
                                       // every PlannedOp.outcome by cutter and running the EXISTING
                                       // `concatToolpathIR` (`ir.ts:1138`) over each group's `ir`s —
                                       // not a new assembly step. ToolpathIR itself is unchanged
                                       // (ir.ts:126), each still carries one tool/toolNumber.
  totalCostSeconds: number
}
interface PlannedOp {
  kind: 'pocket' | 'contour' | 'rough' | 'rest' | 'finish' | 'pencil' | 'chamfer'
  region: RegionRef                   // C's shape, §3.0.1 below — was a bare `regionId: string`; a
                                       // region needs its bounds/obstacles in hand for linking (§5),
                                       // not just its id
  outcome: OpOutcome                  // C's shape, §3.0.1 — was a bare `passes: Pass[]`; `OpOutcome`
                                       // carries the op's IR, what it cleared, and its cutter in one
                                       // record, which is what #961/#962 and D's op-list sentence all
                                       // read, so there is one shape instead of a parallel description
}
// ModelPlanProgress: NEW (plan.ts) — { setupIndex: number; op: PlannedOp['kind'] | 'features' |
// 'clSurface' | 'sequence' | 'linking'; fraction: number }, the minimum D's progress bar needs.
```

### 3.0.1 The shared op/linking contract — superseded by C's real #961/#962 code

This section went through three drafts before landing on what is actually true, and what's true is
code, not a sketch: C's #961 (`sequence.ts`, `cand/961` 3dee66ba) and #962 (`linking.ts`, `cand/962`
366affdb) are real, tested, merged implementations — "stubs to fill in" was never the right frame for
them, and the skeleton now carries their actual files, not a re-invented contract. This note states
only the PUBLIC boundary `plan.ts` exposes, built on top of them; `sequence.ts`/`linking.ts`'s own
richer internal shapes (`SequenceStep`, `CandidateSequence`, a module-internal `CycleCost` that sums
to a bare `estimateSeconds: number`; `LinkPoint`, `MaterialField`, `PassLink`) are theirs to document,
not duplicated here.

```ts
interface OpOutcome {
  ir: ToolpathIR
  cutter: string                      // ToolKey — no such type exists, `roughToolKey` is a bare
                                       // `string` (`types/engraveJob.ts:770`); not invented here
  passes: PassRef[]                   // in execution order — restored on C's objection (below)
  cleared?: RegionAtZ[]               // what it removed, per depth
}
interface RegionAtZ { z: number; boundary: Polygon[] }

interface PassRef {
  z: number; boundary: Polygon[]; cleared: RegionAtZ
  entry: [number, number, number]; exit: [number, number, number]   // what linkPasses (linking.ts) joins
}
interface RegionRef {
  id: string
  kind: 'pocket' | 'island-top' | 'curved' | 'contour' | 'rim'
  bounds: Box2
  topZ: number
  bottomZ: number
  obstacles: ObstacleBox[]            // the fixture envelope's boxes, INFLATED (§3.0), that reach
                                       // this region — the #949 jaw-clearance data
  regionClearanceZ: number            // the lowest Z clearing every one of `obstacles` — C's ruled
                                       // clearance name (below), what linking.ts's `clearanceZ` is
}
interface CycleCost { terms: CycleTerms; toolChangeSeconds: number; totalSeconds: number; toolChanges?: number }
// NEW, no existing equivalent: Polygon = [number, number][]; Box2 = { min, max: [number, number] }.
```

**What this note got wrong twice, and the rulings that fixed it (all on #956, C and the manager):**
1. **The clearance names.** This note invented `stayDownClearanceMm`/`retractClearanceMm`; C
   objected — staying down is a material-state decision, not a height. **Ruled**: the two real
   heights are `RegionRef.regionClearanceZ` (per region, above) and `ToolpathIR.safeZ` (existing
   field, program-wide, between regions/ops). Neither name above survives.
2. **`PassRef` had no consumer.** C's objection: without entry/exit per pass, `linking.ts`'s
   `linkPasses` cannot find where one pass ends and the next begins — restored into `OpOutcome.passes`
   above, matching C's exact shape.
3. **`sequence[].cost`'s shape.** Ruled: the wrapper above (`terms`/`toolChangeSeconds`/
   `totalSeconds`, `toolChanges` optional) — **not** a bare `CycleTerms`, and **not** C's internal
   `sequence.ts` `CycleCost` (which has no `terms` field at all, just a summed `estimateSeconds`).
   `plan.ts` computes `terms` itself from each cutter's concatenated posted `ToolpathIR`
   (`estimateCycleTerms`, `ir.ts:692`) — independent of `sequence.ts`'s own internal accounting,
   which only has to pick the cheapest sequence, not produce the public number.
4. **`ObstacleBox[]`/methods-not-functions/the `clSurface`-vs-`clGrid` rename**: all confirmed as
   this note stated (unchanged from the prior revision).

F's parity harness (`modelGolden.spec.ts`, `cand/964b`) validates exactly this shape — `setupIndex`,
`features`, `clGrid`, `ops[].kind/region/outcome` (with `region.regionClearanceZ` and
`outcome.passes[]`), `sequence[].cost` as the wrapper above, `linking`, `programs` (each `ToolpathIR`
carrying its own `safeZ`), `totalCostSeconds` — and is the actual check, not this note's prose.

**Per-slice minimum, C's own line:** `#957`: `clSurface(cutter, stepOver, region)` plus a cheap
`reach(cutter, feature)`, so #961 prunes before generating. `#959`: `rough`/`rest`. `#960`: `finish`,
the flat-vs-ball slope classification, the chamfer/edge-break rim as its own region.

### 3.1–3.5 The ops

1. **Z-level pocketing** per `PocketNode` (§1), largest flat that fits the node's clearance, rest with
   the next-smaller flat — uses `pocketLoops` (`pocket.ts:204`: polygons + offset function + params →
   loops) **unchanged**. This op maps a recognised node onto the existing function; no new pocketing
   math.
2. **The outer contour**, step-downs to full depth, tabs when `contour.frees` — uses `generateProfile`
   (`profile.ts:631`) **unchanged**; it already supports step-downs and tabs
   (`TabPlacement`/`ProfileTabReport`, `:81,88`; `placeTabs`, `:476`; `tabBars`/`tabBridgeRectangles`,
   `:177,189` — checked, not assumed).
3. **Z-level roughing of stock minus the CL surface** for each `RemainderRegion` (and for the figures,
   where the whole part is remainder): per-level clearing bounded by the CL surface (§2), largest flat
   cutter that fits. Net-new — `rough3d.ts`'s `planLevel`/`roughingAdaptiveMoves` operated on the
   heightfield and its budgets; this op operates on the CL surface and carries no cap forward (§6).
   **Rest by CL-surface difference**: the next cutter's own CL surface compared against the previous
   cutter's, the delta roughed — same method, smaller cutter, no separate rest code path.
4. **Finishing by slope**: a flat-following raster where the local slope is under the flat cutter's
   admissible angle (Studio's method on the tray's scoop, plan v2 §1), a ball at constant scallop
   elsewhere — step-over derived from the ball's own radius and the leftover band, the already-landed
   fix on `held/945-scallop` (`d86410a4`/`b913ca4b`, on main). **Pencil** for creases (concave edges
   under the finish cutter's reach — OpenCamLib's method, re-implemented; see §8's open item on scope).
   The finish's own scallop/cusp on a wall is the step-over's sagitta and does not close by pitch alone
   (C's finding) — carried in the finish op's step-over formula, not patched after.
5. **Chamfer / edge-break as its own op** on each `Rim` — `chamfer.ts` (`generateChamfer`, `:65`) and
   `chamfer3d.ts` (`generateChamfer3d`, `:56`) are already standalone modules with their own result
   types; this engine calls them, it does not rework them.

No operation reads or writes a global grid; each op's working resolution is derived from its own
cutter and tolerance (§2, §3.0).

### 3.6 The job-model and UI seams (#963, D) — carried in full, against the corrected interface

D's #963 comment on #956 is the operator-side contract; §3.0's `SetupPlan` is built to supply it:

1. The CL grid (§2) is read from `plan.clGrid` (now a tolerance plus min/max spacing, §2 — not a
   fixed `gridSpacing`, which would contradict §2's adaptive sampling). The job stops asking for a
   resolution; the engine states what it used.
2. Recognised features (§1) come from `plan.features` as plan output, not job state — the only source
   of the "6 pockets, 1 outer contour, 1 curved region" sentence and the run sheet's rows.
3. The op list (§3) is `plan.ops`, in execution order, each naming its cutter and kind.
4. Finishing's choice per region (§3.4) is on each finish `PlannedOp`, with the numbers that decided
   it. The `surface` resolution fields (`roughStepOverMm`, `roughStepDownMm`, `finishStepOverMm`,
   `scallop`, `pencil`, `pencilCreaseDeg`) are deleted with this slice — the engine derives them, they
   stop being job-document fields.
5. The costed sequence (§4, below) is `plan.sequence`, with the pinned-key rule as stated there.
6. Linking's numbers (§5, below) are `plan.linking`, feeding the run sheet's efficiency line.
7. **Gate independence** (A's review point 1 on #956; D's point 7; A's own §5 on #958; **corrected
   per A's R1, then replaced in full on A's follow-up measurement** — A ran the import walk
   independently and found the first fix's allowlist backwards: stopping at an allowlisted module hides exactly what the
   rule exists to catch, e.g. `jobSetup.ts` alone reaches 10 forbidden files; `session.ts` turned out
   not to be in any gate root's value closure at all — `goalCheckField.ts` imports `SimSession` as
   `import type`, so the `cam/ir.ts`/`threadMill.ts` carve-out this note added for it was unnecessary
   and has been removed, not kept beside the correct rule): the goal check reads the posted NC with the
   Tool-record cutter — the stamp — **never** `plan.clGrid`. Comparing the CL surface the CAM
   planned against the stamp the gate measures is an extra check, never the gate itself. **A's
   replacement paragraph, adopted verbatim:**

   > **Gate roots:** `goalCheckField.ts`, `designCheck.ts`, `goalCoverage.ts`, `goalCheckInput.ts`, and
   > #967's `goalHeightfield.ts`. **Every value import is followed into every module; there is no
   > allowlist.** `import type` declarations are skipped; inline `{ type X }` imports are not, because
   > of `verbatimModuleSyntax`. **Forbidden in the closure:** `engine/cnc/cam/**`,
   > `engine/cnc/vProfile.ts`, `engine/cnc/engrave/partPlan.ts`, `engine/cnc/engrave/jobSetup.ts`. The
   > simulator and placement reach the gate as data, not imports. **The spec goes green after:** #967,
   > A's `oracleTypes.ts` split, and A's `jobKind.ts` move. Any future exemption must name one **edge**
   > (from → to, with its reason), never a module or a subtree. **Reverse rule:** unchanged.

   The three cuts behind "goes green after": `designCheck → oracle` (A's `oracleTypes.ts` split);
   `goalCheckField → cam/surface3d` (#967); `goalCheckInput → jobSetup` (A moving `pureGoalObject` and
   its helper `jobHasItems` — the one thing the gate actually needs from `jobSetup`, a pure job
   predicate — into a new `engine/cnc/engrave/jobKind.ts`, with `jobSetup` re-exporting them). Measured
   on main today: `goalCheckField.ts` fails on 9 forbidden files (first hop into `cam/surface3d.ts`,
   exactly #967's scope, not `designCheck`'s); `designCheck.ts` fails on 4 (`vProfile`,
   `engrave/partPlan`, `cam/ir`, `cam/tabSettings`, via the single `designCheck → oracle` edge); the
   other two roots are clean already. #967's own acceptance should include "its value closure reaches
   nothing forbidden" as a line of its own, since `goalHeightfield.ts`'s imports are the one thing this
   rule does not yet measure.

   Run as part of the same T-tier the rest of this engine's specs run under, so it actually blocks a
   landing.
8. For #964 (F): the parity harness asserts `SetupPlan` directly, and the run-sheet strings are read
   from it.

`bandMm` stays as a job field; its only current producer (the split press, §0) goes with the old
engine. #965 decides whether the figures' multi-setup still needs it (§3.0's `setups[]` is the shape,
not the behaviour) — out of scope for this note. Every refusal code, pass and sentence in
`goal-program-too-big`'s family (the finding, the three presses that feed it, the Technical-fold text,
the two cnc-guide chapter 8 rows) is deleted, not kept beside the new engine (§8) — any new refusal
this engine needs (a genuine stall, §6 below) gets its own code and its own chapter 8 row, per-slice as
each slice lands, not retrofitted at #966.

---

## 4. Cutter sequence by cost (#961, C)

**C's real `sequence.ts` (`cand/961`, landed) does the choosing**: `candidateSequences` builds the
vendor-shaped candidates (largest flat roughs, a smaller flat rests corners it cannot enter, a ball
finishes curved remainder, a chamfer breaks rims), pruned on geometry alone before any move is built
(an opening/corner/depth/curvature refusal, each stated in words); `priceSequence` prices each
survivor by #927's `estimateCycleTerms` on the posted moves plus the shop's `toolChange.seconds` per
change after the loaded first cutter; `chooseSequence` ranks house before catalogue, rowed feeds
before fallback, then price. `plan.ts` is the adapter: it builds the PUBLIC `sequence[].cost` wrapper
(§3.0.1) by concatenating each winning cutter's `OpOutcome.ir`s with the existing `concatToolpathIR`
(`ir.ts:1138`) and running `estimateCycleTerms` itself — independent of `sequence.ts`'s own internal
per-step accounting, which only has to pick the winner. Candidate sequences — **which candidates
`cutters` holds depends on the card, ruled in §7 (A's R5)**: the vendor's own cutter set for a
simulation-only reference card, the house's cutters first
and the catalogue second for a bench card. `CutterCandidates.house`/`sequence[].house` mean exactly
what the caller put in `input.cutters.house` — **the engine does not know or care which card it is
running**; for a reference card the caller fills `house` with the vendor's set (so `sequence[].house`
reads true for a vendor cutter on that card) and leaves `catalogue` empty, so §7's "+1" naturally has
nothing to add one to. D's panel prints `house`/`pinned` as given, without translating "house" to mean
"ours" — on a reference card it means "the set this card is pricing against." The manager's pinned-key
rule (already accepted on #956's thread): a cutter key the operator pinned (`input.cutters.pinned`) is
honoured and labelled `pinned: true` in `sequence[]`; an absent key is the engine's own choice,
`pinned: false`. `roughToolKey` and `chamfer.toolKey` (today's job-document fields) stop being written
by a measured search — they are read from `sequence[]` (D's §3.6 above).


### The planner's inventory ruling (the maintainer, 2026-11-05, #975) — what `chooseSequence` must serve

**The maintainer's words** (#975, relayed by the review session): *"Our software needs to be able to
plan based on all bits available, but when constrained with a fixed inventory present to the user
the tradeoffs (if any) and then implement with the tools available to the best of our ability.
Potentially also showing the user what the outcome of the choice will be."* Followed by: *"should
not bug the user if the difference is minor."*

**1. The ideal is planned from the full catalogue.** `candidateSequences` runs over every cutter
the app knows (the catalogue door, #964), not only the location's inventory. Its output is the
reference plan — on the tray's digits, a ⌀0.6 flat giving the model's flat −1.80 floor with
vertical walls. The app plans BOTH from the same input; the order `planTwoOutcomes` happens to use
(the owned plan first, then the ideal) is an implementation detail and carries no meaning. The
ideal is kept beside the owned plan; it is never the default and never a gate.

**2. The owned plan is the plan, and it never refuses where an owned tool can do the job.** The
same candidate builder runs over the location's set and `chooseSequence` picks the best outcome
those tools can reach — on the digits, the 90° V as a floor-correct pocket (#975's own answer:
the tool is in the set, so `unreachable` is wrong). A refusal is stated only when no owned cutter
can do the work at all, with the reason the geometry gives (a tip wider than the stroke, a leg
shorter than the depth).

**3. The tradeoff is stated only when it is material, in outcome terms.** The owned-versus-ideal
difference goes up as ONE line on the card, naming the outcome that differs and by how much —
never the tool that would have made it. It prints nothing when the two plans pass and fail the
same seven lines and differ by no more than, per the manager's proposed threshold (for the
maintainer to correct): **0.1 mm** in geometry (walls, floor, cut-into, leftover — the cell
tolerance), **0.5 points** of coverage, **10 %** of cycle. Past one of those, one line. This is
the standing rule that warnings must discriminate: a minor difference is visible on demand in the
comparison view (point 4), never as a warning.

**4. Both outcomes are shown, simulated.** The demo page renders the owned plan's simulated part
beside the ideal's (its before/after machinery); the Cut card carries the same two pictures, or
the delta line when they are within the material threshold. The simulation is the same one the
goal check reads — the owned plan's numbers are the seven lines' numbers.

**5. The operator's choice is recorded on the job; the owned plan is the default.** The job stores
which plan the operator chose (`ideal | owned`, with the plans' keys), so a re-run reproduces the
choice. The default is the owned plan — fix the default before adding a control. The ideal is a
recommendation ("a ⌀0.6 flat would give vertical walls"), never a pass condition.

**What this means for #961.** The cost-ranked sequence is run twice — once over the catalogue,
once over the inventory — and the card prints both. The stop rule and the seven lines judge the
OWNED plan; the delta to the catalogue plan is a stated line (on the tray today: 3 owned cutters
against Makera's 4). `sequence[].house` keeps meaning exactly what the caller put in
`input.cutters.house`; the two runs are two calls, never one mixed candidate set.

**What this means for #975.** The picker's rule is not "V when nothing else fits"; it is the best
outcome from the owned set with the ideal's outcome stated beside it. For a pocket narrower than
every owned flat and ball, the V cuts it as a **floor-correct pocket**: the floor is the model's
floor at the model's depth (−1.800) and outline (the stroke, exact at the floor plane), the walls
at the V's half-angle, and the **land taken per side at the surface is `depth · tan(half)` —
0.60 mm for the 90° bit — stated on the card as the V's own geometry**, not counted as a failure.
The gate reads the flanks as the **edge-break class** it already has (cells within the stated V's
reach of a design edge, no deeper than its leg): the plan names the V on the pocket so `whoAt`
answers it, and nothing on the flanks is adjudicated. The card prints the land per side and, beside
it, the vendor's T4 reading (−1.60, 0.20 mm above the model floor) — the vendor's approximation is
a yardstick, not the target. The ideal (vertical walls from a ⌀0.6 flat) is one line up when the
flank width is past the material threshold, which 0.60 mm is.

---

## 5. Linking (#962, C)

**C's real `linking.ts` (`cand/962`, landed).** `tour.ts`'s `tourNearest` is lifted from loops to
passes (`orderPasses`): nearest-neighbour + 2-opt, deterministic. The link decision itself (`link`)
is prior-art-sourced and stated as such in the module: Kiri:Moto's short-hop rule (a planar move
within 2 cutter diameters at the same Z stays down, as a hard permission guard, never a preference)
and FreeCAD Path's `KeepToolDownRatio` (default 3.0 — a stay-down detour may cost up to 3× the direct
distance) and collision-tested clear height. The material test is C's own: the caller supplies
`MaterialField.topAt(x, y)` (the stock top after every preceding op); `linkIsClear` samples the WHOLE
cutter disc along the segment, not the centreline, so a wall or ridge just inside the radius still
blocks it — a link the field cannot prove clear always retracts, never "probably fine." A blocked
short hop may still go around a `dogleg` waypoint when FreeCAD's ratio pays for the detour; otherwise
`retract` goes to the region's own `clearanceZ` (`RegionRef.regionClearanceZ`, §3.0.1), traverses as a
rapid, and plunges. **Vertical legs use `feeds.plungeFeed`, not `feeds.feed`** (Review B's F8: the old
engine's staircase corner fed a near-vertical leg at the cutting feed) — every retract/plunge in
`link()` is `plungeFeed`; §2's CL-surface staircase rule carries the equivalent rule for a vertical
inside one region's own drop-cutter sampling, and the two don't need to know about each other.
`linkPasses` orders and joins a whole op's passes in one call — the first pass has no incoming link,
since the program's entry is the op's own start, not a link between regions.

Target on the references (plan v2 §3): rapids per 1,000 feed lines ≤ 2× Makera's; air fraction ≤
Makera's + 10 points. `linking`'s three numbers in `SetupPlan` (§3.0) are exactly what the run sheet's
efficiency line reads (§3.6's point 6, above).

---

## 6. No budgets

Memory is proportional to the mesh (the triangle index, §2) and to the CL grid the engine itself chose
per operation (§2, §3.0) — not to a fixed-pitch global grid. A stall guard only: a wall-clock or
iteration ceiling on the planning loop itself (not a cell-count or memory ceiling on the geometry), that
reports which op was running and refuses to proceed, rather than silently coarsening a pitch the way
`DEFAULT_MAX_CELLS` does today (§0). Plan v2 §5.3: "a refusal on memory or time is a defect in the
method, filed as such; caps are not re-priced" — a stall guard firing on a reference part is a bug
report against this engine, not a number to raise.

---

## 7. Acceptance — plan v2 §3's seven lines, on the Makerables references (#955), amended per A's review

For the tool tray and tool organizer, Makera's own NC scored on our checker, then ours on the same
checker:

| line | pass |
|---|---|
| coverage (top-surface per side; **whole-surface after all setups for figures**, per the maintainer's ruling) | ≥ vendor − 1 point, and ≥ 95% |
| cut-into | 0 beyond the edge-break allowance — **sequenced per A's R4, below**, not a day-one line |
| cycle time (the app's own estimate, #927) | ≤ 2× the vendor's; goal 1.25× |
| air fraction | ≤ vendor's + 10 points |
| rapids per 1,000 feed lines | ≤ 2× vendor's |
| cutters | **ruled, A's R5**: simulation-only reference cards (this table) are priced on **the vendor's own cutter set** — the method comparison, not the house's catalogue — ≤ vendor's count + 1; bench cards (the five sticks, no vendor program to compare against) are priced on the **house's** cutters only, with no "+1" since there is no vendor count to add one to |
| posts as filed | yes, in the vendor's own holding, without an operator changing the pitch |
| **placement (new, A's R2)** | the app's own placement of the goal (§2, `placeTarget`) agrees with E's Makerables `--dz` reading within 0.01 mm |

**The edge-break allowance's leg is read by the gate, never from this engine's plan output (A's R3).**
Both sides read the **same job field** independently: this engine's chamfer op (§3.5) sizes its cut
from `ModelPlanInput.edgeBreak` (§3.0, the job's stated edge break or a shop constant), and the gate's
allowance reads that same job field through its own path, capped by the chamfer Tool record's own
geometry. Neither derives its number from the other's plan output — `ModelTolerances` (§3.0, corrected)
no longer carries anything edge-break-related at all.

**"Cut-into 0 beyond the allowance" is sequenced, not a day-one line (A's R4).** On today's checker,
Makera's own tray NC — *without* its chamfer tool — already reads 0.44% cut-into beyond 0.1 mm
(boundary/slot sampling artefacts, #955); the organizer reads 1.55%. A "zero" line the vendor's own
program fails proves nothing about this engine. Order:
1. V2-2 (A's edge-break allowance) lands in both checkers.
2. Makera's own NC reads 0 beyond the allowance on the same checker.
3. Only then is this engine held to 0.

Until step 2 lands, the card prints this engine's **non-chamfer** reading beside the vendor's
**non-chamfer** reading, named exactly — not the all-tools reading, which includes the chamfer's own
deliberate edge breaks and would let a real gouge hide under it (the tray's all-tools reading is
3.08%, entirely the chamfer; its non-chamfer reading is the 0.44% named above, the organizer's 1.55%).
The line reads "≤ the vendor's own non-chamfer reading (0.44% tray / 1.55% organizer)" until step 2,
never a bare "≤ the vendor's own reading".

**The tray's setup (A's N3):** `setups = [top]` — the uncut underside is recorded as the vendor's own
intent (§1, A's §1 note on the recess Makera's program leaves) and is **not scored**, on either side.

Then the coasters, badge and top clamps (already-passing 2.5D classes, re-run through `cam/model/` to
prove §3's ops are a drop-in, not a rewrite of what already worked), wild-spirit relief for surfacing
only (no multi-setup; §8 — rotary/primitive relief is ruled out of this rebuild's scope, so "relief"
here means a mesh goal through `cam/model/`, not that code path), then the elephant and panther at
stick scale on the maintainer's whole-surface line (plan v2 §7.1), after the setups the app itself
proposes — #965, after this note, not part of it.

**The stop rule applies here too** (plan v2 §5.5): a package whose cycle estimate on its reference is
more than 3× Makera's is not "done" whatever its coverage reads.

---

## 8. Seams and removal

`cam/model/` lands behind `generateGoalPrograms`'s existing call shape (§0, §3.0) — no change to
`generateOneProgram`, confirmed already true for the 3D path, not a thing to preserve by discipline
alone.

**What #966 actually deletes, and what it cannot** (the corrected version of this section — the first
draft of this note said "delete `surface3d.ts`, `rough3d.ts`"; that is wrong, checked against every
importer):

- `GoalHeightfield`, `sampleGoalHeightfield` (`surface3d.ts:129`, `:283`), and — checked, not named by
  guesswork — every other export `goalCheckField.ts` pulls from the same import line (`isMold`,
  `moldHeightfield`, and `sampleImageHeightfield` for the PNG-goal path, `:24,65`) are **not
  CAM-planning private.** The same functions sample the goal for the independent gate's own stamp:
  imported (directly or via the type) by `designCheck.ts`, `goalCoverage.ts`, `goalCheckInput.ts`,
  `goalTopFace.ts`, `oracle.ts`, `cutterPlan.ts`, `runSheet.ts`, `session.ts`, `goalCheckField.ts`,
  `thumbnail.ts` — nine files outside this engine, several of them the gate machinery §3.6's point 7
  requires to stay independent of `cam/model/`. **Filed as #967 (owner C, measurement column), ruled
  by the manager on A's review, on four conditions A set:**
  1. A pure move — the golden and every goal-check number on the corpus unchanged; the page and app
     still agree cell for cell.
  2. Lands **before** any `cam/model/` code.
  3. The new module (`engine/cnc/engrave/goalHeightfield.ts`) joins §3.6 point 7's gate-root list.
  4. `surface3d.ts` may keep importing it until #966 retires that file; `cam/model/**` never may.
- `rotaryRelief.ts` and `primitiveSurface.ts` import only `DEFAULT_GRID_PITCH_MM`/`DEFAULT_MAX_CELLS`
  (and, for `primitiveSurface.ts`, the `GoalHeightfield` type) — not the planning functions. These are
  a different goal class (rotary/cylindrical relief carving, and cone/sphere primitives) that plan v2
  does not name as M2 or M3 scope. **Ruled (manager, 2026-11-04): out of scope**, this note's default
  taken as-is. These two keep their own grid-pitch constants, moved beside #967's extracted
  heightfield module, never into `cam/model/`.
  **Correction (Session A, 2026-11-05):** the claim above about `rotaryRelief.ts` was checked
  against the actual code and found wrong — it also imports `finishTipField`, `finishingMoves`,
  `DEFAULT_MAX_FINISH_TIP_OPS`, `DEFAULT_STOCK_TO_LEAVE_MM`, `SurfaceFeeds` and `SurfaceTool`
  directly from `surface3d.ts` for its own CAM-over-the-field stage (R-2) — real planning
  machinery, not grid-pitch constants. Since rotary relief stays out of scope and those two
  functions are genuinely "the rough/finish tip-field logic" §8 elsewhere names for retirement,
  deleting them with the rest of `surface3d.ts`'s planning functions would break a kept feature.
  **Ruled (manager, 2026-11-05): extracted as a pure move**, same pattern as #967's heightfield
  extraction — `finishTipField`/`finishingMoves` and their own constants/types now live in
  `cam/surfaceFinishTipField.ts`, beside `rotaryRelief.ts`; `rotaryRelief.ts`'s own specs and golden
  pins are unchanged, and `cam/model/**` never imports it either (`gateImports.spec.ts` pins both
  rules the same way it already pins the heightfield one). `primitiveSurface.ts`'s own claim checks
  out — it does not import from `surface3d.ts` at all.
- `adaptivePool.ts`, `poolSizing.ts`, `levelPlannerPort.ts`, `adaptivePool.worker.ts` depend on
  `rough3d.ts`'s `LevelPlanRequest`/`LevelPlanResult`/`LevelPlanShared`/`LevelPlanner`/`planLevel` —
  checked, and these are the worker-pool plumbing *for* `rough3d.ts`'s own per-level planning, with no
  other caller. They are deleted together with `rough3d.ts`.
- With the heightfield sampling extracted, `surface3d.ts`'s remaining planning functions
  (`generateSurface3dForGoal`, `generateSurface3dIR`, the rough/finish tip-field logic and its budgets,
  §0) and all of `rough3d.ts` are deleted in #966, together with the `goal-program-too-big` family
  (§3.6's point 4 above).

**Correction to A's #958 draft interface:** none needed — read in full (§1), A's `FeatureTree` shape is
adopted as-is; this note's only addition is the `setups[]` wrapper (§3.0), which does not change
anything inside `FeatureTree` itself.

**Ruled (maintainer, 2026-11-05, #943): no second engine.** The old heightfield engine (`surface3d.ts`'s planning functions, `rough3d.ts`, their caps and presses, the `goal-program-too-big` family and every budget constant) and all six flags (`USE_MODEL_CAM_ENGINE`, `CASEMAKER_MODEL_CAM`, `VITE_MODEL_CAM`, `setModelCamEnabled`, `window.__caseMaker`, `setupsOverride`) are retired. The first five went in the removal commit; `setupsOverride`/`modelSetupsOverride` stayed one commit longer as a documented test-only seam and are retired by #1004 (2026-11-06): `generateGoalProgram`'s post-and-verify tail is now `postModelPlan`, and the multi-setup specs call build -> edit `input.setups` -> `planModelCam` -> `postModelPlan` — there is no option that bypasses `buildSetupSpecs`' decision. The package lands with the seam calling `planModelCam` unconditionally, and nothing falls back. Figure and demo cards re-score on the new engine at whatever they read. #966's acceptance is that removal commit; it is no longer gated on the two parts passing. #967's extraction keeps the gate's sampler.

---

## 9. Licences

**Kiri:Moto** (GridSpace `grid-apps`, read at `d138275bbe` — A's #958 — and independently at the
current `master`, matching): the repository root `license.md` states the MIT licence text in full.
Every CAM-mode source file read by either of us (`src/kiri/mode/cam/core/ops.js`, `core/op.js`,
`work/op-level.js`, `op-rough.js`, `op-contour.js`, `op-outline.js`, `op-pocket.js`, `op-trace.js`,
`slicer-cam.js`, `topo3.js`) carries the header `/** Copyright Stewart Allen <sa@grid.space> -- All
Rights Reserved */` — no SPDX tag, no MIT reference, in the file itself. A raised this discrepancy
first (#958 §1, §7 Q2); the manager put it to the maintainer. **Ruled (maintainer, 2026-11-04, via the
manager): Kiri:Moto is a local reference only — read and cite its methods, no code copied into the
tree, the same tier as OpenCamLib and PyCAM. Plan v2's "port with attribution" is withdrawn.** This is
not a pending default any more; this note already held to the reference-only stance throughout (§1's
"ports ideas, not code, attributed in comments" for the feature-recognition area-clearing pattern —
`zFlat`, the shadow stack — carries forward unchanged), so the ruling confirms this note's own
position rather than changing it.

**A correction to plan v2 §4/§6.** The maintainer's ruling above withdraws "port with attribution"
outright, which makes the question below moot for §2 either way — Kiri:Moto is cited, never ported,
full stop. The technical finding stands regardless, because it says what Kiri's code actually does,
which matters for an honest citation even under a reference-only rule: plan v2 named Kiri:Moto as the
M3 port source on the strength of its licence and its general CAM-mode existence. Read against its
own parameters (`op-contour.js` → `topo3.js`'s `Topo.generate`, whose
options are `contourX`/`contourY` (an axis choice), `animesh`, `flatness`, `tolerance`, `density` — an
axis-aligned scan-line parameter set, not a per-cutter-geometry drop-cutter call) and against
`op-rough.js` (2.5D stepdown clearing of a projected `shadow.base` silhouette at a Z-level list, not
roughing against a CL surface), **Kiri:Moto's 3D "contour" op is a raster line-scan over one axis, not
a drop-cutter CL surface.** This note read the entry function's parameter list and imports for both
modules, not their full bodies — stated at that level of confidence, not claimed as a full audit.
Porting `topo3.js`/`op-contour.js` for §2 would reintroduce a version of the scan-line heightfield
method this engine retires (§0). **Kiri:Moto is therefore not the port source for §2**; its real
relevance is to §1 (A's note already uses it this way: `zFlat`, the shadow stack) and to the Z-level
stepping pattern in `op-level.js`/`op-rough.js`, which §3.1/§3.3 already get from the existing
`pocket.ts`/`profile.ts` and the new rough-against-CL-surface op respectively — so even where Kiri is
relevant, no op in §3 depends on a line-for-line port of it. **Every method cited in §2 and §3.3/§3.4 is
OpenCamLib's description** (`BatchDropCutter`, `PathDropCutter`, `Waterline`'s push-cutter + weave, all
LGPL-2.1, re-implemented from `opencamlib.readthedocs.io`'s description, no OpenCamLib source read or
copied), not Kiri:Moto's.

**The two-implementation gap this correction opened, closed (manager, 2026-11-04, on A's finding):**
with Kiri:Moto out as a drop-cutter reference, §2's CL surface had one named source, OpenCamLib, not
two (plan v2 §5.1). FreeCAD's Waterline operation's second, "experimental" path (built on FreeCAD's own
area class, not OpenCamLib) was checked and is not usable — FreeCAD's own documentation states it does
not handle overhangs correctly and returns paths for an end mill only. **A found the real second
reference: PyCAM** (`SebKuzminsky/pycam`, GPL-3.0, pure Python) — `PathGenerators/DropCutter.py` with
`Cutters/CylindricalCutter.py`, `SphericalCutter.py` and `ToroidalCutter.py`, covering flat, ball and
bull. Plan v2 §5.1 is met for those three cutter types; **the V cutter has OpenCamLib alone** — PyCAM's
cutter set has no cone. Both OpenCamLib and PyCAM are reference only, under their own licences
(LGPL-2.1 and GPL-3.0 respectively): F's #964 runs **both programs offline**, with their scripts and
versions committed and only their numeric outputs kept — no source from either enters the tree. Where
the two disagree beyond tolerance, F's harness flags the case rather than averaging it. The maintainer
may still want to state separately that generating reference numbers this way, from GPL/LGPL programs
run but not linked or copied, is acceptable.

**OpenCamLib** (`aewallin/opencamlib`, LGPL-2.1): algorithm reference only, per plan v2 §7.4 and
unaffected by the Kiri question above. `BatchDropCutter`/`PathDropCutter` and `Waterline` are the
sources for §2 and for any constant-Z slice in §3. No LGPL code enters the tree; the result stays
Apache-2.0.

**FreeCAD Path** (`Path/Op/PocketShape.py`, LGPL-2.1-or-later — A's #958 §1): the source for §1's
boolean-on-sections lesson. Description only, no source copied.

**Ruled (maintainer, 2026-11-05, #943): reference numbers from GPL/LGPL programs — yes, numbers only.** OpenCamLib (LGPL-2.1) and PyCAM (GPL-3.0) reference outputs are generated offline. Their generator scripts and the program versions are committed, and only the numeric outputs are kept in the tree. No source from either program is copied or linked. Kiri:Moto stays a local reference only. The parity fixtures' header states the same rule.

---

## 10. Rulings since the landing (2026-11-06 → 2026-11-09) — the design record

*Added 2026-11-09 by the review session from the rulings on #1041, #1073, #1092, #1093, #1094, #1096,
#1097, #1111, #1114 and #1115. Each entry: the rule, why, where it lives, and its status. The threads
on those issues hold the measurements; this section holds the decisions.*

### 10.1 The rest op is two spaces, not one mask (#1092, landed on `1092-plane-is-goal-surface` fd79ac9f, in land14)

`ops/rest.ts` stated "rest by CL difference" and then sampled it as one cell mask pocketed with
`pocketLoops`' radius inset. Five rounds of cell predicates (a per-cell `aboveMaterial` ceiling,
goal-top-above-floor, closed-over, a reach witness, a safe-spot test) traded the same two cases against
each other: set B's 12 mm wall-foot strips (correct work, must be kept) and j29's buried discs (20 mm
into the body, must be killed). In cell space those are the same thing — a cell beside higher goal; only
the cutter's disc tells them apart.

**The rule.** For a rest level `z`, previous cutter P (radius R), rest cutter N (radius r):
- **work, material space:** `L(z)` = cells where P's **stamp** (its CL surface dilated by its own disc —
  the `MaterialField` the linking reads) stands above `z`;
- **admissible centres, CL space:** `A(z)` = cells where N's **drop-cutter tip over the goal**
  (`finishTipField`'s primitive: nearest-point stencil, ball rise where N is a ball) is `≤ z + stockToLeave`
  — over the goal, never a region floor;
- **path:** `A(z) ∩ dilate(L(z), r)`, traced without a radius inset; links through `link()` as before.
The region's floor is a lower bound on `z` only; it never admits a move (j29's pocket-0 floor was stated
−26.1 where the goal is −1.36 — a separate region defect the rule must be correct with or without).

**Three amendments on landing.** The drop-cutter primitive moves to a neutral module (`cam/dropTip.ts`)
so the planner never imports the gate's `surfaceFinishTipField` (#964's reverse import rule). The tip is
computed **per rest region**: `restTipField` builds its window on the region's bbox grown by
`2·radius + pitch`, copies the goal cells inside it, and caches the field per `(cutter key | region id)` —
a whole-goal field at 0.1 mm needed 1.2e9 stencil reads against the 3e8 budget of the time and silently
refused every region. And the field is an **exact grey-scale dilation**, not a brute stencil: for a flat
cutter a sliding-window maximum along each row of the disc (van Herk/Gil-Werman — 33 rows for a ⌀3.175 at
0.1 mm where the stencil counted 853 cells, bit-identical because a maximum over the same values is
order-independent); the ball keeps the stencil. The budget therefore has **two units with their own
ceilings**: FLAT = grid cells × rows in the disc against **150 M**; BALL = covered cells × stencil cells
against **300 M**. A budget refusal is a stated finding, `rest-region-over-budget`, typed on the plan's
last setup — error when the shop's coverage line (`restVisibility.share`, fallback
`REST_MACHINING_FALLBACK.thirdToolFraction`) is crossed, warning under it — joined with the finish's
measured leftover (#1023), with its row in the CNC guide.

**Evidence.** j29 card: cut-into 0.0 %, blocks 1–5 absent (dave-1 and k3). Set B: top p5 does more of the
rest work it owed (leftover > 1 mm 0.21 → 0.13 %, volume −31 %, cut-into unchanged at 0), bottom p2 +0.7 s,
the other 12 byte-identical — accepted and re-keyed on the land14 tree. Red-first specs: the tangent
strip (CL at `wall − r` along every wall), the one-cell sliver beside a body (no move whose disc covers
body), the region lie (same output).

### 10.2 The owned set, one list, and the pick among equals (#1041 landed; #1111 narrowed; #1114/#1115 open)

- **Owned = `inv:` + `user:` + the chosen tool; `cat:` never enters the owned plan; built-ins only when the
  inventory is empty, stated on the plan** (#1041, landed 2026-11-07).
- **Both doors see one list** (#1111). The app's registry (built-ins + the house's `cat:` + `inv:`) and the
  CLI's (`--location`, no catalogue) held the same 35 owned cutters in **different orders**:
  `dedupeCutterEntries` keeps the `inv:` entry but in its `cat:` twin's position, and the ball rank's
  stable sort let the first same-diameter cutter win. Rule: dedupe returns a **canonical order** (tier, then
  key); the CLI registers the catalogue as `cat:` too (ideal-plan parity); the ball rank's tie requires a
  **reach-margin gate** — `fluteLength − deepest cut ≥ reachMarginMm` (shop setting, recommendation 1.0 mm,
  from the Z-datum class) — so the 10 mm ball with 0.387 mm of margin at 9.613 mm deep loses to the 22.
- **What is NOT ruled: which cutter wins among equals that all pass the gate.** Three stated keys each
  produced a different tray plan (longest flute → a 42 mm O-flute roughing on a 1/8" shank; shortest
  sufficient → two new bits; key order → the 4-program plan). That is a shop-policy question — stiffness,
  reach, bit changes or time — and it changes which bits the maintainer loads, so it went to him as
  **#1114** with the three measured plans. Until it is answered, `chooseSequence`'s primary,
  `reachingFlatFor` and `restBallFor` pick by the canonical order and the rank row says so: "same diameter:
  by key, pending #1114" (#1115 adds the row text). Set B's table is versioned with the rule (13 files on
  the land14 tree).
- **Lesson:** "same set" is not "same list"; a rank that stable-sorts a registry snapshot inherits arrival
  order as a silent key; every tie names its key on the sheet.

### 10.3 Program files: one name, in cut order (#1093, landed in land13)

`releaseFileName(stem, index, total)` is the only function that names a program file — Save, the run sheet,
the release store, the run record and the CLI all read it: `total ≤ 1 → <stem>.nc`; otherwise
`<stem>-p<index>.nc` with the index **zero-padded to the width of `total`** (`p1…p5`, `p01…p19`), because
the machine's file list and every folder sort by name and `p10` before `p2` is how a tab release runs before
the cuts. With N > 1 the file bar offers **Save all** only (a folder where a directory picker exists, else
a zip, from one `programFiles()` list the release store also uses); per-program Save lives on the sheet's
rows; the run record lists every program's name and hash (program 1's fields kept for back-compat); a frame
file sits beside every program that produced one. One file per setup was ruled out: it would change the
release's per-file vacuum span and bit-change pause, and Makera Studio plays one file at a time anyway.

### 10.4 The rotary rough's clamp is a drop-cutter tip, once (#1094; #1096, #1097)

`aSweepRoughing` clamped each cell at `max(layer, goal + allowance)` — the cell's own angle only — so the
ball's flank cut 11 mm into the panther's body beside a near-axis cell. Rule: **one** precomputed
drop-cutter tip of the goal-plus-allowance (`finishTipField` over the radial map with `wrapRows`), and each
layer reads `max(layer, tip)` — not a per-layer stencil (G's measured 12.97 s) and not a 1-D angular clamp
(9 mm residuals). The receipt's 83 % "coverage" on the gouging rough was the flank reading as within
tolerance; the honest standing stock has three causes none of which is the rough's: the ⌀2 ball's 0.107 mm
cusp at 0.9 mm step-over against a 0.1 mm band, a goal whose axis runs alongside the body (39.5 % of the map
hit by no ray, 11.25 % within 2 mm of the axis — **#1097**, a design question), and tight concavities.
The 36 near-axis "pinholes" were the sampler's: seam-straddling footprints cast 0.164° (1.6 cells) off their
row because `ny·pitch ≠ 2πR` (**#1096**, landed in land13: the row's own angle).

### 10.5 The flip: the fixture is never reflected (#1073)

`flipReflection` reflects the blank's **contents** — the goal copy, the tab bands, the locating bores
(X 156 → 4 on a 160 blank), the release path — never the fixture or the stock envelope. The bracket's arm
and back clamp are bolted to the bed; the operator re-seats the turned blank's new left edge against the
same arm, and side 2's origin is that corner (the pins at X 4 say the same), so the arm is at X ≤ 0 in side
2's frame exactly as in side 1's. A side-2 `bracket-in-path` that side 1 passed is the flip working:
side 1's right margin becomes the margin against the arm. Also ruled: the locating bores are through holes
cut to the job's through rule (`thickness + breakthrough`, 0.3 mm into the board); the chip clearance was a
blind-bore number with no object; the finding, the sheet and the NC say one depth.

### 10.6 Verdicts never excuse silence

A plan that drops a region, a cutter or a run must say why on the page, whatever the coverage line reads:
land14's tray passed at 98.80 % while every rest region had been refused for budget. New diagnostic codes
get their row in the CNC guide (the house rule, enforced by `cncGuide.spec.ts`).


## Status

The full history of this note's amendments (what changed, when, on whose review, and why) moved to
its own comment — [6620931732](https://github.com/SlyWombat/CaseMaker/issues/956#issuecomment-6620931732)
— once this file approached GitHub's comment-size cap. New status entries are appended there, not
here. Current state, in brief: the maintainer's go landed (6620383859); the `cam/model/` skeleton is
pushed and reconciled with C's real #961/#962 (`957-cl-surface` @ c792c0ec) and matches F's parity
harness (`cand/964b` @ 9f65797a) field-for-field; #957's real CL-surface algorithm is next, on a
branch off `cand/964`'s `a17b27f4`.
