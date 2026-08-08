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
| Top/bottom ×2 | 222 × 250 × 15 | 5 mm plate + 5 mm lip + 10 mm snap tabs (z levels −10/−5/0/5). 222 = 252 − 2×15 |
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
