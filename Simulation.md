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
- **The round-trip is the post-processor's test:** `sweep(ir) ≡ sweep(parse(post(ir)))`
  within ε. That validates #173 with no machine at all, which nothing else in the plan does.
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

**This matters for scope.** Designing the sweep around "flat end mill at constant Z" would
build something that has to be replaced to reach the rest of `/Makera-Parity.md` §2's
strategy list. Designing it around *convex hull of two tool solids* reaches all of 3-axis
work for free, and only rotary needs a different backend (§5).

### 3.2 The 2.5D fast path

A flat end mill at constant Z is the overwhelmingly common case and has a 2D shortcut worth
keeping: the sweep of a disc along a segment is a **capsule**, which is
`circle ∪ rectangle ∪ circle`. Emitting those three as separate CCW contours lets Clipper2's
`Positive` fill rule union them, with no hull arithmetic in JS.

Constant-Z moves are bucketed by quantised Z, unioned in 2D per bucket, then extruded once
from that Z up past the stock top. Non-constant-Z moves fall back to §3.1.

**The naive version of this is catastrophically slow.** §4 is the measurement and the fix.

### 3.3 Rapids, arcs and modal state

- **A G0 above the stock removes nothing.** A G0 that intersects the stock **removes
  material in the simulation** — it is not merely flagged. The gouge must be visible;
  #174 refuses the file separately.
- **Linear only.** Studio's own output contains no arcs at all — 9 607 `G1`, 25 `G0`, zero
  `G2`/`G3` (`/Makera-Parity.md` §6). Our IR is linear too. If a file ever does contain
  arcs, the **parser** tessellates them, so the sweep never sees a curve.
- The parser must survive a file with **no `G54` and no `G10`** that opens with `T1 M6`,
  because that is what Studio emits.

---

## 4. Measured performance, and the algorithm it dictates

All figures: Manifold 3D wasm via this repo's harness, Windows node v24.19.0, synthetic
glyph-like paths (short wandering segments), 1 mm flat end mill (r = 0.5), 16-gon cap
circles, one Z level. Scratch probes: `casemaker-app/probe-sim-{perf,2d,3,4}.mjs`.

### 4.1 A single Clipper2 union call is quadratic and unusable

Feeding every capsule contour to one `new CrossSection(all, 'Positive')`:

| cutting segments | contours | points | single call | chunked (64) |
|---|---|---|---|---|
| 250 | 500 | 5 000 | 261 ms | 34 ms |
| 500 | 1 000 | 10 000 | 783 ms | 57 ms |
| 1 000 | 2 000 | 20 000 | **4 530 ms** | 141 ms |
| 2 000 | 4 000 | 40 000 | **43 430 ms** | 1 903 ms |
| 4 000 | 8 000 | 80 000 | **114 093 ms** | 904 ms |

Both methods produce an **identical area** (1.366 mm²), so chunking is a restructuring, not
an approximation. An earlier probe that unioned the extruded solids one at a time instead
died outright with `RuntimeError: memory access out of bounds`.

### 4.2 `simplify()` before extruding is free, and removes the 3D cost entirely

The union keeps per-capsule sliver detail: 8 000 contours covering 2.38 mm² came out with
9 016 contour points and produced 36 076 triangles.

| simplify ε | contour points | area (mm²) | extrude + subtract | result triangles |
|---|---|---|---|---|
| none | 9 016 | 2.38 | 176 ms | 36 076 |
| **0.002** | **145** | **2.38** | **2 ms** | **592** |
| 0.01 | 58 | 2.38 | 1 ms | 244 |
| 0.05 | 29 | 2.38 | 0 ms | 128 |

`simplify(0.002)` costs 5 ms, cuts contour points 62×, preserves area to three significant
figures, and makes the whole 3D stage cost 2 ms. **The 3D boolean was never the problem.**

### 4.3 Pairwise tree reduction with simplify at each level makes it linear

| segments | contours | flat union | simplify-each, then one union | **pairwise tree (8-way) + simplify** |
|---|---|---|---|---|
| 4 000 | 8 000 | 2 432 ms | 2 153 ms | **473 ms** |
| 12 000 | 24 000 | 29 811 ms | 25 747 ms | **1 435 ms** |

Areas agree across all three methods to three decimals (2.374–2.380). Tripling the input
triples the tree-reduction time — 473 → 1 435 ms — so the tree is **linear** where the flat
union is quadratic. Simplifying each chunk without restructuring the reduction buys almost
nothing; the win is the tree.

### 4.4 The algorithm, and the budget

```
for each quantised Z level:
    contours   = capsules for every cutting move at that level        (JS)
    chunks     = CrossSection(chunk of 64, 'Positive').simplify(ε)    (Clipper2)
    region     = pairwise 8-way union tree, simplify(ε) at each level
    solid      = extrude(region, stockTop - z).translate(z)
removal = union(solids);   after = stock.subtract(removal)
```

with ε = 0.002 mm. **Budget: ~1.4 s per Z level at 12 000 cutting segments**, so a
three-depth badge lands at **4–5 s** — a debounced background job in the geometry worker,
not a per-frame computation. Cap circles at 16 segments (chord error 0.010 mm at r = 0.5);
reducing to 12 made it *slower*, not faster, so segment-count tuning is not a lever.

### 4.5 Where exact CSG stops being the right answer

Parsing Studio's `TopClamp.nc` — a real 3D job with ramping — gives **9 618 cutting moves
spread over 482 distinct Z levels**, 19 204 contours, 192 232 points. Exact CSG needs one
extrude and one boolean per level, so 482 levels is not a tuning problem; it is the wrong
representation. **This is the case decision 2's dexel engine exists for**, and it is now
measured rather than assumed.

---

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
- Cut depth greater than `fluteLength` → refuse; the shank would be rubbing.
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

The two cannot be compared for exact equality: #171's prediction uses Clipper2 arc offsets
while the sweep hulls tessellated circles and then simplifies, so every round corner leaves
slivers. Compare in an **ε band** instead, with the band strictly larger than the sweep's
own simplify ε and the cap-circle chord error:

- `difference(offset(predicted, −ε), simulated)` must be empty → the toolpath does not
  **under-cut**. This is what catches uncut corners and stepover gaps.
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
2. **Is ε = 0.002 mm safe for the oracle, or does it mask a real thin feature?** It
   preserved area to three figures on synthetic paths; it has not been tried on real glyph
   outlines at badge scale.
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
