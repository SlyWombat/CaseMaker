# Fabrication — driving a CNC as well as a 3D printer

Status as of 2026-10-03. Decisions taken in conversation; nothing implemented yet.

**Review scope.** Fable's adversarial review produced decisions 12–18 and covers this
document as it stood at commit `d4369d7`. The print-orientation flip (§7.2), the §7
rewrite and decisions 19–24 all postdate it and have **not** been reviewed.

**Companion documents.** `/Simulation.md` is the detailed design for toolpath simulation
(#182), including the measured performance budget. `/Makera-Parity.md` is the capability
inventory of Makera Studio and the gap list — read it before planning any CAM feature,
because it is where the evidence for Studio's actual parameter surface lives.

This is the plan for expanding Case Maker from "compile geometry, write an STL" to
"compile geometry, then make it on a chosen machine" — initially a **Makera Z1**
desktop CNC alongside the existing FDM path.

---

## 1. The machine

Figures below are from Makera's own SQLite library (`t_MachineType` in
`%APPDATA%/MakeraStudio/makera_library.db`), **not** from `ControllerConfig.txt`.
That file opens with `### Carvera settings` and much of it is Carvera template
values that do not describe the Z1 — the 6-slot tool rack is the clearest example.
`safety_limits.json` is likewise a ceiling, not a spec: its `max_spindle_rpm` of
24 000 is nearly double what the Z1 can actually turn.

**Provenance rule for this document:** anything sourced from a Carvera page, a
Carvera-era config file or Studio's shared UI is marked as such. Z1 behaviour is
only asserted where it is confirmed by `MakeraInc/MakeraZ1Firmware`, a `Z1/*` wiki
page, or the machine's own database row.

| | Makera Z1 | (Carvera, for contrast) |
|---|---|---|
| Work volume | **200 × 200 × 100 mm** | 320 × 240 × 140 |
| Automatic tool changer | **none** (`isATC=0`, `ATC_Number=0`) | 6 slots |
| Max spindle | **13 000 RPM** (150 W, closed loop, 0.01 mm runout) | 15 000 |
| Max feed rate | **1200 mm/min** | 3000 |

Firmware is a branch of **Smoothieware** (`MakeraInc/MakeraZ1Firmware`), so the
G-code semantics are LinuxCNC-flavoured and documented.

### Hardware we have
- Base machine, the **wired probe** and the **3D Probe Rod** that ship with it.
- **The Makera 3D Probe** — a separate accessory, and the one that matters. See the
  warning below: it is *not* the 3D Probe Rod.
- **4th axis rotary module.** Work envelope ⌀80 × 150 mm. Belt-driven: fine for
  hobby work, with real compromises in rigidity and precision.
- **Low-profile vise** (confirmed 2026-10-03). Listed on `Z1/Accessories`. It matters more
  than it looks — see §7.3, where it may remove a V1 deliverable.

> ### ⚠ Three probes ship or are sold for this machine, and only one can touch off PLA
>
> They have nearly identical names, they all install the same way, and they all plug
> into the same connector. Picking the wrong one means **the printed-blank workflow
> does not work at all**.
>
> | | Probes | Materials |
> |---|---|---|
> | **Wired probe** (in the box) | Z only, plus surface levelling and area scanning | not stated |
> | **3D Probe Rod** (in the box) | X, Y and Z | **CONDUCTIVE ONLY.** "The workpiece must be electrically connected to the aluminum table via locating pins, screws, or other conductive methods" (`Z1/QuickStart`) |
> | **Makera 3D Probe** (separate accessory, **the user owns this one**) | X, Y and Z | "both conductive and non-conductive materials" (`Makera-Accessories/Makera-3D-Probe`) |
>
> So **decision 8 and §7.3 stand — but only because the user owns the separate 3D
> Probe.** The rod that came in the box cannot do it. #165 still verifies it on PLA
> rather than taking the page's word for it.

### Workholding, as the machine does it natively
`Z1/QuickStart` documents an **anchor-based system** this document had not accounted
for: an L-bracket pinned to the bed with two 4 mm dowel pins and three M5×20 screws,
the workpiece registered against its inner face and clamped at the opposite corner, and
**"the system will automatically detect the lower-left corner as the machining origin"**.
The first-job walkthrough sets "Work Origin relative to Anchor 1, with X Offset = 0 and
Y Offset = 0".

That is a hardware XY datum, which is exactly what decision 23 assumed did not exist —
see §7.3 for why probing is still the plan, and what would change that.

**Bit collars** also matter more than they look: they set the shank protrusion
(~12 mm by default) so that stickout is repeatable across tool changes. That is one of
the three unquantified terms in §7.6's Z chain, and the machine ships with a jig for it.

**There is a Z1 Pro.** `Z1/QuickStart` is written throughout for "Makera Z1（Z1&Z1Pro）",
but `t_MachineType` has only one `Makera Z1` row. Whether the Pro differs in any figure
this document relies on is **unknown** — #184 should not hard-code a single Z1 identity
without noting it.

### Hardware we do NOT have
- **No laser module.** The optional unit is 5 W / 445 nm. Everything laser is out
  of scope: `M321`/`M322`/`M323`/`M324`/`M325`, and Studio's `LaserImagePath` /
  `LaserVectorPath` strategies.

### Confirmed by the docs
- The 3D Probe's page states it "enables automatic X / Y / Z probing on both
  conductive and non-conductive materials" — which is what makes the printed-blank
  workflow possible at all. Note it is filed under generic Makera accessories and is
  *not* listed on the `Z1/Accessories` page (which names only the 4th Axis module,
  Vacuum Bed, Low-Profile Vise and Ionizer); the user has confirmed owning it.
- Using it is itself a tool change: remove cutter → fit probe → unplug wired probe
  connector → plug 3D probe → probe → swap back → `M491`. §7.6 explains why that
  chain's repeatability needs measuring.
- The **wired** probe *is* documented after all: `Z1/QuickStart` says it "supports
  automatic Z-axis probing, surface leveling, and machining area scanning", and that with
  the anchor system "it enables easy XYZ positioning". What it does **not** state is
  whether it touches off non-conductive material — so for PLA the separate Makera 3D
  Probe remains the one to use.
- **Work volume is independently confirmed.** `CarveraProfiles`'s Z1 FreeCAD machine
  definition gives X 0–200, Y 0–200, Z 0–100, matching `t_MachineType`. It also gives the
  kinematic chain — Y is the **table**, X and Z are the **head** (Z parented to X), and
  the A axis is a table rotary parented to Y.

---

## 2. Codes that matter

The published table at <https://wiki.makera.com/en/supported-codes> is **written
for the Carvera** — it says "clearance position on the Carvera", tags some codes
Carvera- or Air-only, and describes ATC behaviour the Z1 does not have. Every row
below was therefore checked against `MakeraInc/MakeraZ1Firmware`, and where the
firmware disagrees with the wiki for a no-ATC machine, the firmware wins and the
row says so.

Retrieval note: the Z1 wiki pages are **absent from `sitemap.xml`**. Reach them via
the wiki.js GraphQL page list (`{pages{list(locale:"en"){id path title}}}`), then
fetch the rendered HTML with a browser User-Agent. `single(id:)` content requires
auth; the rendered page does not.

The ATC-dependent codes branch in firmware on
`THEKERNEL->factory_set->FuncSetting & (1<<2)`. The Z1 has that bit clear
(`isATC=0`), so it takes the `// Manual Tool Change` path — which the firmware
implements deliberately, not as a degraded fallback.

| Code | Why we care |
|---|---|
| `G10 L2 P1` / `G54` | Set and select the work origin after probing. |
| `G38.2` | Standard touch probe move. |
| `G32 R1 X Y A B I J H` | Probe a **grid** and leave compensation active (`R0` off, `R1` on). `M370` clears it, `M375.1` dumps the data. Implemented by stock Smoothieware `CartGridStrategy.cpp`, and the firmware emits this itself at `ATCHandler.cpp:1473` — so it is a real Z1 path, not Carvera-only. It uses whatever probe is wired to the zprobe input. |
| `G92` / `G92.1` / `G92.4` | Offsets; clear offsets; manually set homing. |
| `G20` / `G21`, `G90` / `G91` | Units and absolute/relative. `G21 G90` is our default. |
| `G28` | Go to clearance position. |
| `G53` | Next G0/G1 in machine coordinates. |
| `M6 T<n>` | Tool change. `T0` = the probe, `T-1` = none. The wiki calls T0 the *wireless* probe (Carvera); on the Z1 tool 0 is simply "the probe", and `M491` keys off `active_tool == 0`. |
| `M490.1` / `M490.2` | **Not** collet tighten/loosen on a Z1 — that is the ATC branch. The manual branch makes `.1` = `set_tool_waiting(true)` plus a beep, `.2` = `set_tool_waiting(false)`. An **operator handshake**: "stop and wait for the human to swap the tool" / "done, carry on". `M490` with no subcode is an ATC-motor self-check. |
| `M491` | Run calibration; **resets TLO for the current tool**. **Not ATC-gated** — works on the Z1. This is the tool length sensor, and it is what makes manual multi-tool jobs viable. |
| `M497.<n>` | Sets a UI state flag only (`set_atc_state`); no motion. Subcodes name the setup workflow: 4 = margin, 5 = Zprobe, 6 = Autolevel, 7 = Done. Useful for telling the UI where we are; it does not *do* any of it. |
| `M600` | Suspend and wait for resume (`Player.cpp`). Separate mechanism from the `M490.x` handshake. |
| `M3 S<rpm>` / `M5` | Spindle. |
| `M7` / `M9` | Airflow. `M331`/`M332` auto-vacuum mode. |
| `M811`/`M812`, `M821`/`M822`, `M851`/`M852` | Spindle fan, light, extended port PWM. |
| `M220 S<pct>` / `M223 S<pct>` | Feed and spindle overrides. |
| `M482.4` / `M482.5` | Retrieve MAC / IP. |

`M801`/`M802` (internal vacuum) are **Carvera-only** — do not emit for the Z1.
`M861`/`M862` (beep) are documented Carvera Air-only.

### The manual tool change, as the firmware implements it
No ATC means a multi-tool job is a scripted handshake rather than an impossibility:

```
M490.1          ; tool-waiting status + beep — machine stops and waits
                ; operator loosens collet by hand, swaps the cutter
M490.2          ; clear tool-waiting — operator has finished
M491            ; re-measure tool length, reset TLO for the new tool
```

This is the whole reason multi-tool jobs stay on the table. It also means a job with
*n* tools can be a single `.nc` file with *n*−1 of these breaks in it, rather than
*n* separate files the operator has to launch in the right order.

### Output file format
Studio's `.nc` carries a self-documenting header, which the machine UI reads for
material, stock, time estimate and thumbnail. We emit the same (see
`%APPDATA%/MakeraStudio/GCodes/TopClamp.nc` for a full example):

```
;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=...|name=...
;@MKR|STOCK|id=cuboid|length=|width=|height=|diameter=
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=|y=|z=
;@MKR|CAM|id=CaseMaker|name=Case Maker|v=<ours>   ; Studio writes id=MakeraStudio here;
                                                 ; use our own unless the machine
                                                 ; turns out to require Studio's
;@MKR|UNIT|value=mm
;@MKR|TOOL|number=|id=|name=|type=|diameter=|...
;@MKR|TIME|seconds=
;@MKR|TOOLPATH|number=|tool_number=|name=
;@MKR|END
G90 G21
...
G0 Z15 / M9 / M05 / G28 / M02
;(thumbnail_image_begin)  <base64 PNG>
```

Origin defaults to the stock's **top-front-left** corner: it matches Studio's
`ORIGIN type_name=topFrontLeft`, and it is a landmark you can see on the part.

---

## 3. Data we read rather than reinvent

All of it lives in the user's Makera Studio install. **Read at runtime; do not
copy into this repo** (we ship LICENSE/NOTICE and care about provenance).

- **Feeds and speeds** — `t_MakeraCutterProperties`: 1328 rows over 129 tools in
  `t_MakeraCutterList`, keyed material × cutter, giving spindleSpeed, feedRate,
  plungeFeedRate, stepDown, stepOver, coolant.
- **Machine profiles** — `t_MachineType` (above).
- **Strategy vocabulary** — `%APPDATA%/MakeraStudio/configure/*.json` gives the
  full parameter shape of each Studio strategy: Contour2D/3D, Pocket2D/3D,
  Drill2D/3D, Chamfer2D/3D, Thread2D/3D, Relief3D, RotationRelief (and the two
  laser ones we're ignoring). Useful as a checked-against reference, not a spec
  to copy.

### Known-buggy baseline
Makera Studio 0.1.2.0 ("Beta") has needed local patching to run on this machine;
`MakeraStudio.exe.orig` sits beside the patched binary in the install — **keep
both**. Relevant here only as a reason not to depend on it, and for one detail:
Studio's own stock preview is **dexel**-based, which is independent support for the
representation chosen in §5.

---

## 4. Decisions taken

Decisions 1–11 were taken in conversation with the user. Decisions 12–18 came out
of Fable's adversarial design review and are corrections to this document's
earlier assumptions, each verified against the code or the geometry before being
accepted.

| # | Decision | Notes |
|---|---|---|
| 1 | **True 3D surfacing** eventually, not 2.5D only | Not in V1 — see §10. |
| 2 | **In-house heightmap/dexel engine** when 3D arrives | §5.5 states what it cannot do. |
| 3 | **Design for the 4th axis** | We own the module (⌀80 × 150 mm). Superseded for V1 by decision 18. |
| 4 | **No laser, ever (on this machine)** | Removes `M321`–`M325` and two strategy families. |
| 5 | **Images get two user-selectable methods** | Vector trace and greyscale relief. Not in V1 — V1 is text. |
| 6 | **Mesh import only to start (STL/3MF/OBJ)** | Behind a pluggable registry. Not needed for V1. |
| 7 | **Stock setup = corner find + Z touch-off, `G32` autolevel, model cross-check** | **Superseded in all three parts** — by decision 23 (edge-find on flats, not a corner), decision 12 (`G32` out) and decision 24 (no thickness cross-check). |
| 8 | **We have both the wired probe and the Makera 3D Probe** | Non-conductive probing is available, so PLA can be probed. |
| 9 | **First real job is a 3D-printed blank (PLA/PETG)** | The badge, literally. |
| 10 | **Transport is WiFi** | Still the chosen transport. **Not in V1** — see §10.1. |
| 11 | **4th axis: designed for, not built** | See decision 18. |
| 12 | **The depth window is bed-referenced; `G32` is not an input.** | See §7. **The clause "measured stock thickness is the required input" is superseded by decision 24** — after the flip, total thickness is not a job input at all. "Bed-referenced" survives and is strengthened: the printer's bed face *is* the engraved face. |
| 13 | **The blank must be printed 100 % infill, and its spec is part of the depth model** | See §7. |
| 14 | **V1 cuts with a flat end mill, not a V-bit** | A V-bit couples depth to stroke width, so per-label depth stops meaning what the UI says. V-carve is V2. |
| 15 | **Engravability is computed and rendered, not assumed** | Tool radius removes glyph detail; the viewport shows the *opened* region and the predicted colour. |
| 16 | **Glyph profiles use `NonZero` fill, as an opt-in field** | Not a change to the global `EvenOdd` default. |
| 17 | **No `Project.kind` union for V1** — `case.badge` as an optional field plus a `derivedKind()` helper | The old §5.1 premise was false. See §5.1. |
| 18 | **V1 is a vertical slice, and several agreed decisions are explicitly deferred out of it** | Deferring is sequencing, not reversal. See §10.1. |
| 19 | **Workholding is a printed nest, and it is a V1 deliverable** | See §10.3. |
| 20 | **Per-label depth is a two-state choice with a numeric override** | Two outcomes exist (top colour, bottom colour), so that is what the control should offer. Same reasoning as the X-ray toggle. |
| 21 | **The app loads the object; depth limits come from the solid** | No hand-coded pocket rectangles. A void in the geometry produces a shallower limit automatically, for this part and any future one. §7.1. |
| 22 | **The app models the printer's layer grid** | Layer height **and first-layer height** are inputs. The colour boundary and the depth limits sit on real layer lines, not ideal dimensions — because 0.810 mm is layer 4.05 and the difference matters, and after the flip the first layer *is* the engraved face. §7.1. |
| 23 | **Registration: probe everything** | Edge-find X/Y on two *straight* edges (the corners are R3.175 and make poor datums), then probe Z on the engraved face. The nest holds the part but is not a position reference. §7.3. |
| 24 | **Thickness error is ignored, by design** | The blank prints engraved-face-down, so error lands on the back face. Cut depths come from the probed face plus model distances. Total thickness is **not** a job input. §7.2. |
| 25 | **Build the `MachineProfile` now, even though the Z1 is the only machine** | Maintainer's call, 2026-10-03, overriding §5.3's deferral: pay for the seam once rather than recode later. Scope stays Z1-only; the profile is where machine limits get clamped and where "no laser on this machine" becomes a flag instead of an assumption. §5.3, #184. |
| 26 | **Workholding is an explicit input, and the probe plan is derived from it** | Supersedes decision 23's fixed edge-find sequence. The part may be in a nest, under clamps, in the vise or in the rotary chuck; each answers reachable / obstructed / datum candidates / residual uncertainty, and the planner queries the compiled solid for touch points. §7.3, #188. |
| 27 | **The blank spec makes the colour boundary slicer-independent** | Slicers sample each layer at its mid-plane, not its boundary, and the rule differs per slicer. So put the split on an exact layer multiple and give the pocket ceiling a one-layer conservative margin, rather than modelling one slicer's arithmetic. Costs a little depth band; removes a dependency on which slicer the user owns. #166, #178. |

---

## 5. Architecture

**Reuse, don't restart.** Keep the BuildOp/Profile IR, `evaluateOp` (Manifold), the
importers, the exporters, and the Tauri shell — which already carries `tokio` with
`net` and `axum`.

### 5.1 Correction: the flag model already expresses a no-PCB part

This document previously claimed that `Project` requires a board, that a part with
no PCB could not be a fourth archetype flag, and that this is why
`samples/badge-blank/make_badge.py` shipped as standalone Python. **That premise is
false**, and the code says so:

- `buildRackNodes(caseParams.rack)` never reads `board`
  (`engine/compiler/ProjectCompiler.ts:62-68`).
- `emptyBoard()` exists precisely to satisfy the required field with a placeholder
  (`library/templates/buildFromSpec.ts:13-25`).
- `protectiveCase()` already ships a no-PCB project through it
  (`library/templates/index.ts:69-80`).

So the badge went to Python for some other reason — most likely it was quicker for a
one-off — not because the model forbade it. The `kind` refactor is therefore **not on
the badge's critical path**, and putting it there would have been self-inflicted risk.

What V1 does instead, following the **v7 `hinge` precedent** (`store/projectSchema.ts:444-456`,
a purely additive `.optional()` field with a bookkeeping version bump):

- `case.badge?: BadgeParams`, optional on the type and the Zod schema. Templates get
  it free through `templateSchema.casePatch`, which is `caseParamsSchema.partial()`.
- A `derivedKind(project): 'rack' | 'stand' | 'badge' | 'shell'` helper that
  centralises the precedence **once**. The nine existing flag sites then read
  `derivedKind(p) === 'rack'` instead of `p.case.rack?.enabled`.
- Early returns in `compileProject`, `validatePlacements`, `hardwareList`, and the
  board placeholder hidden in badge mode exactly as rack mode does it.

The `kind` discriminant is still the right end state; it buys exhaustiveness
checking. It gets done when a third no-PCB part type arrives, at which point the
flags are already the derivation and the change is mechanical.

### 5.2 Correction: the seam is `PartPlan`, not a general `FeaturePlan`

The earlier proposal — every archetype's `compileProject` emits a general
"`FeaturePlan` of named regions with depth intent" alongside `BuildPlan` — is the
right instinct at the wrong altitude. It retrofits fourteen feature compilers
(`ProjectCompiler.ts:90-137`) to serve one consumer that only needs the badge, and
invents semantics nobody has asked for.

**What is true and worth keeping:** CAM must consume profiles and a target Z, never
a mesh. The compiler knows the region and the depth; a mesh discards both and forces
CAM to re-infer them.

**What V1 builds instead** — the seam sits *above* `BuildPlan`, for the part family
only:

```ts
interface PartPlan {
  stock: {
    outline: Profile;
    thickness: Mm;
    split: Mm;                                      // colour change height
    keepOuts: { footprint: Profile; zCeiling: Mm }[];  // the magnet pocket
  };
  engraves: { id: string; profile: Profile; depth: Mm }[];  // one per label
}
```

with two pure derivations: `toBuildPlan(part)` for the viewport, STL and 3MF, and
`toCamJob(part, tool)` for the `.nc`. **It takes no `measuredThickness`** — this document
said it did, and decision 24 says total thickness is not a job input. The signature was a
leftover from the superseded depth model. That is literally "a set of
2D profiles each with a target Z", which is what V1 is. Generalise when a second
consumer exists.

Two mechanics this document previously glossed over:

1. **`Profile` is a tree, evaluated only in the worker.** CAM needs flat polygons to
   offset. `CrossSection.toPolygons()` exists (`manifold-3d/manifold.d.ts:322`), so
   the CAM core runs in the geometry worker beside `executeProfile`, and the
   pocketing offsets are `CrossSection.offset` — the same Clipper2 already in use.
2. **Make the CAM core pure**: `(polygons, params) → ToolpathIR`, so it runs under
   vitest in node through the same wasm harness `scripts/export-sample.ts` already
   loads. The post (IR → `.nc` text) is then trivially snapshot-testable.

### 5.3 One machine profile — **in V1** (decision 25)

Machine knowledge is scattered across `PRINTER_PRESETS` (`engine/compiler/rackFit.ts:37-44`)
and a hardcoded `ASSUMED_NOZZLE` (`engine/compiler/fasteners.ts:303`). Unifying them behind
a `process: 'fdm' | 'mill'` discriminant is correct.

**This document previously deferred it** — "a single `Z1` constant in one file is enough
until a second CNC exists". The maintainer has overridden that: build the profile now, so
that supporting a second machine later is configuration rather than a refactor. **#184.**

Scope: **the Z1 is still the only machine we support.** The profile is the seam, not a
portability project. It carries what the rest of the plan already needs to ask:

- work volume, and whether a rotary module is fitted (⌀80 × 150 on the Z1);
- **spindle and feed ceilings** — 13 000 RPM and 1 200 mm/min. These are not optional:
  Makera's own tool table has no machine column and **32 rows exceed the Z1's spindle
  ceiling** (`/Makera-Parity.md` §5.1), so every feed and speed must be clamped against
  the profile before it reaches a toolpath;
- `hasATC` / tool-slot count — `isATC=0` on the Z1, which is what makes the
  `M490.1`/`M490.2` manual handshake the tool-change path (§2);
- **capability flags for hardware we do not have**, laser and vacuum among them, so that
  "this machine cannot do that" is a profile answer rather than an absence. Decision 4
  stays in force as a *scope* decision — no laser strategies are being written — but it
  stops being an assumption baked into the code.

Carvera and Carvera Air are already rows in Makera's own `t_MachineType` alongside the Z1,
so the profile's shape is known and does not have to be guessed.

### 5.4 Importer registry — deferred

One registry normalising to **mesh** or **profile set** is the right shape for
SVG/DXF/STEP later. V1 is text, so the existing `engine/import/assetImporter.ts` is
fine untouched.

### 5.5 How the heightmap engine reaches the 4th axis

Recorded for when 3D surfacing happens; nothing in V1 depends on it. A heightmap
generalises to rotary work by **changing coordinate system, not algorithm**: sample
**radius over an (A, X) grid** instead of Z over (X, Y). Drop-cutter becomes
drop-radius; the stock simulator becomes a cylinder. Studio's
`RotationReliefPath.json` is its 3-axis relief strategy plus a `reliefdirection` and
a `haveTailTop` flag, consistent with a reparameterisation rather than a different
engine.

What this approach cannot do in either coordinate system: undercuts, and simultaneous
4-axis motion. The A axis indexes or wraps; it does not interpolate with X/Y/Z.

### 5.6 Simulation is the pre-hardware oracle

**Sweep the selected tool along the computed toolpath, subtract it from the stock, show
before and after.** #182. This is in V1, and it is the single highest-value thing that
can be built before the machine is touched: it needs no bridge, no probe and **no
numbers from #165** — depth is an input, not a measurement.

**Full design: `/Simulation.md`.** The summary, and two corrections to what this section
said before it was measured:

The swept volume is **exact**, with no dexel grid and no sampling — and not only for a
flat end mill at constant Z. For any *convex* tool translated along a segment,
`K ⊕ [a,b] = hull(K+a, K+b)`, and every Makera tool category except the thread mill is a
convex solid of revolution (`/Makera-Parity.md` §3). So one rule covers flat, ball, bull,
V, chamfer and drill, at any Z, ramps included.

**Performance: see `/Simulation.md` §4, and note the retraction there.** This section
previously claimed "Clipper2 unions thousands of short glyph segments cheaply; Manifold
booleans do not", then replaced it with the opposite — that a single Clipper2 union is
quadratic. **Both statements were wrong**, the second because the probe behind it had a
clockwise capsule rectangle that cancelled its own end discs under `Positive` fill, and a
synthetic load confined to a 1.4 mm box. On a realistic raster the single call and the
union tree are within 30 % of each other. The settled position is that `simplify()` before
extruding pays, the tree is modestly faster, and neither library is the villain — the full
re-measurement lives in `/Simulation.md` §4.

**The rule that would have caught it:** assert a closed-form area or volume for one
primitive before measuring anything built from it. §5 of the geometry notes already said
this for two earlier Manifold traps.

**Correction, on scope.** Exact CSG is right for V1 but does not generalise to dense 3D:
Studio's own `TopClamp.nc` spreads 9 618 cutting moves over **482 distinct Z levels**, and
exact CSG needs an extrude and a boolean per level. That is the measured case for
decision 2's dexel engine, so `/Simulation.md` §5 puts both behind one `Sweeper`
interface from the start, and V1 implements only the exact one.

The reason it is an oracle and not a picture: §7.5 predicts the engravable region
*analytically*, as the morphological opening of the glyph. The simulator computes the
same region *from the toolpath*. **Disagreement means the toolpath is wrong**, and that
is a machine-free unit test — as is intersecting the simulated removal with the magnet
pocket void and asserting it empty. Volumes and bounding boxes snapshot cleanly, so none
of it needs an eye or a screenshot.

**It simulates the `.nc`, not the toolpath IR**, so a sign flip or an origin error in the
post-processor cannot pass through it, and so it can be validated against Studio's own
output before any of our CAM exists. That drops its dependency from #172 to #174's
parser. `/Simulation.md` §1.

### 5.7 Machine bridge — deferred out of V1

**Tauri-only** when it happens; the web deploy can write `.nc` but cannot open
sockets. Transport is **WiFi** (decision 10), with a transport interface behind the
protocol layer so USB can follow. `M482.5` returns the machine's IP and `M482.4` its
MAC, which is how we confirm we are talking to the right machine.

It must be developed and tested **from Windows** — WSL2's NAT will almost certainly
break UDP discovery, and the Tauri build has to run on Windows anyway (`CLAUDE.md`).

**Why it is not in V1:** Makera Studio already uploads over WiFi. Putting a
Windows-only development loop on the critical path buys nothing a working `.nc` file
does not already deliver. See §9.1 — this is the one place V1 narrows the original
brief, and it is deliberate.

**Correction: there is no protocol to reverse-engineer.** This section used to justify
the deferral partly as avoiding "a protocol reverse-engineer". Makera publish their own
controller client — **`MakeraInc/CarveraController`** — and its `src/` contains
`WIFIStream.py`, `USBStream.py`, `XMODEM.py`, `CNC.py` and `Controller.py`. The
transport, the discovery and the file-transfer mechanism are all readable. The
`Z1/QuickStart` manual also documents the connection surface: USB, the machine's own
AP-mode hotspot (SSID prefix `Makera Z1`), or a shared local network, with the WiFi
credentials pushed over **Bluetooth** from Studio or the mobile Makera App. So the
bridge is a smaller job than this document assumed — it is deferred on *sequencing*
now, not on risk.

> **⚠ Licence constraint, and it binds before anyone opens those files.**
> `CarveraController` is **GPL-3.0**. Case Maker is **Apache-2.0**. GPL-3.0 code cannot
> be copied or adapted into this repo. `CarveraProfiles` is worse: it carries **no
> licence at all**, which means all rights reserved.
>
> Protocol *facts* — port numbers, framing, command sequences — are interoperability
> information and fine to learn and reimplement. **Code, comments and files are not.**
> Write the bridge from a written-down description of the protocol, not with the Python
> open beside it.

**The platform seam it needs is #181.** The split follows what a browser physically
cannot do — raw sockets (this bridge), local filesystem reads (Makera's feeds/speeds
database, the filesystem board library in #131), and the embedded server controls.
Everything else stays on web, including geometry, CAM, the post-processor, the
verifier, `.nc` export, and fonts. Fonts were considered for removal from the web
build and **rejected**: opentype.js needs no platform capability, glyph outlines serve
case labels which are a core web feature, and the 1.1 MB payload is a loading problem
whose fix is #180. Build the seam before the bridge, so bridge work does not scatter
platform checks through the UI.

---

## 6. The geometry, ported

`make_badge.py` gets **ported into the app**, not called from it: Python is not in
the app toolchain, the Tauri shell has no interpreter, and this project's notes
already record a `python3` shim on one dev machine that reports wrong paths.

`engine/compiler/badge.ts` on the Profile IR, which already has what this needs —
`roundedRect(w, h, r)` is built from `pOffset` (`engine/compiler/profile.ts:77-85`):

- `badge-bottom` = `difference(extrude(outline, split), pocket)`
- `badge-top` = `translate([0, 0, split], extrude(outline, T − split))`

The script's 141 lines of hand-rolled triangle fans (`make_badge.py:45-83`) become
roughly 30 lines of IR.

**`samples/badge-blank/make_badge.py` stays where it is, untouched** — it is the
user's file. Its three existing output files are the one-time regression oracle:
compare bounding box and volume of the ported nodes against them.

Two gaps on the export side that V1 has to close:

- `buildModelXml` writes one object per mesh with **no extruder metadata**
  (`workers/export/threeMf.ts:32-62`). Two-colour export needs the
  `Slic3r_PE_model.config` sidecar that `make_badge.py:120-130` already writes.
- `meshNodesForExport` special-cases a single node id, `gasket`
  (`engine/exportTrigger.ts:84-111`). An optional `material?: { extruder?: number; fillDensity?: string }`
  on `BuildNode` (`engine/compiler/buildPlan.ts:43-46`) lets the gasket, the badge
  halves and every future part go through one path instead.

---

## 7. Depth: the model is the source of truth

Earlier revisions of this section argued twice, in opposite directions, about whether
cut depth should be referenced from the top face or derived from a measured total
thickness. Both arguments were wrong-headed, because both were *inferring* something
the app already knows exactly. The resolution, decided with the user:

> **The app loads the actual object. It knows where the pocket is and where the colour
> boundary sits, because it compiled them. Nothing about depth is inferred, measured or
> re-derived.** The machine's only job is to establish where the physical part sits
> relative to that model.

Everything below follows from that.

### 7.1 The layer stack — one structure, two answers

The app slices the compiled solid on **the printer's actual layer grid** (layer height
**and first-layer height** are inputs, recorded in the blank spec). The first layer
matters disproportionately here: after the flip (§7.2) it *is* the engraved face, and
the colour split sits only four or five layers above it. That single structure answers
both questions that matter:

- **Where does the colour change?** At the layer boundary where the extruder
  assignment changes. Not at the ideal design height — at the layer line the printer
  will really produce.
- **How deep can the cutter go at any point?** Descend the stack from the engraved
  face; a point is cuttable to depth *d* only if it is solid in **every** layer from
  the face down to *d*. The running intersection of cross-sections is the depth-limit
  map.

The magnet pocket needs no special case. It is a void in the solid, so the stack
reports a shallower limit over its footprint automatically — and so would any future
pocket, slot, or boss on any other part. There are no hand-coded keep-out rectangles
anywhere.

This is cheap: the cross-sections are Clipper2 `CrossSection` objects, the running
intersection is one `intersection` call per layer, and the badge is ~19 layers.

Why the layer grid rather than ideal dimensions: the badge's nominal top-colour band is
0.810 mm, which at 0.2 mm layers is layer 4.05. A slicer puts that boundary at 0.80 or
1.00 mm, and the difference is a large fraction of the usable depth range. Modelling the
grid removes the guess instead of budgeting for it.

### 7.2 Print orientation, and why it settles the Z reference

**The blank is printed flipped relative to `make_badge.py`'s authored orientation:
engraved face on the build plate, pocket opening upward.** No support, no bridging.

`make_badge.py` authors the pocket on the z = 0 face and ships its 3MF
identity-transformed (`make_badge.py:117`), so as exported it prints the wrong way up and
the user flips it by hand. The app's export should emit it print-ready — the
`PRINT_FLIP_NODE_IDS` machinery in `engine/exportTrigger.ts` already exists for this.

Consequences, and these are the ones that stop the argument:

- The **engraved face is the build-plate face**, so the colour boundary and pocket
  ceiling are at fixed layer counts *from the face the cutter touches*.
- The part's **total-thickness error accumulates at the back face**, which nothing
  references and nothing cuts.
- Therefore **cut depths are measured down from the probed engraved face, using the
  model's layer distances, and a thickness-deviant blank needs no compensation at all.**
  Total thickness is not an input to the job. Feeding it in would import far-side error
  into the cut.

Secondary benefits: a build-plate face is flatter and more dimensionally honest than a
top surface, it gives the probe a genuinely flat reference, and on smooth PEI it is
glossy — so the engrave reads matte-on-gloss.

**Two orientations, and they are opposite ways up.** The blank is *printed*
engraved-face-down — magnet hole facing up, away from the plate. It is *machined* the
other way up: **pocket-down in the nest, engraved face up to the cutter**, contacting
the nest floor on the annulus around the pocket (§7.6). Both are fixed, and the only
thing they share is that the engraved face is the reference in each. Conflating them is
what put a bridged-roof measurement into #165 that this blank does not have — printed
this way up, **no layer in the part is bridged**, and the 1.51 mm over the magnet pocket
is solid 100 %-infill material. What that membrane *does* have is nothing underneath it
while it is being cut.

### 7.3 Registration is derived from workholding, not fixed

**Decision 26, taken 2026-10-03, and it supersedes decision 23's single sequence.** The
first question is not "which edges do we probe" — it is **how is the part held?** A badge
in a printed nest, a plate under top clamps, a block in the low-profile vise and a cylinder
in the 4th-axis chuck are four different registration problems, and a hardcoded
edge-find sequence is only correct for one of them.

So **workholding is an explicit input to the model**, and the probing plan is **derived**
from it together with the part the app already compiled. The app knows the geometry because
it built it; given how the part is held, it can plan the probe itself rather than being
told where to touch.

```ts
type Workholding =
  // --- owned, in scope (confirmed 2026-10-03) ---
  | { kind: 'anchor-bracket'; anchor: 1 | 2; offset: Vec2 }   // native L-bracket
  | { kind: 'top-clamps';     clamps: { at: Vec2; footprint: Profile }[] }
  | { kind: 'vise';           jawFaces: [Plane, Plane]; jawHeight: Mm }
  | { kind: 'rotary-chuck';   jawDiameter: Mm; stickout: Mm }
  // --- status under review: see "the vise question" below ---
  | { kind: 'printed-nest';   nest: NodeId; seatClearance: Mm };
  // NOT built: vacuum bed. Not owned, nobody has asked.
```

The four owned variants are in scope. The vacuum bed is deliberately absent — building a
variant for hardware nobody has is the speculative infrastructure this project has a
standing rule against.

Each variant has to answer the same four questions, and that is the whole interface:

| | What the planner needs from it |
|---|---|
| **Reachable** | Which faces and edges a probe can touch without hitting the fixture |
| **Obstructed** | Clamp, jaw and bracket footprints, as keep-out profiles in the work frame |
| **Datum candidates** | What this fixture *already* establishes, and how well — the anchor bracket fixes XY to the bed; a vise fixes one face and rotation; a chuck fixes the axis; a nest fixes nothing but holds the part still |
| **Residual uncertainty** | What is left for the probe to resolve, with a number. A nest pocket cut at `+0.15` leaves ±0.15 mm of XY slop; a vise leaves essentially none across the jaws |

**The plan then falls out of geometry, not out of a rule.** Query the compiled solid for
candidate surfaces, score them, and emit the touches that resolve the residual:

- Prefer **long straight edges** — the badge's corners are R3.175 (`make_badge.py:23`) and a
  radiused corner is a poor datum, but that is a *consequence* of querying the outline, not
  a special case to hand-code.
- Reject any touch point inside an obstructed footprint, or on a face the fixture covers.
- Two touches on one straight edge give position **and rotation**; one on a perpendicular
  edge closes XY. Only emit them if the residual uncertainty justifies the cycle time.
- **Z is always probed** on the engraved face (§7.2), whatever the fixture. That is the
  datum every cut depth is measured from and no fixture can supply it.
- If the residual cannot be resolved by any reachable surface, **say so and refuse** rather
  than registering against something that is not a reference.

The point of decision 26 is that the plan is now an *output* of the model, so the vise and
rotary cases do not each need a new hand-written sequence.

#### The vise question — decision 19 may be superseded

**The low-profile vise is probably the right fixture for the badge, not a printed nest.**
This follows from facts already in this document rather than from a preference:

- §7.6 and #175 reject clamping because the blank is "**3.8 mm thick, too thin to clamp
  below the cut line without the clamp being in the tool's way**". A low-profile vise is
  built for exactly that case — that is what "low-profile" means.
- A **nest fixes nothing positionally** (decision 23, §7.3) and leaves ±0.15 mm of seat
  clearance. A **vise fixes one face and rotation**, leaving almost no residual for the
  probe to resolve. It is strictly the better datum.
- The badge is 76.2 × 38.1 mm. Gripping the long edges leaves the entire engraved face
  clear, and the part is machined pocket-down so the top face is the one being cut.
- A nest has to be designed, printed and iterated for every part. A vise holds anything.

What the nest still does better: it backs the blank flat across its whole area, which a
vise does not, and §9.2's unsupported membrane over the magnet pocket is the one place that
could matter. **#165 Row A measures precisely that**, so the comparison is decidable rather
than arguable.

**Decision 19 ("workholding is a printed nest, and it is a V1 deliverable") is therefore
under review, pending #165.** If the vise wins, #175 drops out of V1 and the badge's
registration becomes: vise fixes XY and rotation, probe Z on the engraved face, done — which
is simpler than anything this document has proposed so far.

**What this does not settle — see #187 item 1.** Whether the probing happens in our `.nc`
or in Studio's dialogs is still open, and the in-file route is constrained: Smoothieware has
no variables, so `G10 L2 P1` cannot take a computed offset and **rotation compensation is
impossible in a static file.** A derived *plan* can be executed interactively today and
emitted later when the bridge exists; the planner does not care which.

**Probe, confirmed 2026-10-03.** The one in use is the **separate, cabled Makera 3D
Probe** — the only one of the three rated for non-conductive material, and therefore the
only one that can touch off a PLA blank (§1). Using it means unplugging the wired-probe
connector, which stays a step in §7.6's Z chain. The *wireless* probe is a Carvera part,
which is why `M491` and `T0` reference it in the shared firmware and why Studio's control
panel carries wireless-probe charging voltages; there is none on this machine.

### 7.4 What a V-bit does, and why V1 uses a flat end mill

**This section's arithmetic was wrong about the tools that exist, and the correction goes
the other way.** It modelled a V-bit as an ideal 60° point, `w = 2·d·tan(θ/2)`, giving a
0.94 mm minimum stroke at the 0.810 mm reveal depth and the conclusion that small text
"cannot change colour with a V-bit at any commanded depth".

Makera's **non-metal** engraving bits are **30° included (half angle 15°) with a flat tip
of 0.1–0.5 mm** — the 60° ones in the catalogue are the metal bits
(`/Makera-Parity.md` §3.1). A truncated cone, not a point, so:

```
w(d) = tipDiameter + 2·d·tan(halfAngle)
```

A 0.1 mm tip at 15° gives **0.534 mm** at d = 0.810, not 0.94 mm. Meanwhile the smallest
catalogued non-metal **flat** end mill is **1.0 mm**, which erases every stroke thinner
than 1.0 mm outright (§7.5). **On reach, the V-bit beats the flat end for small text.**

What survives, and what decision 14 now rests on: **a V-bit couples depth to stroke
width**, so a per-label depth control stops meaning what the UI says — it becomes a clamp
at best. "Depth controls colour" holds only for a **flat end mill pocketing the glyph
region**, where depth is genuinely independent. That is the honest reason for decision 14,
and V-carve stays V2.

Still unmeasured: "a 4 mm cap-height title has a stroke around 0.5 mm" was a guess. Run
§7.5's opening over the bundled fonts at r = 0.5 and at the V-bit's effective radius and
report which strokes actually survive. If the user owns a 30° bit, one V-groove row added
to #165 settles it on the same afternoon.

### 7.5 Tool radius silently deletes glyph detail

With an end mill of radius *r*, the reachable region is the morphological **opening** of
the glyph: `offset(offset(G, −r), +r)`. Anything thinner than 2*r* vanishes; inside
corners get radius *r*. A 3.175 mm cutter engraves nothing legible at badge scale; a
1 mm cutter handles a 10 mm name and loses a 4 mm title's thin strokes.

Two `p-offset` nodes compute it today (`engine/compiler/profile.ts:116-123`), so the
viewport renders the **opened** region and colours engraved floors by which side of the
colour boundary they land on. The user sees the true result before cutting — the honest
default rather than a warning bolted onto a lie.

### 7.6 What is still physical, and therefore still unmeasured

The model settles geometry. These need the machine:

- **The Z chain across a tool change.** Probe fitted → hand swap → `M491` → cutter.
  Probe repeatability plus `M491` repeatability plus collet seating has never been
  quantified. #176 measures it by cutting a step and calipering it.
- **Chatter over the pocket.** Engraving inside the pocket footprint cuts a ~1.5 mm
  membrane spanning an unsupported void. Expect deflection and poor finish there at
  *any* depth. The layer stack correctly permits the cut; it cannot predict the finish.
  #171 warns on overlap for this reason, separately from the depth limit.
- **Workholding.** A printed nest: badge outline offset `+0.15` via `p-offset`, flat
  floor, finger relief. The blank sits **pocket-down**, contacting on the annulus around
  the pocket — so tape goes on the annulus, never spanning the void.
- **PLA finish at 13 000 RPM.** A parameter table, not a design risk. #165 records it.

## 8. Safety constraints

- **Nothing is sent to the machine without an explicit go-ahead** — not even a
  status query.
- **Motion or spindle commands only with the user physically at the machine.**
- WSL2's NAT will likely block UDP discovery; test the bridge from Windows before
  concluding anything about the protocol.
- Demand-driven: **the Z1 only.** No driver plugin API until someone asks.

---

---

## 9. V1 — multi-font depth engraving on the printed blank

**The goal, concretely:** the user opens the badge template, places several text
labels each with its own font and its own engrave depth, exports a `.nc`, and ends
up holding a two-colour badge where the deep labels read in the bottom colour and
the shallow ones don't.

### 9.1 What V1 deliberately does not include

These are all agreed decisions. Deferring them is **sequencing, not reversal** —
each is recorded above and keeps its decision number.

| Deferred | Why it is not in V1 |
|---|---|
| **WiFi machine bridge** (decision 10) | Studio already uploads over WiFi. A protocol reverse-engineer plus a Windows-only dev loop on the critical path buys nothing a working `.nc` doesn't. |
| **`G32` autolevel** (decision 7) | §7.1 — it addresses the wrong error. Re-add only if **#176** shows warp matters after clamping in the nest. |
| **Heightmap/dexel engine** (decision 2) | Nothing in V1 is 3D. **#182** does exact 2.5D stock simulation with CSG, and **#174** re-parses the output — between them that is the stock check V1 actually needs, with no sampled grid. |
| **4th-axis fields in the IR** (decisions 3, 11) | Adding an `A` to a move record later is one line. Adding it now is a field nobody tests. |
| **Image methods** (decision 5) | V1 is text. |
| **Mesh import registry** (decision 6) | V1 is text; `assetImporter.ts` is fine as is. |
| **Feeds/speeds from `makera_library.db`** (§3) | Hardcode the measured numbers from **#165**; read the DB when there are two tools. |
| **Multi-tool `M490.1/.2` handshake** | V1 jobs are single-tool. The probe→cutter swap happens before the job starts. |
| **V-carve** (§7.4) | V2. It is the thing that eventually gets small text to change colour, and it needs a medial-axis engine. |
| **`Project.kind` union** (decision 17) | §5.1 — not on the critical path, and the flags are already the derivation. |

> **One flag for the user.** The original brief asked the app to "ensure the blank
> material is correctly in the machine and start the milling". V1 as scoped here
> stops at a verified `.nc` that you upload through Studio. That is the single place
> this plan narrows the brief, and it is deliberate: it removes the riskiest,
> most environment-bound work from the path to a badge in hand. The bridge is the
> immediate follow-on, not a someday. Say the word and it moves back in.

### 9.2 The riskiest assumption, and the experiment that kills it first

**The assumption:** that engrave depth is a controllable scalar inside a sub-millimetre
band on *this* blank — i.e. that two-colour reveal is a depth-controlled deliverable at
all.

Three of the four reasons this document originally gave for doubting it have been
**retired**, by the print orientation (§7.2) and the 100 % infill premise (decision 13):
thickness error lands on the uncut back face, the engraved face is the flat build-plate
face, and no layer anywhere in the part is bridged. What is left is a shorter list, and
a different one:

- **The entire usable band sits inside the first few print layers.** The colour split is
  0.810 mm above the build plate — layer 4 or 5. So first-layer height and first-layer
  squish set the boundary, and elephant's foot distorts the one face the probe touches.
  This is the measurement #165 most needs, and it replaces the bridged-roof question.
- **The probe → hand swap → `M491` → cutter Z chain is unquantified** (§7.6). The band is
  sub-millimetre; the chain's error has never been measured against it.
- **The membrane over the magnet pocket is unsupported while it is cut** — 1.51 mm of
  solid material spanning a 45 × 13 mm void, because the blank is machined pocket-down
  (§7.2). Deflection and finish there are unpredictable at *any* depth, and that is a
  separate failure from breaking through.
- **PLA finish at 13 000 RPM** — a parameter table, not a design risk.

Every other depth decision hangs on this, and the usable band may be well under the
nominal 0.810 mm.

**It gets tested before a line of code is written.** If it fails, the fix is a *blank*
change — thicker top colour, split lower, 5 mm part, magnet moved — which is the
cheapest thing in this entire plan to change, and impossible to change cheaply once its
numbers are compiled into `badge.ts`.

### 9.3 Breakdown

Filed as GitHub issues; **#177** tracks them. `[P]` = prerequisite for the first
physical engraved badge, `[F]` = follows.

**Gates — nothing with a number in it gets written before these close:**

| | Issue |
|---|---|
| [P] | **#165** Depth-ladder experiment: measure the real engraving window (`bench-test`) |
| [P] | **#166** Blank print specification: thickness, split, infill, usable band |

**App side** (parallel with the fabrication side):

| | Issue |
|---|---|
| [P] | **#167** `case.badge` part type + `badge.ts` compiler (§5.1, §6) |
| [P] | **#178** Layer-stack model: colour boundary + depth limits from the solid (§7.1) |
| [P] | **#184** `MachineProfile` for the Z1: limits, capabilities, feed/speed clamping (§5.3) |
| [P] | **#168** Per-node material tag + two-volume 3MF export (§6) |
| [P] | **#169** Real glyph outlines, multi-font (§7.4) |
| [P] | **#170** Badge-face labels: per-label font and depth, two-colour viewport (decision 20) |
| [P] | **#171** Engravability check: tool-opened glyph, pocket breach block (§7.4) |

**Fabrication side:**

| | Issue |
|---|---|
| [P] | **#172** CAM core: contour-parallel pocketing → toolpath IR (§5.2) |
| [P] | **#173** Z1 post-processor: IR → `.nc`, bed-referenced Z, MKR header (§7.1, §2) |
| [P] | **#174** G-code verifier: parse our own output, refuse unsafe files |
| [P] | **#182** Toolpath simulation: sweep the selected tool, show the object before and after (§5.6) |

**Fixture, then the run:**

| | Issue |
|---|---|
| [P] | **#175** Printed nest fixture (§7.6) — any time after #167 |
| [P] | **#176** First cut: V1 acceptance + Z-chain error measurement (§7.6) (`bench-test`) |

**[F] Deferred**, each with its reasoning in §9.1: **#181** web/desktop build split
(prerequisite for the bridge, not for V1) ·
feeds/speeds from `makera_library.db` · WiFi bridge · `G32` option if #176 justifies
it · V-carve · `Project.kind` · multi-tool jobs · importer registry · image methods ·
heightmap engine · 4th axis.

**#182 needs #174's parser, not #172** — it simulates the emitted `.nc` (`/Simulation.md`
§1), so parser, frame tests and sweeper can all be built and validated against Makera's own
sample files before our CAM core exists. It cross-checks #171 and #178 once those land, and
it is what makes the `.nc` trustworthy without cutting.

#165 and #166 gate everything numeric. **#178 gates #171, #172 and #174** — all three
ask it for depth limits rather than carrying rules of their own. #175 needs only #167.
#176 needs all of them.

### 9.4 Still unverified

- **Is the Z1's `FuncSetting` ATC bit actually clear on this machine?** Everything in
  §2 about the manual-tool-change path depends on it, and it is inferred from
  `isATC=0` in Makera's database rather than read off the machine. `M499` dumps tool
  state and would likely show it. Not V1-blocking — V1 is single-tool.
- **Does `G32` apply compensation across long straight moves?** Stock Smoothieware only
  follows the map at segment endpoints unless `mm_per_line_segment` is set. Glyph loops
  are short segments, but the stem of an `I` is one long `G1`. Only matters if `G32`
  comes back into scope.
