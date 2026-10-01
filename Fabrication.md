# Fabrication — driving a CNC as well as a 3D printer

Status as of 2026-10-01. Decisions taken in conversation; nothing implemented yet.

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
- Base machine and the **wired probe** that ships with it.
- **The Makera 3D Probe** — probes X/Y/Z on conductive *and* non-conductive
  materials, which is what makes the printed-blank workflow possible. This is the
  probe to use for anything that isn't metal.
- **4th axis rotary module.** Work envelope ⌀80 × 150 mm. Belt-driven: fine for
  hobby work, with real compromises in rigidity and precision.

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
  connector → plug 3D probe → probe → swap back → `M491`. §7.5 explains why that
  chain's repeatability needs measuring.
- What the **wired** probe can and cannot touch off is **not documented either way**.
  Assume nothing; the 3D probe is the one to use for anything non-metallic.

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
| 7 | **Stock setup = corner find + Z touch-off, `G32` autolevel, model cross-check** | **Substantially revised by decision 12.** |
| 8 | **We have both the wired probe and the Makera 3D Probe** | Non-conductive probing is available, so PLA can be probed. |
| 9 | **First real job is a 3D-printed blank (PLA/PETG)** | The badge, literally. |
| 10 | **Transport is WiFi** | Still the chosen transport. **Not in V1** — see §10.1. |
| 11 | **4th axis: designed for, not built** | See decision 18. |
| 12 | **The depth window is bed-referenced. Measured stock thickness is the required input; `G32` is not.** | See §7. This inverts what this document said before. |
| 13 | **The blank must be printed 100 % infill, and its spec is part of the depth model** | See §7. |
| 14 | **V1 cuts with a flat end mill, not a V-bit** | A V-bit couples depth to stroke width, so per-label depth stops meaning what the UI says. V-carve is V2. |
| 15 | **Engravability is computed and rendered, not assumed** | Tool radius removes glyph detail; the viewport shows the *opened* region and the predicted colour. |
| 16 | **Glyph profiles use `NonZero` fill, as an opt-in field** | Not a change to the global `EvenOdd` default. |
| 17 | **No `Project.kind` union for V1** — `case.badge` as an optional field plus a `derivedKind()` helper | The old §5.1 premise was false. See §5.1. |
| 18 | **V1 is a vertical slice, and several agreed decisions are explicitly deferred out of it** | Deferring is sequencing, not reversal. See §10.1. |
| 19 | **Workholding is a printed nest, and it is a V1 deliverable** | See §10.3. |
| 20 | **Per-label depth is a two-state choice with a numeric override** | Two outcomes exist (top colour, bottom colour), so that is what the control should offer. Same reasoning as the X-ray toggle. |

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
`toCamJob(part, tool, measuredThickness)` for the `.nc`. That is literally "a set of
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

### 5.3 One machine profile — deferred

Machine knowledge is scattered across `PRINTER_PRESETS` (`engine/compiler/rackFit.ts:37-44`)
and a hardcoded `ASSUMED_NOZZLE` (`engine/compiler/fasteners.ts:303`). Unifying them
behind a `process: 'fdm' | 'mill'` discriminant is correct, and it is **not V1** — a
single `Z1` constant in one file is enough until a second CNC exists.

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

### 5.6 Machine bridge — deferred out of V1

**Tauri-only** when it happens; the web deploy can write `.nc` but cannot open
sockets. Transport is **WiFi** (decision 10), with a transport interface behind the
protocol layer so USB can follow. `M482.5` returns the machine's IP and `M482.4` its
MAC, which is how we confirm we are talking to the right machine.

It must be developed and tested **from Windows** — WSL2's NAT will almost certainly
break UDP discovery, and the Tauri build has to run on Windows anyway (`CLAUDE.md`).

**Why it is not in V1:** Makera Studio already uploads over WiFi. Putting a protocol
reverse-engineer and a Windows-only development loop on the critical path buys
nothing a working `.nc` file does not already deliver. See §10.1 — this is the one
place V1 narrows the original brief, and it is deliberate.

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

## 7. The depth window — corrected

This section previously got the physics backwards. The correction matters because
every V1 decision about depth rests on it.

### 7.1 Print orientation decides everything, and the blank is printed flipped

**The blank is printed upside down relative to the script's authored orientation:
the engraved face goes on the build plate, and the magnet pocket opens upward.**
The reason is printability — pocket-up needs no support and no bridging.

This matters more than anything else in this section, because it decides which face
is the dimensional datum. `make_badge.py` authors the part with the pocket on the
**z = 0** face and ships its 3MF identity-transformed
(`make_badge.py:117`), so as exported it would print pocket-down and bridge the
pocket roof. Flipping removes that — and relocates the accumulated error.

Measured up from the build plate in the flipped orientation:

| Boundary | Distance from the **engraved** face | At 0.2 mm layers |
|---|---|---|
| Colour split (model z = 3.0) | **0.810 mm** | layer 4.05 |
| Pocket ceiling (model z = 2.3) | **1.510 mm** | layer 7.55 |
| Back face / pocket opening | 3.810 mm | layer 19.05 ← rounding lands **here** |

Both boundaries that matter are therefore **fixed layer counts from the engraved
face**, and the part's total-thickness error accumulates at the *back* face, which
nothing references.

**Consequence — this reverses an earlier conclusion in this document.** Depth
referenced from the **probed engraved surface** is correct and repeatable. Total
measured thickness is *not* the right input, and feeding it in would actively import
back-face error into the cut:

```
Z_cut = −(topBand + margin)                       // CORRECT in this orientation
Z_cut = measuredThickness − split − margin        // WRONG: imports back-face error
```

An earlier revision of this document argued the opposite. That argument was sound for
a part printed engrave-face-up, which is not what happens here. Probe the face you are
about to cut, and cut relative to it.

What remains variable in Z, and it is small:
- **First-layer squish** — one layer, not accumulated, and consistent across a run.
- **Layer quantisation of the colour split.** 0.810 mm is layer 4.05 at 0.2 mm, so the
  slicer puts the change at 0.80 or 1.00 mm — a 0.2 mm step inside a sub-millimetre
  window. **Fix this in the spec**: choose the top-colour band as an exact layer count
  and derive `split = thickness − N × layerHeight`. See #166.

### 7.2 What the usable band actually is

**Sparse infill — retired.** The test blank is printed at **100 % infill**, which
removes the sparse-floor variable outright rather than measuring it. On a 3.81 mm part
the cost is negligible, so 100 % infill is a **premise of the blank spec**
(decision 13, #166), not a finding.

**The bridged pocket roof — also retired, by the flip.** With the pocket opening
upward, the material over it is printed as ordinary solid layers on top of solid
layers. There is no bridge and no porous first bridged layer. The earlier concern that
the real sealed ceiling sat above the nominal 2.3 mm **does not apply in this
orientation.**

**What is left is layer quantisation at both ends:**

| Bound | Nominal | Conservative, layer-aligned at 0.2 mm |
|---|---|---|
| Reveal (must exceed) | 0.810 | **0.80** — or exact, if §7.1's spec fix lands |
| Pocket breakthrough (must stay above) | 1.510 | **1.40** — the pocket may begin a layer early |

So the realistic working band is roughly **0.80 → 1.40 mm**, about 0.6 mm wide — and
unlike the earlier estimate it is *not* eroded by print thickness error, because of
§7.1. #165 measures the true values.

**Two new consequences of the flip, both worth designing around:**

1. **Cutting over the pocket means cutting over a void.** Engraving inside the
   45 × 13 mm footprint removes material from a 1.4–1.6 mm membrane spanning an
   unsupported cavity. Expect deflection, chatter and a worse finish there than
   anywhere else on the badge, independent of depth. #171 should discourage deep
   engraving over the pocket, not merely block breaches.
2. **The engraved face is a build-plate surface.** Flatter and more dimensionally
   honest than a top surface, and on smooth PEI it is glossy — so an engrave reads
   matte-on-gloss, which flatters the part. It also means the probe lands on a genuinely
   flat reference.

**The blank's slicing is part of the depth model, and the app does not control the
slicer.** It therefore has to specify it, including the print orientation — which is
what #166 is for.

### 7.3 Why a V-bit breaks the whole idea
For an included angle θ, floor width at depth d is `w = 2·d·tan(θ/2)`. At 60° that
is `w = 1.155·d`, so reaching the 0.81 mm colour boundary needs a stroke at least
0.94 mm wide; at 90° it needs 1.62 mm. A 4 mm cap-height title line has a stroke
around 0.5 mm, so **it never changes colour with a V-bit, whatever depth the label
claims.** V-carving derives depth from stroke width; the user's number becomes a
clamp at best.

"Label → depth → colour" only holds for a **flat end mill pocketing the glyph
region**, where depth is genuinely independent. Hence decision 14.

### 7.4 Tool radius is the third coupled variable
With an end mill of radius r, the cut region is the morphological **opening** of the
glyph: `offset(offset(G, −r), +r)`. Anything thinner than 2r disappears; inside
corners get radius r. A 3.175 mm cutter engraves nothing legible on a badge; a 1 mm
cutter handles a 10 mm name and loses a 4 mm title's thin strokes.

This is computable **today** with two `p-offset` nodes
(`engine/compiler/profile.ts:116-123`), so the viewport must render the opened region
rather than the ideal glyph, and colour engraved floors by `depth > T − split`. The
user sees the real result before anything is cut — the honest default, not a knob.

### 7.5 The Z reference chain crosses a tool change
Probing happens with the probe fitted; cutting happens with the cutter after a hand
swap and `M491`. The achievable depth tolerance is therefore probe repeatability +
`M491` repeatability + how well the operator seats the collet. **None of these is
quantified anywhere.** Cut a step and caliper it once before anyone trusts a 0.3 mm
margin.

### 7.6 Workholding, and why the corner find is the wrong plan
Decision 7 called for an XY corner find, but the badge corner is a 3.175 mm radius
(`make_badge.py:23`) and the part is 3.8 mm thick — too thin to clamp below the cut
line, and a rounded corner is a poor datum.

The cheap answer is the good one: a **printed nest** — the badge outline offset
`+0.15` via `p-offset`, a sharp datum corner, double-sided tape. Printed on the same
printer that makes the blank. It fixes XY once instead of every job, and gives the
probe a known flat floor to measure thickness against (§7.1). Hence decision 19.


---

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
| **`G32` autolevel** (decision 7) | §7.1 — it addresses the wrong error. Re-add only if §9.3 item 12 shows warp matters after clamping in the nest. |
| **Heightmap/dexel engine** (decision 2) | Nothing in V1 is 3D. The G-code re-parser (item 10) is the stock check V1 actually needs. |
| **4th-axis fields in the IR** (decisions 3, 11) | Adding an `A` to a move record later is one line. Adding it now is a field nobody tests. |
| **Image methods** (decision 5) | V1 is text. |
| **Mesh import registry** (decision 6) | V1 is text; `assetImporter.ts` is fine as is. |
| **`MachineProfile` unification** (§5.3) | One `Z1` constant until a second CNC exists. |
| **Feeds/speeds from `makera_library.db`** (§3) | Hardcode the measured numbers from item 1; read the DB when there are two tools. |
| **Multi-tool `M490.1/.2` handshake** | V1 jobs are single-tool. The probe→cutter swap happens before the job starts. |
| **V-carve** (§7.3) | V2. It is the thing that eventually gets small text to change colour, and it needs a medial-axis engine. |
| **`Project.kind` union** (decision 17) | §5.1 — not on the critical path, and the flags are already the derivation. |

> **One flag for the user.** The original brief asked the app to "ensure the blank
> material is correctly in the machine and start the milling". V1 as scoped here
> stops at a verified `.nc` that you upload through Studio. That is the single place
> this plan narrows the brief, and it is deliberate: it removes the riskiest,
> most environment-bound work from the path to a badge in hand. The bridge is the
> immediate follow-on, not a someday. Say the word and it moves back in.

### 9.2 The riskiest assumption, and the experiment that kills it first

**The assumption:** that engrave depth is a controllable scalar inside a sub-millimetre
band on *this* blank — i.e. that two-colour reveal is a depth-controlled deliverable
at all, given FDM thickness error (§7.1), default infill and a bridged pocket roof
(§7.2), the probe→cutter Z chain (§7.5), and PLA finish at 13 000 RPM.

Every other depth decision hangs on it, and §7.2 suggests the usable band may be
~0.2 mm rather than 0.70.

**It gets tested before a line of code is written.** If it fails, the fix is a
*blank* change — thicker top colour, split lower, 5 mm part, magnet moved, 100 %
infill — which is the cheapest thing in this entire plan to change, and impossible to
change cheaply once its numbers are compiled into `badge.ts`.

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

**Fixture, then the run:**

| | Issue |
|---|---|
| [P] | **#175** Printed nest fixture (§7.6) — any time after #167 |
| [P] | **#176** First cut: V1 acceptance + Z-chain error measurement (§7.5) (`bench-test`) |

**[F] Deferred**, each with its reasoning in §9.1: `MachineProfile` unification ·
feeds/speeds from `makera_library.db` · WiFi bridge · `G32` option if #176 justifies
it · V-carve · `Project.kind` · multi-tool jobs · importer registry · image methods ·
heightmap engine · 4th axis.

#165 and #166 gate everything numeric. #167–#171 and #172–#174 can proceed in
parallel. #175 needs only #167. #176 needs all of them.

### 9.4 Still unverified

- **Is the Z1's `FuncSetting` ATC bit actually clear on this machine?** Everything in
  §2 about the manual-tool-change path depends on it, and it is inferred from
  `isATC=0` in Makera's database rather than read off the machine. `M499` dumps tool
  state and would likely show it. Not V1-blocking — V1 is single-tool.
- **Does `G32` apply compensation across long straight moves?** Stock Smoothieware only
  follows the map at segment endpoints unless `mm_per_line_segment` is set. Glyph loops
  are short segments, but the stem of an `I` is one long `G1`. Only matters if `G32`
  comes back into scope.
