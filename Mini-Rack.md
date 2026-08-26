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
| Top/bottom ×2 | 222 × 250 × 15 | 5 mm deck + four 8 mm corner tabs that sit in ledges in the side rails, screwed down with M5. 222 = 252 − 2×15. See **Plate joint** below |
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

Print the plate **outer face down**: the tabs are flush with that face, so the
whole underside is one flat plane on the bed. The head counterbores open
downward and their floors bridge, which slicers handle. Note this **inverts the
old print flip** — `rack-top` is now the part that needs turning over, not
`rack-bottom`.

Screw sizes (clearance, pilot, counterbore) are provisional pending
[issue #140](https://github.com/SlyWombat/CaseMaker/issues/140), which is
researching one repeatable screw-hole mechanism to replace the ~90 hand-rolled
hole sites across the compiler.

`tests/unit/rack.spec.ts` pins the seat, the fore/aft location, the
deliberate top-lifts / bottom-captured asymmetry, and the thread annulus at
all four screws.

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
