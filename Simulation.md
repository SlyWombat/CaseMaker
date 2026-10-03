# Simulation — proving the cut before the machine

Status as of 2026-10-03. Design only; nothing implemented. Tracked by **#182**.

Architecture context: `/Fabrication.md` §5.6. Capability context: `/Makera-Parity.md`.

**What it does, in one sentence.** Sweep the selected tool along the toolpath, subtract
the swept volume from the stock, and show the object before and after — so that a wrong
`.nc` is something you *see*, not something you discover in PLA.

**Why it is worth a design document.** Every other number in the V1 plan is gated behind a
bench experiment (`/Fabrication.md` §9.3). This is not: it takes depth as an input, needs
no machine, no probe, no bridge and none of #165's measurements. It is the largest piece of
genuinely useful work available before the first cut, and it is the piece that makes the
first cut worth trusting.

The performance section below is **measured**, not estimated. Three scratch probes ran
against real Manifold/Clipper2 through this repo's wasm harness, and the numbers changed
the algorithm twice.

---

## 1. The one decision that shapes everything: simulate the file

**V1 simulates the `.nc`, not the in-memory toolpath IR.**

The deliverable the user holds is a file they upload through Makera Studio. Sweeping the IR
is one level removed from that file: a Z sign flip, a wrong origin offset, a modal-state
slip or a units bug in the post-processor (#173) would pass straight through an IR
simulation and still ruin the part. A check one level removed from the assertion is not
evidence.

So:

- **One sweep, over one `Move[]` type.** #172's CAM core emits it; #174's G-code parser
  emits the same type from text. The sweep does not know or care which produced it.
- **The round-trip is a *serialisation* test, and only that:** `sweep(ir) ≡
  sweep(parse(post(ir)))` within ε. It catches number formatting, modal `G0`/`G1`, sticky
  words and `F` placement.
  **It cannot catch a frame error.** §2 insists `toWorkFrame` is one function shared by the
  post-processor and the simulator — so both sides of the `≡` pass through it and a wrong
  sign, origin corner, Y direction or unit scale **cancels exactly**. The frame is the thing
  this project has reversed twice, so it needs its own test: **golden-number assertions on
  the emitted coordinates** of a known move, hand-derived from the badge's dimensions, for
  an off-centre label near one corner. Not a sweep equality.
- **A volumetric oracle is blind to more than frames.** A union is invariant to **move
  order** — plunging full depth into solid stock and then clearing gives a picture identical
  to a correct roughing sequence, with a broken cutter — and to **feed and spindle**
  entirely (`F1200` plunge, `M3` issued after the first cutting move). Those belong in
  #174 as sequence checks, not here.
- **The one genuinely independent validation available** is #165's ladder `.nc`, generated
  by Studio, whose intent is known by construction: twelve squares at six depths. Note that
  "validate against Studio's output" cannot mean `TopClamp.nc` — it has 482 distinct Z
  levels (§4.4), so V1's `ExactSweeper` cannot run it at all, and there is no independent
  model of it to compare against.
- **It removes the hard dependency on #172.** Parser + sweep + stock can be built and
  validated first, against **Makera Studio's own output** — including the `.nc` Studio
  generates for #165's depth ladder, *before* that ladder is cut. The simulator gets
  validated against known-good third-party CAM before ours exists.

This is a change from #182 as originally filed, which depended on #172.

---

## 2. Frames, and why this document is explicit about them

`/Fabrication.md` reversed its Z reference twice before settling, so this is stated once
and shared by one function.

- **The machining frame is the authored frame.** `make_badge.py` authors the magnet pocket
  on the z = 0 face, engraved face up at z = T. The blank is *machined* that way up —
  pocket down in the nest, engraved face to the cutter. **Printing is the flip**, handled by
  `PRINT_FLIP_NODE_IDS` on export (`/Fabrication.md` §7.2). The simulator therefore applies
  **no flip**.
- **The work origin is anchored at the engraved face**, never at z = 0. In this frame z = 0
  is the back face, and the back face carries all of the thickness error (decision 24).
  A cut to depth *d* is at model z = T − d, which is machine Z = −d.
- **One transform, shared.** `toWorkFrame(part)` is written once and used by both the
  post-processor and the simulator. Two copies of this arithmetic is how a sign error
  survives its own test.
- **"Front" is physical, not axial.** Front is the long edge facing the operator, matching
  Studio's `topFrontLeft` origin with front = −Y (`/Makera-Parity.md` §6.1). Text reads
  left-to-right along +X.
- **Every frame test uses an off-centre label near one corner.** A centred badge is
  symmetric under exactly the mirrors and sign flips most likely to be wrong — the same
  family of bug as the KiCad Y-down board layout error.

---

## 3. The sweep

### 3.1 One exact rule covers every 3-axis tool

For a **convex** body *K* translated along a straight segment from **a** to **b**, the swept
volume is exactly

```
K ⊕ [a,b]  =  hull(K + a,  K + b)
```

Every Makera tool category except one is a convex solid of revolution
(`/Makera-Parity.md` §3): flat end (cylinder), bull nose (cylinder with a rounded corner),
ball nose (hemisphere + cylinder), engraving V-bit (truncated cone + shank), chamfer
(truncated cone), drill (cone point + cylinder). So **one `hull` of two tool solids is an
exact sweep for all of them**, at any Z, including ramps and plunges.

The exception is the **thread mill**, whose helical form is not convex; model it as a union
of convex discs. V1 does not use one.

**But "for free" was wrong, and §4.5 is the measurement.** The hull identity is exact and
the *algorithm* is unaffordable: 1 600 hull-moves take 40–119 s against Manifold. So V1's
exactness claim is **a flat end mill at constant Z**, the 2D fast path in §3.2, and
hull-per-move sits with the dexel decision in §5 rather than in V1.

**Two caveats on the tool solids themselves**, from `t_MakeraCutterList`:

- The *modelled* tool — the cutting profile extended upward — is convex. The *physical*
  tool often is not: the 3.175 mm 30° engravers have a 5.0 mm flute but need 5.74 mm to
  reach shank diameter, so the cone tops out at 2.78 mm and then **steps** to 3.175. Every
  1 mm flat end and every drill is a stepped solid. The gap is a shank-collision question,
  and §6's depth gate is what covers it.
- The data needed to *build* some of these solids is missing: `shoulderLength` is **empty**
  for every engraver and chamfer, and category 7 (tapered ball) has empty `tipDiameter` and
  `halfAngle`. So "cone point + cylinder" and "tip diameter + half angle" cannot be
  constructed from the catalogue for those types. Refuse them rather than guess.

### 3.2 The 2.5D fast path

A flat end mill at constant Z is the overwhelmingly common case and has a 2D shortcut worth
keeping: the sweep of a disc along a segment is a **capsule**, which is
`circle ∪ rectangle ∪ circle`. Emitting those three as separate CCW contours lets Clipper2's
`Positive` fill rule union them, with no hull arithmetic in JS.

Constant-Z moves are bucketed by quantised Z, unioned in 2D per bucket, then extruded once
from that Z up past the stock top.

**Non-constant-Z moves use the conservative rule, not the exact hull:** the move's capsule
extruded from its **lowest** Z. That is the rule #182's body always described, it is the
only affordable one (§4.5), and it **over-removes** — so §7's over-cut check must tolerate
it rather than treat it as a toolpath fault. Ramps are not an edge case: Studio's own 2.5D
pockets ramp in.

**Winding is load-bearing.** All contours must be wound counter-clockwise. A clockwise
rectangle against counter-clockwise caps cancels under `Positive` fill and silently yields
half a disc — see §4's opening note. Assert the closed-form area (§4.0).

### 3.3 Rapids, arcs and modal state

- **A G0 above the stock removes nothing.** A G0 that intersects the stock **removes
  material in the simulation** — it is not merely flagged. The gouge must be visible;
  #174 refuses the file separately.
- **The sweep is linear-only; the parser is not optional about arcs.** Studio's own output
  contains no arcs — 9 607 `G1`, 25 `G0`, zero `G2`/`G3` (`/Makera-Parity.md` §6) — and our
  IR is linear too, so it was tempting to treat arcs as a contingency. They are not:
  Makera's own Z1 FreeCAD machine definition sets **`split_arcs: false`**, which means the
  *controller accepts* `G2`/`G3` and other CAM will emit them. Since §1 commits to
  simulating any `.nc`, **the parser must tessellate arcs**, with the tessellation
  tolerance tied to the same ε as everything else (§7). The sweep still never sees a curve.
- The same definition sets `translate_drill_cycles: true`, so the machine does **not**
  take canned cycles (`G81`/`G83`) — consistent with Studio emitting none.
- The parser must survive a file with **no `G54` and no `G10`** that opens with `T1 M6`,
  because that is what Studio emits.

---

## 4. Measured performance, and the algorithm it dictates

> **This section was wrong once and is now re-measured.** The first version reported a
> single Clipper2 union as quadratic and unusable (114 s at 8 000 contours). That came from
> a probe whose capsule rectangle was wound **clockwise** while its end discs were
> counter-clockwise, so under `Positive` fill the windings cancelled: a capsule that should
> be 10.7654 mm² measured **0.3827 mm²**, exactly half a 16-gon disc. The load was also a
> golden-angle walk confined to a **1.4 mm box**, so every contour overlapped every other,
> and `numTri()` sat outside the timer so the subtract was never timed. All three are fixed
> below. Keeping the history because §5.6 of `/Fabrication.md` has now been wrong in both
> directions, and the reason was always the same: nobody checked a single primitive against
> a closed form.

### 4.0 The gate comes first

`probe-sim-5.mjs` asserts one capsule against the exact closed form before it measures
anything:

```
area(capsule(L, r))  ==  2·r·L  +  8·r²·sin(2π/n)        # rectangle + inscribed n-gon disc
GATE one capsule (L=10, r=0.5): area 10.7654  expected 10.7654  OK
```

It prints `*** WRONG ***` and skips the measurement if that fails. Whatever ships as the
real sweeper carries the same assertion as a unit test. This is the only reason the
defect above is now a paragraph instead of a shipped algorithm.

### 4.1 The load has to be a real toolpath

Figures: Manifold 3D wasm through this repo's harness, Windows node v24.19.0, 1 mm flat
end mill (r = 0.5), 16-gon caps, one Z level, **contour-parallel raster over a 60 × 20 mm
face at 63 % stepover** — the shape pocketing actually emits.

| cutting moves | contours | single `CrossSection(all)` | chunk-64 → simplify → 8-way tree | swept area |
|---|---|---|---|---|
| 250 | 750 | 101 ms | **72 ms** | 422.444 mm² |
| 1 000 | 3 000 | 282 ms | **192 ms** | 1250.427 mm² |
| 4 000 | 12 000 | 1 011 ms | **676 ms** | 1250.427 mm² |
| 12 000 | 36 000 | 6 131 ms | **2 192 ms** | 1250.427 mm² |

Three things to read off it:

- **The tree is linear; the single call is mildly superlinear.** 12× the contours costs the
  tree 11.4× and the single call 21.7×. So the tree is worth having — but it is a **2–3×
  win, not the two orders of magnitude this document previously claimed.**
- **Area is identical between the two methods at every size**, so the tree is a
  restructuring and not an approximation. It is also **invariant to how finely the path is
  subdivided** (1 000 and 12 000 moves over the same region both give 1250.427 mm²), which
  is a strong signal that the sweep is geometrically right.
- A single Clipper2 union call is a perfectly serviceable fallback. Clipper2 is not the
  villain; the 1.4 mm blob was.

### 4.2 `simplify()` before extruding, timed properly

With forced evaluation inside the timer:

| contours | extrude + subtract, unsimplified | after `simplify(0.002)` |
|---|---|---|
| 3 000 | 80 ms | **40 ms** |
| 12 000 | 34 ms | **28 ms** |
| 36 000 | 42 ms | **29 ms** |

A 1.4–2× win, not the 88× the lazy-evaluation bug suggested. The useful property is that
the 3D stage **stops growing with contour count** once simplified — ~29 ms at 36 000
contours — so the whole cost sits in the 2D union and the budget is predictable.

Independently verified by the review: `simplify(0.002)` is **safe for this oracle** —
deliberately left uncut walls of 0.05, 0.01 and 0.003 mm all survive it with unchanged
contour counts. Only sub-ε slivers, which Clipper2 has already fragmented, change. §9's
open question 2 is closed for V1 and reopens for V-carve.

### 4.3 The algorithm, and the budget

```
for each quantised Z level:
    contours = capsules for every cutting move at that level            (JS, CCW!)
    chunks   = CrossSection(chunk of 64, 'Positive').simplify(ε)        (Clipper2)
    region   = 8-way pairwise union tree, simplify(ε) at each level
    solid    = extrude(region, stockTop - z).translate(z)
removal = union(solids);   after = stock.subtract(removal)
```

ε = 0.002 mm. **Budget: ~0.7 s per Z level at 4 000 cutting moves, ~2.2 s at 12 000.** A
solid 60 × 20 mm pocket at 63 % stepover is about 1 000 moves, so a realistic three-label
badge lands **well under a second in total**; 12 000 is a generous upper bound. That makes
it a debounced worker job comfortably, and possibly an interactive one.

**Do not pick the cap-segment count by intuition.** 16 segments gives 0.010 mm chord error
at r = 0.5. Dropping to 12 made an earlier probe *slower*, not faster.

### 4.4 Where exact CSG stops being the right answer

Parsing Studio's `TopClamp.nc` — a real 3D job with ramping — gives **9 618 cutting moves
over 482 distinct Z levels**, 19 204 contours. Exact CSG needs an extrude and a boolean per
level, so 482 levels is not a tuning problem; it is the wrong representation. This figure
is a count from a real file and involves no sweep, so it is unaffected by everything
retracted above. **It is the measured case for decision 2's dexel engine.**

### 4.5 The hull path has no budget, and that is a scope problem

§3.1's "one `hull` of two tool solids is an exact sweep for all of them" is correct
mathematics and **not a V1-usable algorithm**. Measured with forced evaluation: 400
hull-moves take 8–13 s; 1 600 take **40–119 s**, super-linearly, and the tree reduction
helps only ~2.5×. At 12 000 moves it is hours.

This bites earlier than V-bits do. **Studio's own 2.5D pockets ramp in** — `TopClamp.nc`'s
first toolpath enters on a Z-interpolating ramp — so any third-party file has
non-constant-Z moves. §3.2's "those fall back to §3.1" therefore commits V1 to an
unaffordable path.

**V1's exactness claim is for a flat end mill at constant Z.** Non-constant-Z moves use the
conservative rule — the capsule extruded from the move's lowest Z — which over-removes, so
§7's over-cut oracle has to tolerate it. Hull-per-move moves next to the dexel decision in
§5, not into V1.

## 5. Two backends, one interface

```ts
interface Sweeper {
  sweep(moves: Move[], tool: Tool, stock: Manifold): SweepResult;
}
```

- **`ExactSweeper` (V1)** — the pipeline in §4.4. Correct for 3-axis work with few Z levels:
  all of 2.5D, and 3D roughing where step-down levels are discrete.
- **`DexelSweeper` (deferred, decision 2)** — for dense ramping 3D (§4.5) and for rotary,
  where A-axis moves rotate the stock and the sampling grid becomes (A, X) with radius as
  the sampled value (`/Fabrication.md` §5.5). The A axis indexes or wraps; it never
  interpolates with X/Y/Z, which is what makes the reparameterisation legitimate.

V1 builds `ExactSweeper` only, but the interface exists from the start so the dexel work is
an addition rather than a rewrite. Choose the backend from the Z-level count, and say which
one ran in the UI.

---

## 6. Stock, tool and input validation

**Stock.** The "before" object. From the compiled part for our own jobs (#167). For
simulating a third-party file, a cuboid from the `;@MKR|STOCK` header, or
`make_badge.py`'s existing STL read as-is — that file is the maintainer's and the
regression oracle for #167, so it is read and never written.

**Tool.** The `Tool` type mirrors the fields Makera's `.nc` header actually carries
(`/Makera-Parity.md` §6): number, name, type, diameter, tip diameter, corner radius, angle,
half angle, flute length, shoulder length. For a file simulation these are read **from the
`TOOL` line**, which simultaneously tests our reading of the header. Where the tool comes
from in our own UI is an open question (§9).

**Validation — refuse, don't approximate.** This is the direct lesson of
`/Makera-Parity.md` §8: Studio writes uninitialised doubles and `0xCCCCCCCC` into its own
settings files, so a simulator that quietly coerces bad input reproduces bad input.

- Unknown or unsupported tool `type=` → refuse. Do not simulate a V-bit as a flat end.
- Cut depth greater than **`shoulderLength ?? fluteLength`** → refuse; the shank or neck
  would be rubbing. `shoulderLength` is the governing field and the catalogue leaves it
  **empty for every engraver and chamfer**, so **refuse when both are missing** rather
  than falling through to "no limit".
- Non-finite, denormal or out-of-range coordinate, feed or spindle value → refuse, naming
  the line.
- Feed or spindle beyond the selected machine's limits → refuse. Makera's own tool table
  contains 32 rows above the Z1's spindle ceiling, so this is a real case.

---

## 7. The oracle — what this proves with no machine

This is the part that makes the simulator a test rather than a picture. #171 predicts the
engravable region **analytically**, as the morphological opening of the glyph
`offset(offset(G, −r), +r)`. The simulator computes the same region **from the toolpath**.
Disagreement means the toolpath is wrong.

**First, a limit on what this can prove.** #172 computes its first pocket loop as
`offset(region, −r)` using the same Clipper2 primitive #171 uses for `offset(G, −r)`, and
sweeping that loop with a disc of radius *r* reconstructs `offset(offset(G,−r),+r)` **by
construction**. So "no over-cut" is close to an identity, and a wrong *r* shared by #171,
#172 and #182, a glyph-outline bug, or a Clipper2 offset bug is invisible to it — and the
viewport, drawing the same opened region, agrees with the mistake. **The oracle's real
content is the under-cut direction** (stepover cusps, unreached interior) plus
serialisation. For genuine independence, add one check computed a *different* way: sample
points of the raw glyph whose distance to its boundary is ≥ *r* — by point-in-polygon on
the original outline, not by offsetting — and assert each lies inside the simulated region.

The two cannot be compared for exact equality: #171's prediction uses Clipper2 arc offsets
while the sweep hulls tessellated circles and then simplifies, so every round corner leaves
slivers. Compare in an **ε band**, and size it honestly — the tree applies `simplify(ε)` at
**every level**, so the drift is `levels × ε` (about 3ε here), not ε; the inscribed 16-gon
also under-removes by 0.010 mm **one-sidedly**, which is a bias rather than a tolerance.
The band must exceed the sum:

- `difference(offset(predicted, −ε), simulated)` must be empty → the toolpath does not
  **under-cut**. This is what catches uncut corners and stepover gaps.
  **Per level, `predicted` is the union of the openings of every label whose depth reaches
  that level or deeper**, because the extrude runs from that Z up to the stock top. Comparing
  a single label's opening against a level's removal will fail for the wrong reason.
- `difference(simulated, offset(predicted, +ε))` must be empty → it does not **over-cut**
  outside the glyph.
- `intersection(removal, magnetPocketVoid)` must be **empty** at every permitted depth, and
  **non-empty** for a deliberately over-deep label. That is #178's depth-limit map checked
  against geometry rather than against itself.
- `sweep(ir) ≡ sweep(parse(post(ir)))` within ε → the post-processor (§1).
- A **G0 that crosses the stock** must appear as removed material.
- An oversized tool must produce a visibly empty or mangled result for small text — the
  honest form of #171's warning.

Area, volume, triangle count and bounding box are all snapshot-stable, so every one of
these is a vitest assertion on numbers. None of them needs an eye, a screenshot or a
machine. ε, the cap segment count and the simplify tolerance are named constants shared by
the test and the sweep, because an ε that drifts is a test that gets loosened until it
checks nothing.

---

## 8. Before and after, in the UI

Three objects exist after a run — **stock**, **result**, and **removed volume** — and all
three are useful. The removed volume is the most informative and should be visible rather
than implied.

- **Colour comes out for free.** Rather than classifying engraved floors after the fact,
  subtract the removal from the **two colour volumes separately**, split on #178's real
  layer line measured from the engraved face, and render each in its own colour. The reveal
  then simply appears, which is what decision 15 asks for and what decision 20's two-state
  depth control needs to preview.
- **A transparent mesh still writes depth.** The viewport once drew a shell identically with
  four standoffs and with none. Prove the removed volume is actually *drawn* before
  concluding the sweep is wrong.
- **Say what the simulation assumes.** On the panel, not only in this document: a rigid,
  ideal machine — no deflection, no runout, no Z-chain error, no chatter. That disclaimer
  matters most exactly where the user will trust it least justifiably, over the unsupported
  membrane above the magnet pocket (`/Fabrication.md` §9.2).
- **Mockup before UI code**, following `docs/assets/open-in-prusaslicer-mockup.png`.

---

## 9. Not in scope, and open questions

**Not in scope:** the dexel backend (§5), rotary and simultaneous-axis motion, thread-mill
sweeps, laser paths, cutting forces, deflection, surface-finish prediction, and any claim
about how the part will *look* beyond which colour volume a floor lands in.

**Open questions:**

1. **Where does tool selection live?** Nothing in the plan has a tool picker. Makera's
   catalogue is in a local SQLite file the web build cannot read (`/Fabrication.md` §5.7,
   #181), so V1 needs its own small tool list with the §6 fields, and the DB becomes an
   import path later.
2. ~~**Is ε = 0.002 mm safe for the oracle?**~~ **Closed for V1.** Independently checked:
   deliberately uncut walls of 0.05, 0.01 and 0.003 mm all survive `simplify(0.002)` with
   unchanged contour counts; only sub-ε slivers that Clipper2 has already fragmented change.
   Reopens for V-carve, where the floor width is a function of depth.
3. **Does the pairwise tree stay linear past 24 000 contours?** Measured at 8 000 and
   24 000. A full-face relief would be far larger.
4. **Can the dexel backend share the `Move[]` type unchanged?** It should, but rotary adds
   an `A` component, and that is the field `/Fabrication.md` §9.1 deliberately deferred.

---

## 10. Build order

1. **`Move[]` type + G-code parser** (#174's front half) — pure, no geometry.
2. **`toWorkFrame` + the frame tests** (§2), including the off-centre-label case.
3. **`ExactSweeper`** (§4.4) with the measured algorithm, in the geometry worker.
4. **Validation gate** (§6) — refusals, with the line named.
5. **Run it on Studio's `.nc`**, including #165's ladder file before the ladder is cut.
   This is the first point at which the whole thing is proven against third-party CAM.
6. **The oracle tests** (§7), once #171 and #178 exist to compare against.
7. **Round-trip against #173**, once the post-processor exists.
8. **UI** (§8), after the mockup.

Steps 1–5 need nothing from #165, #166, #167, #171, #172, #173 or #178. They are available
now.
