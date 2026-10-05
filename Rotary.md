# Rotary — the 4th axis, designed before any `A` reaches the IR

Status as of 2026-10-05. **Design only; nothing implemented.** Tracked by **#235**; the placeholder
it replaces is **#223**. Companion documents: `/Fabrication.md` §1, §5.5 (the machine and the
heightmap claim this document tests), `/Simulation.md` §4.4, §5, §8 (the sweeper, the checkpoint
model and the viewport this has to fit into), `/Makera-Parity.md` §2, §5, §11.1.1 (Studio's rotary
strategy and the vendor sample files). Where this document disagrees with one of those three, §11
lists the exact change; **it does not edit them** — another session owns them.

**What it is, in one sentence.** The axis touches the move record, the checkpoint, the toolpath IR,
the post, the stock model, the workholding model, the CAM, the simulation backend, the verifier and
the viewport; this settles the shape all ten have to share, compares the ways the viewport could draw
it, and says which (if any) code has to change *now* to keep the later work additive.

**Provenance rule.** Three kinds of evidence appear below and each is marked: **measured** (a number
computed from a file on disk — the two vendor rotary programs, Studio's config), **read** (a reading
of the firmware repository or a vendor's documentation, with file and section), and **unknown** (the
module has never been fitted; nothing about its behaviour on *this* machine has been observed).
Firmware facts come from `MakeraInc/MakeraZ1Firmware` on its `main` branch as fetched 2026-10-05;
that repo is GPL-3.0 and this document records *behaviour*, never code (`/Fabrication.md` §5.7).
Vendor claims cite `docs/market-research/` by file and line, and the corpus's own limits apply
(`UI-PATTERNS.md`, "What this list does not say"): documentation-level evidence, no competitor
product was run.

---

## 1. What the evidence says before any design is done

### 1.1 The two vendor programs, measured

`casemaker-app/reference-gcode/Rotation/NefertitiRough.nc` and `NefertitiFinish.nc` (fetched by
#186, never committed) are Makera's own 4th-axis jobs. `Tests/4th-test-air.nc` is **byte-identical
to the rough file except for `T6M6` in place of `T1M6`** (`cmp`, 2026-10-05) — so the vendor's
"4th axis air test" is the roughing job with a different tool number. Counted with a 40-line script
over every `G0`/`G1` line (`scratchpad/ncstats.py`, 2026-10-05):

| | Rough | Finish |
|---|---|---|
| moves (`G0` / `G1`) | 5 063 (516 / 4 547) | 100 519 (**7** / 100 512) |
| moves carrying an `A` word | 5 061 | 100 516 |
| `X` range (mm) | 6.00 – 74.00 | 15.19 – 65.43 |
| `Y` | commanded 3×, **always 0** | commanded once, **0** |
| `Z` range (mm) | −0.70 – 30.00 | **−5.00** – 30.00 |
| `A` range (°) | +360 → **−80 280** (223 turns) | +360 → **−153 720** (427 turns) |
| `A` direction reversals | 561 | 4 |
| `G1` moves changing X and A together (Z fixed) | 1 261 | 628 |
| `G1` moves changing Z and A together (X fixed) | 0 | **89 198** |
| `G1` moves changing X, Z and A together | 2 624 | 4 369 |
| `G1` moves changing A alone | 133 | 6 306 |
| distinct Z values | 1 163 | 2 391 |
| feeds (`F`) | 1125, 1245, 1372, 1500 | 1125, 1372, 1500 |
| moves at or below Z = 0 | 4 | **3 847** |
| last motion word | `G92.4A0S0` | `G92.4A0S0` |

Reading those numbers:

1. **The roughing pass is a helix.** `G01X72.10Z22.00A-360.00` → `G01X70.71Z22.00A-720.00`: one
   full turn of A per 1.39 mm of X, at constant Z, repeated from X 74 down to X 6, then Z drops by
   3 mm (22 → 19 → 16 → … → 8) and it goes again. **A and X interpolate simultaneously in 3 885 of
   the 4 547 cutting moves.**
2. **The finishing pass is a slower helix with the relief in Z.** X advances 0.1175 mm per turn
   (50.24 mm over 427 turns) and Z follows the model as A sweeps — `Z10.20 → 10.26 → 10.28 …` at
   steps of about 0.54° of A. **A and Z interpolate in 89 198 moves.** Z is a different value
   on nearly every line.
3. **A is unwound, never wrapped.** It runs to −153 720° and is reset at the end with `G92.4 A0 S0`.
   `Makera_Z1.fcm`'s ±10 000 000° (`/Makera-Parity.md` §11.2) is boilerplate, but *unbounded* is the
   right model: a rotary program's A is a monotone count of degrees, not an angle.
4. **Y is zero throughout.** The tool stays over the rotary axis. That — not "A does not
   interpolate" — is the constraint that makes a radius-over-(A, X) model legitimate (§4.1).
5. **Z is measured from the rotary axis, not from the stock top.** The first roughing level is
   Z 22 and the clearance is Z 30; a cut at Z 22 on a stock whose top was Z 0 would be air. Makera
   CAM's own rule confirms it: *"a safe clearance height is typically ½ the stock diameter + 3 mm"*
   (`docs/market-research/raw/makera/software-MakeraCAM_userguide.txt:1025`), and Studio's
   `RotationReliefPath.json` default `safeZ` is 27.749 (§1.3). So **work Z = distance above the axis;
   Z at the surface IS the radius.**
6. **The finish crosses the axis.** 3 847 moves sit at Z ≤ 0, down to Z −5.00: the cutter tip
   passes 5 mm *below* the rotary axis (the bust's neck is thinner than the stock and off-centre).
   §4.3 says what that does to a radius heightmap: it breaks it.

**Consequence for `/Fabrication.md` §5.5 and `/Simulation.md` §5.** Both state "the A axis indexes
or wraps; it does not interpolate with X/Y/Z" and §5 makes that the thing that "makes the
reparameterisation legitimate". **Measured against the vendor's own files the claim is false**
(items 1 and 2). The claim that *is* true, and that does carry the legitimacy, is item 4: the tool
axis always intersects the rotary axis (Y = 0, no tilt). That is what a 3+1 "wrapped" job means,
and it is what every vendor in §8 ships under the name "rotary". §11 has the wording change.

### 1.2 The firmware, read

Two files in `MakeraInc/MakeraZ1Firmware` (`main`, 2026-10-05) say more about the module than anything
on the wiki. Both carry the standing caveat from `/Fabrication.md` §1: `configZ1.default` is the
*shipped* config and contains Carvera-era boilerplate (`worksize_x 300` on a 200 mm machine), so
these are readings of the repository, **not of the device**.

| Setting (`src/configZ1.default`) | Value | Meaning |
|---|---|---|
| `delta_steps_per_mm` | **88.888889** | steps per **degree** of A (32 000 steps per turn) |
| `delta_max_rate` | **3600.0** | °/min → **60 °/s, 10 rpm** |
| `delta_acceleration` | 360.0 | °/s² |
| `delta_homing_direction` / `delta_min_endstop` | `home_to_min` / `1.4^` | A **has a homing switch** in the shipped config |
| `delta_max_travel` | 380 | a homing search distance (same trap as `alpha_max_travel`, `/Makera-Parity.md` §11.3) |
| `delta_limit_enable` | true | the switch is also a limit |
| `default_feed_rate` / `default_seek_rate` | 1000 / 2000 | mm/min; the Z1 file differs from the stock-Smoothieware 1000/3000 quoted in `/Makera-Parity.md` §11.2 |

`src/modules/robot/Robot.cpp`, `append_milestone` — described, not copied:

- For a move whose X, Y and Z do not change, the **distance is the A delta in degrees**, so on a
  pure-A move `F` is degrees per minute. This is stock Smoothieware behaviour.
- **Makera added rotary-aware feed scaling.** When the A actuator is involved, the firmware converts
  the target to work coordinates, takes `r = √(Y_wcs² + Z_wcs²)` — **the target's distance from the
  work origin in the Y–Z plane** — and forms a "perimeter" of `2π·r + 30` mm per revolution (`2π + 30`
  when r ≤ 1 mm). The `30` has no comment. A pure-A move is sped up so that its equivalent surface
  speed over that perimeter reaches the commanded `F`; a combined move is slowed so the A component
  does not exceed it. After that, the ordinary per-actuator clamp applies, so **`delta_max_rate`
  caps every A move at 60 °/s.**
- `G92.4 A<v> S<n>` **shrinks the A position by whole turns** (the value modulo 360 is kept, the
  turns are dropped) and `G92.4 A<v> R<n>` resets it to the value modulo 360. This is the firmware's
  **rotary unwind**, the code the vendor's files end with. Our parser reads any `G92.4` as a manual
  re-homing of the machine position and forgets X, Y and Z (`interpreter.ts`, the `case 92` branch,
  `sub === 4` → `g92-4-manual-home` + `unknownPosition()`), which is the wrong semantics for the
  rotary form — harmless at end-of-program, a position-losing trap mid-program.

**Two things follow that this document treats as settled by the firmware, not by us:**

- **The rotary work origin lies on the rotary axis** (work Y = 0 and Z = 0 at the axis line). It is
  not a convention we may choose: the firmware's feed arithmetic reads the radius from the work Y and
  Z, and a WCS placed anywhere else makes the machine compute the wrong surface speed on every move.
  It also matches item 5 of §1.1, Makera CAM's clearance rule, and the Z1 wiki (§1.4).
- **The post never emits degrees-per-minute.** `F` stays mm/min on every move, as today; the
  controller performs the conversion. What the post *does* owe the operator is the surface speed the
  material will actually see, which is not `F` (§3.4).

### 1.3 Studio's rotary strategy, read

`%APPDATA%/MakeraStudio/configure/RotationReliefPath.json` (`type: 11`) is `Relief3DPath.json`
(`type: 6`) with `direction`, `parallel_angle`, `path_direction`, `pocket_strategy` and
`toolcontainment` removed and two fields added — `reliefdirection: 0` and `haveTailTop: true` — plus
a `tools[]` array (multi-tool roughing/finishing). Its `safe.safeZ` is 27.749 and `startZ` the same,
consistent with a stock of radius ≈ 24.75 mm plus the "½ diameter + 3" rule. `endDepth` is the same
uninitialised double (`-9.255963134931783e+61`) `/Makera-Parity.md` §8 records in six other configs.
`/Fabrication.md` §5.5's reading — "its 3-axis relief strategy plus a `reliefdirection` and a
`haveTailTop` flag" — is confirmed.

Makera CAM (Carvera-only, `/Makera-Parity.md` §13) documents the same model more fully
(`raw/makera/software-MakeraCAM_userguide.txt`): a **4-axis project type** presets stock and WCS
(l. 152); stock gains a **Shape: Square or Round** parameter (l. 1005); tabs are **modelled by hand**
as cylinders or cone frusta (l. 1009–1011); **Max Depth** offsets the end depth from the model
(l. 1021); clearance and retract are defined against *"the Z-axis 0 coordinate detected by the
probe"* at *"½ the stock diameter + 3 mm"* (l. 1024–1028); **Rotation Relief** is the only rotary
strategy, with **Direction: Horizontal or Vertical** and an **Enable Tailstock** flag that contains
paths by the model instead of by the stock length (l. 1052–1075); roughing and finishing are
recommended as separate paths because of chip load (l. 1069). There is **no wrap of 2D vectors** in
Makera's rotary offering at all — only relief from an imported mesh.

### 1.4 The module, read from the Z1 wiki

`https://wiki.makera.com/en/Z1/Accessories/4Axis` (fetched with a browser user agent, 2026-10-05;
the page is JS-rendered and the first fetch returned only its title):

- Mounts on **two 4 × 11 mm locating pins and three M5×10 screws**, **after removing the MDF
  wasteboard** — so, like the vise (`/Fabrication.md` §7.3), **rotary and tape-down are mutually
  exclusive setups**, and the module occupies the same pin datum.
- **Three-jaw chuck, reverse jaws fitted by default** for larger work; standard jaws for small parts.
  Jaw capacity in either mode: **not stated**.
- **Tailstock** with an adjustment knob; *"drilling a center hole at the end is recommended"*.
- *"The 4th-axis zero point is preset in the software at the center of the right edge of the
  spindle"* — a module datum Studio knows (its UI carries "rotary module X/Y/Z offsets, max A speed
  and acceleration", `/Makera-Parity.md` §7). **What that preset's precision is, and whether it
  survives re-mounting, is unknown.**
- Cable to a 4th-axis port at the rear-left inside the machine; **do not hot-plug**.
- No number anywhere for steps, speed, homing, or envelope; the ⌀80 × 150 mm envelope comes only from
  `t_MachineType`.

### 1.5 What exists in the code today, with the lines that do it

| Piece | State | Where |
|---|---|---|
| `A` words parsed | tracked into `MoveEvent.a` and `MachineState.a`; one `rotary-axis` info diagnostic per file; relative `A` resolved by the parser only | `gcode/interpreter.ts` `doMotion` (the `aw` block), `gcode/types.ts` `MoveEvent.a` |
| `A` is **not** in `Pos`, `commanded` or `values` | those are X/Y/Z triples; the runner's `resolveMove` cannot re-resolve A against its own state | `gcode/types.ts`, `emulator/timeline.ts` `resolveMove` |
| machine-frame moves drop A | `applyEvent` copies `ev.a` only on the work-frame branch | `emulator/timeline.ts` `applyEvent` case `'move'` |
| the sweep **refuses** by name | `if (timeline.summary.rotary) return { ok: false, … code: 'rotary-job' }` | `workers/geometry/sweep.ts:716`; tests `cncSweep.spec.ts:305`, `simSession.spec.ts:405`, `gcodeCorpus.spec.ts:100` |
| checkpoints are keyed on (segment, Z) | a change in A does not open a new run; `zs` carries a Z pair per move | `emulator/timeline.ts` `Checkpoint`, the run-splitter |
| the IR has no `A` | documented as deliberate; `ToolpathIR.frame` (`'flat'`/`'rotary'`) is the R-0 discriminant | `cam/ir.ts` header |
| the post refuses the rotary frame | `frame === 'rotary'` and `zDatum === 'rotary-axis'` are errors until R-3 | `post/z1.ts` `postZ1` |
| the profile carries the module | `MachineProfile.rotary` (axis/parent/envelope/steps/rates/homing/unwind), `configZ1.default` figures, `source` flagged unverified | `machine.ts` `RotaryProfile`, `Z1.rotary` |
| `G92.4 A S/R` is a rotary unwind | lowers to a `rotary-unwind` event (mode + a + value), X/Y/Z left intact; bare `G92.4` stays a manual home | `gcode/interpreter.ts`, `gcode/types.ts`, `emulator/timeline.ts` |
| the post emits X/Y/Z/F only | sticky formatted words | `post/z1.ts` `emit` |
| the verifier **refuses any `A`** | `PARAM_LETTERS = {T,S,F,X,Y,Z}` → `not-our-dialect` | `verify.ts` |
| `PartSpec` `cylinder` | `{ diameter, length }` — no axis, no chuck end; **R-0 fix:** `stubSetup`'s cylinder WCS is now on the **axis** (`at[2]`), not the top face (§3.3, R6) | `setup.ts` `stubSetup`, `machinePlacement` |
| `Workholding` `rotary-chuck` | `{ jawDiameter, stickout }` | `setup.ts` |
| `MachineProfile.capabilities.rotary` | the boolean stays; **R-0 adds `MachineProfile.rotary`** with the envelope, limits, steps and unwind as sourced data | `machine.ts` |
| frames | translation-only `workToMachine`; `engravedFaceWorkZ` is `null` for a cylinder | `frames.ts` |
| viewport | work-frame meshes drawn untransformed; `SimPath.xyz` is a Float32 triple per vertex; camera bounds from the stock bbox; `GridFloor` hidden in CNC mode | `SimMeshes.tsx`, `simGeometry.ts`, `viewportCamera.ts`, `Viewport.tsx` |
| transport | step-indexed, pause ticks only, material at checkpoints | `SimTransport.tsx`, `playbackClock.ts` |
| engrave preview | a prism stock, floors by depth, vise jaws, X/Y axis marker; `EngraveJob.workholding` is `{ kind: 'vise' }` only | `EngravePreview.tsx`, `workers/sim/engravePreview.ts`, `types/engraveJob.ts` |

Two facts about the refusal that matter for §4: even with `rotary-job` lifted, **both vendor files
would be refused as dense 3D** — the rough has 1 163 distinct Z values and `MAX_CHECKPOINTS` is 1 000
(`/Simulation.md` §9 item 6), and the finish's Z changes on nearly every line, so a (segment, Z)
checkpoint is roughly one move. The exact sweeper is the wrong representation for continuous rotary
work for the same reason it is wrong for `TopClamp.nc`, independently of the A axis.

---

## 2. Job classes, and the order they come in

**Decision R1 — scope is "3+1 wrapped": the tool axis is vertical and passes through the rotary
axis (work Y = 0); A interpolates freely with X and Z.** *Reason:* §1.1 items 1–4 — this is what the
vendor's files do, what the firmware's feed model assumes (`r` from Y and Z of the work position, §1.2),
and what every vendor in §8 ships as "rotary"; and it is exactly the family a single-valued
radius-over-(A, X) column model can represent (§4). Simultaneous 4-axis in the sense of a tilted or
off-axis tool (Y ≠ 0 while A moves) is **out of scope**, and §6 makes `Y ≠ 0` a refusal rather than a
silent assumption.

Three classes inside that scope, in the order they should land:

| | Class | Motion | Stock representation it needs | First consumer |
|---|---|---|---|---|
| **W** | **Wrap engraving** — text and shapes laid out on the unrolled cylinder surface, cut at constant (or per-item) depth below the surface | A and X interpolate along each path segment; Z constant per item (plus plunges) | single-valued radius columns over (A, X) | the dowel: #223's "engraved text round a wooden dowel" |
| **I** | **Indexed faces** — rotate to a fixed A, clamp (hold), cut a 2.5D operation, repeat | A changes only between operations; each operation is ordinary 3-axis at constant Z levels | the **existing exact sweeper**, with the stock rotated into each index | flats, hex sections, cross-drilling patterns on a round part |
| **R** | **Continuous relief** — the Nefertiti class: Z follows a mesh as A sweeps | A, X and Z all interpolate; **Z may cross the axis** | *multi-valued* radius columns (intervals), or a 2D cross-section per X slab | relief from a mesh — #222's second half, on a cylinder |

**Decision R2 — W is the first milestone, I the second, R the last; R is not committed to.**
*Reasons:* W is the owner's stated first job and the only one with an analytic oracle (the opened
glyph on the unrolled plane, §4.5); its columns are shallow and single-valued; nothing in it reaches
the axis. I is cheap once W's data model exists — it reuses the exact sweeper almost unchanged (§4.6)
— but it is not what anyone has asked for. R needs a representation neither this document nor #222
has specified (§4.3), and the only evidence for its parameters is a Carvera-generated file.

**What §5.5's "indexes or wraps" claim cost, and what dropping it costs.** Keeping the claim would
have excluded both vendor files and the whole of class W (whose paths are short *helical* segments:
A and X interpolate on every glyph stroke). Dropping it costs nothing in the column model — a move
that changes A and X together is a line in the (A, X) grid, exactly as a move that changes X and Y is
a line in the (X, Y) grid — and it costs the *exact* sweeper everything, because a helical sweep is
not a hull of two tool placements. Which is why I (A fixed per operation) is the exact sweeper's
class and W is the column engine's.

---

## 3. The data model, and the bolt-on question

For each piece the issue names: what A needs, whether it is additive or structural, and what breaks if
it is added later rather than now. "Now" means a type-level reservation in a milestone R-0 (§10), not
behaviour; **nothing in this section is implemented by this document.**

### 3.1 `MoveEvent` and `MachineState`

- **Needs:** `a` (exists). For the runner to interpolate A it also needs to know whether the line
  *commanded* A (`G1 A90` when already at 90 is not a move; `G1 X5` after `A90` keeps A) — today it
  infers that from a change in value, which is right except for a zero-delta command.
- **Decision R3 — A never joins `Pos`.** `Pos` is a translation-mapped triple consumed by `frames.ts`,
  `toMachinePos`, `insideEnvelope` and every sweep quad; A is an angle with unwind semantics and a
  work offset in degrees (Tormach's own release notes record an A work-offset bug,
  `extracted/tormach/PathPilot_UserGuide_Lathes_UM10751.md:7043`). Putting it in `Pos` would make
  every triple a quadruple and every frame function wrong by construction. **Additive:** a sibling
  field, as it already is.
- **Later-is-fine:** adding `aCommanded: boolean` and an `aOffset` on `MachineState` touches the
  parser and reducer only.
- **Must change when W starts, not before:** `G92.4 A S/R` becomes a `rotary-unwind` event (§1.2),
  and `applyEvent` carries `a` on machine-frame moves too.

### 3.2 `Checkpoint`

`/Simulation.md` §5 and #223 both say "rotary adds an `as` pair per move to `Checkpoint` beside
`zs`". **Tested against §1.1, that is the wrong unit for two of the three classes:**

- For **W** and **R**, A changes on nearly every move and Z on most of them (finish: 2 391 Z values),
  so a (segment, Z) run is about one move. The checkpoint — "a run of cuts at one Z, materialised as
  one Manifold solid" — is the *exact sweeper's* unit of work and of playback (§8.0). The column
  engine does not produce solids per run; it produces a grid, and its playback cadence is its own
  (§4.4). Adding `as` to a type the column engine never reads is the field-nobody-tests case.
- For **I**, A is constant inside an operation, so what the checkpoint needs is **one `a`**, and the
  run-splitter must **open a new run when A changes** (today a change in A does not). Without that,
  indexed playback would fold cuts on two faces into one solid and draw them on the wrong face.

**Decision R4 — `Checkpoint` gains a single `a: number | null` (constant within the run) and the
run-splitter keys on (segment, A, Z); the per-move pair goes to the column engine's own move record,
not to `Checkpoint`.** *Reason:* above. **Additive and local** (one field, one condition in
`buildTimeline`); nothing breaks if it waits for milestone I, because until then every run has
`a === null`. §11 corrects the sentence in `/Simulation.md` §5 and §9 item 4.

### 3.3 The toolpath IR (#172) and the post (#173)

- **Needs:** `CamMove` gains `a: number` on every move of a rotary IR (fully resolved, like the other
  axes, so the post only omits words — #187 item 3); `ToolpathIR` gains a frame discriminant,
  `frame: 'flat' | 'rotary'`, carrying the radius datum so a rotary IR cannot be posted by the flat
  path silently; `PostContext.zDatum` gains a second legal literal (`'rotary-axis'`) and `origin` a
  rotary value — the literal type exists precisely to force the datum to be *stated*, so a second
  value is its intended extension; the `;@MKR|STOCK` record needs the round-stock form (**unknown**:
  the two vendor files carry no header, and no Studio-generated rotary `.nc` has been seen — §9).
- **Additive or structural?** Additive. `emit` is a sticky-word loop (one more letter), the IR's
  moves are plain records, and the frame field defaults to `'flat'` for every existing caller.
- **What breaks if added later:** nothing in the type system; **one thing in the tests** — the
  round-trip `sweep(ir) ≡ sweep(parse(post(ir)))` and the golden-number frame tests
  (`/Simulation.md` §1.2, §2) have no rotary case, and a rotary frame is a *new* frame (§3.6), so
  those tests have to be written when the frame is, not retrofitted.
- **Decision R5 — #223's instruction stands: do not add `a` to the IR, the post or the sweep until
  milestone W is active.** *Reason:* confirmed by the analysis, not by preference — every rotary
  addition here is local and additive, so adding it early buys nothing and leaves a word in the post
  that no job produces. What **does** go in R-0 is the frame discriminant on `ToolpathIR`, because
  its absence is the one thing that would let a later rotary IR flow through the flat post
  unnoticed.

### 3.4 `PartSpec`, `Workholding`, `Setup`

- `PartSpec.cylinder` needs: the axis direction (always X on this machine — the module is parented to
  Y and the vendor's X spans the part while Y is 0), which end is in the chuck, the grip length, and
  the nominal radius as a **registration input with provenance** (the probed radius and run-out
  replace the nominal; §6).
- `Workholding.rotary-chuck`'s `jawDiameter` is ambiguous (jaw opening? chuck body?). It needs the
  **grip diameter** (what the jaws close on), **jaw mode** (`'standard' | 'reverse'` — the wiki says
  reverse is fitted by default, §1.4), **tailstock** (`boolean`, with the centre-hole note), and
  `stickout` (exists). The chuck body and tailstock are **obstacles with provenance** per decision 28
  — the `FixtureEnvelope` box type is enough for a conservative bound, and a rotationally symmetric
  obstacle does not care whether it is drawn rotating.
- `Setup` needs the **rotary datum**: the axis line in machine coordinates (y, z), the X of the chuck
  face, the A-zero convention, each with `source` and `uncertainty` exactly as `placement` and `wcs`
  carry them (`/Simulation.md` §1.1). `stubSetup`'s cylinder branch currently puts the WCS on the top
  of the cylinder; under R6 it moves to the axis.
- **Additive** (new fields, a new optional block). **Later-is-fine**, except that `stubSetup`'s
  cylinder convention is already *wrong* against the firmware (§1.2) and is relied on by one test
  (`cncSweep.spec.ts:195`); correcting it is part of R-0 so no further test is written against it.

### 3.5 `MachineProfile` (#184)

- **Needs:** a `rotary` block, optional (`undefined` = no module), all as **sourced data** in the
  `SoftEndstop` pattern: axis name `A`, parent `y` (`Makera_Z1.fcm`), envelope ⌀80 × 150
  (`t_MachineType`), `stepsPerDegree 88.888889`, `maxRate 3600 °/min`, `acceleration 360 °/s²`,
  `homing: 'home_to_min'`, `unwind: 'G92.4 A S'` (all `configZ1.default` / `Robot.cpp`, flagged
  *shipped default, unverified on the device*), the module datum preset (semantics **unknown**),
  and — deliberately — **no angular travel limits**, because A is unwound and none exist; the
  Pocket NC spec sheet shows what a limit looks like when it is real (`A −25° to 135°`,
  `extracted/pocketnc/spec-V2-10.md`).
- `capabilities.rotary: boolean` stays as "a module exists"; the block says what it is.
- **Additive.** Later-is-fine; the schema must gain it at the same time (`projectSchema` strips
  unknown keys — the standing rule).

### 3.6 Frames

`/Simulation.md` §2 fixes **one** work frame: Z = 0 on the top face, cuts negative. **A rotary job has
a different work frame** (§1.2): Y = 0 on the axis, Z = radius, X along the axis, and A the stock's
rotation. `toWorkFrame` is one function shared by post and simulator so a frame error cancels in the
round-trip (§1.2 of that document) — which is exactly why a rotary frame needs its **own golden-number
test**, hand-derived, for a glyph off-centre in both X and A, before either side uses it.

**Decision R6 — the rotary work frame is the firmware's: origin on the rotary axis, work Z = radial
distance above the axis, work Y ≡ 0, X along the axis; A is the stock's rotation about +X.** *Reason:*
§1.2 — it is read from the machine's own feed arithmetic. The sign of +A (which way the chuck turns)
is **unknown** until the bench (§9); the frame carries it as a field, not an assumption.

### 3.7 The verifier's context (#174)

**Needs:** a rotary mode in `VerifyContext` that admits the `A` word to the dialect, replaces the
cuboid `stockDepthLimit` with a **radius limit** `(x, θ) → deepest permitted radius`, and adds the
rotary refusals of §6. **Additive** (a second depth-limit shape behind the same `DepthLimit`
injection the flat case already uses). Later-is-fine.

### 3.8 Summary — the bolt-on verdict

Nothing above is structural. The axis was kept out of `Pos`, the checkpoint is the right unit only
for class I and gets one field, the IR and post are word-loops, the profile is data. **Three things
belong in R-0 because their absence would let a mistake through later, not because they are
rotary features:** the `ToolpathIR` frame discriminant (3.3), the correction of `stubSetup`'s
cylinder WCS to the axis (3.4), and the second legal `zDatum` literal (3.3). Everything else is
sequenced into W and I.

---

## 4. Simulation

### 4.1 One engine, two parameterisations

A **column engine** holds a 2D grid of columns, each a single height, and subtracts a tool by
per-column `min`. The flat parameterisation (#222) is columns over (x, y) holding the remaining top
Z; the rotary one is columns over (θ, x) holding the remaining radius ρ. **Decision R7 — one engine,
two parameterisations, and the rotary one is the simpler.** *Reason:* the grid, the min, the mesh
generation and the playback cadence are identical; only the **tool footprint** differs, and the
rotary footprint is the thing §4.2 works out. The flat footprint for a non-flat tool is a height
profile over the disc (#222's own statement); the rotary footprint for a flat end mill is a closed
form.

The exact sweeper keeps its own classes: indexed (I) and all of 2.5D. The two backends share the
`Timeline` and the `Sweeper` interface as `/Simulation.md` §5 already requires.

### 4.2 What a flat end mill does against a curved surface

In the cross-section plane perpendicular to the axis, a vertical end mill of radius `r_t` centred over
the axis with its tip at height `Z_t` above the axis is the half-strip `|y| ≤ r_t, z ≥ Z_t`. For a
column at angular offset φ from the tool, the material removed along that ray is the interval
`[Z_t / cos φ, r_t / |sin φ|]`, which exists only while `tan φ ≤ r_t / Z_t`. So, for `Z_t > 0`:

- columns within the half-angle `φ_max = atan(r_t / Z_t)` are cut to `ρ = Z_t / cos φ`;
- **the floor is a flat chord, not an arc** — the cut is deepest under the tool centre and
  shallower by `Z_t (1/cos φ − 1)` towards the tool's edge;
- the facet height at the edge is `e = √(Z_t² + r_t²) − Z_t`:

| cutter | r_t | Z_t = 5 | 10 | 20 | 40 |
|---|---|---|---|---|---|
| 1.0 mm flat | 0.5 | 0.025 | 0.012 | 0.006 | 0.003 |
| 3.175 mm flat | 1.5875 | **0.246** | **0.125** | 0.063 | 0.032 |

(mm, computed 2026-10-05.) On a ⌀20 dowel a 3.175 mm cutter leaves a 0.125 mm facet cusp at every
stroke edge — eight times #206's 0.016 mm oracle band — so the rotary oracle cannot be the flat one
with the frame swapped (§4.5). Along X the footprint is the ordinary disc: a column at axial offset
`dx` sees an effective `r_eff = √(r_t² − dx²)` in the angular formula.

**Step-over is measured along the arc at the floor radius**, `(R − d)·Δθ`, and #191's rule
(step-over ≤ tool radius) applies in that metric; a step-over set at the surface radius is 10 %
too wide on a ⌀20 dowel at d = 1 mm.

### 4.3 Where the single-valued column breaks: the axis crossing

For `Z_t ≤ 0` the ray from the axis along the column directly under the tool is inside the strip from
ρ = 0 outward — **the column is removed entirely** — while the column on the far side (φ = 180°) is
removed from the axis out to |Z_t| and keeps its material *beyond* that: the remaining solid is the
disc segment below the chord `z = Z_t`, and along the far ray the material no longer starts at the
axis. A single "remaining radius" cannot represent an interval that does not start at ρ = 0. **The
finishing file does this 3 847 times, to Z −5** (§1.1 item 6).

**Decision R8 — the first rotary engine is single-valued, and any move whose tip reaches Z ≤ 0
(or whose floor would) is refused, by name (`axis-crossing`), with the step.** *Reason:* class W
never approaches the axis (an engraving on a ⌀20 dowel stops 9 mm short of it), the refusal is
exact and cheap, and the alternative — interval columns, or a Clipper2 cross-section per X slab with
rotated half-strips subtracted — is a representation choice that belongs to class R and should be
made with a measured load (§10, R-5). **This is stated plainly as a limit: the vendor's own finishing
sample stays refused by the engine §5.5 describes.**

### 4.4 Resolution, memory, cadence — estimates to be measured, not measurements

Nothing here has been run; `/Simulation.md` §4's history (two confident wrong conclusions from
unmeasured loads) is the reason this paragraph is labelled an estimate and the first task of
milestone R-2 is a probe script against the Nefertiti rough file.

- **Grid.** To resolve the finish's 0.1175 mm per-turn pitch needs Δx ≤ 0.06 mm; its A steps are
  ≈ 0.54°, so Δθ = 0.25°. Over the finish's 50.24 mm of X that is 840 × 1 440 ≈ **1.2 M columns**,
  4.8 MB as Float32. The whole ⌀80 × 150 envelope at 0.1 mm × 0.25° is 1 500 × 1 440 = 2.2 M
  columns, 8.6 MB. Memory is not the constraint.
- **Work per move.** A 3.175 mm cutter at Z 10 has `φ_max` = 9°, i.e. 72 columns across at
  Δθ = 0.25°, by 32 columns along X at Δx = 0.1: ≈ 2 300 `min` operations per tool placement.
  The finish's 100 k moves, each at most a few placements long, is on the order of **10⁸–10⁹ scalar
  ops**: seconds in a worker, not minutes — *if* the inner loop is a typed-array walk. The rough
  (5 k moves, ΔA = 360° helix turns of 1.39 mm pitch) is far cheaper. Both are inside the 60 s
  `SIM_BUDGET_MS` on this arithmetic; **measure before believing it.**
- **A precision.** The finish ends at A = −153 720°. Float32 has a 24-bit mantissa: above
  |A| = 131 072° its spacing is 0.0156°, coarser than the file's 0.01° steps. `SimPath`'s Float32
  buffers cannot carry A as written. **Decision R9 — A is carried as Float64, or as (turns, angle
  mod 360); never as a Float32 of unwound degrees.**
- **Mesh regeneration.** The display mesh is a heightfield over the cylinder, rebuilt from the grid
  per playback frame at a *display* resolution (e.g. 0.5 mm × 1°: 300 × 360 = 108 k vertices,
  216 k triangles, ≈ 4 MB per transferred frame), not at simulation resolution. There is no boolean
  per frame; the regeneration is a straight loop, so the checkpoint cadence can be denser than the
  exact sweeper's — per operation and every N moves — and the "material updates at N points" line on
  the transport (#198) stays honest with a larger N. Decimation and transfer cost are R-2's second
  measurement.
- **Gouges.** A rapid is a gouge when, for any column its footprint crosses, the tip is below that
  column's remaining ρ — and the vendor's rapids *do* move A (`G00X74.00Z30.00A130.42`), so an air
  move is a helix sampled along its length. The "retract straight up is in air by construction" rule
  (`/Simulation.md` §4.6) survives when only Z increases and A and X are unchanged. A gouge is
  reported and drawn, never subtracted (#192 q1) — as a column-set, meshed like the stock.

### 4.5 The oracle in column space

#206's band — `levels × simplifyEps + 2 × ARC_CHORD_TOLERANCE_MM` — is made of Clipper2 and
tessellation artefacts of the exact sweep; none of them exists in a sampled grid, and #222 already
says the band does not apply as written. For class W the prediction is still analytic: the opened
region of each glyph on the unrolled plane (`offset(offset(G, −r), +r)`, #171 / #201), and the test
is **per column**: predicted floor radius `R − d` inside the opened region (with the facet term of
§4.2 added towards the stroke edges), `R` outside, against the simulated ρ. The tolerance is **one
grid cell in each direction plus the facet term** — derived from named constants (Δx, Δθ, r_t, Z_t),
never hand-set, the same discipline as `/Simulation.md` §7. Under-cut remains the direction with real
content (step-over gaps along the arc); over-cut outside the region catches a wrong `A = s / R`
mapping, which no flat test can.

**What the opened-region prediction must use (Decision R10):** the item is **authored on the surface
map** (arc length at the design radius R — what the user sees on the dowel, and the frame
`feedback_landmark_geometry_comms` asks for), **A is posted from the surface arc length**, and the
opening is computed with an **anisotropic radius**: `r_t` along X, `r_t · R / (R − d)` along the arc
— because a vertical tool at floor depth d subtends `atan(r_t / (R − d))` of arc, which on the
surface map is wider than `r_t`. For engraving depths the correction is ≤ 11 % on a ⌀20 dowel; for
anything deeper it is the difference between a legible letter and a merged one, and it must be in the
same function the viewport's opened-region preview uses so the two cannot disagree (#201's rule).

### 4.6 Indexed jobs on the exact sweeper

For class I the stock at index `A_k` is the Manifold cylinder rotated about X by `A_k`; each
operation is constant-Z 2.5D and sweeps exactly as today; its removal solid is rotated back by
`−A_k` into the stock frame before it joins the cumulative union, so `stockAt(k) = stock −
∪ removals` holds unchanged and playback needs no new machinery. Cost: one `rotate` per checkpoint.
The one structural prerequisite is R4 (a run breaks when A changes). A flat cut on a round stock is a
CSG the exact path already does well.

### 4.7 What stays refused

By name, with the step and the reason: `Y ≠ 0` on any move while a rotary job is active (R1);
`axis-crossing` (R8); a non-flat tool on a rotary job until #221/#222's tool profiles exist in the
column engine (`tool-refused`, as today); stock outside ⌀80 × 150 (§6); `G93` inverse-time feed
(already `unsupported-code` — and the mode Fusion's 4-axis output uses, §8); a rotary job on the
*exact* sweeper (`rotary-job` stays, narrowed to "A changes inside a run" once I exists).

---

## 5. Visualization — the half nobody had written down

Nothing in the repo says how a rotary job should be *drawn*. The existing layers (#197) are: an opaque
stock mesh, a translucent removed-material ghost (`depthWrite: false`), opaque gouge solids, the cut
path (done / to come by `drawRange`), dashed rapids, a tool cylinder standing on the tool tip, fixture
boxes, a sacrificial body; camera presets and `Fit` frame `activeSceneBounds()`; the transport is
step-indexed with pause ticks; the engrave preview draws the prism stock with depth-coloured floors
and an X/Y axis marker. Four ways to draw a rotary job, measured against those.

### 5.1 The four options

**(a) Rotate the stock.** The physical picture: the stock turns about X by A(step); the tool stays
in the X–Z plane at Y = 0. The stock mesh, the removed ghost, the gouges and *the cut path* live in a
group whose rotation is `−A(step)` (or `+A`; the sign is the bench's, §9); the tool, the headstock
body, the tailstock and the camera live in the fixed frame.

- *Path lines.* In the work frame the tool tip never leaves the plane Y = 0: the cyan path collapses
  to a 2D curve in X–Z and says nothing about *where on the part* a cut landed. In the stock frame
  the same path is the helix wrapped on the cylinder — informative — and it rotates with the stock,
  so "done" segments stay on the material they cut. `splitPath` / `segmentGeometry` are unchanged;
  what changes is a pure helper that converts `(x, z, a)` per vertex into the stock-frame point
  `(x, z·sin a, z·cos a)` (sign convention pending). The drawRange logic is untouched.
- *Removed ghost and gouges.* Stock-frame, in the rotating group; `depthWrite: false` as before.
  They are material-relative, so this is the only frame in which they can be right.
- *Camera.* The stock's bounding box `[x₀, x₁] × [−R, R] × [−R, R]` is **invariant under rotation
  about X**, so `activeSceneBounds` needs no per-step update and `AutoFrame` does not fight the
  rotation. Top / Front / Side keep their meaning: Front looks along Y at the X–Z plane the tool
  lives in, which is the most useful rotary view. The SimMeshes contract "Z = 0 at the stock's top
  face, material at negative Z" is **false** for a rotary scene (material spans Z ∈ [−R, R]);
  `GridFloor` is already hidden in CNC mode, which is right because the floor plane would cut the
  cylinder in half.
- *Transport.* Step → A(step) is a lookup (`stateAt(step).a`, or the new `a` buffer on `SimPath`);
  the rotation is a transform, **free per frame**. This is a genuine gain over the flat case: between
  material updates the flat emulator can only move the tool, while the rotary one shows the stock
  turning under it. The bar gains an A read-out (degrees and turns). Pause ticks are unchanged.
- *Material updates.* The stock mesh regenerates at the column engine's cadence (§4.4) — no boolean,
  a heightfield re-mesh — so the stock can update more often than the exact sweeper's checkpoints
  without changing the transport model.
- *Fixture.* The chuck body and tailstock are machine-frame obstacles and do not rotate; the jaws do,
  but the obstacle envelope is a bounding solid of revolution so drawing it fixed loses nothing.

**(b) Rotate the tool / the world.** Stock fixed, tool orbits the axis. Cheaper only in the sense that
the path is static. It is wrong-looking — the user's machine does not do that — and it misleads on
the one thing the fixture layer exists for: a tool drawn at an angle appears to approach the chuck
and tailstock from directions it never takes. Rejected, except as the frozen "inspection" pose of (d).

**(c) Unrolled / developed view.** The cylinder surface as a flat map `(x, s)` with `s = R·θ` and
depth `R − ρ` drawn as a flat heightfield. **It is the existing flat scene with `s` for `y`:** every
layer, the camera presets, the depth-coloured floors, the X/Y axis marker and the transport work
unchanged, and it is what the authoring pass needs — text is laid out on a flat page. Its limits:
the seam at `s = 0 ≡ 2πR` (a glyph crossing it must be split or the map duplicated by a margin on
each side), spiral and multi-turn paths leave the page (Vectric names exactly this, §8), the facet
geometry of §4.2 is invisible (floors draw flat, which is fine), the chuck and tailstock become end
bands with no sense of the real diameter, and class R's axis crossings are undrawable.

**(d) Hybrid.** (c) for authoring and inspection, (a) for the run, with a toggle between them on the
same session: the column grid *is* the unrolled map, so "unroll the result" is a re-mesh of the same
data onto a plane.

### 5.2 Recommendation

**Decision R11 — hybrid: the engrave panel authors on the unrolled map; the simulation draws the
rotating cylinder with the path, ghost and gouges in the stock frame and the tool fixed; an "unroll"
toggle re-meshes the same columns onto the plane for inspection; the stock, not the tool, rotates.**
*Reasons:* (a) is the only frame in which the ghost and gouges are truthful and it makes the transport
more informative than the flat case for free; (c) is where the user reasons about layout and it reuses
the whole flat viewport; neither alone covers both; and the corpus shows the two vendors with real
wrapping doing exactly this split — Vectric's *"how the 2D view will be laid out"* plus *"visualize your
job in a wrapped environment … auto-wrapped simulation"* (§8), and Tormach's live plot of *"the effective
tool path relative to the workpiece"* (§8). (b) is rejected for the fixture reason above.

### 5.3 Consequences for what exists

| Existing piece | Change under R11 | Additive? |
|---|---|---|
| `SimPath` (#197) | gains `a: Float64Array` per vertex (R9); `xyz` stays the tool-tip work position | yes |
| `simGeometry.ts` | one pure helper: work `(x, z, a)` → stock-frame `(x, y, z)`; a second: column grid → unrolled plane mesh | yes |
| `SimMeshes.tsx` | a rotating `<group>` for stock / ghost / gouges / path; the tool and fixture stay outside it; the "Z = 0 at top face" comment becomes per-frame-kind | yes |
| `viewportCamera.ts` | nothing — the cylinder's bbox is rotation-invariant; `Fit` and presets work as they are | — |
| `AutoFrame` | nothing; it must *not* reframe per step, and the invariant bbox guarantees it does not | — |
| `SimTransport.tsx` | an A read-out (° and turns); otherwise unchanged — step-indexed, pause ticks, material cadence from the backend | yes |
| playback (`playback.ts`) | not used by the column engine; its anchors and MRU stock cache are Manifold-specific. The column engine keeps **grid snapshots** at its own anchor spacing and replays `min`s between them — the same bounded-memory idea, different store | new module |
| `EngravePreview.tsx` / `engravePreview.ts` | a `cylinder` stock renders the **unrolled map** by default (the existing prism path with the stock's `width` = 2πR, a seam margin, and the chuck/tailstock drawn as end bands), and a **wrap toggle** shows the dowel with the opened regions on it — the floors and stock warped onto the cylinder (`Manifold.warp` on the preview meshes, or a textured cylinder), the axis marker reading X and A instead of X and Y | yes |
| run sheet (#207) | rotary sections (§6.4) | yes |

**What the engrave preview shows while a rotary job is authored:** the unrolled map with the
opened regions coloured by depth exactly as today, plus the seam line, the chuck and tailstock bands
at the ends of X with their source labels (default / saved / measured), the surface circumference as
the map's height, and — in the wrap view — the same regions on the cylinder with the A-zero mark.
The anisotropic opening of R10 is what both views draw, so a stroke that merges at depth merges in
both.

---

## 6. Registration and safety

### 6.1 How the chuck fixes the axis, and what is still free

A three-jaw chuck fixes the **axis line** (y, z in machine coordinates) and, with the tailstock,
holds the part still; it fixes **nothing in X** (the stock can sit anywhere along the jaws), and it
fixes **A-zero only up to a convention**. Under decision 26 (`/Fabrication.md` §7.3) the
`rotary-chuck` variant answers the four questions as:

| | Answer |
|---|---|
| Reachable | the stock's surface at any A, the stock's free end face (X), the top of the chuck body |
| Obstructed | the chuck body and jaws from the chuck face inward; the tailstock body and centre from the free end inward — **envelopes with provenance** (decision 28), defaults unknown until measured |
| Datum candidates | the axis line, from the module's preset zero (precision **unknown**) or from probing; **not X and not A-zero** |
| Residual | X (the chuck face or stock end must be touched); the stock's actual radius and run-out; A-zero if the job is indexed to a feature |

### 6.2 Probing the radius and the run-out

Probe Z on the stock top at A = 0°, 90°, 180°, 270° at one X. The mean is the radius; the first
harmonic is the eccentricity of the stock relative to the rotary axis; the second harmonic is
out-of-round. The planner (#188) consumes the result as `radius` with `uncertainty = eccentricity`,
and **refuses the job when the eccentricity exceeds the depth band of the shallowest item** rather
than engraving a letter that is deep on one side and absent on the other. Repeating at a second X
gives the stock's tilt relative to the axis, which the tailstock adjustment controls. Roland's
controller does the machine-side half of this — *"Detect the rotary axis and correct its position
and orientation"*, with separate inversion and tilt corrections
(`extracted/roland/MDX-50_UserManual_EN.md:2797–2827`) — and Tormach's probe tab finds the A-axis
centre and can do so without rotating A (UM10751 `.md:7107`, `:7193`). Bantam ships a **gauge pin** to
find the chuck centre *"whenever you install it"* (`raw/bantam/art-4th-axis.txt`). The axis datum is
re-established per mounting, everywhere.

### 6.3 What the A envelope check can honestly assert

- **Nothing about angular limits.** A is unwound (§1.1 item 3); the shipped config has a homing
  switch but no travel limit for A, and `Makera_Z1.fcm`'s ±10 000 000° is boilerplate. A check that
  refused at some angle would be inventing a constraint (`/Simulation.md` §9 item 7's logic).
- **It can assert the representable range** — R9's Float64 — and warn when |A| grows past a round
  number of turns without a `G92.4` unwind, because the vendor's own files unwind at the end.
- **It can assert the radial envelope:** every tool placement must satisfy `Z_t + stock clearance
  ≤ machine Z max − axis height` and the stock must fit ⌀80 × 150 — but the **module axis height above
  the table and the chuck face's X in machine coordinates are unknown** (§9), so until the bench the
  check is "cannot be proven", a warning, never a silent pass (the `holder-vs-fixture-unproven`
  pattern).

### 6.4 The refusals the verifier owes a rotary job

| Code | Rule | Why |
|---|---|---|
| `rotary-y-off-axis` | any `Y ≠ 0` while A is in use | R1; the firmware's feed model and the column model both assume Y = 0 |
| `axis-crossing` | tip or floor at Z ≤ 0 | R8 |
| `rotary-rapid-engaged` | a `G0` that changes A or X while `Z_t` is below the stock's current surface radius at that column (cheap form: below `R_stock + clearance`) | the rotary form of `rapid-too-low`; the vendor's rapids move A |
| `wrap-into-clamp` | any cut X inside the chuck envelope or the tailstock envelope, the envelopes inflated by their uncertainty | the chuck and tailstock are the fixture |
| `stock-exceeds-module` | stock diameter > 80 or length > 150 | `t_MachineType` |
| `feed-at-radius` (warning) | surface speed implied by F and the perimeter model (§1.2) falls below the table value by more than a stated fraction, or the 60 °/s cap binds | so the operator knows the chip load is not what the table says (§3.4 below) |
| `g93-unsupported` | already refused | Fusion's 4-axis output mode (§8) |

### 6.5 The feed problem, stated with numbers — and what the run sheet must say

From the firmware model as read (§1.2) — **unverified on the device**: revolutions per minute
= `F / (2π·r + 30)`, capped at 10 rpm, and the surface speed the material sees is `rpm × 2π·r`.

| r (mm) | F = 500 → rpm / surface mm/min | F = 1200 → rpm / surface mm/min | cap 10 rpm → surface |
|---|---|---|---|
| 5 | 8.1 / **256** | *cap* / **314** | 314 |
| 10 | 5.4 / **338** | *cap* / **628** | 628 |
| 15 | 4.0 / 380 | 9.7 / 910 | 942 |
| 20 | 3.2 / 404 | 7.7 / 969 | 1 257 |
| 40 | 1.8 / 447 | 4.3 / 1 072 | 2 513 |

So at the engraving radii the material sees **half to three-quarters of F**, and below r ≈ 19 mm at
F 1200 the A speed cap, not F, sets the surface speed. The vendor's own files hit the cap: the rough's
last level at r = 8 with F 1500 is 18.7 rpm by the formula and runs at 10; the finish at r = 4.5 with
F 1125 is 19.3 rpm and runs at 10, i.e. 283 mm/min at the surface.

**The post emits F in mm/min exactly as today (R12).** *Reason:* the controller converts; emitting
degrees would be converting twice. **The run sheet tells the operator:** the stock radius the job was
posted for and the probed radius it must match; the surface speed range the material will see (from
the table above, labelled "from the firmware's model, unverified"); that the A axis caps at 10 rpm as
shipped; the A-zero convention and which way +A turns (once known); the chuck jaw mode and tailstock
state the envelopes assume; and the unwind at the end. Section 2 ("Mount the vise") becomes "Mount the
rotary module", carrying the wiki's pin-and-screw steps with the `unverified` tag, and section 5's
origin diagram becomes the axis-centred one.

---

## 7. Decisions

| # | Decision | Reason | Section |
|---|---|---|---|
| R1 | Scope is 3+1 wrapped: tool over the axis (Y = 0), A interpolating freely with X and Z; tilt / off-axis out | the vendor's files, the firmware's feed model and the column model all assume it; §5.5's "no interpolation" is measured false | §2 |
| R2 | Order: W (wrap engraving) → I (indexed) → R (continuous relief, not committed) | W is the stated first job with an analytic oracle; I reuses the exact sweeper; R needs a representation nobody has specified | §2 |
| R3 | A never joins `Pos` | `Pos` is translation-mapped and consumed everywhere; A has unwind semantics and its own offset | §3.1 |
| R4 | `Checkpoint` gains one `a`, runs break on A change; per-move A lives in the column engine's record | the checkpoint is the exact sweeper's unit (class I); it is the wrong unit for W and R | §3.2 |
| R5 | #223 stands: no `a` in IR / post / sweep before W; only the `ToolpathIR` frame discriminant, the second `zDatum` literal and the `stubSetup` cylinder WCS fix go in R-0 | all additions are additive; those three are the ones whose absence lets a later mistake through | §3.3, §3.8 |
| R6 | Rotary work frame = the firmware's: origin on the axis, Z = radius, Y ≡ 0, X along the axis | read from the firmware's own feed arithmetic; matches the vendor files and Makera CAM | §1.2, §3.6 |
| R7 | One column engine, two parameterisations; the rotary one first if the maintainer chooses (§10) | identical grid / min / mesh / cadence; only the footprint differs | §4.1 |
| R8 | Single-valued columns; Z ≤ 0 refused by name (`axis-crossing`) | W never nears the axis; the finish file's crossing needs class R's representation | §4.3 |
| R9 | A carried as Float64 or (turns, angle); never Float32 unwound degrees | 153 720° exceeds Float32's 0.01° resolution | §4.4 |
| R10 | Author on the surface map, post A from surface arc length, open with the anisotropic radius `r_t · R/(R−d)` along the arc | the user reasons from the dowel; the geometry of a vertical tool at floor depth | §4.5 |
| R11 | Hybrid viewport: unrolled for authoring/inspection, rotating stock (not tool) for the run | ghost and gouges are truthful only in the stock frame; the map reuses the flat scene; Vectric and Tormach split it the same way | §5 |
| R12 | Post emits F in mm/min; the run sheet reports surface speed and the 10 rpm cap | the controller converts; the operator needs what the material sees | §6.5 |

---

## 8. Prior art — read from `docs/market-research/`, cited by file

`FEATURE-MATRIX.md:186` ("4th axis / rotary") with the column key at `FEATURE-MATRIX.md:110`:
MKS Y · MKC Y · C3 N · BT P · SM Y · IV N · RG P · TM Y · SC P · OB N · GM P · SP N · ST ? ·
VC Y (Pro) · CV Y · ES ? · AD Y · LB N · OF P · PN Y (5-axis). `UI-PATTERNS.md` has **no rotary
entry at all** — none of its ten patterns is about the 4th axis — so what follows is from the notes
and the raw captures.

| Vendor | What it does (evidence) | Copy | Refuse |
|---|---|---|---|
| **Vectric** VCarve / Aspire | Job setup is *single-sided, double-sided or rotary*, changeable retrospectively; the rotary dialog asks for *"your cylinder dimensions, the orientation of the job, how the 2D view will be laid out and which axis you're wrapping around"*; *"visualize your job in a wrapped environment … simulate the toolpaths in an auto-wrapped simulation"*; **spiral toolpaths** are long vectors that *"exceed the 2D workspace of the rotary job"* and stay in the material through wrapping; the mechanism is stated outright: *"wraps standard 3 axis toolpaths around a cylindrical axis, substituting one of the linear axis to drive the rotation"*; full 3D models and *"Flat 3D"* reliefs can be unwrapped into a rotary job (`raw/vectric/txt-vcarve.txt:199, 209–227, 339–341`; same text in `txt-aspire.txt`). Pro-tier only (`FEATURE-MATRIX.md:186`). | the unrolled 2D view for layout + wrapped 3D simulation (R11); job type chosen at setup and changeable; the explicit "which axis you're wrapping around" question — ours has one answer (X) and should say so | "substituting a linear axis" as the *post's* model — our controller has a real A with its own feed scaling (§1.2); substituting Y would defeat it |
| **Carveco** | `FEATURE-MATRIX.md:186` marks CV = Y, but **no captured text supports it**: `notes/carveco.md` lists strategies without rotary and records that the comparison accordion rendered only three of its blocks ("Gaps"). **NOT FOUND in the corpus** — nothing about Carveco's rotary can be stated here. | — | — |
| **Fusion 360** | marketing only: *"whole-part strategies like steep & shallow, deburr, hole recognition, and rotary"*, *"specialized 4- and 5-axis toolpaths… collision avoidance"* (`raw/autodesk/txt-overview-archive.txt:118`; `notes/autodesk-fusion360.md`, Feature inventory). Indirect, from Tormach's manual: Fusion's 4-axis programs need *"G64 Naive CAM Detection … supports rotary axes, which smooths out 4th axis Fusion 360 programs"* and use **G93 inverse-time feed** for *"simultaneous coordinated linear and coordinated rotary motion"* (`extracted/tormach/PathPilot_UserGuide_Lathes_UM10751.md:7279, :5935, :7345–7349`). Makera's own Fusion workflow page exists (`/Makera-Parity.md` §11) but says nothing about the rotary. | nothing specific — the CAM-simulation doc was not captured | **G93** — our parser refuses it (`unsupported-code`) and the firmware is not known to support it; a Fusion 4-axis post for the Z1 is unverified territory |
| **Roland** MDX-50 / SRP Player | the A word is accepted only with the optional unit; DRO shows the angle to 0.01°; the controller **detects the axis and corrects position, orientation, inversion and tilt** (`extracted/roland/MDX-50_UserManual_EN.md:4693, :531, :2791–2827`); *"The feeding speed of the A axis depends on the specifications of the attached rotary axis unit"* (`:4731`); SRP Player on the MDX-40A was sold as *"4-axis SRP Player"* for *"multiple-surface cutting"* — indexed faces (`extracted/roland/3d-tech-brief.md:48`; `MDX-50_InstallGuide_EN.md:1879`) | the axis as a **measured, corrected, saved datum** with tilt — decision 28's shape; indexed multi-surface as a job class (I) | nothing |
| **Snapmaker** Luban | *"3-/4-axis laser and CNC"* (`notes/snapmaker.md` §3); the CNC UI and any rotary preview were **not captured** ("Gaps") | — | — |
| **Stepcraft** / UCCNC | no CAM of its own (`notes/stepcraft.md` §3); UCCNC's setup has *"functions designated to find the center of the 4th axis"* — a tool-length sensor placed beside, then above, the axis gives a horizontal and a vertical measurement and *"automatically calculates the center of the 4th axis"* (`extracted/stepcraft/manual-uccnc-quickstart.md:1077–1123`, manual p. 21); a *"Rotary Table with Three-Jaw Chuck (4. Axis)"* accessory, Art. 10055 (`:1539`, p. 27) | a two-touch axis-centre routine as the planner's rotary datum step | — |
| **Tormach** PathPilot | A-axis centre probing, with an option to find the centre *without rotating A*, and *"a visually distinct probe model in the live plot"* (`UM10751.md:7193`, `:7107`); a **4th Axis Rotary settings sub-tab** and an improved *"A-axis display in the Tool Path display, which makes it easier to understand the effective tool path relative to the workpiece"* (`:7275`); 4th-axis homing (`:7309`); a feed DRO bug when only A moved and A work offsets wrongly scaled in G21 (`:7043–7047`) | the stock-frame ("relative to the workpiece") path display (R11a); A as a probed centre; **A work offsets exist** and have units — R3's reason | — |
| **Pocket NC / Penta** | A −25°…135°, **B continuous (−9999° to 9999°)**, 40 °/s, 0.01° resolution, ±0.05° repeatability (`extracted/pocketnc/spec-V2-10.md`); Kinetic Control adds G-codes for **TCPC, Rotated Work Offsets and "Rotary Unwind"**, and a **SIMULATOR** page as a 3D digital twin (`notes/pocketnc.md` §3, §4) | "Rotary Unwind" as a named, visible operation (our `G92.4 A S`); limits written as ranges with resolution and repeatability, so a profile can carry *real* ones | TCPC / tilt — out of scope by R1 |
| **Genmitsu** / Candle | rotary module as a $279 accessory with *"184mm Clamp Range"*; *"4th Axis Support ✔"* on the 4040-PRO and PROVerXL spec rows (`raw/genmitsu/g-4040-pro.txt:75–81, :149`; `g-3018-prover-v2.txt:55, :158`; `g-proverxl-4030-v2.txt:87, :175–177`); Candle *"allows operation up to 4-axis milling machines"* (`notes/genmitsu.md`, Feature inventory) | — | the GRBL route generally: no native A axis |
| **Sienci** gSender / Vortex | *"Supports 4th and rotary axes, even on vanilla grbl devices by hijacking Y-axis movements"*; *"rotary accuracy fixes"* in the visualiser; *"rotary time estimation"* (`raw/sienci/gsender-readme.md:57, :215, :195, :222`); Vortex ships *"a switch for going from linear to rotary mode"*, chuck and tailstock (`raw/sienci/sienci-vortex-rotary-axis.html`, product body) | a **rotary mode** the visualiser must know about to draw correctly — the same fact as R11's stock frame; time estimation that knows the radius (§6.5) | Y-axis hijacking — a workaround for a controller without A |
| **Bantam** | headstock *"factory-aligned"*, adjustable tailstock with live centre, three-jaw chuck, belt-driven stepper; a **gauge pin** *"used to find the centerpoint of the chuck … whenever you install it"*; a tool touch-off block; separate *"SVG Workflows"* and *"Fusion 360 Workflows"* for 4th-axis (`raw/bantam/art-4th-axis.txt`, body and article list) | find-the-centre-on-every-install as a planner step; SVG (2D) wrap as a first-class path | — |
| **Makera** CAM Beta / Studio | §1.3: project type at launch, Square/Round stock, Rotation Relief only, manual tabs, clearance = ½ ⌀ + 3, tailstock containment; Carvera-only (`FEATURE-MATRIX.md` §3.2) | the project-type decision at setup; the clearance rule as a named default | relief-only rotary — class W is the gap in the incumbent's offering |

**Across the corpus, the two questions the issue asked split cleanly.** *Wrapping versus true 4-axis:*
only Fusion and Pocket NC do true simultaneous multi-axis; Vectric, Makera, Roland's SRP Player,
gSender and Bantam's SVG route are all wrapped 3+1 — R1 is the field's norm, not a simplification.
*How the job is previewed:* the only vendor whose preview is documented in the captured text is
Vectric (2D unrolled layout + wrapped 3D simulation) and the only controller-side display described
is Tormach's stock-relative path; nobody in the corpus is documented drawing the tool orbiting a
fixed stock. *What the UI asks the user for:* cylinder dimensions, orientation, wrap axis, 2D layout
(Vectric); stock shape and tailstock (Makera); the axis centre by probe or gauge (Roland, Tormach,
Stepcraft, Bantam). That is the input list §6 and the engrave panel should match.

---

## 9. Unknown until the hardware — and the bench item for each

| Unknown | Why it matters | Bench item |
|---|---|---|
| Which way +A turns (dir pin is inverted in the shipped config) | the viewport's rotation sign, the wrap's handedness, text mirroring | jog +90°, photograph the chuck mark |
| Steps per degree on the device vs the shipped 88.889 | every angle in every job | command 360° from a pencil mark; command 3600° and check the mark returns |
| The real `delta_max_rate` and whether the perimeter scaling behaves as read | §6.5's whole table; chip load | time a pure-A 3600° move at F 1200; time an A-only vs X+A move at known r |
| Homing: does `$H`/`G28` home A to the switch, and where is A = 0 after it | whether an indexed job can be re-run after power-off | observe at power-up and after homing |
| The module axis height above the table and the chuck face's X in machine coordinates | the radial envelope check (§6.3), the clearance of a ⌀80 stock under the head at Z max | probe the chuck body top and a mounted dowel; record with uncertainty |
| What *"zero point preset … at the center of the right edge of the spindle"* means and how precise it is | whether the module datum is a usable `fixture` source or needs probing every time | compare the preset against the probed axis at two mountings |
| Chuck jaw capacity in standard and reverse mode; tailstock reach | `stock-exceeds-module` and `wrap-into-clamp` | caliper |
| The `;@MKR|STOCK` record and `ORIGIN` for a round stock | the post's header | generate one Rotation Relief job in Studio and read the header |
| `G92.4 A S` / `R` behaviour on the device, and whether the rotary files' `G92.4A0S0` leaves X/Y/Z untouched | the parser's `rotary-unwind` semantics | run the unwind after a known position; read the DRO |
| Run-out and backlash of the belt drive at the chuck and at 150 mm | the eccentricity refusal threshold (§6.2) | dial indicator on a ground pin at two X positions |
| Feeds for PLA, softwood and hardwood at radius | the feeds table has no rotary column | the dowel job's own depth ladder, like #165 |

None of these can be answered from the files on disk, and this document does not guess at any of
them. Milestone R-1 is their home.

---

## 10. Milestones — proposed, not filed

**Open choice for the maintainer first (it decides the dependency arrow):** #222 and #223 say the
dexel engine comes first and rotary is built on it. §4.1 says the rotary parameterisation is the
*simpler* half of the same engine and class W is a far smaller, better-bounded first load than
`TopClamp.nc` or `PirateShip.nc`. **Option A** — keep the arrow as filed: #222 then rotary. **Option
B** — build the column engine once as a shared core and let W be its first consumer, then widen it
for #222. This document recommends **B**, for the bounded load and the analytic oracle, and because
R8's single-valued limit is exactly #222's stated limit too (no undercuts). The milestones below are
written for B; under A, R-2 becomes "#222's engine, then the rotary footprint".

| | Milestone | Entry | Exit | Bench work |
|---|---|---|---|---|
| **R-0** | **Keep it additive.** The three reservations of §3.8 (`ToolpathIR.frame`, the second `zDatum` literal, `stubSetup`'s cylinder WCS on the axis), `MachineProfile.rotary` as sourced data with provenance (§3.5), the `rotary-unwind` event for `G92.4 A S/R`, the doc edits of §11 | this document accepted; the maintainer's answers to §12 | all tests green; rotary still refused everywhere; `grep` finds no `A` word in the post | none |
| **R-1** | **Bench: fit and characterise the module.** Every row of §9 | the module, a dowel, a dial indicator, an afternoon | the profile's `rotary` block carries device values with `source: 'measured'`; the +A sign is recorded; a Studio rotary header is on disk (uncommitted, like the corpus) | all of it |
| **R-2** | **The column engine, rotary parameterisation.** Grid, footprint (§4.2), `axis-crossing` refusal, gouges, mesh at display resolution, snapshot anchors; a probe script first (§4.4's estimates measured) | R-0 | `NefertitiRough.nc` simulates inside `SIM_BUDGET_MS` with memory recorded; `NefertitiFinish.nc` is **refused** `axis-crossing` at its first Z ≤ 0 step, with the path still returned; the engine's interface is the one #222 extends | none |
| **R-3** | **Wrap engraving — the dowel.** `EngraveJob` stock `cylinder` + `workholding: rotary-chuck`; unrolled authoring with the seam and end bands; anisotropic opening (R10); wrap CAM; `a` in IR and post; verifier rotary rules (§6.4); the rotary frame's golden-number test; the column-space oracle (§4.5); the viewport hybrid (§5.3); run sheet sections (§6.5) | R-1 and R-2 | a verified, simulated, oracle-passing `.nc` cuts legible text round a wooden dowel; the probed radius and run-out are on the run sheet; the viewport shows the dowel turning with the path on it and unrolls on demand | the cut itself; a rotary depth ladder |
| **R-4** | **Indexed faces** on the exact sweeper: R4's run-splitting on A, rotated stock per index, flats and cross-features | R-3 | a two-flat job on a round stock simulates exactly and plays back per face | one indexed cut |
| **R-5** | **Continuous relief (class R)** — only if asked for: interval columns or per-slab cross-sections for axis crossing, ball/V footprints (#221), relief from mesh (#222's second half) | R-3, #222, a request | `NefertitiFinish.nc` simulates | — |

Issue titles proposed for the maintainer to file: *rotary: R-0 type reservations and doc corrections
(#235)*; *bench: fit the 4th-axis module and record A behaviour (R-1)*; *sim: the column engine,
rotary parameterisation first (R-2)*; *engrave: wrap text round a dowel — authoring, CAM, post,
verifier, viewport (R-3)*; *sim: indexed rotary faces on the exact sweeper (R-4)*; *cam: continuous
rotary relief and axis crossing (R-5, placeholder)*. #223 becomes the tracker or closes in favour of
them; #222's entry condition "rotary simulation is built on the dexel engine" is rewritten per the
option chosen.

---

## 11. Corrections owed to the other documents (not made here)

| File | Section | Change |
|---|---|---|
| `/Fabrication.md` | §5.5 | Replace *"The A axis indexes or wraps; it does not interpolate with X/Y/Z."* with: *"A interpolates freely with X and Z — Makera's own `Rotation/Nefertiti*.nc` are helices (§1.1 of `/Rotary.md`). What the heightmap cannot do is a tool that leaves the plane through the axis (Y ≠ 0, tilt) or a cut that crosses the axis (Z ≤ 0); both stay refused."* Add that the firmware scales rotary feed from the work-frame radius (`/Rotary.md` §1.2). |
| `/Fabrication.md` | §1, "Hardware we have", 4th-axis bullet | Add: mounts on the two 4 × 11 pins + three M5×10 after removing the MDF wasteboard (mutually exclusive with tape-down); three-jaw chuck, reverse jaws by default; tailstock; shipped config `88.889 steps/°`, `3600 °/min`, `360 °/s²`, `home_to_min` — *read, not measured* (`/Rotary.md` §1.2, §1.4). |
| `/Fabrication.md` | §4 decisions 3 and 11 | Notes column: *"Design in `/Rotary.md` (decisions R1–R12)."* |
| `/Fabrication.md` | §9.1, row "4th-axis fields in the IR" | Keep; add *"confirmed by `/Rotary.md` R5; the three R-0 reservations are the exception."* |
| `/Simulation.md` | §5, `DexelSweeper` bullet | Replace *"The A axis indexes or wraps; it never interpolates with X/Y/Z, which is what makes the reparameterisation legitimate"* with *"The tool axis always intersects the rotary axis (Y = 0), which is what makes the reparameterisation legitimate; A interpolates with X and Z. A cut crossing the axis is refused (`/Rotary.md` §4.3)."* Replace *"rotary adds an `as` pair per move to `Checkpoint` alongside `zs`"* with R4. |
| `/Simulation.md` | §9 item 4 | Same correction as §5: the `as` pair is withdrawn; `Checkpoint.a` (single) for indexed jobs; per-move A is the column engine's. |
| `/Simulation.md` | §2 | Add: *"A rotary job has its own work frame — origin on the rotary axis, Z = radius, Y ≡ 0 (`/Rotary.md` R6) — with its own golden-number test."* |
| `/Simulation.md` | §7.1, corpus table, "two 4-axis files" | Add the measured facts: X+A and Z+A interpolation, A unwound to −153 720°, Z to −5.0, `G92.4A0S0` at the end; `Tests/4th-test-air.nc` is the rough file with `T6`. |
| `/Makera-Parity.md` | §2, row 11 | *"deferred (decisions 3, 11)"* → *"designed in `/Rotary.md`; class R of three"*. |
| `/Makera-Parity.md` | §5, "Stock" | Add Makera CAM's *Square / Round* shape parameter and that the `;@MKR|STOCK` record for round stock is still unseen. |
| `/Makera-Parity.md` | §11.1.1, `Rotation/` row | Add the §1.1 measurements and that Z is referenced to the axis. |
| `/Makera-Parity.md` | §7 | Cross-reference the wiki's module zero-point preset to the "rotary module X/Y/Z offsets" strings. |
| `/Makera-Parity.md` | §11.2 | Note `default_seek_rate 2000` in `configZ1.default` against the 3000 quoted there (both commented out; neither is a device figure). |

---

## 12. Choices the maintainer must make

1. **Dependency arrow:** Option A (#222's engine first, rotary on it) or **Option B** (one column
   engine, rotary wrap as its first consumer) — §10. *Recommended: B.*
2. **The rotary work frame is the firmware's** (origin on the axis, Z = radius) — accept R6, which
   means `stubSetup`'s cylinder WCS is corrected in R-0 and one existing test changes.
3. **Viewport:** accept the hybrid with the **stock** rotating (R11), or choose a single view.
4. **Authoring map:** surface radius with the anisotropic opening (R10), or floor radius per item.
5. **R-0's three type reservations now** (R5's exception) versus no code until R-3.
6. **Class R (axis-crossing continuous relief):** a placeholder milestone, or declared out of scope
   until someone asks (`feedback_demand_driven_features`).
7. **Shipped firmware numbers on the profile now** as `source: 'configZ1.default (shipped default, unverified)'`,
   or an empty `rotary` block until R-1.
