# Toolbox — ToolStack review (interoperability dimensions + construct harvest)

Review of **"ToolStack"**, a shipped modular stacking-toolbox system (Kickstarter,
480 files: core STLs, 21 stretch-goal accessory sets, build guides, gear list).
Source material lives locally at `OneDrive/3D/Toolbox/` — **not** in this repo,
and it must stay that way (see the licensing position below). This document is
the deliverable of [issue #147](https://github.com/SlyWombat/CaseMaker/issues/147):
prose, numbers and diagrams only.

Every dimension below was measured from the STLs (binary-STL bbox + plane-slice
scanline probes) or quoted from the bundled guides; anything inferred is marked
**inferred**. Beware: several ToolStack STLs are exported with **permuted axes**
(the Standard cases have Y as height and Z as depth; the Mini cases have Z as
height) — always identify axes from features, never from raw span order.

## Licensing position

ToolStack is **paid Kickstarter backer content with no licence in the folder**
(the bundled READ ME thanks backers and directs support to Kickstarter DMs).
Compare `src/types/rack.ts`, which can cite "Mini Rack by Meuon, Printables
1307276, CC-BY 4.0". ToolStack does not pass our provenance practice, so:

- **What we may use:** interoperability DIMENSIONS (footprints, heights,
  connector envelope and socket profile, fastener schedule, tolerances) and
  construct *ideas* — the things documented here.
- **What we may not do:** copy, trace, remesh, convert or commit any ToolStack
  geometry. No ToolStack STL/STEP/3MF enters the repo, ever. Any toolbox
  archetype we build is our **own design**, clean-room from this document, and
  per #147 it will NOT be interoperable with ToolStack parts (arbitrary
  parametric dimensions, our own connector).

## The interoperability grid

Three footprints × three shared module heights. Footprints and heights measured
from the module-case STLs; the guide's stated nominals agree except Mini width
(documented 150, measured 148).

| Size | Footprint (doc) | Measured case | Short | Tall | Extra Tall | Lid case |
|---|---|---|---|---|---|---|
| Mini | 150 × 150 | 148 × 150 | 67 | 87 | — | 53 |
| Standard | 210 × 190 | 210 × 190 | 67 | 87 | 102 | 53 |
| Mega | 340 × 305 | 340 × 305 | 67 | 87 | 102 | (present, not measured) |

Heights are the shared axis: 67/87/102 recur identically across footprints, so
any drawer guts (latch, slides at a given height) interchange across sizes and
the marketing promise "design your toolbox around your tools" is really "pick
rows from one height column". Mega ships **split into FL/FR/BL/BR quadrants**
joined with M3×16 (7 screws per housing, 10 per drawer, 7 per lid, read from the
Mega guide's diagrams), with an `Uncut Mega Files for larger printers/` folder
carrying one-piece versions — the split is a *distribution* choice layered on
one design, not a separate design.

## Interface 1 of 3 — stack registration (rim + skirt)

Modules register vertically by telescoping, before any connector is involved
(all numbers measured on Mini Short, wall section at mid-depth):

- Walls are 4.0 thick. The **bottom 13 mm of every module is a skirt recessed
  6.0 mm inboard** of the outer wall face; it drops INSIDE the module below's
  top opening, whose inner face at the top band sits exactly 6.0 inboard —
  line-to-line nominal, with ~45° lead-in funnels cut into both parts (the
  case top thickens inward to ~8.6 for this).
- The top edge carries a **triangular perimeter rim ridge** (~4.7 tall) that
  noses into the mating chamfer at the skirt root and seats the joint.
- Stack pitch is therefore **module height − ~13** (inferred from the mating
  faces; not verified on an assembled pair).

This is worth copying as an idea: registration (rim) and retention (connector)
are **separate features**, so a module stacks square even with no connectors
fitted, and the connector never fights the fit.

## Interface 2 of 3 — the module connector slider

`Module Connector Slider [All].stl` — one geometry for every size, 2 per module,
overall **9.8 × 35 × 20 mm**. A loose-fit variant ships beside it along with the
CAD (`Module Slider_Loose Fit.STEP`, SolidWorks AP214). Dimensions below were
measured by slicing the STLs (the STEP corroborates the envelope; its B-rep was
not parsed).

### The slider (male part)

Cross-section perpendicular to its 35 mm length, layered from the socket
outward — total 9.8:

| Layer | Thickness | Extent |
|---|---|---|
| Detent bump | 0.8 proud of wings | central rib ~2.6 wide, on the leaf spring |
| Wings (dovetail rails) | 3.0 | two rails 29 long, outer span 15.0, gap 8.0 between, **45° flanks**, each joined to the web by a ~1.1 wide neck |
| Web | 3.27 | full 35 length × 19 tall |
| Back/grip layer | 2.73 | end paddles only (~4.5 long × 13 at each tip); mid-span back face is relieved and ribbed as a grip |

Mid-length, a **2 × 22 window** behind a **1.0 × 22 leaf spring beam** carries
the detent rib: the spring gives ~2 mm of travel, the bump 0.8 of engagement.
Symmetric end-to-end, so it is insertable either way up.

### The socket (female part)

A **vertical dovetail channel on the exterior of both side walls** (never the
rear wall — measured absent on Mini), cut into a pad raised 1.0 off the wall:

- Channel floor **3.0 below the pad**; mouth **~11.4** between lips; floor
  width **~16.0**; lip flanks **45°** (measured 1:1 slope), overhanging ~1.6
  per side — the slider's wings fill the channel depth exactly and the 45°
  flanks mate.
- The channel runs the wall height, **open at the top edge**, and is
  interrupted by a **10 mm full-width flush block** (over-insertion stop);
  below the block sits an **11 mm closed pocket** 14–24 mm above the module's
  bottom face — the *receiving* pocket, reachable from below through the
  skirt zone.
- Socket position: centred ≈ 38 mm behind the front face on Mini, ≈ 48 mm from
  one face on Standard — **profile identical across sizes** (verified on
  Standard Short), position size-specific.

### How a joint works (choreography partly inferred)

The slider drops into the lower module's channel from the top edge, wings
riding under the lips. The leaf-spring bump drags on the channel floor
(compressed 0.8) until it clears the channel's top end and clicks out, parking
the slider roughly half-proud. The upper module slides down over the protruding
half: its skirt zone passes the slider's proud web, its closed pocket captures
the upper wing section (~10 mm of dovetail engagement, inferred from mating
positions), and its channel floor re-compresses the bump until the bump sits at
the seam. Pushed fully home instead, the wings bottom on the stop block and the
slider sits flush — a storage position. Removal reverses with a thumb on the
grip ribs.

### Variants — a tolerance choice exposed to the user

| File | Envelope | Delta vs standard (measured) |
|---|---|---|
| `Module Connector Slider [All].stl` | 9.8 × 35 × 20 | — |
| `Module Slider_Loose Fit.stl/.STEP` | 9.8 × 35 × 20 | wing faces relieved **0.2** (engagement depth 3.0 → 2.8); wing outer span **15.0 → ~13.6**; web, back and bump-tip position unchanged, so the bump stands 1.0 proud and the click still lands |
| `Module Slider - Tall.STL` (set 12) | 9.8 × 20 × **54** | same cross-section, longer — deep-reach hanger coupling |
| `Module Slider - Cutoff.STL` (set 14) | 10.2 × 20 × **21.8** | roughly the bottom half — permanent-mount coupling (the extra 0.4 not investigated) |

Note what the loose variant is: not a global scale, but **relief on exactly the
two engagement surfaces**, with the detent compensated so retention survives.
That is the right way to ship a tolerance option.

## Interface 3 of 3 — the drawer peg grid

Every drawer floor carries a grid of **5.0 × 5.0 square holes on a 12.0 mm
pitch, both axes** (measured on Mini Short). Partition pegs drop in:

| Peg | Width (measured) | Spans | Heights |
|---|---|---|---|
| 2H | 21.6 | 2 holes | 15 / 20 / 30 |
| 3H | 33.6 | 3 holes | 15 / 20 / 30 |
| 5H | 56.6 | 5 holes | 15 / 20 / 30 |

Plus legacy Small/Medium/Large pegs and full-length partition panels
(stretch-goal 01: 4.9 thick, drawer-length). The same grid doubles as the
mounting interface for every in-drawer accessory (bit holders, bottle inserts,
bins simply sit on it). Third parties get a stable interior interface without
ever touching the connector.

## Fastener schedule (gear list + build guide, cross-checked)

Per **drawer module**:

| Fastener | Qty | Joint |
|---|---|---|
| M3 × 6 SHCS + M3 hex nut | 4 | face plate → drawer |
| M4 × 8 SHCS + M4 hex nut | 8 | slide dogs (2 screws × 4 dogs) |
| M3 × 16 + nut (Mega only) | 7/10/7 per housing/drawer/lid | quadrant joins (counts read from the Mega guide's diagrams; the core guide says "4 extra" — discrepancy unresolved) |

Per **lid module**: 2× M5 × 25 SHCS + 2 hex nuts + 2 flat washers (handle).
The #147 brief said 1; the guide and gear list both say **2 of each**.

Elsewhere: 6 × 2 mm magnets (name plates, e.g. Mini plate 33 × 37 × 2.5);
M5 T-nuts + button/socket screws into **2020 aluminium extrusion** (dolly
uprights, ~700 mm); 3/8" locknut + hex bolt (castor wheels, hardware ships with
the wheels); M4 × 20 (dolly stand).

Design notes from the guides worth keeping:

- **Nut pockets are deliberately tight** ("we never want the nut to freely
  spin… pull the nut into place with a longer screw") — friction-fit nut
  retention is a documented, intended behavior, not slop.
- Print settings: 0.2 layer, **4 wall loops**, 15–20% infill (25–35% for rough
  service), **no supports** — except four named parts (drawer face, latch
  handle, connector slider, lid case) which take buildplate-only supports.
  They publish per-part support requirements; we publish nothing.
- Assembly order (slides → dogs → latch → face plate → connector sliders)
  means the drawer is serviceable without unstacking: everything fastens from
  the front or the open side.

## Other measured parts

| Part | Dims (mm) | Notes |
|---|---|---|
| Drawer (Mini Short) | 122 × 134 × 44 | in a 148-wide case: 13/side for the slide stack |
| Drawer slide | 7 × 35 × 125 (Mini) / 165 (Std, from #147) / 250 (Mega) | a **floating middle rail** — the Mega file is literally named `Floating Slider`, making this a two-stage printed telescoping slide |
| Slide dog | 7 × 12 × 47.4 (Mini) / 82 (Std, Mega) | 4 per drawer; 2 clamp the slide path to the case, 2 to the drawer |
| Latch spring | 28 × 35 × 5 | separate printed leaf spring, one per face plate |
| Latch handle | 57.5 × 25 × 25 (Mini) | 2 per face plate, sprung apart by the leaf |
| Face plate | 135 × 47 × 4 (Mini) / 197 × 47 × 4 (Std) / 327 × 47 × 4 (Mega, two-piece L+R) | 47 tall regardless of module height |

The latch is worth a sentence: **the spring is its own printed part**, dropped
into the face plate between two sliding handles. It is a replaceable wear item,
prints flat in the strong orientation, and its stiffness can be re-chosen
without touching the latch bodies. Every latch in `latches.ts` /
`latchProtection.ts` (including the #109 Pelican cam latch) gets its spring
force from geometry integral to a structural part.

## The 21 stretch-goal sets — attachment census

The hypothesis from #147 was "ONE connector unifies the whole ecosystem."
Verdict: **partly confirmed, usefully refuted in the details.** The ecosystem
runs on the **three interfaces** above, each doing one job:

- the **slider socket** joins module-to-module and module-to-flat-carrier,
- the **rim/skirt** registers everything that stacks,
- the **peg grid** mounts everything inside a drawer.

Carriers that hold a whole stack (wall shelf, dollies) use a fourth, dumber
mechanism: a **nesting pocket** the bottom module drops into.

| # | Set | What it is | Attachment | Evidence |
|---|---|---|---|---|
| 01 | Fullsize Partitions | full-length divider panels, 4.9 thick | peg grid | bbox |
| 02 | Socket Storage | hex/torx bit holders | drop-in on peg grid | bbox (fits drawer) |
| 03 | Flat Top | flat cap lid (Mini 139 × 145.6 × 12) instead of the lid module; Mega split A–D + uncut | rim (nests in top opening) | bbox |
| 04 | Wall Mount | shelf tray + 3 triangular gusset struts, screwed to studs | **pocket**: tray walls swallow the bottom module (Mini tray interior ~153 wide, 46+ deep); no socket found in the tray walls (measured); the strut edges carry a dovetail-profiled rail section (partial measurement — likely slider-family, unconfirmed) | scanline probes |
| 05 | Double Drawers | two half-height drawers in one Extra-Tall case | standard module (own case included) | file census |
| 06 | Cord Holder | flat cord clip 90 × 51.5 × 4.9 + Mega cord-hole drawer variants | drawer accessory | bbox |
| 07 | Bit Bins | lidded bins 5×5 / 6×6 / 7×7 | drop-in | bbox |
| 08 | Cord Hole Drawers | drawer + case variants with cord pass-throughs, all sizes | standard module | file census |
| 09 | Paint Bottle Insert | bottle racks, 1in / 45 mm / 75 mm | drop-in | bbox |
| 10 | 2 Wheel Dolly | hand-truck: pan base, 2020 uprights (~700), printed handle + stand | **pocket** pan + M5 T-nuts + 3/8" wheel hardware | guide + bbox |
| 11 | Castor Wheel Dolly | 4-castor version, incl. Mega (split A–D) | as 10 | guide + file census |
| 12 | Tool Hangers | hanger inserts (Mini 196 × 174 × 40) for tools | **slider socket** — ships `Module Slider - Tall` (54 long, same section) | bbox of slider |
| 13 | Castor Wheel Bottom | 148 × 150 × 37 wheeled base, module footprint | bottom carrier (socket use unverified) | bbox |
| 14 | Surface Bottom Mount | bench base plate + `Module Slider - Cutoff` | **slider socket** — the plate's side walls carry the exact module socket (3 deep, ~16 floor, 45° lips, 38 from front — all measured identical to the case) | scanline probes ✓ |
| 15 | Nozzle Holder | 62 × 56 × 17 printer-nozzle insert | drop-in | bbox |
| 16 | Flip-up Lid | one-piece flip lid, 28 tall, print-in-place hinge (0.2 clearance slits measured at the hinge line) | rim/skirt like the lid case | scanline probes |
| 17 | Quad Drawer (Mega) | four drawers in one Mega Extra-Tall housing | standard module | file census |
| 18 | Under Desk Mount | 148 × 150 × 28 frame, screws under a desk | frame rails + cross members measured; **could not confirm** socket reuse — mechanism undetermined | scanline probes |
| 19 | Padlock Drawers | case + drawer variants with aligned holes + printed padlock loop (40 × 40 × 10) | standard module | file census |
| 20 | Gridfinity Drawers | drawer floors that are **Gridfinity baseplates**, all 8 size/height combos | drawer variant; note they adopted a *third-party* interior standard alongside their own peg grid | file census |
| 21 | Blank Drawers | drawers without the peg grid | drawer variant | file census |

Set 20 deserves emphasis: when a de-facto community standard existed
(Gridfinity), they shipped native support for it *in addition to* their own
grid. An interior interface is cheap to multiplex; an exterior connector is
not.

## Construct inventory → where each lands in this repo

From #147 goal (a), after review. "Issue" = follow-up filed; constructs judged
not worth a standalone issue say so here instead.

1. **Split-part scheme** — Mega quadrants + M3×16 + an *uncut* folder for big
   printers. Our `rackFit.ts` only FAILS the build-volume check; it never
   splits. Applies to case, rack and any toolbox equally. → **issue**.
2. **Assembly-to-assembly connector** — nothing in the repo joins two
   separately-printed finished assemblies (`snapCatches.ts`/`boardSnap.ts` are
   board→shell; rack snap tabs are within one rack). A clean-room dovetail
   slider + socket, designed from the *behaviors* documented here (separate
   registration vs retention, leaf-spring park detent, over-insertion stop,
   tolerance variants), is the single most valuable harvest. → **issue**.
3. **Hole-grid + drop-in partitions** — 12 mm grid of 5×5 sockets + pegs. We
   have no internal-divider concept at all (`customCutouts.ts` is
   outward-facing). Serves case interiors and rack cable trays too. → **issue**.
4. **Latch with separate printed leaf spring** — genuinely different from
   everything in `latches.ts` (springs there are integral). But its natural
   consumer is a drawer face, and we have no drawers; as a lid latch the #109
   Pelican cam already covers the use case. **No standalone issue** — folded
   into the toolbox go/no-go as part of the drawer package.
5. **Printed linear motion** (floating-rail two-stage slide + dogs) — the most
   toolbox-specific construct; meaningless without a drawer archetype.
   **No standalone issue** — folded into the toolbox go/no-go.
6. **Mount family + structural stock interface** — wall shelf + gussets,
   under-desk frame, bench base plate, dollies on **2020 extrusion with M5
   T-nuts**. The extrusion interface is an off-the-shelf structural system we
   lack entirely (compare `mountingFeatures.ts`, `stand.ts` 'slider' mount,
   `enclosure.sliderChannel` — all case-to-surface, none case-to-stock).
   → **issue** (2020/T-nut interface + carrier-pocket pattern).
7. **Magnet pockets** — 6×2 magnets retaining swappable name plates. Grep
   confirms no magnet support anywhere in the compiler; `fasteners.ts` (#140)
   is the natural home, `textLabels.ts` makes the plate. → **issue**.
8. **Exposed tolerance variants** — standard + loose shipped side by side,
   relieved only on engagement faces, detent compensated. Generalizes to our
   snap features (`snapCatches`, board snaps, rack tabs). → **issue**.
9. **Print-orientation metadata** — they name exactly which parts need
   supports; we emit STLs with no print guidance. We already flip parts via
   `PRINT_FLIP_NODE_IDS`; the missing half is per-part orientation/support
   notes surfaced at export. → **issue**.

## The third archetype — questions still open

#147 goal (b), updated by this review. Already decided by the user in #147:
**no ToolStack interop** — arbitrary recommended dimensions, parametric like
the rack.

- **Bin + lid + connector, with drawers as one fill option** now looks right.
  The census shows the case/drawer split is what makes 11 of 21 accessory sets
  possible (they swap one part of a module); a monolithic drawer-box primitive
  would forfeit that.
- **The connector question is really three questions** (registration, stack
  retention, interior grid). A v1 could ship rim registration + interior grid
  and defer the slider entirely — stacking without locking is already useful
  on a bench.
- **Rack vs toolbox convergence**: both are "stack of modules joined by a
  repeated interface". But the rack's interface is a screwed slot pitch on a
  frame, the toolbox's is a moulded joint between self-contained boxes; the
  overlap is the compiler machinery (part families, fit checking, fused
  export), not the geometry. Recommendation: shared machinery, separate
  compiler — same relationship `stand.ts` has to `rack.ts`.
- Remaining research named in #147: commercial toolbox features (Systainer,
  Packout et al.) and specific tool-insert holders — out of scope for this
  review, listed in the go/no-go issue.

Gate: the go/no-go issue is explicitly gated on the provenance question — the
connector and every module dimension must be re-derived clean-room (this
document is the allowed input), and nothing we release may be marketed as
ToolStack-compatible.

## Method notes (for the next reviewer)

- Binary-STL bbox and min/max scripts plus a plane-slice scanline prober
  (`slice.mjs`, `scan.mjs`) live in the session scratchpad; they are ~50-line
  node scripts, trivially recreated: slice triangles against a plane, chain
  segments, or sweep a scanline and print solid intervals.
- Office docs opened with python3 + zipfile + regex on `word/document.xml`,
  `ppt/slides/slideN.xml` (`<a:t>` runs), `xl/sharedStrings.xml`.
- The guides' assembly diagrams (PNGs inside the pptx) disambiguate what the
  STLs cannot; extract `ppt/media/` and look before theorizing — the connector
  choreography above took both.
