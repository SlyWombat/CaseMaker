# 3D machining from a shape — the dry scaffolding (#222)

> **Status: Design.** The plan for making "give it a 3D shape and a block of stock, dry-model
> it now, cut it when the bench is free" buildable in **bench-free slices**. The maintainer
> authorised advancing the 3D path now, dry-modelling and UI first, ahead of bench time.
> Nothing here needs the machine except the one slice that is explicitly carved out for it.

## Contents

1. Today — what already exists, with evidence
2. The grid-resolution decision (#222 entry condition) — and its blocker
3. The slices — each dry-verifiable
4. Migration order, and the maintainer's ordering

---

## 1. Today

The surprise of the audit: **most of the simulation half of #222 is already built.** The gap is
narrower than "no 3D at all."

**The dexel engine exists and already runs.** `src/workers/geometry/columnEngine.ts` is "one
engine, two parameterisations" (decision R7). The **FLAT** parameterisation — columns over
(x, y) holding the remaining top Z, i.e. the dexel — is implemented, not reserved:
`export const FLAT: ColumnParameterisation = { kind: 'flat', buildGrid(...), applyMove(...) }`
(`columnEngine.ts:619`), beside `ROTARY` (`:486`). Cost scales with cells touched per move, not
with Z levels.

**And it is already wired into live sim** — for the tools the exact sweep cannot do.
`session.ts:409` routes to `columnSweep` when `timeline.summary.rotary || sweepsOnColumn(tool)`,
and `sweepsOnColumn` (`session.ts:289`) is `isVShape(tool) || tool.shape === 'drill' ||
tool.shape === 'thread'`. So V-carve, drilling and thread milling are **already simulated on the
FLAT dexel today.** The backend, the grid, the mesh-out, the transport and the viewport all work
over it.

**The grid-resolution knob exists** (#438): `COLUMN_FLAT_PITCH_Y_FALLBACK_MM = 0.1`
(`columnEngine.ts:341`), surfaced as the shop default `sim.columnFlatPitchYMm`
(`platform/defaultsClient.ts:263`, `z.number().min(0.05).max(0.5)`, fallback 0.1). The X pitch is
the move's own `dx`. So resolution is already a per-shop, labelled number.

**What is missing for a 3D *shape*, precisely:**

- **Ball / bull-nose are refused.** `sweepsOnColumn` does not include them, and the exact sweep's
  tool reader refuses them (`tool-refused`, `sweep.ts:776`; `verify.ts:661` notes a ball/bull
  "can neither sweep nor trace"). A ball is exactly a height profile over its radius — the FLAT
  dexel's `applyMove` already subtracts a non-flat footprint for the V-cone — so admitting it is a
  tool-reader change, not a new engine.
- **A dense 3D program is refused, not routed to the dexel.** `MAX_CHECKPOINTS = 1000`
  (`sweep.ts:87`) classifies a job with more causal runs than 1000 as "a 3D or dense job" and
  refuses it **by name** (`too-many-checkpoints`), leaving a path-only session (#194). The dexel
  engine that *could* draw it is never reached, because a flat end mill on a prism does not trip
  `sweepsOnColumn`. The fix is routing, not a new backend: a dense flat job goes to FLAT, not to a
  refusal.
- **Nothing generates a 3D toolpath.** `cam/ir.ts` is `frame: 'flat' | 'rotary'`, linear moves,
  no arcs; no CAM module emits a surfacing path. `cam/adaptive.ts` exists but is **not imported by
  `engraveGenerate.ts`** (#433, not wired). There is no raster-roughing or ball-finishing pass.
- **A 3D model is a *reference*, not a goal.** `types/engraveJob.ts`'s `EngraveTargetObject`
  (STL/3MF) is embedded as a reference and is **not cut** (`target-object-not-cut`,
  `engrave/jobSetup.ts`). "Make this shape" needs the mesh as the **target surface to reproduce**
  — a heightfield the roughing/finishing passes drive toward — which is a new input role.

**Verdict:** the dexel *simulation* is ~80% there (engine built, wired, gridded; needs ball +
dense-routing). The *toolpath generation* and the *3D-as-goal input* are greenfield but small and
self-contained. The UI is the only part that collides with other work.

---

## 2. The grid-resolution decision (#222 entry condition)

#222 names "a decision on grid resolution versus memory, measured on `TopClamp.nc` (482 levels)
and `PirateShip.nc` (6 683 levels)" as an entry condition.

**Blocker, stated up front: those two files are not on disk.** A tree-wide search finds no
`TopClamp.nc` / `PirateShip.nc` / `Nefertiti` anywhere; they survive only as mockup captions in
`docs/assets/cnc-mockup.html`. #186 ("already fetched") did not land them in this checkout. **A
*measured* resolution-vs-memory decision is blocked until they are fetched** — that is the one
piece of this plan that waits, and it waits on a download, not on the bench.

**Provisional decision, to hold until the files land.** Memory is `nu × nv × bytes`. At the
default pitch (X = move `dx`, Y = 0.1 mm) a full Z1 bed (≈ 360 × 240 mm) is 3600 × 2400 ≈ 8.6 M
columns; at 4 bytes/height that is ~35 MB — comfortable. The real cost is *moves × cells-touched*,
which is why the dexel was chosen over the exact sweep's `MAX_CHECKPOINTS` wall. Proposal:

- **Default pitch 0.1 mm** (already the fallback), **cap the grid at ~16 M cells** and, above it,
  coarsen the pitch and **state the coarsened value in the UI** rather than refuse.
- **The dexel is sampled**, so every number it reports carries a resolution, and the oracle's ε
  band (#206) does **not** apply to it — the UI must say *"simulated on a 0.1 mm grid"*, never
  present a dexel volume with the exact sweep's confidence. This mirrors the existing
  "say which backend ran" rule.

The provisional numbers are safe to build against; only the *final* default is gated on the
benchmark files.

---

## 3. The slices

Each slice is bench-free and verifiable by **unit tests + dry modelling** (sim + a viewport
screenshot). The bench-dependent part — real cutting **feeds** for 3D engagement (#184, Studio's
table exceeds the Z1 spindle in 32 rows) — is carved into slice **F** and left for bench time.

Every slice below is **file-disjoint from the peer's panel/viewport work**
(`EngravePanel.tsx`, `EngraveCutSurface.tsx`, `EngravePreview.tsx`, `fixture.ts`, the engrave
e2e specs) — except slice **E**, which is held until that UI wave lands.

| Slice | Scope (one line) | Files | Depends on | Dry-verified by |
|---|---|---|---|---|
| **A** | Admit **ball / bull-nose** as a dexel tool profile (height over radius); include them in the column route; un-refuse in sim | `columnEngine.ts` (tool reader + `applyMove` footprint), `session.ts` (`sweepsOnColumn`) | — | unit: a ball move leaves a round-bottomed column floor; a bull leaves a filleted corner |
| **B** | **Route a dense flat job to the FLAT dexel** instead of refusing it — removes the "a refused 3D job gets no picture" gap (#194) | `session.ts` (route when exact sweep would hit `too-many-checkpoints`), `sweep.ts` (expose the classifier) | — | unit: a >1000-checkpoint flat timeline returns a meshed load, not `too-many-checkpoints`; sim screenshot of a dense relief |
| **C** | A **3D target input**: a mesh/heightfield as the shape to *make* (goal), distinct from today's reference object | `types/engraveJob.ts` (+ zod schema, both edits per the schema-strip rule), `engrave/jobSetup.ts` (new validation, drop `target-object-not-cut` when the object is a goal) | — | unit: a job with a goal mesh validates; schema round-trips |
| **D** | **3D toolpath generation**: raster roughing in step-downs + a ball-nose finishing raster over the heightfield → the IR | new `cam/surface3d.ts`, `cam/ir.ts` (reuse `frame: 'flat'`), `workers/sim/engraveGenerate.ts` (import + dispatch) | A, C | unit: generated IR reproduces a known heightfield within the step-over; the dexel sim of that IR matches the target within grid tolerance |
| **E** | **UI + viewport**: a 3D-job surface, the viewport dexel render, the backend/resolution indicator | the panel + a new `viewport` layer | B, D, **the panel redesign (#521/#523/#524) + viewport slices (#519/#526–#530)** | Playwright: load a goal mesh, generate, see the dexel preview + "simulated on a 0.1 mm grid" |
| **F** | **Bench feeds for 3D engagement** (#184) — the only machine-gated slice | `feeds.ts` / feeds table | D, bench | *bench* — coupon cuts; carved out, not built dry |

Slice **B** is the fastest win and is pure routing: it makes `relief-3d.nc`-class files *show a
cut picture* today, with no new engine. Slice **A** is what makes that picture correct for a
ball. **C + D** are the authoring/CAM greenfield. **E** is the only one that waits on the peer.

---

## 4. Migration order, and the maintainer's ordering

The maintainer's 2026-10-15 order (`docs/design/cnc-job-workflow.md` §8) is: finish passes (done)
→ cut-outs+tabs (#218) → drilling/threads/chamfer → adaptive (done) → **3D (#222)** → rotary
(CNC-5). #222 sits late **because its *cutting* is late** — the feeds and the first real 3D cut
belong after the V1 operations are proven on the machine.

This plan does not jump that queue. It builds the **dry scaffolding** — the simulation, the
toolpaths on paper, the input model, the preview — early, by the maintainer's explicit
authorisation, and leaves the **bench-fed cutting (slice F)** exactly where the ordering puts it.
The order to build:

1. **B** (dense → dexel routing) — a picture for every 3D file, immediately.
2. **A** (ball/bull as dexel tools) — that picture made correct for finishing cutters. *(A ball
   is in the house inventory already — `C1-BIT-BALL-NOSE-*`.)*
3. **C** (3D target as a goal input).
4. **D** (raster roughing + ball finishing → IR), dry-verified against C by B+A.
5. **E** (UI + viewport) — after the panel/viewport redesign lands, so it builds on the new rail.
6. **F** (bench feeds) — when the bench is free.

Steps 1–4 are file-disjoint from the current UI wave and can run as parallel worktrees now;
5 waits on it; 6 waits on the machine. The benchmark files (§2) are a blocker only for *finalising*
the grid default, not for any slice's construction.
