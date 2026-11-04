# User Manual

What Case Maker makes, with a worked example for each, the main options, and the questions that
come up most. For a first run in ten minutes, see **Getting Started** instead.

## Install, files and export

Case Maker runs in a browser at **<https://electricrv.ca/casemaker>**, no install, or as a desktop
app you download and run — either way opens to the same welcome page. The desktop app adds
offline use and, on a machine with a CNC attached, direct control of the cut.

**Saving and loading.** **Save** writes a project file holding the whole parametric model — board,
case parameters, ports, external assets — or, for a CNC job, the stock, the cutter and every
operation. **Load** reopens one. A project opens fine on a machine that doesn't have the exact
board installed; it carries its own copy.

**Exporting.** Three formats, for the 3D capabilities (cases, racks, toolboxes):

| Format | When to use |
| :--- | :--- |
| **STL (ASCII)** | The default — human-readable, so a fresh export is something you can open and check, not just trust. |
| **STL (binary)** | Smaller and faster to write; switch to it once you're past checking exports by eye. |
| **3MF** | Carries units and, on a two-colour part, the extruder assignment — nothing to pair up by hand. |

Always use the app's own **Export**, not a browser save of the preview — Export forces a rebuild
first, so the file matches what's on screen. The CNC side exports a program (G-code) instead; see
**Cut it on the CNC** below.

**Settings.** The **App settings** panel covers the embedded server's port (desktop builds,
default **8000**) and whether it's reachable from other devices on the network, plus the default
export format and layout. A port change applies the next time the app starts, and the panel says
so while it's pending.

---

## Cases that fit the board

Pick a board and the shell grows around its ports, holes and standoffs.

### Worked example: a Raspberry Pi case

1. On the welcome page, click **Cases that fit the board**.
2. Search for a board — "rpi-4b" finds the Raspberry Pi 4B — and click its card. The detail panel
   shows its connectors, mounting holes and where its measurements came from.
3. Click **★ Create from quickstart**. The shell generates around the board's real geometry: wall
   around the PCB outline, bosses under the mounting holes, a cutout behind every connector that
   faces an outer wall.

   ![A board sitting in a case shell, with the shell's side wall cut away to show each connector lined up with its own cutout](img/board-port-cutouts.svg)
   *Port cutouts line up with the connectors behind them.*
4. In the sidebar, open **Case parameters** and drag **Wall thickness** — the shell rebuilds live
   as you move it, usually in under 100 ms.
5. Under **Port cutouts**, turn off anything you don't need — a header pin block hidden under a
   HAT, say.
6. Under **Case parameters → Joint type**, choose a joint for the lid:

   ![A case shell and its lid apart, with a close-up of a snap-fit lip dropping into the cavity wall](img/case-parts-joint.svg)
   *The snap-fit lid's lip drops inside the case wall.*

   - **Flat lid** — sits flat on top of the rim; easiest to print, no recess.
   - **Snap-fit** — cantilever barbs on the lid flex into a catch on the case wall; no fasteners.
   - **Screw-down** — the lid is fastened to the case via screws that engage corner bosses.
7. Open **Export** and choose a format. The file is upright, in millimetres, ready for a slicer —
   no rotation needed.

### Main options

All dimensions are in millimetres; the model is Z-up, with the board sitting at the wall-plus-
clearance offset from the origin.

| Parameter | Default | Range | What it does |
| :--- | :--- | :--- | :--- |
| Wall thickness | 2.0 mm | 1–6 | Outer-wall thickness on all four sides |
| Floor thickness | 2.0 mm | 1–6 | Bottom-floor thickness |
| Lid thickness | 2.0 mm | 1–6 | Top-lid thickness |
| Internal clearance | 2.0 mm | 0–5 | Gap between the board's edge and the inner cavity wall |
| Z-clearance | 5.0 mm | 0–50 | Headroom above the board — raise this for tall connectors or an add-on board |
| Joint type | Flat lid | — | Flat lid, Snap-fit, or Screw-down (see above) |
| Fit | tight | — | Printed clearance for snap interfaces and tabs: tight (as designed), standard (+0.10 mm) or loose (+0.25 mm). Print a fit coupon before trusting a grade on a new printer. |
| Mounting bosses | on | — | Posts at the board's hole positions, for self-tapping screws, heat-set inserts, or a plain pass-through hole |
| Ventilation | off | — | Vent slots or a hex grid cut through one wall |

**Board library.** The picker merges three sources: built-in profiles, boards you've imported or
saved yourself, and any online library you've added under **Sources**. Every card states its
origin, so an imported board is never mistaken for a built-in one. Profiles are measured by
people and printers vary — treat a first print as a test article and check the critical
dimensions against your own board.

**Magnet pockets and the nameplate.** The **Features** panel cuts pockets for disc magnets into
any face, held by glue, a press fit, or captured under a thin skin the print pauses for. A
**nameplate** is a separate magnetic plate carrying text, matched to pockets on the case so it
seats home on its own magnets. A clash with a port, a standoff or another feature is stated with
its size and location, and the panel offers the nearest clear spot — nothing moves until you
choose to.

**Stacking connector.** A printed key locks two cases together, one on top of the other, through a
dovetail socket on the walls you choose. A **registration ring** on the lid and a matching groove
on the floor square a stack with no key fitted yet; the key still does the holding. A base plate
can carry the same sockets, for a case that sits on something other than another case.

**Floor grid and dividers.** A grid of blind sockets in the floor takes drop-in dividers that
split the inside into bays — each divider is its own printed part, liftable later. The grid skips
sockets under the board or a standoff, with room to spare, and a divider that runs into something
is stated and offered a nearby line that clears it.

**External assets.** Import an STL or 3MF mesh and use it as a reference overlay, subtract it from
the shell (a custom cutout), or add it to the shell (a stiffener or extension).

### Cutting a 3D part from a model

Import the part as a **goal** (the **Surface a mesh** operation). The app reads the model before it
cuts it and tells you what it found:

- **What it recognised** — "6 pockets, 1 outer contour, 1 curved region". Flat faces become
  pockets, the outer edge becomes the contour, and sloped or curved surfaces become curved
  regions. If part of the model cannot be cut, the row says which part and why.
- **The cutters it chose**, in order, with an estimate for each and for the whole job. The largest
  flat that clears the stock cuts first, a smaller one takes what it cannot reach, a ball finishes
  the curves, and a V-bit breaks the edges — the fastest sequence that still reaches the part. You
  can pin a cutter if you want a particular one used; otherwise the choice is the app's.
- **How the passes are joined** — the cutter stays down between neighbouring passes and lifts only
  to travel to another region. The row states the rapids, hops and the share of the cycle spent in
  air, so a program that travels more than it cuts is visible before it runs.

The cut that frees the part from the stock always comes last, with tabs you cut by hand at the
end — the part is held throughout. If no freeing cut is posted, the row says "The part is not
freed" rather than leaving it to the machine.

When you generate, the simulation checks the result against the model. The **judged** line is the
verdict — "Matches the design", or the deepest cut and where it is, with the cells that cannot be
fairly judged (a wall's own cell, the shadow behind a wall, a deliberate edge break) set aside. The
**raw** line beside it is the same reading with nothing set aside. The **top-surface coverage** and
**whole-surface reach** are printed against the shop's pass line, so a part that leaves surface
standing is stated even when nothing was cut too deep.

### Common questions

**Why doesn't my board's connector line up with the cutout?** Profiles are measured, not
guaranteed — check the board's measurement source in the detail rail, and compare a critical
dimension against your real board before committing a print.

**The snap-fit lid won't click shut, or falls out too easily.** The default fit is a starting
point. Print a fit coupon, then choose standard or loose (looser drops in more easily) under
**Case parameters → Fit**.

**Can I reuse a board I've customised?** Yes — **Clone & edit** any built-in board to get an
editable copy, or **Export JSON** your own profile to share it.

---

## Racks sized to your gear

A snap-together rack, resized to fit the hardware going in it.

### Worked example: a 10″ U-mount rack

1. On the welcome page, click **Racks sized to your gear**, or enable the **Rack** panel from the
   sidebar on an existing project.
2. Under **Rack family**, choose **10″ U-mount — 44.45 mm per U** to build to the standard rack-gear
   pitch, or **Printed-shelf — 16.5 mm side-column pitch** for a smaller, fully custom rack.

   ![A rack's rear rail, front-on, showing the two columns of mounting holes on a fixed pitch and a blank panel slotted into one slot height](img/rack-u-rails.svg)
   *The rail's hole pitch sets where every panel mounts.*
3. Set the rack's size. U-mount has **Rack units** (1–12 U) and **Depth** — its width is fixed at
   236.525 mm, the standard's own hole spacing, so ecosystem gear always fits. Printed-shelf has
   **Width**, **Depth** and **Height** (in slots) instead, each free to size.
4. Set **Mounting**: freestanding, wall — screw ears, or wall — french cleat.
5. Export. The **assembled export** toggle (shown only when the whole rack fits your selected
   printer) switches between one fused part and the rack's separate panels.

### Main options

- **Rack family** picks the pitch everything else is built to: U-mount's 44.45 mm standard, or the
  printed-shelf's 16.5 mm side-column pitch.
- **Rack units / Depth** (U-mount) or **Width / Depth / Height** (printed-shelf) set the size; a
  printer-fit banner and an **N/M slots used** line tell you what the current size actually holds
  and whether your printer can build it.
- **Mounting** switches between freestanding and the two wall-mounted modes; wall modes thicken the
  sides' rear band for the added load.

### Common questions

**What should I print a rack in?** PETG, not hardwood or PLA — a rack carries real load (5–10 kg
of gear) and needs more heat resistance and creep resistance than an enclosure does. Use a gyroid
or cubic infill (near-isotropic, so it doesn't matter which part is loaded which way): 40% for the
side panels that carry the mounting bosses, 30–40% for the bottom plate and shelf decks, 25% for a
one-piece fused export. Run 4–5 perimeters — a rack's thin sections are beams, and the perimeters
are their flanges — and don't skimp on layer adhesion: it's where a loaded rack actually fails,
more than the infill percentage ever will.

**Why won't my rack fit on my printer?** Watch the printer-fit banner and the **N/M slots used**
line as you adjust the size — they state directly whether the current rack fits your selected
printer's bed, before you commit to a print.

---

## Toolboxes that stack

Bins and lids that register on each other with no connector, and inserts pocketed to your own
tools.

### Worked example: a toolbox with dividers

1. On the welcome page, click **Toolboxes that stack**, or enable the **Toolbox** panel from the
   sidebar.
2. Set the **Footprint** (width and depth) and the **Module height** — the bin and its lid resize
   together.
3. Turn on **Floor grid** if you want the floor divided into a grid rather than left open.
4. Add **Dividers** to split the bin into bays sized to your own tools — a socket set, a
   screwdriver, a wrench. Each divider is its own printed part.

   ![A toolbox bin with its lid above it and dividers inside the bin forming pockets of different sizes](img/toolbox-bin-dividers.svg)
   *The bin's dividers pocket it to whatever you're storing.*
5. Export. The bin, the lid, and each divider export as separate parts — they print without
   supports and assemble by registering on each other, no connector needed.

### Main options

- **Footprint** (width and depth) and **Module height** set the bin and lid's overall size; both
  resize together.
- **Floor grid** divides the floor into a grid instead of leaving it open.
- **Dividers** are added one at a time, each its own part, sized to split the bin into bays for
  your own tools.

### Common questions

**Do the bins need a clip or a catch to stay stacked?** No — the parts register on each other by
their own geometry. Nothing fastens them; lifting the top one off is a plain lift.

**Can I size a toolbox for a specific set of tools?** Yes — add a divider per tool or group of
tools; there's no fixed layout.

---

## Cut it on the CNC

Carve hardwood on the CNC — a name plate, a coaster, a pocket, an engraving.

> The CNC side is withheld on the public site unless the address carries `?BETA=yes`
> (`https://electricrv.ca/casemaker/?BETA=yes`) — dev builds and the desktop build show it without
> the switch. The switch does not let a browser reach a machine; only the desktop build can.

### Worked example: a first cutting job

1. On the welcome page, click **Cut it on the CNC**. This opens a four-step wizard: **Machine**,
   **What are you cutting?**, **Stock**, **Holding**.
2. On **Machine**, pick a connected machine or continue without one.
3. On **What are you cutting?**, pick an operation — or, with nothing picked, move on: a fresh job
   already carries three lines of engraved text on a 100 × 60 × 12 mm hardwood block, ready to cut
   with no setup at all. A few quick starters are also offered here — **Name badge**, **Bare
   blank**, **Name on a dowel** — each a different starting recipe.
4. On **Stock**, the blank is proposed from whatever you're cutting; adjust its material, form or
   size if the proposal isn't what you want.
5. On **Holding**, check how the stock is held, then press **Create the job**.
6. In the Job panel, click **Generate**. The app plans the toolpath, checks it against the stock
   and the holding, then runs a simulated pass so you can watch it sweep across the block before
   anything real happens.
7. Once it's checked out, the job is ready to post as a program for a CNC machine — the CNC
   equivalent of the **Export** button on the other three capabilities.

### Main options

**Stock and cutter.** Every job states a stock block (material, width, length, thickness) and a
cutter. Hardwood is the default material; picking a different one adjusts the feeds the app plans
for it.

**Work origin and holding.** A job's zero point sits at a known corner of the stock, and the
holding (a vise, by default) is shown alongside it, so what the app plans matches where the
material actually sits on the machine.

![A block of stock held in a vise, with the work-origin corner marked and arrows naming the X, Y and Z axes from that corner](img/cnc-work-origin-holding.svg)
*Work origin and holding: where zero is, and what's holding the stock.*

**Simulating.** Generate always runs a full simulated pass before a job is considered ready — a
pass that doesn't match the design, or that the chosen cutter can't physically reach, is refused
rather than silently produced.

### Exporting from FreeCAD

A part modelled in FreeCAD imports cleanly if it's exported the right way:

![A simple flow diagram: a FreeCAD model, an arrow to STEP for a 3D part to carve or DXF for a flat profile, both arriving at Case Maker](img/freecad-export-path.svg)
*FreeCAD's two export paths: STEP for a 3D part, DXF for a flat one.*

- **A 3D part to carve** — export **STEP**: select the Body or Part, then *File → Export → STEP*.
  One solid per file; union an assembly into a single solid first. If STEP isn't available, 3MF is
  the fallback — it carries millimetres correctly. Only use STL or OBJ when the mesh is fine
  enough to hold the detail you need (roughly 0.01 mm deviation or better); either format loses
  the exact surfaces STEP and 3MF keep.
- **A flat profile, pocket or engraving** — export **DXF**, in millimetres, with closed outlines.
  SVG works too, but check its pixel scale carries over correctly.
- **Before you export**, put the side you want cut facing +Z — or use **Lay it flat** or
  place-on-face after importing. Set your model's units to millimetres; Case Maker states the
  units it assumed on import, so check that line matches what you exported.

Most other CAD tools export the same two formats the same way: Fusion 360 and SolidWorks both
offer STEP directly from their export menu for 3D parts, and DXF for sketches; Inkscape exports
DXF for flat vector work if you set its document units to millimetres first.

### Common questions

**Why was my Generate refused?** The app checks the planned cut against the stock, the cutter's
reach and the holding before it will call a job ready — the message names which of those it
failed. A goal the engine cannot plan is stated as such, with the reason; there is no resolution
to trade away.

**My imported part looks right but won't carve correctly — why?** Check that the side you want
cut is facing +Z, and that the unit Case Maker reports on import matches what you actually
exported — a model exported in inches read as millimetres is 25× too large.

---

## Coordinate system and undo

Every capability shares the same ground rules once you're past the welcome page.

**Coordinate system.** Z is always up. For the 3D capabilities, the model's origin sits at one
corner, with the part spanning positive X, Y and Z from there — what you see on screen is exactly
what exports, with no rotation needed for a slicer. For a CNC job, the work origin is a stated
corner of the stock, shown alongside the holding that's meant to match it.

**Undo and redo.** `Ctrl+Z` undoes, `Ctrl+Shift+Z` (or `Ctrl+Y`) redoes, with a deep history of
project changes — UI selection itself isn't part of it. Both are suppressed while you're typing in
a text field.

**Tolerances.** Every printed fit in this manual — snap-fit, screw clearance, heat-set inserts,
divider pockets — is a starting point, not a guarantee. Print one test piece and measure it with
callipers before committing a full build; the fit grade (tight, standard, loose) in each panel is
there so you don't have to redesign anything to try a looser one.
