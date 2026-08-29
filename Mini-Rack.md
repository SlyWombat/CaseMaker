# Mini-Rack — parametric rack project type

Emulates "Mini Rack" by Meuon (Printables model 1307276, CC-BY 4.0 — remix allowed,
attribution required). Sample files + PDF live in `samples/Rack/`. Our version is a
**parametric regeneration**, not a mesh rescale: envelope dimensions resize to the
user's printer while functional features (screw holes, keystone cutouts, snap fits,
wall thickness) stay fixed-size.

## Measured from the sample (defaults)

Overall: ~250 deep × 252 wide × 275 tall mm. Author printed on a Prusa XL;
"won't fit small or medium printers" — which is exactly why we make it resizable.

| Part | Dims (mm) | Notes |
|---|---|---|
| Side panel L/R | 250 d × 275 h × 20 thick | Mirror pair. Heavy front column (x 0–45) protecting cables; y range −5..270 → 5 mm stacking foot below base |
| Top/bottom ×2 | 222 × 250 × 15 | Flat 5 mm slab with six corner/mid tabs that sit in ledges in the side rails; four are screwed with M5. 222 = 252 − 2×15. See **Plate joint** below |
| 3-slot long shelf | 252 × 49.5 × 123 deep | Vented deck, no front lip |
| 3-slot short shelf | 252 × 49.5 × 86 deep | Pairs back-to-back with long shelf |
| 3-slot blank | 252 × 49.5 × 4 | For user drilling/CAD variations |
| 2-slot short shelf | 252 × 33 × 88 deep | |
| 2-slot blank | 252 × 33 × 4 | |
| 2-slot keystone plate | 252 × 33 × 10 | 5 keystone jacks: 15 mm openings on 30 mm pitch, jack #1 at x 36–51; latch shoulders at z 8.25; cable path at x ≈ 175–228 |
| Cable tray v2 | 252 × 104.5 × 25 | |

**Slot system (the core invariant):** vertical screw pitch **16.5 mm**; slot height
N × 16.5 (2-slot = 33, 3-slot = 49.5). Side-column hole centers at
**y = 13.5 + n × 16.5**, ~5 mm holes for 5 mm-head allen cap screws. 275 mm height
≈ 16 slots (264 mm) + margins. Screws clamp shelves to the sides and hold the whole
rack together; everything else snaps.

## Parameter model

Independent knobs (all default to sample values):

- **width** (faceplate span, default 252) → faceplates, shelves, tray, top/bottom
  (width − 2×15). Sides unaffected.
- **depth** (default 250) → sides, top/bottom; shelf depths offered as short (86) /
  long (123) / custom ≤ depth − front column.
- **slots** (integer, default 16) → side height = slots × 16.5 + margins (11 mm at
  sample size). Never scale the pitch.
- **parts** — per-family selection with quantity: blank faceplate (N-slot),
  vented shelf (N-slot × depth), keystone plate (jack count auto = what fits width
  at 30 mm pitch), cable tray.
- **printer** — preset (A1 mini 180³, Ender-3/MK4 220–250, XL/X1C 256+) or custom
  X/Y/Z. Every generated part is fit-checked, flat placement first then
  diagonal-on-bed fallback; warnings name the blocking part and the max rack dims
  that would fit. Governing parts: side panel (depth × height) and faceplate (width).

Fixed (never scaled): 16.5 pitch, 5 mm screw holes, keystone 15 mm/30 mm pitch +
latch shoulder depths, 4 mm faceplate thickness, snap tab sizes, wall thicknesses.

## Plate joint

The top and bottom plates are carried on **four corner tabs** that drop into
**ledges** cut in the side rails, and each tab is screwed to the side with an
M5. This is the third joint on this part; the history matters because each
version failed in a way the next one fixes.

**v1** cut the seat pocket the plate's full thickness at z = FOOT_H and
z = H_TOP − PLATE_T, so both pockets broke out through the side body's faces.
The plates were located fore/aft and free in z — on the first printed set the
top plate lifted straight off and the bottom plate dropped out.

**v2** replaced that with a blind rebate (seat = the plate's inner 3 mm only)
plus two-jaw snap darts. It held z properly, but it could only ever be
assembled plate-then-sides, and the plates could not come back out of a
standing rack.

**v3 — what is there now.** Tabs and screws, for serviceability:

- Each tab is **flush with the plate's OUTER face** and reaches `TAB_REACH`
  over the side panel. That face points out of the rack in *both* installs, so
  the tab fills its ledge at whichever end it lands: the top stays flat enough
  to stack on and the underside stays flat enough to sit on.
- **One printed plate, installed twice** survives. `rack-top` is `rack-bottom`'s
  op rotated 180° about x; every y feature is symmetric about depth/2.
- **The two ends are not alike, and cannot be.** At the top the ledge is only
  as deep as the tab, so the rail keeps material underneath for the screw, and
  the ledge is open upward — the plate drops into an assembled frame and lifts
  back out. At the bottom there is nothing below plate level at all (the
  plate's underside *is* the rack's underside), so the bottom screw is driven
  **UP** into the rail instead, and the tab tucks under rail material, which
  captures the bottom plate and means the frame is built onto it.
- **Screw direction is set by what fits.** Downward at the bottom is not an
  option: there are only 19 mm of rack below plate level (5 mm foot + 14 mm
  rail) and a 24 mm screw would come straight out through the foot. Driving up
  reaches the rail and the web above it, and lands the head in the same
  outer-face counterbore the top plate uses.
- **Tab placement is pinned by three constraints that nearly conflict:**
  symmetric about depth/2; wholly over a stacking foot (what the bottom tab
  lands on); and clear of the front accessory screw column. Centring on the
  foot put the tab screw 3 mm from that column — with radii summing to 4.7 the
  two holes broke into each other, so the tab screw ran out into slot 0's
  clearance hole. Sitting the tab at the *front* of the foot opens that to 7 mm.
- **The screw axis is offset, not centred in the tab.** The heads in hand are
  Ø9.2 × 3 mm (a button head), so the counterbore is Ø9.8. Centred in an 11 mm
  tab that leaves 0.6 mm of wall each side, which is not a wall. Offset 4.3 mm
  inboard from the plate edge, the outboard wall gets 1.8 mm and the inboard
  side of the bore runs into the deck, which is solid there. Tab thickness is
  head height + a 3 mm bearing floor.
- **The bottom screw needs a way IN.** Its head lands in the tab's outer-face
  counterbore, which on the bottom plate faces the rack's underside — and the
  end tabs sit over a stacking foot. The first cut of this joint left that head
  pocket sealed against the foot: a Ø9.8 insertion path measured 375 mm³
  blocked, so the screw could not be fitted at all. Each foot now carries a
  driver access hole. The constraint worth remembering: *whichever face carries
  the counterbore must have unobstructed access in the assembled rack.*
- **The mid tab (racks ≥ 180 mm deep) is support only** — it carries the deck
  against sag and takes no screw. Giving it one means reserving a solid column
  at depth/2, and the only way to do that is to split the vent window there,
  which measured ~100 cm³ per panel. A tab that just carries the deck costs
  nothing and is what the sag actually needs.
- **Each screw needs a reserved solid column.** Measured: directly under the
  rack's top face there is only ~1.5 mm of solid before the lightening pocket
  opens up. The columns are keep-outs in the lightening profile, and the vent
  windows were pulled back off the rear tabs — without both, two of the four
  screws had only ~67% of their thread annulus. They now measure 98–99%.

Print the plate **counterbores UP**. The tab is the same thickness as the deck
— the plate is a flat slab with ears, not a slab with lumps — so it lies flat
either way and the only thing choosing the orientation is the head seats.
Printed the other way up, each seat is a downward-facing ceiling spanning its
own bore: it bridges, droops, and gives the screw head nothing flat to bear on.
Turned over, the same face is an ordinary supported top surface.

In assembly the bottom plate's counterbored face points down, so **`rack-bottom`
is the one that gets turned over**; `rack-top` is already correct as modelled.
Both therefore reach the bed the same way up, which is right — they are one
printed part, and `rack.spec.ts` proves it by mapping one onto the other and
differencing (0.00 mm³).

This flip entry has now changed twice. It is decided by which way the
counterbores face and nothing else; re-derive it from that if the joint moves
again.

**Pilot diameter is 4.8, set by test print** (`samples/pilot-coupon-m5.stl`,
[issue #140](https://github.com/SlyWombat/CaseMaker/issues/140)) — not by
arithmetic, which got it wrong. The usual 0.8×major rule (~4.0–4.3 for M5) is
for thread-*forming* screws designed for plastic, with a ~30° profile that
displaces material. A standard 60° metric machine screw driven into PLA at
that size splits the boss instead of forming a thread. Of 4.0/4.2/4.4/4.6/4.8
driven into a printed coupon in both layer orientations, 4.8 held best. Note
4.8 was the top of the tested range, so the optimum is not yet bracketed.

The head recess is still provisional pending #140, which is researching one
repeatable screw-hole mechanism to replace the ~90 hand-rolled hole sites
across the compiler.

`tests/unit/rack.spec.ts` pins the seat, the fore/aft location, the
deliberate top-lifts / bottom-captured asymmetry, and the thread annulus at
all four screws.

## One-piece (assembled) export

A rack printed fused is far stiffer than one bolted together. Where the printer
can fit the whole thing, **Offer one-piece export** in the rack panel adds two
entries to Export:

| Entry | What it fuses | Mass at sample size | Support |
| :--- | :--- | ---: | :--- |
| Rack frame — ASSEMBLED | sides + plates | ~1.09 kg | open box interior, reachable |
| Whole rack — ASSEMBLED | + all accessories | ~1.58 kg | sealed under each shelf deck |

**Both variants weld the plate edges to the sides along their full length.**
Unioning the frame as-is gives a single Manifold component, which sounds like
more than it is: the tabs only TOUCH their ledges on coincident faces, and
everywhere else the `SIDE_CLEAR` slot runs the whole depth. Measured, just 26%
of each plate edge was bridged — the three tabs, 66 mm of 250 — leaving a
1.1 kg frame hanging off six small tabs with a 0.3 mm crack down both sides.
Fit clearance is for parts that come apart; a part printed as a unit gets it
filled. Now 100% bridged.

The whole-rack variant additionally welds the accessories, which sit on `SIDE_CLEAR` and do **not** touch at all. Shelf positions become
permanent, and the support under each deck can only be worked out through the
side vent windows.

Both are **alternatives** to the separate parts, not extra parts: they are kept
out of the 3D view (they would sit exactly on the geometry they fuse) and out
of Save All (which would otherwise hand you the rack twice).

**Print them UPSIDE DOWN — top plate on the bed.** Found on the first one
printed: standing the way it sits in the rack, the four stacking feet are the
only thing touching (14.6 cm² of a 630 cm² footprint) and the whole
221 × 250 mm bottom plate bridges 5 mm above the bed, so a slicer supports the
entire underside. Turned over, the top plate and rails give 392 cm² of bed
contact and nothing bridges. Both fused ids are in `PRINT_FLIP_NODE_IDS`, and
single-part export now applies that flip too, so the file arrives the right way
up rather than relying on the hint being read.

Off by default, and gated on fit. Building them means unioning the whole rack
twice — measured ~2.4 s and 70k extra triangles on the sample — which is not a
cost every slider drag should pay. The fit test lives in `rackFitsWhole()` and
is shared by the compiler and the panel so the offer and the checkbox cannot
disagree; the rack prints in its assembly orientation, so it is straight or
turned 90° on the bed, nothing diagonal.

## Wall mount — ears

A loaded rack hangs entirely off the two ear blades, and the load grows with
the box: a 250 mm deep rack cantilevers hard off the wall. Screws are one per
~60 mm of blade, never fewer than four — five a side at the sample height,
seven on a 24-slot rack. Erring high is deliberate: extra holes cost almost
nothing to print, and more of them up the blade gives more chances to land on
a stud or on solid backing rather than bare plasterboard.

Gussets brace the blade back to the panel under every screw, **plus one at each
end of the blade**. The screws are spread through the middle of the height by
construction, which used to leave the top and bottom of the blade as unbraced
cantilever — the corners that peel first when a heavy rack tries to rotate off
the wall. `earScrewsPerSide()` is shared with the hardware list so the count in
the list is the count in the part.

## Full-depth shelf

`shelfDepth: 'full'` re-sizes with the rack instead of being a fixed number:
the shelf always runs from the front recess to the rack's rear face, so
changing the rack's depth changes the shelf with it.

It anchors in **three** places, not two. A full shelf spans ~238 mm at sample
size while the existing rear column sits only 88 mm back from its front edge,
which would leave most of the shelf cantilevered. The sides therefore gain a
rear column at `REAR_ANCHOR_INSET` in from the back face — inside the rear
band, which is solid at every mount type. That column is cut **only when a
full-depth shelf is present**, so an ordinary rack is not peppered with holes
it will never use.

## Shelf deck stiffening — and a note on material

**Every figure of sag in this document assumed PLA.** PETG is about HALF the
stiffness (E ≈ 2.0 GPa against ≈ 3.5) — and it is the right material for a rack
holding warm gear, since it has ~25 °C more heat headroom (Tg ≈ 80–85 °C against
55–60) and far better creep resistance under sustained load. Design for the
lower modulus rather than switching material.

A flat 3 mm deck over the ~197 mm span between the end ribs is not enough:
measured I = 106 mm⁴, which is **23 mm of sag under 5 kg in PETG**. A printed
shelf came out flimsy exactly as that predicts. Closing the deck lattice alone
only reaches 14.5 mm — section depth is the only lever big enough.

The deck therefore carries **upstand ribs** across the span, `SHELF_RIB_H` tall,
tying the two end ribs together:

| | I (mm⁴) | PETG @5 kg | @10 kg |
| :--- | ---: | ---: | ---: |
| flat deck, lattice opened | 106 | 23.2 mm | 46.3 mm |
| ribbed, lattice restored | 687 | 3.6 mm | 7.1 mm |

The stiffening ribs run **across** the direction a device slides in and out, so
on their own they are a row of steps to catch on. Half the cross-hatch — one of
the two diagonal families — is raised to the same height between them, so a
device rides on a near-continuous plane instead of dropping into the gaps and
snagging on the next rib. Diagonals rather than more straight ribs on purpose:
they engage progressively as something slides over them. Left clear at the very
front, so there is a flat lead-in to start a device on, and around any rear
cable cutout. The raised bars come from `lightenBars()` — the same construction
the pocket uses — so they sit exactly on the lattice rather than fractionally
off it.

UPSTAND, not downstand, for two independent reasons: the shelf prints
**deck-down**, so downstand ribs would print first and leave the deck bridging
between them; and downstand ribs would steal headroom from the accessory below.
Raised ribs also give a device airflow underneath, which is how most rack
shelves work — so `accessorySpaces()` measures usable height from the RIB TOP,
not the deck.

The deck lattice was also restored to 3/14 (~43% solid). Opening it to 2.6/19
saved 7.5 cm³ and removed a third of the material from the one accessory that
carries equipment. Do not re-open it for weight.

## Floor plate stiffening

The floor is **not held up by the ground**. It sits 5 mm clear, carried by its
tabs — the feet are under the SIDES, not under the deck — so anything heavy on
the rack floor is a plate spanning between the side panels.

Worse, only the END tabs bear downward: they land on a stacking foot, while the
mid tab has nothing beneath it and can only resist uplift. A load was therefore
carried on **four corners**.

Two fixes, both automatic:

- **A bearing pad under the mid tab** (racks ≥ `MID_BAR_MIN_DEPTH` deep) takes
  it to six load points. It works in COMPRESSION into the side panel, so it
  carries whether the rack stands on the floor or hangs off its ears. A screw
  there would do the same job in tension, but needs a reserved column at
  mid-depth which splits the vent window — measured at ~100 cm³ per panel
  against this pad's ~2.
- **Downstand ribs under the plate** (`floorRibs`, default on once the span
  passes 260 mm), 4 mm into the 5 mm of air beneath, 1 mm of ground clearance
  left deliberately: ribs reaching the floor would help a freestanding rack and
  do nothing for a wall-mounted one, which is the case that needs them. The
  perimeter rib matters as much as the cross ribs, since the load runs to four
  corners and the edge rib is the beam that gets it there.

Measured on a 350 mm rack (319 mm span), second moment of the real section:

| | I (mm⁴) | sag @10 kg | @15 kg |
| :--- | ---: | ---: | ---: |
| no ribs | 1540 | 7.7 mm | 11.6 mm |
| ribs | 3501 | 3.4 mm | 5.1 mm |

2.3× stiffer for ~64 g. Those figures assume line support along both edges, so
the real plate — supported at six points — does a little worse; treat them as
the optimistic bound. PLA also creeps under sustained load, so a UPS parked
there will settle further than day one.

Ribs go on the plate's OUTER face and therefore only on the bottom plate: the
top plate is the same part turned over, and ribs would stand proud of the rack.
With ribs on, the two plates are different printed parts.

## Cable notches

Pass-throughs for power and cabling, cut into the **rear edge** of the top
and/or bottom plate. Count, width and depth are all configurable; width is
clamped so N notches plus the walls between them actually fit the plate.

Two things worth knowing:

- **It costs the shared plate.** The top plate is the bottom one turned over,
  and that flip maps the rear edge to the front, so a rear-only notch cannot be
  shared. With notches on you print two different plates. The cuts are made in
  ASSEMBLY space for exactly this reason — after the flip, so each notch lands
  at the back of whichever plate carries it.
- **The deck keeps solid material around each notch.** The walls between
  notches otherwise land wherever the lattice happens to be open and come away
  as detached fingers — eight notches at minimum spacing split the plate into
  *nine* separate bodies before `notchKeepOut()` fed their footprints into the
  lattice's keep-out list.

**Full-depth shelves get the same notches.** A full shelf runs right to the
rack's back face, so its deck blocks the vertical cable run the plate notches
exist to open; a shorter shelf leaves that run clear behind it and gets
nothing. Both are cut from one shared `cableNotchGeometry()`, so a cable
dropping through a shelf lands on the opening below rather than beside it.
The shelf's deck keeps solid material around each notch for the same reason
the plates do.

Slots are rounded at their inner end: a square inside corner is where a loaded
plate starts a crack, and a cable dragged over a sharp edge eventually shorts.

## Usable space on an accessory

Slots are a mounting pitch, not usable space. `accessorySpaces()` reports the
box a device can actually occupy on each shelf or tray, and the panel shows it
per accessory:

- **Height** — from the deck's TOP face to the underside of what is above. The
  deck takes its own thickness off the bottom (3 mm shelf, 4 mm tray), so a
  3-slot shelf is 46.5 mm of room, not 49.5.
- **Only decked accessories form a ceiling.** A blank or keystone faceplate
  above is 4 mm of plate at the very front and blocks nothing behind it —
  measured against the compiled geometry, a 3-slot shelf under a blank has the
  full 79.5 mm run up to the next shelf. Counting faceplates as a ceiling
  under-reported it as 46.5.
- **Width is between the end ribs**, ~197 mm at sample size, not the rack's
  252 mm outside width.

The slot cursor mirrors `buildRackNodes` exactly, overflow clamp included —
computed any other way the figure drifts away from the geometry it describes.
`rack.spec.ts` checks each reported height against a column raised off the
deck in the compiled model.

## Front recess

Accessories mount 12 mm (`FRONT_RECESS`) behind the sides' front faces and span
BETWEEN the sides (plate width = W − 2×15 − clearance), so the front columns
stand proud and protect cables — the original's signature feature. Side screw
column sits at y=22 (accessory-local hole at 10); rear column at y=100
(accessory-local 88). Tie-wrap holes run along the top/bottom rails.

## Wall mount + strength

Three styles (all optional, per project):

1. **Screw-through rear ears** — ears integral to the side panels (in the panel's
   print plane, so load is carried along layers, not across them), gusseted,
   2 screws per side; screw count scales with slot count. Load path goes straight
   from the structural sides into the wall.
2. **French cleat** — printed wall cleat strip + bottom spacer. The hook is the
   full-depth block at each side's rear-top; the rear band below is relieved by
   the cleat's thickness. NOTE: the strips are a 12 mm standoff plane by
   geometric necessity — a wall strip that protrudes cannot coexist with a
   flush back below the seat (it would collide during the slide-down).
3. **Keyhole hangers** — the FLUSH option: two keyholes per side cut into the
   rear faces drop over #8/4 mm pan-head wall screws. No extra printed parts.

Strength package when wall mount is enabled: solid (non-vented, non-pocketed)
rear band on the sides, and UI guidance (studs/anchors, screw spec).
No fake FEA — design rules + clear guidance only.

## Implementation status

New project type ("rack") alongside board cases: `src/engine/compiler/rack.ts`,
types in `src/types/rack.ts`, Zod in `src/library/schema.ts` (schema strips unknown
keys — every new field must be added), UI panel + welcome entry, per-part STL export.
