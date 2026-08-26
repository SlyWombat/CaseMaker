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
| Top/bottom ×2 | 222 × 250 × 15 | 5 mm plate + 5 mm lip + 10 mm snap tabs (z levels −10/−5/0/5). 222 = 252 − 2×15. See **Plate joint** below — the lip/tab is a hook that clips under a ledge, not a lap |
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

The top and bottom plates seat in **blind rebates** cut into the side panels'
top and bottom rails, and are snapped in by **two-jaw darts**.

Measured from `samples/Rack/miniracktoporbottom.obj`, the original's plate is a
5 mm deck (z 0..5) with a lip hanging 5 mm below it set 5 mm in from each long
edge, which then widens back out to the plate edge for a further 5 mm — an
undercut barb that clips under a ledge on the side panel. The four z levels the
table above records (−10/−5/0/5) are that hook. Our first cut of this
reproduced the *tab* and lost the *hook*: it cut the seat pocket the plate's
full thickness at z = FOOT_H and z = H_TOP − PLATE_T, so both pockets broke out
through the side body's bottom and top faces. The plates were located fore/aft
and free in z — on the first printed set the top plate lifted straight off and
the bottom plate dropped out.

What replaced it:

- **Seat in the plate's inner 3 mm only**, never its full 5 mm, so the rebate
  keeps solid material on its outboard z face at both ends of the rack.
- **Seats sit over the stacking feet** (y centres at 19 and depth − 19, plus a
  mid seat past 180 mm depth), so the bottom rebate's floor has the full foot
  depth under it. Both rebates sit wholly inside the top/bottom rails, which
  are solid the full depth.
- **Two-jaw darts** at each seat: the jaws lie *in* the plate's print plane so
  they flex along the layers, and they squeeze toward each other into the
  dart's own central slot — the side panel never has to provide deflection
  clearance, which is what lets the rebate stay tight. Each jaw carries a barb
  that ramps in and returns square into a detent at the blind end of the
  rebate.
- **The rebate is the seat outline grown by `SEAT_SLACK`**, generated from the
  same `plateSeats()` profile, so fit clearance cannot drift from the shape it
  is meant to clear.
- **One printed plate, installed twice** — the top is the same part turned
  over. Every y feature is symmetric about depth/2 and the barbs are on both
  jaw faces, so the flip lands on the same rebates. `buildRackNodes` emits
  `rack-top` as `rotate([180,0,0])` of `rack-bottom`'s op.

Assembly is plate-then-sides: the rebates are blind, so the signature front
column stays uncut and the plates are not removable from a standing rack.

`tests/unit/rack.spec.ts` pins all of this by nudging an assembled plate ±1 mm
in z, 3 mm in y, and pulling a side 0.6 mm outward, asserting each move
collides.

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
