# Radxa Dragon Q8B — mechanical reference (profile `radxa-dragon-q8b`)

The built-in profile `casemaker-app/src/library/boards/radxa-dragon-q8b.json` is derived from
Radxa's own CAD for the Q8B, **v1.30**. The board on hand is the 8 GB model, label
**RS782-D8S32W0X110**, Rev **V1.306** — the same revision family (the DXF silkscreen reads
"Dragon Q8B V1.3"; the STEP assembly is `RS782_V13_20260523`).

## Sources (read 2026-10-23)

| What | URL |
|---|---|
| Product page / spec list (docs, CC BY 4.0) | https://docs.radxa.com/en/dragon/q8b |
| Interface callouts (names only, no coordinates) | https://docs.radxa.com/en/dragon/q8b/hardware-use/hardware-info |
| Downloads (Hardware Design, all V1.30) | https://docs.radxa.com/en/dragon/q8b/download |
| **2D dimensions drawing (PDF)** — the profile's source | https://dl.radxa.com/dragon/q8b/hw/radxa_dragon_q8b_2d_dimensions_v1.30.pdf |
| **2D DXF** (top + bottom, AC1009) | https://dl.radxa.com/dragon/q8b/hw/radxa_dragon_q8b_2d_dxf_v1.30.zip |
| **3D STEP** (assembly `RS782_V13_20260523`) | https://dl.radxa.com/dragon/q8b/hw/radxa_dragon_q8b_3d_stp_v1.30.zip |
| Component placement map | https://dl.radxa.com/dragon/q8b/hw/radxa_dragon_q8b_components_placement_map_v1.30.pdf |
| Product brief RAD-DOC-0188 v1.2 | https://dl.radxa.com/dragon/q8b/docs/rad-doc-0188_radxa_dragon_q8b_product_brief__1.2_g6b20932.pdf |
| Accessories (no heatsink, fan or case is offered) | https://docs.radxa.com/en/dragon/q8b/accessories |
| Schematic v1.30 | https://dl.radxa.com/dragon/q8b/hw/radxa_dragon_q8b_schematic_v1.30.pdf |

**Licence.** The docs pages are CC BY 4.0; the files on `dl.radxa.com` carry **no stated
licence**, so they are LINKED here and not vendored into the repo (same rule as
`src/docs/board-assets.md`). The one image in this folder is the maintainer's own photo (below).

## Coordinate frame (the profile's frame)

- Origin = PCB corner at the **3.5 mm jack / microSD** end. **X** along the 100.2 mm side, **Y**
  along the 74.2 mm side, **Z = 0 at the PCB bottom** (Case Maker convention; PCB top = 1.6).
- The I/O edge (jack … RJ45) is **y = 0, facing −y**. The 40-pin header and the two DP USB-C are on
  **y = 74.2 (+y)**; microSD and the EDL button on **x = 0 (−x)**; the power button on
  **x = 100.2 (+x)**.
- DXF/STEP native frame: PCB spans x 185.051..285.243, y −22.916..51.306; subtract
  (185.051, −22.916). STEP Z: PCB bottom = 0, top = 1.6.

## Board outline

- **100.2 × 74.2 × 1.6 mm** (drawing callouts; STEP solid 100.192 × 74.222 × 1.600). The label's
  "100 × 75" is nominal.
- Corners: arcs R ≈ 3.0–3.2 in the STEP PCB solid (3.04, 3.08, 3.20, 3.21); the DXF draws them as
  3.2 × 3.2 chords. **R3.2** is used.

## Mounting holes — 5 × Ø2.7 (drawing "5× Ø2.7"; STEP arc r = 1.351)

| id | x | y | note |
|---|---|---|---|
| h1 | 3.54 | 21.67 | 21.7 from the I/O edge (drawing) |
| h2 | 3.51 | 70.68 | Raspberry Pi pattern 58.0 × 49.0 with h1/h3 |
| h3 | 61.55 | 70.65 | |
| h4 | 96.68 | 70.65 | 93.2 from h2 (drawing) |
| h5 | 96.73 | 21.66 | |

Annular pads are Ø6.0 (DXF `PIN_TOP`), so a boss of OD ≤ 6 fits; Case Maker's default OD 5 is used.
Ø2.7 is M2.5 clearance.

Three further Ø2.7 holes are **M.2 standoffs, not case bosses** and are NOT listed as mounting
holes: (88.24, 26.41) E-key 2230; (91.25, 31.94) and (91.25, 55.77) M-key 2280.

## Heatsink screw pattern — 4 × Ø2.2 (drawing "4× Ø2.2"; STEP arc r = 1.1)

(23.55, 24.82), (55.55, 24.82), (23.55, 65.22), (55.55, 65.22) → **32.0 × 40.4**, pattern centre
**(39.55, 45.02)**, Ø4.5 pads. The SoC package U26 (20 × 17) is centred (39.48, 37.46); the
LPDDR4X packages UD1–UD4 (4 × 10.1 × 14.8) occupy x 14.45–64.51, y 47.44–62.24, which is why the
pattern is biased +7.6 mm in Y.

## Edge connectors — from the STEP (bodies relative to the PCB; Z relative to the PCB top)

**I/O edge, y = 0, facing −y** (order along +x; the maintainer's ruler photo agrees on the order):

| ref | part | x extent (width) | centre x | y overhang | z above PCB top |
|---|---|---|---|---|---|
| J2 | 3.5 mm jack "HP" | 3.30–9.60 (6.30) | 6.45 | 2.50 | −0.75..5.25 |
| J11 | USB-C 20 V PWR_IN (vertical) | 13.58–16.74 (3.16) | 15.16 | 2.81 | 0.11..9.05 |
| J10 | HDMI 2.1 A (vertical, edge-mount) | 21.07–28.96 (7.89) | 25.02 | 4.05 | −3.67..16.49 |
| J14 | 2× USB 2.0 A stacked (black) | 30.90–46.74 (15.84) | 38.82 | 3.51 | −3.21..15.55 |
| J13 | 2× USB 3.2 Gen2 A stacked (blue) | 48.00–63.84 (15.84) | 55.92 | 3.51 | −3.21..15.55 |
| J9 | RJ45 2.5GbE #1 | 64.89–81.18 (16.29) | 73.04 | 3.95 | −3.70..13.60 |
| J19 | RJ45 2.5GbE #2 | 82.58–98.87 (16.29) | 90.73 | 3.95 | −3.70..13.60 |

Body gaps along the edge: 3.98 / 4.33 / 1.94 / 1.26 / 1.05 / 1.40 mm. With 0.5 mm cutout margins
the ribs between the two USB-A stacks and the two RJ45s would be 0.05–0.94 mm slivers, so the
profile merges those four cutouts into ONE custom opening (`io-cluster`, x 30.90–98.87, top 15.55
above the PCB top) — comment 3's own fallback, the `jetson-nano-b01` usb3-cluster pattern. The four
connector BODIES stay in the profile without a `facing` (drawn in the preview, no cutout), so the
picker still lists them and the rail still draws them in order. The HDMI and the cluster keep a
0.94 mm rib — two 0.4 mm lines, kept separate on purpose.

**Header edge, y = 74.2, facing +y:**

| ref | part | x extent | centre x | y overhang | z above PCB top |
|---|---|---|---|---|---|
| J8 | USB-C DP-Alt #1 | 71.30–80.24 (8.94) | 75.77 | 1.00 | 0..3.16 |
| J15 | USB-C DP-Alt #2 | 84.32–93.27 (8.94) | 88.80 | 1.00 | 0..3.16 |
| J1 | 40-pin header 2×20 | 7.12–57.92 (50.80) | 32.52 | −1.84..−0.76 (inside) | −2.0..7.5 |

Header pad columns x = 8.39 … 56.65 at 2.54 pitch; rows y = 69.63 / 72.17 (Pi-compatible against
the 58 × 49 holes).

**−x edge:** microSD "TF" on the **underside**, body x 0.47–11.92 × y 4.62–16.61, 1.45 mm tall
below the PCB bottom; the card inserts from −x (no card in the STEP — protrusion unknown, see
assumptions). EDL button K2 at y 62.12–66.72, cap 0.30 proud of the edge.
**+x edge:** power button K1 at y 61.72–66.32, 0.28 proud. 50-pin B2B J12 (internal, ≤ 3.5 tall)
and the PCIe FPC J7 on −x at y 39–53 (internal, ≤ 4.5).

Nothing protrudes past ±x by more than 0.30 mm; the largest overhang is HDMI's 4.05 mm on −y.

## Top-side, mid-board

- M.2 **E-key 2230** J18: 77.31–99.16 × 52.81–59.91, up to 8.52 above the PCB top; standoff at
  (88.24, 26.41). A fitted 2230 module lies x ≈ 77.2–99.2, y ≈ 26–55, top ≈ 8.0 + module
  components (assumed ≤ 2.5 → ≈ 10.5 above the PCB top — the profile's `m2-ekey-2230`).
- Fan header J6 (3-pin PWM 5V GND) at x 66.87–72.22, y 57.92–61.62, 4.5 tall.
- 3-pin power header J20 at x 10.64–18.26, y 18.05–20.59, 8.89 tall (inside the heatsink's
  assumed footprint).
- **The stock heatsink + fan is in NO vendor file.** The maintainer's photo shows it fitted (four
  screws into the pattern above; the fan hub carries the Radxa logo) — its envelope is an
  assumption, below.

## Underside

| part | footprint | below the PCB bottom |
|---|---|---|
| M.2 M-key connector A | 7.70–15.85 × 21.02–42.87 | 5.52 |
| M.2 M-key connector B | 7.65–15.80 × 44.84–66.69 | 5.52 |
| M-key standoff posts | (88.41–93.41, 29.44–34.44) and (88.36–93.36, 53.27–58.27) | seat at 4.20 |
| 2280 module envelopes (derived) | x ≈ 12–92.5, y 20.94–42.94 and 44.77–66.77 | 4.20 + 0.8 PCB + ≤ 2.5 components ≈ 7.5 |

The profile models the two 2280 envelopes as `m2-mkey-2280-a/b` (no `facing` — no cutout; hatched
in the picker); `defaultStandoffHeight: 8` pays for them (6.5 + 1.5 mm).

## Assumptions (measured nowhere — do not read these as vendor numbers)

Recorded here because the schema has no free-text notes field. **The bench's calipers replace
them.**

1. **Stock heatsink + fan envelope** (the profile's `heatsink-fan`, and therefore the lid height):
   a fin base **44 × 46 mm** centred on the screw-pattern centre (39.55, 45.02) → x 17.55–61.55,
   y 22.02–68.02 (0.34 mm clear of the 40-pin header); fins **12 mm** above the PCB top; a **40 ×
   40 × 10 mm** fan centred on the same hub on top of the fins → **fan top 22 mm above the PCB
   top**. `recommendedZClearance: 32` = fan top + a 10 mm intake plenum. Basis: the screw pattern,
   the SoC+RAM footprint, Radxa's FAN_SPECS-class fan sizes and the photo — **not a measurement**.
   The bench owes: footprint distances to each PCB edge, fin-top and fan-top heights, fan frame
   size and hub offset, airflow direction, fan-cable route to J6. **The header's usability depends
   on this**: if the real heatsink overhangs y > 68.36 the 40-pin header is inside the heatsink's
   shadow and the case cannot expose it.
2. **M.2 M-key drive class**: the standoff of 8 assumes ONE single-sided 2280 module per slot, no
   drive heatsink (envelope ≈ 7.5 below the PCB). A double-sided drive or a drive heatsink raises
   it; the profile's `defaultStandoffHeight` must rise with it (the compiler does not derive
   underside clearance).
3. **UFS module height**: not modelled — no module is fitted, and the vendor files do not give a
   fitted height. If one is added, its envelope goes here and into the profile.
4. **microSD card protrusion**: unknown (no card in the STEP). The profile uses the slot body
   (1.45 mm below the PCB bottom) with a 0.7 mm cutout margin, giving a small slot just under the
   PCB level; a card left in the board protrudes further and is not modelled.
5. **Buttons**: power = a finger/pen hole (margin 0.8), EDL = a pin hole (margin 0.3). Judgment
   calls, not measurements.
6. **Corner radius** R3.2: the drawing draws 3.2 × 3.2 chords, the STEP arcs are 3.04–3.21.
7. **USB-C power and HDMI are vertical (portrait) connectors**: their openings are 3.16 × 8.94 and
   7.89 × 16.49. If the picker's glyphs draw sideways for them, they should become `custom`.

## Thermal note

An 8cx Gen 3 with a 65 W PD supply is not a passive part: the profile assumes the stock heatsink +
fan is fitted, and the case carries an intake plenum over the fan (10 mm above the fan top) plus
exhaust vents on the ±x walls (the fins run parallel to the I/O edge, so hot air leaves toward
±x), clear of the microSD (left) and power button (right).

## Maintainer's ruler photo

`port-edge-ruler-2026-10-23.jpg` — the port edge against a cm ruler, 2026-10-23, by the
maintainer. Ruler zero is out of frame; the readings are relative (±1 mm, perspective may
foreshorten), so only the ORDER is used: jack ≈1.3–1.9, USB-C ≈2.4–2.9, HDMI ≈3.5–4.3, USB-A
black ≈4.6–6.0, USB-A blue ≈6.3–7.9, RJ45 #1 ≈8.0–9.7, RJ45 #2 ≈10.1–11.7 cm. The sum exceeds the
100 mm side, so at least one reading is off — the positions above come from the DXF/STEP, never
from this table. The photo also shows **two RJ45s** (the label mentions one) and the fitted
heatsink + fan.

## Bench still owed (issue #612, step 0)

Calipers on the fitted heatsink/fan, the microSD protrusion with a card in, the M.2 drive class,
and ruler photos of the +y and ±x edges as a sanity check. Then replace assumptions 1–2 with
measurements and re-run the board specs.
