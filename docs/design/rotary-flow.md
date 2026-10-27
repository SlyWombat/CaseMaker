# Rotary jobs — the target flow (design v1, 2026-10-26)

*The screens an operator meets for a job held in the rotary chuck, from the door to the run. It extends
`first-job-flow.md` (the shipped first-job flow, #679) and follows its principles and vocabulary exactly; where
this document is silent, that one holds. The engine design is `/Rotary.md` (decisions R1–R12, classes W / I /
R). Mockups: `rotary-flow-mockups.html` beside this file, one station per screen, with the exact copy. Tracker:
#545 (the maintainer's two comments of 2026-10-26 are the plan this follows). Status: PROPOSED — no
implementation of the screens until the maintainer approves the flow and the mockups; the engine slices
already running (the evidence pass; R-3's data model and post) proceed in parallel.*

**Source rule.** Every option and default below names where it comes from: a `/Rotary.md` section, the Z1 wiki's
4th-axis page as read in `/Rotary.md` §1.4 (the capture itself is not on this machine's checkout — #626's sweep
found `docs/market-research/raw/` absent), the firmware's shipped config or Robot.cpp as read in `/Rotary.md`
§1.2, Studio's `RotationReliefPath.json` (§1.3), Makera CAM's user guide (§1.3, by line), the machine profile
(`engine/cnc/machine.ts`, the `Z1.rotary` block), this machine's config read (2026-10-07, B9), or the market
research (`/Rotary.md` §8). A value nobody has published is shown as a value with its provenance in the
Technical fold — "Makera's shipped value", "Case Maker's default", "not published — measured at the bench" —
never guessed silently. §9 lists the questions this design could not settle and the default it took for each.

## 1. Principles the screens are held to

**Inherited, unchanged:** first-job §1 items 1–8 — one flow and one numbering (the wizard is still "Step n of
4", Cut is still four lines); plain language first with the number behind a `Technical` fold; the house's
defaults; the blocker at the button; one vocabulary; units on every field and ≤ 3 decimals; nothing explained
twice; the machine's state is read, and every change to the machine has a wizard of its own.

**Added for the rotary:**

9. **A rotary job is a first-job job.** It is not a second wizard, a "4-axis project type" or a mode. The same
   four steps produce it; what makes it rotary is the stock (round, or squared) and the mount (the chuck), and
   both are answers the wizard already asks for. Makera CAM asks for a project type at launch (`/Rotary.md`
   §1.3, user guide l. 152); Vectric asks single-sided / double-sided / rotary at job setup (§8). We ask nothing
   new: the form and the mount decide.
10. **The rotary is on the pins, or the job is taken there.** The machine's state is read (principle 8). A rod
    held in the chuck needs the rotary on the pins; when the vise is there, Holding offers the chuck with its
    cost — `needs the rotary on the pins · Change the machine…` — and the change wizard (§3.5) fits it and
    returns. No rotary job is held in a mount the bed does not carry. With no machine record (the web build),
    the job can still be authored and simulated against the profile's rotary (⌀80 × 150 mm); the Hold line says
    so in one sentence (§3.8).
11. **The operator thinks on the surface.** Items are laid out on the map of the stock's surface, in mm at the
    surface — `along` the stock and `around` it — never in degrees of A (R10). Degrees appear on angle fields
    (the seam, a face's angle, an index) and on the A read-out, with `°` every time.
12. **Two pictures, one geometry.** The map (unrolled) is where items are placed; the rotating stock is where the
    program is watched (R11). Both draw the same opened regions from the same function, so a stroke that merges
    on one merges on the other.
13. **The run path waits for the bench, and says so once.** Until #238 records the module's numbers as
    measured, a rotary program can be authored, generated, verified, simulated, frozen and saved; the run path
    (upload, release, the one-screen Cut) refuses it with this sentence, at the Run line, and nowhere else:

    > **The rotary module has not been measured on this machine yet — this program can be checked and saved;
    > running it waits for the module's bench check.**

    It is the only rotary sentence that mentions the bench. Every other screen shows Makera's values as values,
    with their provenance in the Technical fold (`feedback_no_defensive_qualifiers_in_ui`).
14. **What the cutter cannot do on a round stock is refused by name, at the item.** The cutter stays over the
    axis (R1); it never cuts through the centre (R8); it never reaches the jaws or the tailstock. Each refusal is
    a sentence with the item and the fix (§3.7, §3.9), never a code.

## 2. The flow

```
 Welcome ─ [ Start a cutting job ]      starters: Name badge · Bare blank · Name on a dowel
   │
   ▼  NEW CUTTING JOB — one modal, "Step n of 4"
   1 Machine     "Makera Z1 ‘Zoomba’ · Online · Idle · homed"  · on the machine now: Vise on the pins       [Next]
   2 Stock       material · form: … Disc · Rod · Tube · ⌀ diameter · length X mm                          [Next]
                   └─ a rod longer than the vise holds on its end: "held in the rotary — step 3 offers it"
   3 Holding     ○ In the vise …   ◉ In the rotary chuck  — needs the rotary on the pins · Change the machine…
   │               └─ Change the machine (vise and wasteboard off → rotary on) ──▶ back to step 3, the chuck drawn
   │                  jaws (reverse) · grip 15 mm · stick-out 85 mm · tailstock in                             [Next]
   4 Operation   On the surface: Engrave text · V-carve · Pocket · Flute
   │             On a face:      Flat · Faces all round · Cross-hole
   │             3D:             Relief from a mesh (simulate only)        → the one field it needs     [Create the job]
   ▼  DESIGN
   │   the map: along × around, seam, the jaws and tailstock bands, the ruler · [ Map | Stock ] toggle
   │   the panel: Job (round stock, around = 62.832 mm) · Cutter (+ speed at the surface) · Hold (the chuck)
   │   Generate → ✓ generated · ✓ verified · ✓ simulated · ✓ matches the design
   │   SIMULATE: the stock turns under a still cutter · A in ° and turns · Unroll · the oracle on the map
   ▼  [ Cut ]
   CUT  1 Checked ✓ · 2 Frozen ✓ · 3 Register the stock ● (sides · top × 4 · end) · 4 Run
                                          until #238: Run carries the bench sentence (principle 13)
        the run sheet: mount the rotary · the stock in the chuck · the axis origin · speed at the surface
```

## 3. The screens

### 3.1 The door

Unchanged, except one starter job beside *Name badge* and *Bare blank*: **Name on a dowel** — a PLA rod
⌀20 × 100 mm, held in the rotary chuck, with `Engrave text` asking for the name. The size is #240's own
recommendation for the first rotary job ("a printed PLA cylinder ⌀20 × 100 with a centre hole for the
tailstock"); the material is the house's (`feedback_no_wood_pla_blank`). A starter is a declarative job spec
(`project_board_template_link`), so this is one JSON file, not a screen.

### 3.2 Step 1 of 4 — Machine

Unchanged. Two facts the step already reads matter more on a rotary job and are shown in its existing line:

```
 Step 1 of 4 · Machine                                                    [ Close ]
 Makera Z1 “Zoomba” · 192.168.10.43              ● Online · Idle · homed · checked 09:02
 On the machine now: Rotary on the pins · wasteboard off                    [ Check again ]
                                                                          [ Next: stock ]
```

- "On the machine now" is the active bed profile's line, as Holding prints it. When the rotary is on the pins
  the strip's DRO shows A beside X Y Z (#658: "A appears only when a rotary module is checked out").
- The wasteboard reads **off** with the rotary on: the module *"mounts on two 4 × 11 mm locating pins and three
  M5×10 screws, after removing the MDF wasteboard"* (`/Rotary.md` §1.4). The first-job mockup's change wizard
  writes "Rotary on the pins · wasteboard under" — that line is wrong for the rotary and §3.5 corrects it.

### 3.3 Step 2 of 4 — Stock (round stock)

```
 Step 2 of 4 · Stock                                                      [ Close ]
 Material   [ PLA ▾ ]
 Form       [■ Plate] [▮ Block] [▬ Sheet] [▤ Printed] [● Disc] [▬ Rod] [◎ Tube]
            Rod — round stock: a dowel, a rod. A rod up to 20 mm long stands on its end in the vise;
            a longer one is held in the rotary chuck and cut around (step 3 offers it).
 Size       diameter ⌀ [ 20 ] mm    length X [ 100 ] mm
            Around: 62.832 mm at the surface
 Shelf      On the shelf (1): ○ PLA rod ⌀20 × 100 mm ×3
                                                             [ Back ]   [ Next: holding ]
```

- **Round forms.** *Rod* (it covers a dowel — the operator's word for a wooden rod; the material says wood or
  PLA) and a new *Tube* (outer ⌀, wall, length X). Disc stays a face-job form. **Which form goes where** is
  decided by the numbers and stated under the picture, never by a separate question:

  | Form | The vise | The rotary chuck | Rule and source |
  |---|---|---|---|
  | Rod | stands on its end, cut on that end, when length X ≤ 20 mm | cut around, when ⌀ ≤ 80 and length ≤ 150 | the vise's floor depth `VISE_FLOOR_DEPTH` 20 mm (`stockStart.ts` `ROD_VISE_MAX_LENGTH_MM`, #683); the module's ⌀80 × 150 (`t_MachineType`, a Makera database figure) |
  | Tube | as a rod | cut around; the wall caps every depth | the column model's single-valued radius (R8) — a cut deeper than the wall would open the bore |
  | Block | held as today | **squared stock in the chuck** when it fits ⌀80 × 150 by its diagonal | Makera CAM's stock Shape: *Square or Round* (`/Rotary.md` §1.3, l. 1005); `rotaryFits` (`setups/plan.ts`) |
  | Disc | on its face, as today | not offered: a disc is cut on its face | a chuck gripping the rim leaves only the face, which the vise already gives |
  | Plate · Sheet · Printed | as today | not offered | flat stock; nothing to turn |

- **Size words for round stock:** `diameter ⌀ · length X`, `mm` on each; Tube adds `wall`. Under them, one
  derived line: **"Around: 62.832 mm at the surface"** — the circumference, because it is the map's height in
  §3.7 and the number the operator lays text against.
- A rod past 20 mm keeps today's sentence in the operator's words: *"A rod this long is held in the rotary — the
  vise holds one up to 20 mm tall standing on its end"* (`rodGripProblem`). The step does **not** block it any
  more once Holding can write the chuck (#697); it is the sentence under the picture, and Next goes on.
- Stock over ⌀80 or 150 mm long is the stock's own refusal at the size field: *"⌀90 mm does not fit the rotary's
  ⌀80 × 150 mm"* (`stock-exceeds-module`, `/Rotary.md` §6.4).
- **Faced first** does not apply (plastic is cut as it is; a round stock is not faced — `feedback_no_facing_on_plastic`;
  a wooden dowel's turning is out of scope).

### 3.4 Step 3 of 4 — Holding: in the rotary chuck

```
 Step 3 of 4 · Holding                                                    [ Close ]
 On the machine now   Rotary on the pins · wasteboard off                  [ Change the machine… ]
 How is the rod held?                           ┌ front view ─────────────────────────────────┐
 ○ In the vise, on its end                      │ chuck ▐▌jaws│═══════ rod ⌀20 ═══════│◁ tailstock │
     needs the vise on the pins · Change the…   │  grip 15 mm │←—— stick-out 85 mm ——→│  centre    │
 ◉ In the rotary chuck                          │  X 0 at the jaws ─────────────────▶ X           │
     the rod turns about X; the cutter stays    │            A turns the rod about X              │
     over it                                    └─────────────────────────────────────────────┘
   Jaws        ( reverse, inner teeth ▾ )   Makera's rule for ⌀20: standard under ⌀20, reverse inner 20–35, reverse outer over 35
   Grip        [ 15 ] mm in the jaws     Stick-out  85 mm
   Tailstock   ☑ in — drill a centre hole in the free end first
 ▸ Technical: the chuck and tailstock (Makera's figures and Case Maker's defaults) · the axis datum
                                                             [ Back ]   [ Next: operation ]
```

- **Opens on what is on the machine**, as today. With the rotary on the pins and a round stock that fits, *In the
  rotary chuck* is the default; with the vise on, it is shown with `needs the rotary on the pins · Change the
  machine…` (already built, `holdingMounts.ts`). Selecting it **writes the job** (`workholding: rotary-chuck`) —
  the answer #697 waits for; the "the job is held in the vise" sentence goes.
- **The four chuck answers**, each one line, each defaulted:
  - **Jaws** — `standard` / `reverse, inner teeth` / `reverse, outer teeth`. Default **from the diameter, by
    Makera's own rule** (the decompiled Studio, `/Rotary.md` §9 row 7, evidence pass 08ea46ff): under ⌀20 mm
    standard; ⌀20–35 mm reverse with the inner teeth; over ⌀35 mm reverse with the outer teeth. The wiki's
    *"reverse jaws fitted by default for larger work"* agrees. The chuck's physical clamping limits are still
    the bench's (§9 row 7); until then the size gate is the ⌀80 × 150 envelope.
  - **Grip** — how much of the stock is in the jaws, mm. Default **15 mm**, a Case Maker default (§9 Q3):
    Makera publishes no jaw depth. Typed over in place; the shelf entry can carry it.
  - **Stick-out** — derived, `length − grip`, shown not asked (`Workholding.rotary-chuck.stickout`).
  - **Tailstock** — in / out. Default **in**: Studio's rotary relief ships `haveTailTop: true` (`/Rotary.md`
    §1.3). The line carries the wiki's instruction as an action — *"drill a centre hole in the free end first"*
    (§1.4) — and on a Tube *"the centre seats in the bore"*.
- **The picture** is the front view (looking along Y at the X–Z plane the cutter lives in — the most useful
  rotary view, R11a): the chuck on the left with the jaws and the grip, the stock with its stick-out, the
  tailstock on the right, X from the jaws, and the A arrow round the stock. The chuck on the left is the wiki's
  *"zero point preset … at the centre of the right edge"* read as the chuck's right face (§9 Q5).
- **Technical fold** (provenance, one sentence each): envelope ⌀80 × 150 mm — Makera's figure; the jaws —
  Makera's rule by diameter (Studio); tailstock in — Makera's shipped value (Studio's rotary relief); grip 15 mm and the 3 mm
  keep-out from the jaws and 10 mm tailstock band — Case Maker's defaults until measured; the axis datum — as
  the change wizard left it ("shipped value ±0.5" or "measured 09:20").
- The orientation fold of the vise ("face up · against the fixed jaw · nearest you") does not apply: a round
  stock has one landmark question, **"which end is in the jaws"**, asked only when the stock has ends worth
  telling apart (a printed rod's layers, a tube's chamfer). Default: either end.

### 3.5 Change the machine → the rotary

The #693 wizard already fits the rotary (`machineChange.ts` `fitSteps('rotary')`). Its lines change to match the
wiki's fitting notes (`/Rotary.md` §1.4), which the built words miss: the wasteboard comes off, there are three
screws, and the 4th-axis cable is never plugged with the machine on.

```
 Change the machine · Vise off · rotary on                                  [ Close ]
 1 What changes      Vise on the pins → Rotary on the pins     for: Name on a dowel, held in the rotary chuck
 2 Make it safe      ● Home   $H · Idle · homed ✓   ● Work light on  M821 ✓   ● Spindle cold, cutter out ✓
 3 Take off the vise
                     ○ the left fixed jaw off  ○ the six M5 × 20 screws  ○ lift the vise straight up off the two pins  ○ on its shelf  [Done]
                     (the wasteboard is already off — the vise mounts on the bare bed too, #717)
 4 Fit the rotary    ○ the 4th-axis cable is never plugged in live
                     ○ onto the two pins   ○ the three M5 × 10 screws   ○ the 4th-axis cable, rear left
                     ○ switch the machine on                      ● waiting for it to answer… Online · Idle ✓
                     ○ chuck key in the tray                                                   [Done]
                     axis datum: Makera's shipped value · [ Measure now ] or [ use the shipped value ]
 5 Confirm           the bed is now: Rotary on the pins · wasteboard off
                     written to the machine's record: 2026-10-26 09:20 · vise → rotary · for Name on a dowel
                     ● Work light off · ● Home                                        [ Back to the job ]
```

- **Power is outside Case Maker** (#479, `feedback_power_is_outside_casemaker`): the wizard asks the operator to
  switch the machine off and on at its own switch, and answers with the machine's state when it comes back; it
  never drives a plug.
- **The axis datum.** With no reading on this machine, the line offers the module's preset: the wiki's *"4th-axis
  zero point is preset in the software"* (§1.4), which Studio carries as the rotary offsets
  (`coordinate.rotation_offset_x/y/z`: shipped 12.0 / 85.5 / 23.0, this machine's config −7.5 / 69.0 / 17.0 —
  `docs/bench/2026-10-bench-day-1.md:845`). "Measure now" is the registration's side-and-top touch (§3.10),
  not a nose tap: a touch from above on the chuck body is the axis plus an unmeasured radius (#626).
- **Home** at step 5 homes A as well when the module answers it — the shipped config gives A a homing switch
  (`home_to_min`, §1.2); whether `$H` includes A is §9 row 4, and the line reports what the machine says.

### 3.6 Step 4 of 4 — What are you cutting? (on a round stock)

```
 Step 4 of 4 · What are you cutting?                                      [ Close ]
 On the surface    [ Engrave text ] [ V-carve ] [ Pocket ] [ Flute ]
 On a face         [ Flat ] [ Faces all round ] [ Cross-hole ]
 3D                [ Relief from a mesh ]  simulate only
 ─────────────────────────────────────────────────────────────────────────────
 Engrave text:  Text [ Zoomba ]   Depth [ 0.5 ] mm   Font [ Inter ▾ ]   Reads [ along ▾ ] the rod
                                                             [ Back ]   [ Create the job ]
```

The groups are the classes of `/Rotary.md` §2, named for where the cut lands; the operation names are the
operations matrix's where one exists (first-job §4: an item is an *operation*).

| Group | Operation | What it does on a round stock | Class, engine | Source |
|---|---|---|---|---|
| On the surface | **Engrave text** | text on the map, cut at its depth below the surface; A and X interpolate on every stroke | W, column engine, flat end | `/Rotary.md` §2 (the dowel, #223's first job); R10 |
| | **V-carve** | the same on the map with a V-bit | W; **needs the V footprint in the rotary column engine** — today it sweeps a flat end only (`columnEngine.ts` `tool-refused`) | Studio's `AVRotationVReliefPath` (binary only, `/Makera-Parity.md` §2); V-carve on the flat (#674) |
| | **Pocket** | a region on the map to a floor depth; a band *all the way round* is the same pocket with a full-circumference height (and marks a saw line) | W, column engine | `/Rotary.md` §2 class W "text and shapes" |
| | **Flute** | a ramped line along X (a fluted column) or around | W, column engine | the flat Flute (#674); Vectric names fluting as rotary work (`/Rotary.md` §8) |
| On a face | **Flat** | turn to an angle, hold, cut a flat to a depth (a D-flat, a key face) | I, exact sweeper (R-4) | `/Rotary.md` §2 class I; Roland's "multiple-surface cutting" (§8) |
| | **Faces all round** | n flats evenly indexed: square, hex, octagon, by across-flats | I | `/Rotary.md` §2 ("hex sections"); `cnc-job-workflow.md` §5.4 "the rotary as the alternative" |
| | **Cross-hole** | turn to an angle, drill across (to a depth or through) | I, exact sweeper; a through hole crosses the centre, which the exact sweeper models and the column engine refuses | `/Rotary.md` §2 ("cross-drilling patterns") |
| 3D | **Relief from a mesh** | Z follows a mesh as A sweeps — Makera's Rotation Relief | R; the column engine simulates it while it stays above the axis and refuses the first move that crosses it (R8); **the run path refuses class R** in this design | Studio type 11 / Makera CAM Rotation Relief (`/Rotary.md` §1.3); R-5 not committed (R2) |

- **The face operations take the flat operations onto the face.** Once a Flat exists, `+ Add operation` on it
  offers the flat picker (Engrave text, Pocket, Hole) at that angle — an indexed job is flat work at an index
  (§4.6), so the flat screens are reused, not copied.
- **Cut-off is not an operation.** Makera offers none — Makera CAM's tabs are modelled by hand as cylinders or
  frusta and the tailstock flag only contains paths (`/Rotary.md` §1.3, l. 1009–1011, 1052–1075) — and a vertical
  end mill cannot part a rod off without cutting through the centre (R8). The part is sawn off after the run;
  a Pocket band all the way round marks where, and the run sheet says it (§3.11). §9 Q6.
- **Relief from a mesh is marked `simulate only`** — a fact tag, like `recommended`, not a disabled control: it
  can be authored, generated, verified, simulated and saved, and its Run line says *"Relief on the rotary is
  checked and simulated here; the machine does not run it."* (the maintainer's "class R gets its simulation
  planned … even though its cutting stays uncommitted", #545).
- **The one field each needs:** Engrave text — the text, and **Reads: along / around** (default **along**, like
  the lettering on a pencil — §9 Q4); V-carve — the shape or text; Pocket — nothing (the size comes in the
  panel); Flute — its length along; Flat — the angle `°` and the depth; Faces all round — the count and the
  across-flats `mm`; Cross-hole — the angle `°` and the diameter; Relief — the file.
- An operation the stock cannot take is not offered on it: on a rod in the vise (cut on its end) the picker is
  the flat one, unchanged.

### 3.7 Design — the map (authoring on the surface)

The engrave preview's stock is the map when the stock is round (`/Rotary.md` §5.3, `EngravePreview` row): the
existing flat scene with *around* for Y.

```
 ┌ the map ──────────────────────────── [ Map | Stock ] ─────────────── ⌀20 · around 62.832 mm ┐
 │ around ↑    0°   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ seam ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─         │
 │ 15.708 mm  90°  ▓▓│                                                     │░░░            │
 │ 31.416 mm 180°  ▓▓│            Z O O M B A   (0.5 mm, reads along)      │░░░            │
 │ 47.124 mm 270°  ▓▓│                                                     │░░░            │
 │ 62.832 mm 360°  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ seam ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─         │
 │                 jaws 0–3 mm                                      tailstock 75–85 mm       │
 │                 along → X  0      10      20      30      40      50      60      70  85  │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
   Seam [ 0 ]°   Reads [ along ▾ ]   the strip each side of the seam repeats 5 mm
```

- **Axes.** Horizontal: *along* (X, mm from the jaws). Vertical: *around*, a **ruler in mm at the surface**
  (s = R·θ, the map's height is the circumference) with the matching degrees beside it every quarter turn.
  Items are placed and dimensioned in mm on both axes (R10); a selected item's chip also reads its centre angle
  in `°`.
- **The seam** is a dashed line at the top and bottom edge — where the map's two edges meet on the stock, at A =
  the seam angle (default **0°**, where A homes: `home_to_min`, the shipped config, §1.2). An item may cross the
  seam: A is unwound (§1.1 item 3), so the cut is continuous; the map repeats a strip each side so the item is
  drawn whole (§5.1c). Moving the seam turns the map, not the items' place on the stock.
- **End bands.** The jaws' band at the left end (the grip plus the keep-out from the jaw face, 3 mm) and the
  tailstock's band at the right (10 mm while the tailstock is in) are hatched, with their provenance on hover
  (`Case Maker's default — not published`, or `measured`). An item that enters a band is refused at its row:
  *"“Zoomba” reaches 2 mm into the tailstock's band — move it 2 mm along, or take the tailstock out."*
  (`wrap-into-clamp`, §6.4).
- **Wrap direction** is the item's **Reads: along / around** (text and V-carve); shapes are drawn on the map and
  have none.
- **Map | Stock.** The toggle shows the same opened regions on the cylinder with the A-zero mark (R11, the
  "wrap view"); the opening uses the anisotropic radius `R · atan(r_t / (R − d))` around and `r_t` along in
  both (R10; `r_t · R / (R − d)` is its small-angle approximation), so the two cannot disagree. Default: **Map** while authoring.
- **Depth on a round stock** is the radius lost: a 0.5 mm engraving on ⌀20 leaves the floor at r = 9.5 mm.
  Depth over the tube's wall, or deep enough to reach the axis, is refused at the field (R8).

### 3.8 Design — the panel's rotary lines

The panel keeps its three groups (first-job §3.6); each gains its rotary lines. Nothing new is a group.

```
 ┌ Name on a dowel · saved 09:24 ▾                                      [ Design ] [  Cut  ] ┐
 ├ JOB ─────────────────────────────────────────────────────────────────────────── open ──┤
 │ Stock   rod ⌀20 × length 100 mm · PLA · around 62.832 mm                 ▸ edit        │
 │ Map     seam 0° · jaws 0–3 mm · tailstock 75–85 mm                         ▸ edit        │
 │ Items (1)                                                    [ + Add operation ▾ ]       │
 │   ▸ T  Engrave “Zoomba”   Engrave text · 0.5 mm · reads along · centred at 180°          │
 ├ CUTTER ──────────────────────────────────────────────────────────────────────── open ──┤
 │ ⌀ 1 mm flat end · 7 mm flute  [recommended]                         ▸ change            │
 │ Cutting — Makera's catalogue row for PLA: 12 000 rpm · 500 mm/min                       │
 │ At the surface — the rod turns at 5.575 rpm; the cut sees 333 mm/min      ▸ Technical  │
 ├ HOLD ────────────────────────────────────────────────────────────────────────── closed ┤
 │ Rotary chuck · reverse jaws · grip 15 mm · stick-out 85 mm · tailstock in   ▸ edit      │
 ├──────────────────────────────────────────────────────────────────────────────────────┤
 │ [            Generate            ]                                                       │
 │ ✓ generated · ✓ verified · ✓ simulated · ✓ matches the design      about 4 min           │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Job · Map** carries the seam and the two bands (edited on the map; the line is their summary).
- **Cutter · At the surface** is R12's line: F stays the catalogue's mm/min in the program, and the operator is
  told what the material sees — `rpm = F / (2π·r + 30)`, capped at 10 rpm, surface `= rpm × 2π·r`, at the
  item's floor radius (the firmware's feed model as read, `/Rotary.md` §1.2, §6.5). When the 10 rpm cap binds
  the line says so: *"the rod turns at its 10 rpm limit; the cut sees 597 mm/min of 1 200"* (r 9.5 mm). The Technical fold
  holds the model's provenance ("Makera's firmware feed model; A limit 3 600 °/min read from this machine's
  config 2026-10-07").
- **Cutter recommendation:** a flat end on the surface classes (the rotary column engine sweeps a flat end
  only; a V-bit appears once its footprint lands — §8 R-UI-12); the catalogue's row as today
  (`feedback_follow_catalogue_for_cutters`). Step-over is measured along the arc at the floor radius (§4.2,
  #191's rule).
- **Hold** is the chuck's one line. With no machine record (web build) it reads *"Rotary chuck · the Z1's rotary,
  ⌀80 × 150 mm"* and nothing else.
- **Generate's blockers**, rotary ones in the same form (first-job principle 4): *"Depth 12 mm reaches the centre
  of a ⌀20 rod — choose a depth under 10 mm"* (Fix → the depth field); *"“Zoomba” runs into the jaws"* (Fix → the
  map); *"No cutter in the catalogue simulates a V-carve on a round stock — choose Engrave text"* until the V
  footprint lands.

### 3.9 Simulate

The simulation panel (first-job §3.6, #691) for a rotary job.

```
 ┌ Simulate ──────────────────────────── [ Stock | Unroll ] ──────────── column engine ┐
 │            (the rod turns about X; the cutter stays still, over the axis)          │
 │     ════════════════════[ Z O O M B A ]══════════════   ▼ cutter                   │
 │  chuck ▐▌                                                ◁ tailstock               │
 ├─────────────────────────────────────────────────────────────────────────────────┤
 │ ▶ ━━━━━━━━━━━━━━━━━━━●──────────────────────  step 1 412 of 3 980                    │
 │   A 154.5° · 3 turns     X 31.2 mm   above the axis 9.5 mm      material: 40 updates   │
 ├─────────────────────────────────────────────────────────────────────────────────┤
 │ Matches the design ✓   on the map, every cell within 0.1 mm × 0.25° and 0.013 mm     │
 │ ▸ Technical: grid · the facet allowance · what was not checked                        │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

- **Stock (default):** R11a — the stock, the removed ghost, the gouges and the path turn by A(step) in one
  group; the cutter, the chuck and the tailstock stay still. The camera does not chase the rotation (the
  stock's bounding box is invariant under rotation about X, §5.1). **Unroll** re-meshes the same columns onto
  the map (§5.1d) — the map of §3.7, with what was cut.
- **The scrubber** is step-indexed as today; its read-out gains **A in ° within the turn and the turns**
  (`A 154.5° · 3 turns`, never `1 234.5°` alone — R9's (turns, angle)) and **above the axis** for Z.
- **The oracle line** is the column-space check of §4.5: per column, inside the opened region the floor radius is
  `R − d` plus the facet term, outside it is `R`; the tolerance is one grid cell each way plus the facet
  (0.013 mm for a ⌀1 mm cutter at r 9.5: `√(Z_t² + r_t²) − Z_t`). It reads in the operator's words on the
  main line; the numbers and "what was not checked" sit behind Technical, as first-job moves the oracle numbers
  here.
- **Refusals in the picture's words**, each with the step, drawn where it happens:
  - axis crossing — *"Move 3 847 cuts through the centre: the cutter tip reaches 5 mm past the axis. The
    simulation stops there; the moves after it are drawn, not simulated."* (R8; Makera's own Nefertiti finish
    shows this line, §6)
  - off the axis — *"Move 212 leaves the line over the axis (Y 2.5 mm). A rotary program keeps the cutter over
    the axis."* (R1, `rotary-y-off-axis`)
  - turning in the cut — *"Move 88 turns the stock while the cutter is 1.2 mm inside it."*
    (`rotary-rapid-engaged`)
  - indexed jobs show each face's index as a tick on the scrubber, and the stock turned to it (#241).
- A program opened from a file with A words simulates the same way (the column engine already replays Makera's
  rotary programs, #239).

### 3.10 Cut — registration on the rotary, and the run line

```
 [ Design ] [  Cut  ]          Zoomba · 192.168.10.43 · Online · Idle · homed · A 0° · T1 · vacuum off
 ✓ 1 Checked     1 program · about 4 min · speed at the surface 333 mm/min          ▸ details
 ✓ 2 Frozen      09:26 · the program matches the design
 ● 3 Register the stock   both sides, then the top at four turns, then the free end · 7 touches
       axis datum: Makera's shipped value — the side touches measure it on this mounting
     [ I am at the machine, the probe is fitted ]   [ Start registering ]
 ○ 4 Run         The rotary module has not been measured on this machine yet — this program can be
                 checked and saved; running it waits for the module's bench check.
 ← Back to design
```

- **Register the stock** is the rotary's touch plan, one touch per instruction (`feedback_bench_one_step_at_a_time`):
  1. **Both sides** at the axis height, front and back (Y): their middle is the axis line's Y, their spread the
     diameter (the two-touch centre find of Stepcraft/UCCNC, Tormach's A-axis centre — `/Rotary.md` §8).
  2. **The top at 0°, 90°, 180°, 270°** at one X: the mean, less the diameter's half, is the axis Z; the first
     harmonic is the run-out (eccentricity); the second, out-of-round (§6.2). With the tailstock in, the same
     four at a second X give the tilt the tailstock adjusts (§6.2) — 11 touches instead of 7.
  3. **The free end** (before the tailstock goes in): X, so the map's *along* matches the stock.
  - **A's datum** is where A homes (the seam at 0°). An indexed job aligned to a feature asks for one more touch
    on it (I only).
- **What the result does:** the probed radius replaces the nominal one (the program was posted for ⌀20; the run
  sheet prints both); **the job refuses when the run-out exceeds the shallowest item's depth band** — *"The rod
  sits 0.4 mm off the axis; “Zoomba” is 0.5 mm deep, so one side would be 0.1 mm and the other 0.9 mm. Re-seat it in
  the jaws, or bring up the tailstock."* (§6.2; the threshold is a setting with a per-job recommendation,
  `feedback_thresholds_setting_plus_recommendation`). The chuck's provisional axis residual is the shop default
  `registration.chuckAxisResidualMm` 0.05 mm (`probePlan.ts`).
- **Registration is allowed before #238** (§9 Q7): it moves the probe, not a cutter, and its readings are #238's
  own rows (axis height, run-out). The **Run** line is where principle 13's sentence stands, verbatim. Its
  button is not drawn (first-job principle 7: the sentence replaces the control). When #238 has recorded every
  rotary field as measured, the line becomes first-job's: *"vacuum on · fit the ⌀ 1 mm flat end · about 4 min"*.
- **Relief from a mesh** (class R) keeps its own Run sentence after #238: *"Relief on the rotary is checked and
  simulated here; the machine does not run it."*
- **The strip** shows A while the rotary is checked out (#658). Home before hands in the machine, the work light
  on, home when done — unchanged.

### 3.11 The run sheet

The run sheet's rotary sections (`/Rotary.md` §6.5; `runSheet.ts` has nine vise sections today):

```
 2  Mount the rotary module      vise and wasteboard off · onto the two pins · three M5 × 10 · the 4th-axis
                                 cable rear left with the machine off · chuck key in the tray
 3  The stock in the chuck       PLA rod ⌀20 × 100 mm · reverse jaws · 15 mm in the jaws · 85 mm out
                                 drill a centre hole in the free end · bring the tailstock up after the end touch
 5  The origin                   on the axis: Y 0 and Z 0 on the axis line, Z is the height above it;
                                 X 0 at the jaws; A 0° at home, the seam
 6  Speed at the surface         posted for ⌀20 · probed ⌀19.98 · the cut at r 9.5 mm
                                 F 500 mm/min → the rod turns 5.575 rpm → the cut sees 333 mm/min
                                 the rotary turns at most 10 rpm (3 600 °/min)
 7  Which way it turns           +A: Makera's shipped direction · A unwound at the end (G92.4 A0 S0)
 9  After the run                $H · tailstock back · saw the part off at X 75 mm (the band's edge)
```

- Every number has its provenance in the sheet's source column, as the vise sheet does: the envelope (Makera's
  figure), the jaws and the mounting steps (Makera's guide), 10 rpm (read from this machine's config), the
  feed model (Makera's firmware, as read), the 15 mm grip and the bands (Case Maker's defaults), the probed
  radius and run-out (measured, this run).
- The **surface-speed table** for the job's radii (the floor and the surface of each item) replaces the single
  feed line; a row where the cap binds says so.
- **Clearance** is *"half the diameter + 3 mm above the axis"* — 13 mm for ⌀20 — Makera CAM's rule (user guide
  l. 1025), which Studio's `safeZ` 27.749 also follows (§1.3).

## 4. Vocabulary additions (to first-job §4)

| Thing | Word | Not |
|---|---|---|
| the module | the rotary · "Rotary on the pins" · the chuck · the jaws · the tailstock | 4th axis (only the cable keeps Makera's "4th-axis" name), rotary module, headstock, A unit |
| round stock | Rod (a dowel is a rod) · Tube · squared Block | cylinder, bar, round, dowel as a form word |
| round stock size | diameter ⌀ · length X · (tube) wall, `mm` on each | D, Ø, OD/ID, L |
| the circumference | around: 62.832 mm at the surface | circumference, perimeter, 2πR |
| the axis direction | **along** (X, mm from the jaws) | axial, longitudinal, horizontal |
| the turning direction | **around** (mm at the surface on the map; `°` on angle fields) | circumferential, radial, A-direction, vertical |
| one revolution | a **turn** · "3 turns" · "turns at 5.575 rpm" | rev, rotation, cycle, 360° as a count |
| an angle | a number with `°` on every angle field, ≤ 3 decimals | deg, bare numbers, radians |
| A position | `A 154.5° · 3 turns` | `A 1 234.5`, unwound degrees alone |
| where the map's edges meet | the **seam** (at 0°) | wrap line, A-zero line, split |
| the unrolled surface | the **map** · "on the map" | development, unwrap, developed view, UV |
| the stock picture turning | **Stock** (toggle) · "the stock turns" | wrap view, 3D cylinder, rotating view |
| the line the stock turns about | the **axis** · "above the axis" (Z on a rotary job) | rotary centreline, WCS origin |
| how much is in the jaws | **grip** · **stick-out** | jaw depth, overhang |
| the end features | the jaws' band · the tailstock's band | keep-out zone, clamp envelope, obstacle |
| the speed the cut sees | **at the surface** · "the cut sees 333 mm/min" | surface feed, effective feed, SFM |
| an indexed cut | **on a face** · Flat · Faces all round · Cross-hole · "turn to 90°" | index, indexed operation, 3+1 |
| the relief class | Relief from a mesh · `simulate only` | Rotation Relief, class R, R-5 |
| refusal words | "cuts through the centre" · "leaves the line over the axis" · "runs into the jaws / the tailstock's band" · "turns the stock while the cutter is in it" · "does not fit the rotary's ⌀80 × 150 mm" | `axis-crossing`, `rotary-y-off-axis`, `wrap-into-clamp`, `rotary-rapid-engaged`, `stock-exceeds-module` |

## 5. Options matrix — every option a rotary job exposes

*Default* is what the job gets with no answer. *From*: **M** Makera's value (where), **D** derived (from
what), **T** typed (Case Maker's default or the operator's), **R** read from the machine or the location.
*Bench?* marks the ones #238 replaces with a measurement.

| Screen | Option | Default | From | Bench? |
|---|---|---|---|---|
| Stock | Form | Rod (the shelf's or the last) | R the shelf / the house's last job | — |
| Stock | Material | the house's (PLA) | R location | — |
| Stock | Diameter ⌀, length X | ⌀20 × 100 mm on the starter; else the shelf | T #240's recommended first stock | — |
| Stock | Tube wall | none — typed | T | — |
| Stock | Fits the rotary | ⌀ ≤ 80, length ≤ 150 | M `t_MachineType` (Makera library database) | yes, §9 row 7 |
| Stock | Rod in the vise vs the chuck | the vise up to 20 mm long | D `VISE_FLOOR_DEPTH` (`ROD_VISE_MAX_LENGTH_MM`) | — |
| Holding | The mount | the one on the pins that holds this stock | R the active bed profile | — |
| Holding | Jaws | by diameter: standard < ⌀20 · reverse inner 20–35 · reverse outer > 35 | M Makera's rule (Studio, `/Rotary.md` §9 row 7) | clamping limits, §9 row 7 |
| Holding | Grip | 15 mm | T Case Maker's default (§9 Q3); Makera publishes no jaw depth | yes |
| Holding | Stick-out | length − grip | D | — |
| Holding | Tailstock | in | M Studio `RotationReliefPath.json` `haveTailTop: true` (§1.3) | reach, §9 row 7 |
| Holding | Centre hole | "drill a centre hole in the free end first" | M Z1 wiki (§1.4) | — |
| Holding | Which end is in the jaws | either | T | — |
| Change | Axis datum | the module's preset (rotation offsets, this machine's config −7.5 / 69.0 / 17.0) or measured | M wiki preset + config read 2026-10-07 | yes, §9 rows 5–6 |
| Change | Fitting steps | wasteboard off, 2 pins, 3 × M5×10, cable with power off | M Z1 wiki (§1.4) | — |
| Operation | The operation | Engrave text (the starter) | T | — |
| Operation | Reads (text) | along | T Case Maker's default (§9 Q4) | — |
| Operation | Depth | 0.5 mm (as the flat engraving) | T the flat default, refused at the axis / the wall | — |
| Operation | Flat: angle, depth | 0°, the operator's | T | — |
| Operation | Faces all round: count, across-flats | 6, the largest inside the ⌀ (17.321 mm on ⌀20) | D `⌀ · cos(180°/n)` | — |
| Operation | Cross-hole: angle, ⌀, through | 0°, the operator's, through | T | — |
| Map | Seam | 0° | D where A homes (`home_to_min`, shipped config §1.2) | §9 row 4 |
| Map | Map radius | the stock's nominal radius | D R10 (author at the surface) | probed at Cut |
| Map | Repeat each side of the seam | 5 mm | T Case Maker's default (display only) | — |
| Map | Jaws' band | grip + 3 mm keep-out | T Case Maker's default; chuck body not published (#626) | yes |
| Map | Tailstock's band | 10 mm while in | T Case Maker's default; tailstock reach not published | yes |
| Map | Map / Stock toggle | Map | — R11 | — |
| Cutter | Cutter | the recommendation: flat end on the surface classes | R catalogue (Route A) + D the column engine's flat-only sweep | — |
| Cutter | Feed F (mm/min, as posted) | the catalogue row | M Makera's catalogue | §9 row 11 (feeds at radius) |
| Cutter | Speed at the surface | `F/(2πr+30)` rpm, cap 10, × 2πr | M firmware feed model (Robot.cpp, §1.2) | yes, §9 row 3 |
| Cutter | A limit | 3 600 °/min = 10 rpm | R config-get sd 2026-10-07 (B9) | yes |
| Cutter | A acceleration | 360 °/s² | R config-get sd 2026-10-07 (B9) | yes |
| Cutter | Step-over | ≤ the cutter's radius, measured along the arc at the floor | D #191's rule in §4.2's metric | — |
| Program | Clearance above the axis | ½ ⌀ + 3 mm | M Makera CAM user guide l. 1025; Studio `safeZ` 27.749 | — |
| Program | Origin | on the axis (Y 0, Z 0), X 0 at the jaws, A 0° at home | M the firmware's feed arithmetic (R6); the wiki's preset | sign/position §9 rows 1, 5 |
| Program | Steps per degree | 88.889 | M `configZ1.default` shipped | yes, §9 row 2 |
| Program | +A direction | Makera's shipped direction (the dir pin as shipped) | M `configZ1.default` (the evidence pass, #545 order 0) | yes, §9 row 1 |
| Program | Unwind at the end | `G92.4 A0 S0` | M the vendor rotary files' last line (§1.1) | yes, §9 row 9 |
| Program | Rough / finish (relief) | separate paths | M Makera CAM l. 1069 | — |
| Program | Relief direction | Makera's `reliefdirection: 0` | M `RotationReliefPath.json` | — |
| Simulate | View | Stock (turning) | — R11 | — |
| Simulate | Oracle tolerance | one cell each way + the facet term | D §4.5 (Δx, Δθ, r_t, Z_t) | — |
| Cut | Touch plan | sides × 2, top × 4, end × 1 (top × 4 again with the tailstock in) | D §6.2 + Stepcraft/Tormach (§8) | — |
| Cut | Run-out limit | the shallowest item's depth band | D §6.2; a setting with a per-job recommendation | yes, §9 row 10 |
| Cut | Chuck axis residual | 0.05 mm | T shop default `registration.chuckAxisResidualMm` (provisional) | yes |
| Cut | The run path | refused until every rotary field is measured | the maintainer's rule (#545) | lifted by #238 |

## 6. Simulate before the bench

Every class gets a fixture job that is generated, verified and simulated in the app and in the unit suite, with
an oracle that does not depend on a bench number. Makera's own programs replay as references.

| Class | Fixture job | What it proves | Oracle | Engine |
|---|---|---|---|---|
| W | **Name on a dowel** — PLA rod ⌀20 × 100, reverse jaws, grip 15, tailstock in, `Engrave text “Zoomba”` 0.5 mm, reads along, centred at 180°, ⌀1 mm flat end — every default | the whole flow; the starter | column-space opened region (§4.5); the golden numbers: arc 15.708 mm = A 90°, anisotropic radius 0.52583 mm around (exact `R·atan(r_t/(R−d))`, r_t 0.5, R 10, d 0.5; the small-angle form says 0.526) | column |
| W | **Band across the seam** — text reads around, centred on the seam | the seam: one continuous cut, no doubled or missing column | same, plus "no column changed outside the region" over the seam | column |
| W | **Pocket band all the way round** — 5 mm wide, 1 mm deep at X 60 | full-circumference regions; the saw-line pattern | floor at r 9 on every column of the band | column |
| W | **Into the jaws** — the text moved to X 1 | the band refusal at the row, not at Generate | the sentence and the Fix target | — |
| I | **Two flats** — 0° and 180°, 1 mm deep, on ⌀20 (#241's acceptance) | indexed runs split on A, the stock turned per face | the analytic flat volume per face (chord segment) | exact (R-4) |
| I | **Hex all round** — 6 faces, across-flats 17.321 on ⌀20 | n faces, the across-flats rule | the hexagon's area at every X | exact |
| I | **Cross-hole** — ⌀3 through at 90° | a hole through the centre on the exact path | the cylinder's volume removed | exact |
| R | **Shallow relief band** — a mesh that stays ≥ 3 mm above the axis | relief simulates while single-valued | the mesh's own radius map ± one cell (a 3D oracle like #222's) | column (ball needs #532's rotary footprint) |
| R | **Through the centre** — the same mesh deepened past the axis | the axis-crossing refusal names the first move | the step number and the sentence | column |

**Makera's programs as references** (`reference-gcode/Rotation/`, uncommitted per #186 — the specs skip when
absent, as the corpus specs do):

| File | Plays as | Pinned |
|---|---|---|
| `NefertitiRough.nc` | simulates in full (R-2's exit) | inside `SIM_BUDGET_MS`, memory recorded |
| `NefertitiFinish.nc` | refused at its first move at or below the axis | the step and the sentence of §3.9 |
| `Tests/4th-test-air.nc` | the rough with `T6` — the air-run reference | byte-identical but for the tool (`/Rotary.md` §1.1) |
| the post's own output | our rotary dialect vs the vendor file, structure for structure | the golden test of #545 order 1 |

**What stays bench-only** (`/Rotary.md` §9, unless the evidence pass answers a row from Makera's sources): which way
+A turns; steps per degree on the device; the real A rate and the perimeter scaling; whether `$H` homes A and
where A 0 is after it; the axis height and the chuck face's X; the preset's precision across mountings; the jaw
range and the tailstock reach; the round-stock `;@MKR|STOCK` / `ORIGIN` header; `G92.4 A S/R` on the device;
run-out and backlash; feeds at radius. Each appears in the app as Makera's value with its provenance until then,
and the Run line's sentence is the only place the bench is mentioned.

## 7. Acceptance (for the rotary flow, when built)

1. **The e2e walk.** From the door, with no machine on the network, an operator starts *Name on a dowel* (or
   picks Rod ⌀20 × 100, the rotary chuck, Engrave text), types a name, and reaches a **generated, verified,
   simulated, oracle-passing wrap engraving** — four ticks, *"matches the design"* in column space — **changing
   no default**, never seeing a disabled control without its reason. One spec, run alone
   (`feedback_e2e_single_spec`).
2. **The run refusal.** The same job in Cut with any rotary field not `measured`: lines 1–2 tick, line 3 offers
   registration, line 4 reads principle 13's sentence verbatim and has no button; the upload and release paths
   refuse the same program with the same sentence. Pinned by a unit spec on the gate and one e2e assertion.
3. **Holding writes the chuck.** Selecting *In the rotary chuck* with the rotary on the pins stores `rotary-chuck`
   with jaws, grip, stick-out and tailstock; the "held in the vise" sentence is gone (#697 closed).
4. **The change wizard fits the rotary as the wiki says:** wasteboard off, three screws, the cable with the
   machine off, and step 5 reads "Rotary on the pins · wasteboard off".
5. **Every class simulates** its §6 fixture in the suite; the two Nefertiti files pin their outcome when present.
6. **Words.** The walk's transcripts contain no `#\d`, no rotary code (`axis-crossing`, `wrap-into-clamp`, …),
   no `A` position without `°`, no angle field without `°`, no length without `mm`, no decimal past three; the
   bench is mentioned in one sentence only, at the Run line.
7. **The built screens match `rotary-flow-mockups.html`**, station for station.

## 8. Work items (proposed, to be filed under #545)

Order: the engine slices already running (0 evidence pass, 1 R-3 data model + post) come first; the UI slices
start from this design once approved. *Depends on* names the slice or issue that must land first.

| # | Title | Scope | Depends on |
|---|---|---|---|
| R-UI-1 | rotary: Stock step — Rod and Tube for the chuck, squared Block, "around" line | Tube form (⌀, wall, length X) in `JobStockForm`, the shelf and the schema; the rod sentence no longer blocks; the round-stock sizes; the envelope refusal at the field | R-3 data model (#240 slice 1) |
| R-UI-2 | rotary: Holding writes the chuck — jaws, grip, stick-out, tailstock, the front-view picture | `rotary-chuck` from `applyMount` with `jawMode`, `grip`, `tailstock`; the four lines; the picture; the Technical fold; closes #697 | R-UI-1, R-3 data model |
| R-UI-3 | rotary: the change wizard fits the rotary as Makera's guide says | wasteboard off; three M5×10; the cable with the machine off and the wait for it to answer; "wasteboard off" in the confirm line; the datum line's provenance; first-job mockup §3.8 corrected | #693 (landed) |
| R-UI-4 | rotary: Operation step — On the surface · On a face · 3D | the rotary picker per §3.6, each operation's one field, `simulate only` on Relief, the face operations reusing the flat picker | R-UI-2 |
| R-UI-5 | rotary: the map — along × around, seam, end bands, ruler, Map/Stock toggle | the engrave preview's round-stock path (`/Rotary.md` §5.3 `EngravePreview` row); the band refusals at the row; the anisotropic opening shared with the oracle | R-3 authoring/CAM (#240 slice 2) |
| R-UI-6 | rotary: Design panel's rotary lines | Job · Map, Cutter · At the surface (R12), Hold · the chuck; the rotary blockers at Generate | R-UI-5, #686 (landed) |
| R-UI-7 | rotary: wrap CAM, the verifier's rotary rules and the column-space oracle | `a` on the moves, wrap layout `A = s/R`, the §6.4 refusals with the §4 words, the oracle of §4.5 | #240 slice 2 (this IS that slice's UI-facing half) |
| R-UI-8 | rotary: Simulate — turning stock, Unroll, A in ° and turns, the oracle line, the refusal sentences | `SimPath.a` (Float64), the rotating group, the unroll re-mesh, the scrubber read-out | #240 slice 3, #691 (landed) |
| R-UI-9 | rotary: Cut — the rotary touch plan and the run-path refusal | sides/top × 4/end (+ tilt with the tailstock), the run-out refusal, the A datum; principle 13's sentence at the Run line and on upload/release | R-3 post (#240 slice 1), #689 (landed); #626 for the nose tap |
| R-UI-10 | rotary: run sheet sections | mount the rotary, the stock in the chuck, the axis origin, speed at the surface with the cap, +A and the unwind, the saw line | #240 slice 3 |
| R-UI-11 | rotary: indexed faces — Flat, Faces all round, Cross-hole | the three operations and their simulation on the exact sweeper, the per-face ticks | #241 (R-4) |
| R-UI-12 | rotary: V-bit and ball footprints in the rotary column engine | lifts `tool-refused` for V (V-carve on the surface) and ball (relief); the oracle's footprint term | #405 / #532 (flat-side footprints) |
| R-UI-13 | rotary: Relief from a mesh — simulate only | authoring, generate, simulate within the single-valued limit; its own Run sentence | R-UI-12, #222; R-5 stays uncommitted |
| R-UI-14 | rotary: the simulate-before-bench fixtures and Makera's programs as references | the §6 fixture jobs as specs; the Nefertiti / air-test replay pins | R-UI-7, R-UI-11 |
| R-UI-15 | rotary: the starter job and the acceptance e2e | *Name on a dowel* spec; §7 items 1, 2, 6 as one spec; lands last | all above except R-UI-12/13 |

#238 then replaces each Makera value with its measurement and, when the last rotary field reads `measured`,
lifts R-UI-9's refusal; nothing in the screens changes except the Run line.

## 9. Questions this design could not settle — and the default it takes

| | Question | Default taken | Why |
|---|---|---|---|
| Q1 | Should Tube be a form now (demand-driven features)? | **Yes**, in R-UI-1 | the maintainer named "dowel/rod/tube"; the shelf already stores tube; the wall rule is one comparison |
| Q2 | Squared Block in a three-jaw chuck? | **Offered** when it fits by its diagonal; the run-out touches are the guard | Makera CAM's Square stock (l. 1005); a three-jaw centres round stock best, so the probe decides |
| Q3 | Grip length — Makera publishes no jaw depth | **15 mm**, Case Maker's default, a shop setting | needed for stick-out and the jaws' band; bench calipers it (§9 row 7) |
| Q4 | Text reads along or around by default? | **Along** (like a pencil's lettering) | on ⌀20 the free length (72 mm usable) exceeds the circumference (62.8 mm); Vectric's "orientation of the job" is a question we answer with a default |
| Q5 | Which end is the chuck, and is X 0 at the jaws? | **Chuck on the left, X 0 at the jaws' face** | the wiki's preset "at the centre of the right edge" read as the chuck's right face; confirmed when the module is fitted |
| Q6 | A cut-off / part-off operation? | **None**; a Pocket band all the way round marks the saw line, the run sheet says where | Makera offers none; a vertical end mill parts off only by cutting through the centre (R8) |
| Q7 | Is registration (probing) allowed before #238? | **Yes**; only Run, upload and release refuse | the rule names the run path; the touches are #238's own measurements |
| Q8 | The jaws' keep-out and the tailstock's band | **3 mm** and **10 mm**, Case Maker's defaults, shop settings | the chuck body and tailstock are unpublished (#626); a band with provenance beats none |
| Q9 | Relief's run sentence after #238 | **Still refused** ("checked and simulated here; the machine does not run it") | R-5 is uncommitted (R2) and Makera's own finish crosses the axis |
| Q10 | +A direction on screen before the bench | **"Makera's shipped direction"** in the Technical fold and the run sheet, no clockwise claim | the dir pin is inverted in the shipped config; the evidence pass may settle it from Makera's sources, else §9 row 1 |
