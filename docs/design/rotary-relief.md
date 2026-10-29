# Rotation relief — a goal mesh on the rotary, and a part cut from several sides

Design note for #723, which the maintainer opened on 2026-10-27 ("it should support mounting in 4d
and manual rotation"). It covers two features that share one question — how a mesh becomes a
set of cut surfaces — and are sliced separately:

- **Part 1, the rotary (4th axis):** a goal mesh held in the chuck, cut as Makera's Rotation Relief
  (`Rotary.md` class R; `rotary-flow.md` R-UI-13, today "simulate only"). The mesh is oriented along
  the rod's X; the stock is a rod; roughing and finishing follow a RADIAL heightfield. The
  axis-crossing refusal (R8) stays. The run gate stays as #545 has it until #238 measures the
  module.
- **Part 2, manual rotation (no 4th axis):** orient the mesh in the stock about X, Y and Z, cut it
  from more than one side by turning the stock by hand between setups, each side a setup with its
  own registration (the #419/#579 multi-setup model and its flip references), the stock's remaining
  shape carried between setups by the simulation. This is also what a two-part mold needs.

The engine sources are `/Rotary.md` (classes, R1/R8/R10, §4.5), the goal pipeline of #222/#534
(`sampleGoalHeightfield` → `cam/surface3d.ts`), and the rotary map (`rotary/wrap.ts`). Where this
note and `rotary-flow.md` differ, this note is the newer design and `rotary-flow.md`'s R-UI-13 row
is the one to update when the slices land.

## Part 1 — the radial heightfield

### The frame

A rotary job's map is `rotary-flow.md` §3.7's: **X along the axis from the jaws**, **Y the arc
length around the stock at the design radius `R = ⌀/2`**, zero at the seam (A = 0). The radial
field lives in that map, so the CAM, the `toRotaryIR` wrap and the oracle all speak the units they
already speak:

    map cell (x, s)  →  angle φ = s / R,  a ray from the axis at X = x in direction (0, sin φ, cos φ)
    the goal's radius there: r(x, φ) = the OUTERMOST hit of that ray on the mesh
    the field's height:     z = r − R   (the stock's surface is z = 0; a cut is negative)

`A = 0` is where the stock's surface faces the cutter from above, so φ = 0 is the +Z direction and
positive φ turns toward +Y (the map's "around"). This is the same convention `toRotaryIR` turns
into degrees, so a field cell's `(x, y)` maps to `(X, A)` with no second convention.

### The mesh's placement

- The mesh's **local X is the rod's axis**. Its local Y/Z section is measured about the axis: a
  vertex at local `(y, z)` sits at radius `r = hypot(y, z)` and angle `φ = atan2(y, z)`.
- **The section's origin is on the axis**: a mesh modelled as a turned part (a vase, a dowel with
  beads) is correct as authored; a mesh modelled off the axis is cut off-centre, which is visible
  in the preview and named by the finding's numbers rather than silently recentred.
- **`position.x` is the mesh's centre along the rod** (map mm), so the goal row's X field moves the
  part along the stock as it does on a flat blank. `position.y` is the seam offset: it turns the
  mesh about the rod by `position.y / R` radians (the map's own around coordinate). `position.z`
  is ignored on a rod: the radius IS the height.
- **`scale`** (#722) applies per axis before the mapping; `rotation` is not used in part 1 (it is
  about Z, which on a rod would tilt the part across the axis — part 2's orientation design owns
  rotating a mesh).
- The part must lie inside the **free span** (`rotaryFreeSpan`): the jaws' keep-out at the left end
  and the tailstock's band at the right. A goal reaching outside it is refused with the span's own
  numbers; the field itself still samples the mesh (the preview needs to draw it).

### The sampling rule

For each cell of an `(x, s)` grid at the shop's grid pitch:

1. The grid's X extent is the placed mesh's own X extent; the around extent is the FULL
   circumference `2πR` (a relief may run right round; the seam is not special to the sampler).
2. For each mesh triangle, map its three vertices to `(x, s, r)`; handle a triangle crossing the
   seam by unwrapping its angles about its first vertex (its copy at `s ± 2πR` is the same
   triangle).
3. For each cell the triangle's `(x, s)` projection covers, solve the **exact** ray–triangle
   intersection for the cell's ray and keep the farthest `r` (the outer surface — what a cutter
   from outside meets first is the LAST material on the ray, not the first).
4. A cell no triangle hits keeps `z = 0` (the stock's surface) and `covered = 0`: the goal says
   nothing there, and the CAM leaves the stock standing — the same sentinel contract the flat
   heightfield has.

The grid is capped like the flat one (`DEFAULT_MAX_CELLS`, 4 M): above the cap the pitch is
**coarsened** and the coarser value is stated, never a refusal.

**Single-valued, and honest about it.** One radius per `(x, φ)` cannot express an undercut, a
re-entrant groove that hides behind the outer surface, or an internal void. The sampler takes the
OUTERMOST surface; material the ray re-enters behind it is left standing, which is the honest
single-axis answer (the flat field's identical limit, #222).

### What the field reports (facts, not sentences)

`sampleGoalRadialField` returns `{ nx, ny, x0, pitch, radius, minRadius, maxRadius, z, covered,
coveredCount, resolutionNote }` with `z` in map millimetres relative to the stock's radius. The
findings built on it (later slice) say, in the operator's words:

- **does not fit the rod** — `maxRadius > R`: the part is wider than the stock, so it cannot be
  reproduced; scale it or use a larger diameter.
- **reaches the axis** — `minRadius ≤ 0` (R8): the part meets the axis, and a rotary cut keeps the
  cutter above it; this is the design's "cuts through the centre" class.
- **outside the free span** — the placed mesh's X extent against `rotaryFreeSpan`'s two ends.

### The CAM

- **Roughing in A sweeps at stepped radii.** For each radial layer `L` from the stock's surface
  down to `minRadius + allowance`, the stock turns through a full A sweep while X advances one
  roughing step-over per turn; at each move the tip rides at `L` but is clamped UP to the field's
  gouge-safe tip + allowance, so a layer never reaches the part higher than the allowance. This is
  the flat roughing's clamp (the same `floorAt` rule) with the raster's scan direction around the
  stock instead of across it.
- **A ball finish as an A-spiral or an X-raster on the radial field.** The X-raster follows the
  flat goal's parallel finish in map space (passes along X at a stepped A, spaced by the finishing
  step-over); the A-spiral advances X one step-over per turn with Z following the field. The raster
  is the default: its scallop is measured across the same grid the field is known on, and it
  reuses the flat finish's tip field. The spiral is the fluidity suite's shape (#756) and is the
  option for a long part where a full turn between X steps would waste time.
- Both passes emit MAP-space moves; `toRotaryIR` turns them into `(X, A, Z)`, lifting rapids clear
  of the stock (the rotary clearance rule) exactly as the wrapped text and pocket programs do.
- The finishing tip must stay above the axis: `z_tip = r_goal ≥ minRadius > 0` is R8's condition at
  the CAM's level, and the sweep's own axis rule is the second check.
- Feeds are the job's ordinary 2.5D feeds (the flat goal's labelled placeholder, #536), and the
  rotary feed-at-radius warning (#759) applies to the A moves as it does to any rotary program.

### The cutter classes

Part 1 needs a BALL for the finish and a FLAT for the rough. Both footprints are in the rotary
column engine since R-UI-12 (#763), so the program can be swept and judged. A V finishes nothing
here: its relief role is part 2's V-carve work.

### The run gate

Class R stays **simulate only**: the flow can author, generate, verify, simulate and save it, and
the Run line says so. The sentence stays #545's (the module is unmeasured) until #238 records the
numbers; after #238 the relief's own sentence ("checked and simulated here; the machine does not
run it") applies until R-5's bench check, exactly as `rotary-flow.md` §3.9 states.

## Part 2 — a part cut from several sides by hand (sketch; its own slices)

The operator orients the mesh in the stock — rotation about X, Y and Z, not only Z — and chooses
which sides to cut. Each side is a setup: the existing multi-setup model (#419/#579) with its own
registration (surface touches and edge scans; the flip references of the mount's pins when the
stock is turned over). The stock's remaining shape is carried between setups by the simulation
(the prior-removal seam the exact sweeper already takes, #410/#744), so side 2's preview starts
from what side 1 left. A two-part mold is the same flow with two parts and a flip line.

What part 2 must design that part 1 does not: the orientation controls and their anchors; the
sides list and how a side becomes a setup; what each setup's registration touches (the flip's pin
holes, the datum edges); and how the simulation carries a rotated stock's remaining shape into the
next setup's frame. None of it is built here.

## Slices

| # | Slice | Contents | Depends on |
|---|---|---|---|
| R-1 | The radial field | `sampleGoalRadialField` + its facts + unit tests (this note's sampler rule) | none |
| R-2 | The rotary relief CAM | A-sweep roughing, the X-raster ball finish (+ the A-spiral option), `toRotaryIR` | R-1, R-UI-12 (#763) |
| R-3 | The job wiring | the rotary goal dispatch, the findings above, the run sheet facts, the panel/preview | R-2 |
| R-4 | The acceptance | an analytic solid of revolution + the corpus relief; swept on the column engine against the closed form; Simulate screenshots | R-3 |
| P2-1 | Mesh orientation | rotation about X/Y/Z with its anchors, per-side setups | part 2 design review |
| P2-2 | The flip and the carried stock | pin references, prior-removal between setups, side 2's preview | P2-1 |

## Open questions

- **The mesh's placement contract on a rod.** Part 1 keeps `position.x` as the centre along the
  rod and reads `position.y` as the seam offset; the row's fields were written for a flat blank,
  and part 2's orientation design may want a different anchor set. The field's contract is one
  function, so a change is one place.
- **The finish default.** The X-raster is proposed as the default and the A-spiral as the option;
  the fluidity suite (#756) is the A-spiral's evidence, and R-4 will measure both on the same part.
- **The roughing's X step-over per turn.** It is the flat feeds row's step-over, labelled like
  every 3D feed until #536 measures 3D engagement.
