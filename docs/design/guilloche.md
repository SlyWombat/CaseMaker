# Guilloché / rosette V-carving — a brass coin on the Z1

**Status: roadmap design (issue #609), 2026-10-24.** The maintainer's reference photo is a brass
coin covered in an interlocking rosette (guilloché) cut with a **90° V-bit**; their words: *"This
type of cut will be next after engrave is done."* This document fixes the shape of the work — the
parameter model, the groove geometry, the stock/cutter/workholding/registration choices, and how
the existing stack carries it — so the slices can be filed and estimated when the engrave path
(#567 → #569 → #570) is finished. **No code is written from this document until the maintainer has
read it.**

## 1. What the pattern is

A family of parametric curves — **rose curves, epitrochoids and hypotrochoids** ("spirograph"),
often dozens of lobed passes rotated about a centre with a phase step — cut as V-grooves of equal
depth so the flanks catch the light. The look comes from **clean, equal-depth lines meeting at
facets**: equal depth matters more than the exact curve family.

### 1.1 The parameter model

Two generators cover the reference photo and the family around it:

| Generator | Polar form | Parameters |
|---|---|---|
| Rose | `r(θ) = A · cos(kθ + φ)` | amplitude `A` (mm), lobes `k = n/d`, phase `φ` |
| Spirograph (hypotrochoid) | `x = (R−r)cos t + d·cos(((R−r)/r)t + φ)`, `y = (R−r)sin t − d·sin(((R−r)/r)t + φ)` | ring radii `R`, `r`, pen offset `d`, phase `φ` |
| …and its epitrochoid twin | `x = (R+r)cos t − d·cos(((R+r)/r)t + φ)`, `y = (R+r)sin t − d·sin(((R+r)/r)t + φ)` | same |

**The layer set** — what turns one curve into a guilloché field:

- `lobes` — the curve family's own count (rose `k`; spirograph `(R−r)/r`).
- `rings` — how many copies are drawn, each scaled (`A`, or `d`) or phase-stepped about the centre.
- `phaseStep` — the rotation between consecutive copies (degrees). A ring of `m` passes at
  360°/`m` is a rosette; a fraction like 137.5° gives the interleaved "sunflower" fields.
- `turns` — how many times each curve goes round (spirograph `t ∈ [0, 2π·turns]`).
- `pitch` — the smallest distance between neighbouring grooves, mm (see §2.2), from which the
  polyline step and the ring count follow.
- `centre`, `radius` — the pattern's seat on the coin; `radius ≤ coinRadius − edgeMargin`.

**Resolution.** Each curve becomes a polyline at a chord tolerance (`chordTol`, e.g. 0.02 mm —
the same order the tracer already uses for imported vectors). The generator emits **closed or open
polylines in the stock frame**; nothing downstream needs the maths again.

### 1.2 How it becomes a job — two options

**(A) Generator → trace items (recommended for V1).** The job already has a `traces` list of
`line` items: a polyline the cutter's centre follows, cut at each depth pass
(`engine/cnc/cam/trace.ts`, #219). A rosette editor that emits `line` traces needs **no new CAM,
sim or post code**: a V-bit is already accepted by `cuttingForTrace`, and the column engine
already models a V-bit's cone (#405, `vProfile.ts`). The cost is that the job stores the
polylines, not the parameters — changing a parameter regenerates the items.

**(B) A first-class `rosette` item kind.** Parameters stored in the document and regenerated at
`toPartPlan` time; editable, diff-friendly, and one item per pattern. It touches the item union,
the Zod schema, `partPlan`, the panel's exhaustive switches and the preview — a real slice, not a
quick win.

**Recommendation: A for the first cut, B once the pattern is proven on brass.** Emitting traces
also keeps the door open for imported guilloché SVGs/DXFs (#217 already imports vectors): the
generator is one producer among several.

## 2. The groove, for a 90° V-bit

### 2.1 Width at depth

The repo's one statement of V geometry is `engine/cnc/vProfile.ts`: `halfAngle` from the tool
axis, and the groove's top opening at depth `d` below the tip plane

```
w(d) = tipDiameter + 2 · d · tan(halfAngle)
```

A **90° included** bit has `halfAngle = 45°`, `tan(45°) = 1`, so **`w(d) = tip + 2d`** — a 0.2 mm
tip at 0.15 mm depth opens 0.5 mm; at 0.3 mm, 0.8 mm. The floor is the tip's flat (`tipDiameter`)
however deep the groove goes; the caliper on the floor reads the tip, not the depth (#185).

**Metal mode is CONSTANT DEPTH.** The film engrave path uses the V-bit floor-correct way (the floor
sits on the colour plane, the flank widens the top — the #170/#185 logic in `depthBounds`), because
a printed film's flat colour is the thing to preserve. A metal rosette is the opposite: every pass
is cut to the SAME tip depth so every groove has the same width and the facets catch light
uniformly. The trace CAM already does exactly this — one pass list per depth — so no new mode is
needed; the design decision is that the rosette item's `depth` is the **facet depth** and no
colour-plane reasoning applies.

### 2.2 Pitch, overlap and density

- **Pitch `p`** between neighbouring grooves. At `p < w(d)` the grooves overlap and the field
  closes up; at `p > w(d)` the blank shows between them. The reference coin reads as an
  interlocking field, so the target is `p ≈ w(d)` (adjacent flanks meeting), i.e. `p ≈ tip + 2d`.
- **Facet depth `d`** then sets both width and pitch: picking `d = 0.25 mm` with a 0.2 mm tip gives
  `w = 0.7 mm`, so `p ≈ 0.7 mm`; on a Ø38 coin that is ~170 grooves across the diameter — dense.
- **Density budget.** Grooves × length drives both the program size and the simulation cost
  (§6). The generator should state `p` and clamp the total path length; the panel shows the
  estimate (`planTime`, `estimateCycleSeconds`) before generating.

### 2.3 The facets

Equal depth gives equal flank angles; the crossing pattern is what varies the catch of light. Two
rules worth stating in the run sheet: **plunge at a corner/edge of the pattern, not mid-field**
(a V-bit plunging into a groove wall deflects), and **cut every pass in the same direction** so
the burr side is uniform.

## 3. Stock and cutter

### 3.1 The blank

- **Round brass stock**, Ø30–40 mm × 2–4 mm (the reference coin's class). The job's stock model is
  **rectangular** (`stock.length/width/thickness`), so V1 has two honest choices:
  - **(a) Square proxy**: the job's stock is the coin's bounding square (e.g. 38 × 38 × 3) and the
    pattern, the edge margin and the sheet all live inside the circle. The corners are air, and
    nothing cuts there because the pattern is centred and bounded. Cheapest; no schema change; the
    sheet says "round blank, square proxy" in words.
  - **(b) A `disc` stock shape** on the engrave job (schema + `toPartPlan` + preview + sheet +
    registration stock extents). Correct, but it touches every consumer of the stock rectangle.
  **Recommendation: (a) for V1**, (b) filed as its own issue when the coin is cut for real (the
  nest and the run sheet both prefer a true circle).
- Material `brass` already exists in `engine/cnc/materials.ts` and is classified as a metal
  (`isMetalMaterial`), which is what turns on the "for Metal" checks (#572/#575).

### 3.2 The cutter — a 90° V-bit row is a prerequisite

The catalogue rule applies unchanged (#455): **a cutter the catalogue does not list is not
recommended.** The built-in tier has only the two flat end mills; every engraver is a runtime
catalogue clone or the user's own row. A 90° V-bit for brass must therefore exist as a row — either
in Makera's catalogue (synced at runtime, #347 Route A: **no vendor rows are committed**) or as the
maintainer's own inventory cutter with `shape: engraving`, `angle: 90` — with **feed rows for
brass**. Until such a row exists, the rosette editor must refuse with the catalogue sentence
("the catalogue has no brass row for this cutter"), exactly as the engrave path does today.

The feed numbers themselves come from the catalogue tier when it lists (cutter × brass); the
depth ladder (§5.2) replaces the catalogue's starting numbers with measured ones for the tips the
maintainer owns.

## 4. Workholding — a Ø30–40 coin

The Z1's low-profile vise is the bench's reference holding (#508/#597). A coin cannot be clamped
between flat jaws without marking its rim, so:

- **V1 — a printed V-nest in the vise.** Two V-block jaws (a printed insert pair, or a single
  pocketed seat) hold the coin by its rim, seated on a ledge so the top face sits proud of the jaw
  tops by the usual stockProud. The nest is a `printed-nest` workholding (the `Setup` union already
  has `{ kind: 'printed-nest'; nest; seatClearance }`); the vise's jaw faces are the datum and the
  mount record (#597) and mount tap (#599) work unchanged.
- **Later — V-jaws machined for the vise**, and the **4th axis** for the coin's edge (§8).
- The nest fixes the coin's centre and rotation, which is the point: it reduces registration to the
  worked-proven Z touches (§5).

## 5. Registration of a round blank

### 5.1 Centre: fixed by the nest, not measured

A printed nest seats the coin at a **known centre** in the work frame, so V1 needs no
centre-finding: the registration is the standard surface touch + cut-extent spread (#475/#608) over
the pattern's area, Z0 = the lowest touch, and the tilt/dome verdict (#501) decides whether to
follow a tilt. The nest must be printed with the seat clearance stated (`printed-nest`'s
`seatClearance`) and the job's `stock` proxy centred on the seat.

### 5.2 Measuring the centre (open) — the 3D probe's limits

When the centre must be measured (an un-nested coin, or a nest whose seat moved):

- With the **wired probe** (Z-only) three circumference touches cannot resolve a centre; a
  tangent-scan trick exists but is arithmetically fragile on a Ø38 disc. Not proposed.
- With the **3D probe** (#525), a sideways touch on the circumference gives a point on the circle;
  three touches spanning ~120° fit a circle → centre + diameter. **But on the vise the jaws block
  the X approach**, so only the ±Y free edges are side-probeable (#525's vise rule): two opposing
  touches give the Y centre and the diameter, and X still comes from the nest. A full 3-point fit
  needs a mount that is free on X — the bracket or tape — or the rotary.
- **Open question Q4** below. V1 relies on the nest.

### 5.3 The pattern's area

The registration's cut-extent touches use the job's cut extents; for a centred rosette those are
the pattern's bounding circle ± the edge margin, so the five standard touches land on the coin
inside the pattern's field — they must not touch a previous groove. For a first cut, register
BEFORE cutting anything (fresh coin), which is the normal order anyway.

## 6. Simulation, oracle and the run

- **The column engine already models a V-bit** (#405): each column's floor is the cone profile
  (`vProfile.profile(ρ)`), and crossing grooves resolve as the deepest cut at each column — so the
  swept surface of a rosette is exact by construction. The cost is the column count: a Ø38 field at
  a 0.1–0.2 mm pitch is ~200 × 200 columns and hundreds of thousands of path points.
- **Performance is the question to measure**, not to assume: the dexel route (#531/#532) and the
  column engine's budget (`sim.budgetMs`, the playbook's 60 s fallback) may or may not keep up with
  a dense pattern. The design therefore carries a **bench/offline benchmark**: generate a
  reference rosette (Ø38, ~170 grooves, 0.2 mm tip, 0.25 mm depth), time `loadSim` on the desktop
  build, and record the seconds per 1 000 path vertices. If it exceeds the budget, the rosette job
  is a candidate for the dexel fast path first.
- **The oracle** (#580/#584) compares the swept material with the predicted regions; a rosette has
  no region to compare. The oracle should treat the pattern as a **stroke set** (like traces) and
  compare depth at sampled groove centres, or skip with a stated reason — an open question (Q5).
- **The run sheet**: a V-groove section that states the facet depth, the tip and its measured
  width at that depth, the pitch, the pattern's centre and radius, the plunge point, and the brass
  feed row's provenance — plus #501's tilt/dome verdict for the coin's top.

## 7. The depth ladder on brass (#165's coupon shape)

The facet depth is a **measured** choice, not a catalogue number: a coupon in the same brass,
cut as a ladder of V-grooves at 0.10 / 0.15 / 0.20 / 0.25 / 0.30 mm, each at a marked pitch,
calipered for width and inspected for burr. The ladder sets:
- the facet depth the rosette uses (the width the eye reads),
- the deepest pass the 90° bit's tip survives in brass at the chosen feed,
- whether a single full-depth pass is clean or a spring pass / two depths are needed.

The coupon is the #165 ladder shape with V-grooves instead of flat floors, and its readings go into
the run record and the feeds (decision 28: measured beats catalogue).

## 8. Out of scope for the first cut (but the shape is known)

- **The coin's edge** — knurling/reeding or a second guilloché band on the rim: the **4th axis**
  (rotary) turning the coin about Z while the V-bit cuts radially. The rotary's profile exists
  (#237/#238); its registration is an open item (#607).
- **Two-sided coins** — a second setup with a remount (#419's setup/remount model).
- **Other metals** (copper, aluminium) — the same path, different catalogue rows.
- **Imported guilloché artwork** — SVG/DXF traces already import (#217); the generator is one
  producer among several and the trace path treats them identically.

## 9. Open questions for the maintainer

1. **The reference pattern's family**: rose or spirograph? The photo reads as a multiring
   spirograph (interleaved loops). Which parameters should the first generator offer — both, or
   one family tuned to the photo?
2. **The coin**: brass alloy (C360 free-machining vs C260), Ø, thickness, and whether the blank
   arrives with a finished face (cut as-is) or faced first in the same setup.
3. **The 90° cutter**: is it a Makera catalogue bit (which id?) or a cutter the maintainer owns
   that must be registered? The feed row for brass comes with the answer.
4. **Centre-finding**: accept the nest-fixes-the-centre model for V1, or is measured centring a
   first-cut requirement? (The 3D probe's vise limitation makes a full 3-point fit a
   mount-change question, §5.2.)
5. **The oracle**: for a stroke field, is a sampled-depth comparison worth building, or is
   "stroke set, oracle skipped, reason stated" the honest V1?
6. **The simulator's budget**: what load time is acceptable for a dense rosette before the dexel
   path is pulled in (§6)?
7. **Square proxy vs a disc stock shape** for the blank (§3.1) — (a) is the recommendation.
8. **Pattern ownership**: generator → traces (A) for V1, with a first-class item (B) later — agreed?

## 10. Slice order (each its own issue when the time comes)

| # | Slice | Depends on |
|---|---|---|
| 1 | The depth ladder coupon on brass (V-grooves, #165 shape) — measures the facet depth and the bit's tolerance | a 90° bit + brass row |
| 2 | The rosette generator → `line` traces (rose + spirograph, pitch/density, chord tolerance, preview) | the engrave path finished (#567→#570) |
| 3 | The printed V-nest + the square-proxy stock and its run-sheet wording | the nest design |
| 4 | The dense-pattern sim benchmark and the oracle decision (§6, Q5/Q6) | the generator |
| 5 | The first coin: register, cut, compare with the reference photo | 1–4 |
| 6 | A first-class `rosette` item kind (B), if wanted | 2 proven |
| 7 | The rotary edge pass (§8) | the rotary's registration |

**Gate**: this document is reviewed before any of the above starts, and the engrave path
(#567 → #569 → #570) is finished first — the maintainer's own parking note on #609.
