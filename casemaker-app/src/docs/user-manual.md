# User Manual

Every panel, every parameter, every export option. For a quick start, see [Getting Started](getting-started.md).

## Workflow at a glance

1. Pick a **board** in the board picker — 29 built-in profiles (Raspberry Pi,
   Arduino, ESP32 devkits, touch panels, QuinLED, sensors, cameras, …), plus
   boards you import or enable from online sources. Boards marked **★** apply
   a curated quickstart recipe; otherwise you get a blank parametric shell.
2. Adjust **case parameters** until the geometry suits your print and assembly.
3. Toggle individual **port cutouts** if you don't need them all.
4. Select a **joint type** for the lid (flat / snap-fit / screw-down).
5. Optionally turn on **ventilation** for thermal designs.
6. **Export** STL or 3MF and slice for printing.

## Board library & sources

The picker's catalog merges three source tiers, resolved in priority order:

- **Built-in** — 29 profiles bundled with the app, each schema-validated with
  a manufacturer source URL.
- **My library** — profiles you imported (**Import board JSON**) or saved
  from the Board editor's **Save to library**. Stored in this browser;
  **Export JSON** from the detail rail to share one.
- **Online sources** — any URL serving a board index (a JSON array or
  `{name, boards, templates}`), managed under **Sources**. The official
  community library is offered one click away; sources cache locally so the
  picker works offline, refresh weekly in the background, and can be
  disabled or removed at any time. Boards with a **✓ printed** badge have
  been physically verified to fit by a library maintainer.

> **No fit guarantee:** profiles are measured by humans and printers vary —
> treat the first print of any case as a test article and check critical
> dimensions against your real board first. The **✓ printed** badge means at
> least one confirmed fit, not a promise for your hardware.

If two sources provide the same board id, the higher tier wins and the
Sources panel shows what's shadowed. Projects embed a full copy of their
board profile, so a saved project opens fine on a machine without the board
installed. To contribute a profile to the community library, follow
[casemaker-library's AGENT.md](https://github.com/SlyWombat/casemaker-library/blob/main/AGENT.md) —
Claude Code can drive the whole flow, from measuring to the pull request.

The case rebuilds in real time — every slider, every toggle, every dropdown triggers a Manifold CSG rebuild on a worker thread. Slider drags debounce to 200ms; everything else is instant.

## Parameter dictionary

All dimensions in **millimeters**. Coordinate frame is **Z-up**; the PCB sits at world origin offset by `wallThickness + internalClearance` on X/Y and `floorThickness` on Z.

### Case parameters (the **Case Parameters** panel)

| Parameter | Default | Range | Description |
| :--- | :--- | :--- | :--- |
| `wallThickness` | 2.0 mm | 1–6 | Outer-wall thickness on all four sides |
| `floorThickness` | 2.0 mm | 1–6 | Bottom-floor thickness |
| `lidThickness` | 2.0 mm | 1–6 | Top-lid thickness |
| `internalClearance` | 0.5 mm | 0–3 | Gap between PCB edge and inner cavity wall |
| `zClearance` | 5.0 mm | 0–50 | Headroom above the PCB top — bump for HATs/heatsinks |
| `joint` | `flat-lid` | enum | One of `flat-lid`, `snap-fit`, `sliding`, `screw-down` |
| `bosses.enabled` | `true` | bool | Whether to generate mounting bosses at the board's hole positions |
| `bosses.insertType` | `self-tap` | enum | `self-tap`, `heat-set-m2.5`, `heat-set-m3`, `pass-through` |
| `bosses.outerDiameter` | 5.0 mm | — | Outer diameter of each boss; auto-grows to keep ≥1 mm wall around the hole |
| `bosses.holeDiameter` | 2.5 mm | — | Pilot hole diameter; **ignored for heat-set inserts** (forced to spec) |
| `ventilation.enabled` | `false` | bool | Cut vent holes through the +y wall |
| `ventilation.pattern` | `slots` | enum | `slots` (vertical) or `hex` (triangular grid) |
| `ventilation.coverage` | 0 | 0–1 | Fraction of available wall area used by the pattern |

### Board parameters (the **Board editor** panel, custom boards only)

| Parameter | Description |
| :--- | :--- |
| `pcb.size.x/y/z` | Bounding box of the PCB in mm; `z` is PCB thickness (typically 1.6) |
| `mountingHoles[]` | Each hole: `{ x, y, diameter }` in PCB-local mm |
| `components[]` | Each component: kind (USB-C, HDMI, …), facing wall, AABB position + size |

> **Note:** Built-in board profiles are read-only. Click **Clone & edit** to create an editable custom copy.

### App settings (the **App settings** panel)

| Setting | Default | Description |
| :--- | :--- | :--- |
| `port` | 8000 | TCP port for the embedded HTTP server (1024–65535). Desktop builds restart-required. |
| `bindToAll` | `false` | If true, the embedded server binds to `0.0.0.0` instead of `127.0.0.1`. Allows LAN access. |

## Joint types

### `flat-lid`

The lid is a flat plate the same X/Y size as the case rim. It rests on top with a 2 mm visual lift. Use this when the lid will be permanently glued or when you don't need a re-openable case.

### `snap-fit`

The lid has a downward-facing lip ring that drops inside the case cavity with a 0.2 mm friction fit. Lip depth is 4 mm, lip wall thickness ≈ `wallThickness − 0.6 mm`.

> **Note:** The default friction is **first-pass and unprinted**. See [issue #2](https://github.com/SlyWombat/case-maker/issues/2). Reduce to 0.15 mm if your lid drops in too easily; raise to 0.25 mm if it won't seat.

### `sliding`

The lid is Y-inset by 4 mm so it slides between two horizontal rails on the inner +y/-y walls. Suitable for cases that need to be re-opened often without screw hardware.

### `screw-down`

The mounting bosses extend to the full inner-cavity height (touching the lid). The lid plate has 4 corner holes whose diameter matches the chosen insert variant:

| Insert | Hole diameter | Lid clearance hole |
| :--- | :--- | :--- |
| `self-tap` | 2.5 mm | 2.9 mm |
| `heat-set-m2.5` | 3.6 mm | 2.9 mm |
| `heat-set-m3` | 4.2 mm | 3.4 mm |
| `pass-through` | 3.2 mm | 3.4 mm |

For heat-set inserts, drop the brass insert into the boss with a soldering iron at 220°C before driving the screw.

## Port cutouts

Side-facing components on the loaded board (USB-C, HDMI, RJ-45, etc.) automatically generate port cutouts. The **Port cutouts** panel lets you disable individual ports if your build won't use them — for example, an RJ-45 that's blocked by a hat.

A port's cutout box inflates by `cutoutMargin` (default 0.5 mm) on the perpendicular axes and pierces the wall on the facing axis. Edit the per-component margin in the custom-board component editor.

## External assets (STL / 3MF import)

The **External assets** panel imports binary STL, ASCII STL, or 3MF meshes. Per asset, you choose visibility:

- **`reference`** — translucent gold render in the scene; not part of the case CSG. Use for fitment checks.
- **`subtract`** — boolean-subtracted from the shell. Use for custom cutouts (a fan grille, a logo).
- **`union`** — boolean-added to the shell. Use for stiffeners or extensions.

Mesh data is base64-stored inside the project file (`.caseproj.json`), so saved projects round-trip cleanly.

## Export

Three formats:

| Format | When to use |
| :--- | :--- |
| **STL (binary)** | Default for slicers — smallest file size, fastest to write. |
| **STL (ASCII)** | Human-readable; useful for diffs and source-control inspection. |
| **3MF** | Modern open format, supports units (mm), required by some slicers. |

> **Note:** Always **press Export, not browser-Save** — the on-screen mesh isn't directly the export. Triggering Export forces a flush + rebuild + worker call.

## Save / load projects

- **Save** writes a `.caseproj.json` file containing the entire parametric model (board profile copy, case params, ports, external assets). The schema is versioned (`schemaVersion: 1`) and validated on load.
- **Load** picks any `.caseproj.json` and restores the project. Out-of-date schemas are rejected with a clear error.

## Undo / redo

50-state history (project-state only — UI selection is excluded). Shortcuts:

- `Ctrl+Z` — undo
- `Ctrl+Shift+Z` or `Ctrl+Y` — redo
- Suppressed when typing in inputs / textareas

## Coordinate system

Z is up. PCB origin is at world `(wallThickness + internalClearance, wallThickness + internalClearance, floorThickness)`. The case spans:

- **X:** 0 → `pcb.x + 2·(wall + clearance)`
- **Y:** 0 → `pcb.y + 2·(wall + clearance)`
- **Z:** 0 → `floor + pcb.z + zClearance`

The lid sits on top with a 2 mm visual lift. Slicers ingest the model exactly as exported — no rotation needed.

## Tolerance comparison reference

> **Note:** These are starting points. Print one test cube and measure with calipers before committing.

| Feature | Loose fit (FDM, 0.4mm nozzle) | Tight fit |
| :--- | :--- | :--- |
| Snap-fit lip-to-cavity | 0.4 mm | 0.2 mm |
| Pass-through screw clearance | 0.5 mm above thread OD | 0.2 mm above thread OD |
| Heat-set insert pocket | spec dia (3.6 / 4.2 mm) | spec dia − 0.1 mm |
| PCB-edge to inner wall | 1.0 mm | 0.5 mm |

## Slicer guidance

- **Print orientation:** lay the case open-side-up so the floor and bosses print on the bed without supports. The lid prints flat-side-down separately.
- **Layer height:** 0.2 mm works for the default geometry; drop to 0.12 mm if your snap-fit lip needs better dimensional accuracy.
- **Walls:** at least 3 perimeters for snap-fit lids — the lip flexes under load.
- **Infill:** 15% gyroid is plenty for an enclosure; raise to 30% if you'll be plugging cables in/out frequently. Racks are a different load case — see below.

### Racks — a different load case

Everything above is written for an **enclosure**: a small box that sits on a desk
and carries nothing but itself. A rack carries 5–10 kg of equipment, so the
settings change. Print racks in **PETG**, not PLA — about 25 °C more heat
headroom (Tg ≈ 80–85 °C against 55–60) and far better creep resistance under
sustained load. It is roughly half the stiffness of PLA (E ≈ 2.0 GPa against
≈ 3.5); the rib geometry is already designed for the lower modulus.

**Infill pattern: gyroid.** Not because it wins a benchmark, but because it has
no self-crossings (no nozzle collision, no over-extruded ridge where lines
meet), it extrudes as continuous curves, and it is near-isotropic. That last
point is the one that matters: every rack part is loaded differently — side
panels in bending, the plate tabs in shear across layers, the wall-mount ears in
tension — and one profile prints all of them. Grid and triangles are stronger
*along* their line direction and weaker across it, which is only worth having if
you can align the pattern per part. **Cubic** is a fine faster substitute.

**Infill percent, by part:**

| Part | Infill | Why |
| :--- | :--- | :--- |
| Side panels (250 × 275 × 20) | 40% | The only parts thick enough for infill to dominate mass and time. The M5 bosses live here and the whole load path runs through them. |
| Bottom plate (5 mm + floor ribs) | 30–40% | ~25 layers at 0.2 mm, ~15 of them sparse. The infill's job is shear-coupling the two skins so the plate acts as one section — it is not carrying the bending itself. |
| Shelf decks (3 mm + upstand ribs) | 30–40% | ~15 layers total, ~5 sparse. Almost pure skin and rib; the percent barely moves the mass, so pick 40 and stop thinking about it. |
| One-piece fused export (1.09–1.58 kg) | 25% | Here 40% against 25% is hours and hundreds of grams. The skins still do the work, so this is a budget decision, not a strength one. |

Do not go above ~50%. Past that you are adding mass and print time to a region
that is not carrying load, and you start fighting over-extrusion where the
infill meets the perimeter.

**The settings that matter more than infill:**

- **Perimeters: 4–5.** Every loaded section in a rack is a thin-walled beam and
  the perimeters are its flanges. Going 2 → 4 walls does more for a shelf than
  15% → 50% infill does.
- **Top/bottom solid layers: 5 / 5.** On a 3 mm deck this *is* most of the part.
- **Layer adhesion is where a rack actually fails**, not the infill. The
  wall-mount ears cantilever the whole loaded box and the plate tabs load in
  shear across layer lines. Run PETG at the hot end of its range and cut the fan
  on everything that is not an overhang. That buys more real strength than any
  infill change available to you.
- **Ensure vertical shell thickness: on** — it matters on the ribs and around
  the tab bores.
- Large flat PETG panels want a brim and no draft on the printer.

**Stay on a 0.4 mm nozzle.** A 1.5 kg part begs for 0.6, but the geometry blocks
it: the outboard wall of the plate tab bore is 1.8 mm, and the snap tabs and
keystone latch shoulders are finer still. Possible if you re-check every thin
wall in the slicer preview first; not a free win.
