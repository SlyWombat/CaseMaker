# Ten UI patterns competitors get right — and what Makera does instead

**Captured 2026-10-04.** Ten issues, each with a saved local sample, a verbatim quote and
the source URL it came from. The comparison target is **Makera Studio** (the Z1's only
software) and **Makera CAM Beta v0.2.0** (Makera's newer product, which is *not* sold to
Z1 owners — see `FEATURE-MATRIX.md` §3.2).

> **Tracking issue: [#228](https://github.com/SlyWombat/CaseMaker/issues/228).**
> Evidence index: `SOURCES.md`. Full capability comparison: `FEATURE-MATRIX.md`.

Sample paths are relative to `docs/market-research/`. Quotes are verbatim as captured;
where a claim comes from our own local inspection of the incumbent it is marked
**(local)** and points at `/Makera-Parity.md` or `/Fabrication.md`.

**What a "sample" is here.** Every entry names the local artifact that actually contains
the evidence, which is one of three kinds:

- a **UI screenshot** (`*.png` / `*.jpg` / `*.webp`) — usually the vendor's own image,
  occasionally our Playwright capture of a vendor docs page;
- a **page capture** (`*.html` / `*.txt`) — the vendor's marketing or manual text, which
  is what most quotes come from;
- a **docs-page capture** that embeds the vendor's UI image — noted as such, since the
  screenshot is of the documentation page rather than of the application.

Where the quoted sentence lives in a page capture and a UI screenshot exists separately,
both are listed. Screenshots of vendor docs pages carry that site's feedback widget in
the corner; that is the capture, not part of the UI being described.

Every pattern below is one where a competitor demonstrably does better, ordered roughly
by how much it costs a Z1 owner today.

---

## 1. The first run is a guided wizard, not a set of defaults

**The pattern.** The app walks the operator through *this machine* the first time —
identity, connection, homing, limits, tool setter, spindle type — and writes a machine
profile you can keep, export and re-import.

**Evidence.**

- Carbide Motion opens with `Setup New Machine`, launching a **Machine Setup Wizard**:
  *Connect to Machine → Initialize your machine → Configure BitSetter → Spindle Type →
  Machine Options*. It verifies as it goes rather than assuming — *"Press your BitSetter
  and ensure that the 'BitSetter Input State' changes as it's pressed and released."* —
  and it ends by disconnecting so the app restarts on a valid config.
  <https://guides.carbide3d.com/start-here/setup-machine/>
  · sample: `raw/carbide3d/starthere-setup-machine.html`
- Bantam Tools ships the same idea as a permanent left-rail wizard: **Home ▸ Initial
  Setup ▸ Material Setup ▸ Plan Setup ▸ Summary/Run Job ▸ Settings ▸ Jog**, with a live
  3D viewport beside it. *"Simply import your design file, choose your tooling… and
  you'll immediately see a preview of your design."*
  <https://support.bantamtools.com/hc/en-us/articles/360043268254>
  · sample: `raw/bantam/art-software-overview.png`
- gSender treats configuration as a first-class tab: a firmware-settings search (*"Type the
  setting you're looking for in the search bar (for example 'acceleration' or '$110')"*), a
  **'View Modified'** toggle to show only what has been changed from default, Machine
  Profiles, and explicit **Import** / **Export** of firmware settings — *"save your firmware
  settings to a file so you have it on hand"*.
  <https://resources.sienci.com/view/gs-setup-and-layout/>
  · sample: `raw/sienci/doc-gs-setup-and-layout.clean.txt`
- MillMage opens a **Project Setup Wizard** whose step 1 is literally **Choose Your
  Machine**, followed by units, stock dimensions, Z zero, origin/work offset, the two
  clearance heights and pocket lift height (see pattern 5).
  <https://docs.millmagesoftware.com/latest/GetStarted/ProjectSetupBeginners/>
  · sample: `raw/lightburn/shot-mm-projsetup.png`
- Stepcraft's **Multi-Installer** takes the profile idea literally: *"Select your machine
  model (M, D, or Q.Series)"*, and for Q.Series *"we provide you with a second installer
  where you can select additional profiles"* — each attachment becomes an installed profile
  rather than a setting.
  <https://stepcraft.us/uccncinstall/> · sample: `raw/stepcraft/us-uccncinstall.html`

**What Makera does instead.** Studio assumes a Z1. There is no machine-setup wizard at
all; the operator is handed a machine profile and a panel that is *"partly Carvera-only"*
(local, `/Makera-Parity.md` §7). Makera CAM Beta goes the other way and gates first-run
behind purchase-email verification — *"If you've purchased Carvera or participated in the
Carvera Air crowdfunding, verify and log in using your purchase email"*
<https://wiki.makera.com/en/software/MakeraCAM_Intro> — so a Z1 owner cannot even
complete its onboarding.

**What Case Maker should take.** Machine profile as a *document the user owns*: created
by a wizard, exportable, diffable, and the single source for feed/spindle/travel ceilings
(the job #184 is already scoped for). The import/export half matters as much as the
wizard — it is how a second machine gets added without re-answering every question.

---

## 2. Simulation is an interactive artifact you drive, not a picture you look at

**The pattern.** Material-removal simulation with **playback controls** — play, scrub,
step, 1:1 real time, jump to end — so the operator can stop *at the move* that looks wrong
rather than re-running the whole preview.

**Evidence.**

- Carveco: *"Choose to simulate each toolpath individually or simulate all your toolpaths
  for a look at the final design. With the dedicated playback controls, you can scrub
  through the toolpath for a closer look at specific tool moves, watch your cuts in
  real-time (1-to-1 speed) or jump to the completed simulation."*
  <https://carveco.com/carveco-software-range/carveco-maker-plus/>
  · samples: `raw/carveco/maker-plus.html` (the quote), `raw/carveco/shot-maker.png` (page)
- Easel frames the same feature as risk reduction: a toolpath simulation with play and
  timeline scrub so you can *"catch a mistake while it is still free to fix"*.
  <https://easel.com/product/easel-pro-features>
  · samples: `raw/inventables/easel-pro-features.html` (the quote),
  `raw/inventables/easel-ui-screenshot-oct.png` (the 3D toolpath preview it refers to)
- Pocket NC's Kinetic Control makes the simulator a **top-level page** beside Production
  and Setup — a rotatable digital twin of the actual machine, not an overlay.
  <https://pentamachine.atlassian.net/wiki/spaces/KCUR/pages/1727660098>
  · sample: `raw/pocketnc/kc-software-overview.png` (docs page; its text is the evidence)
- LightBurn/MillMage colour-code the preview by move type (cut vs travel vs Z down / ramp
  / up) with a tool crosshair, so the *colour* carries the meaning.
  <https://docs.millmagesoftware.com/latest/Reference/Preview/>
  · samples: `raw/lightburn/mm-preview.html` (the quote), `raw/lightburn/shot-mm-preview.png`

**What Makera does instead.** Two different failures.

- **Studio** ships a dexel simulator (`dexeltool.dll`) — the engine exists — but the
  documented workflow still ends in *"upload and find out"* (local, `/Makera-Parity.md`
  §8.1 item 4). The capability is present and not in the path.
- **Makera CAM Beta has no simulation at all.** `[Calculate]` *"complete[s] the tool path
  calculation and … generate[s] a preview of the created tool path"* — a static drawing of
  the path, no stock, no removal, no playback. "Simulat" appears **zero times** in the
  92 KB user guide.
  <https://wiki.makera.com/en/software/MakeraCAM_userguide>

**What Case Maker should take.** `/Simulation.md` already scopes a dexel simulator; the
design rule to add is that **scrubbing is part of the deliverable**, not polish. A
simulation you cannot stop mid-move cannot answer the question the user actually has
("what is that gouge at 60%?").

---

## 3. Say how long the job will take, before the machine runs

**The pattern.** A time estimate computed from the real toolpath, shown on the job file,
before it is sent.

**Evidence.**

- gSender computes it **on file load, with no machine connected**: *"feed range, spindle
  range, tools used, estimated cutting time, and overall, max, and min dimensions"*.
  <https://github.com/Sienci-Labs/gsender>
  · samples: `raw/sienci/gsender-readme.md` (the quote), `raw/sienci/gsender-ui.jpg`
  (the project's own screenshot of that panel)
- MillMage's Preview annotates the job with the estimated time *"in parentheses"* beside
  each move group, so the number is attached to the movement it describes.
  <https://docs.millmagesoftware.com/latest/Reference/Preview/>
  · samples: `raw/lightburn/mm-preview.html` (the quote), `raw/lightburn/shot-mm-preview.png`
- Vectric goes further and makes the estimate **correctable**: *"the software will
  calculate a time based on the length of the toolpath and the specified feeds and speeds…
  This can be tweaked by the operator by editing the 'scale factor' so over time a value
  can be optimized based on actual machine performance to ensure the estimate is as close
  as possible to the actual cutting time."* The software knows its estimate is a model.
  <https://www.vectric.com/products/vcarve>
  · samples: `raw/vectric/shot-vcarve.html` (the quote), `raw/vectric/shot-vcarve.png`

- Tormach's PathPilot takes the *empirical* route: a **time-remaining clock above the
  time-elapsed clock**, and once a file has been run it **saves** that estimate, so the
  remaining time shows *"immediately after the file loads… you no longer need to select
  Cycle Start."* Added 2026-10-04 from the vendor manual's own release notes (PP-1500,
  PP-2257); cycle time and run time are logged separately (PP-2181).
  · sample: `raw/tormach/PathPilot_UserGuide_Lathes_UM10751.pdf` (pp. 239, 241)
  — see `notes/tormach.md`

**What Makera does instead.** Neither product states a time estimate. Studio's feed data
is a static 1 328-row material × cutter table; CAM Beta's `[Calculate]` returns a path,
not a duration. For a Z1 owner this is a real cost — the Z1's max feed is **1 200 mm/min**
(local, `/Fabrication.md` §1), roughly a third of the Carvera's, so a job that "looks
short" in the preview can be a long afternoon.

**What Case Maker should take.** The estimate falls out of the simulator's step count at
no extra engineering cost, so compute it from the geometry rather than from a formula
over path length. Vectric's editable scale factor is the right honesty valve: let the
operator correct the model instead of hiding it.

---

## 4. Feeds and speeds come from the *machine* and the *material*, not a static table

**The pattern.** Pick the material and the bit; the app chooses feed, speed and depth, and
the values are constrained by the machine that is selected.

**Evidence.**

- Easel makes it the core interaction: a **material chip** (`MDF · 18 × 18 × 0.5 in`), a
  **bit selector** (`Bit: 1/8 in`) and a **Cut Settings** panel on the top bar, backed by
  a **Toolbox** — *"Add your own bits and materials and save the cut settings that work in
  your shop, on top of the built-in library of roughly 600 bits from five brands"* — and
  layered with **Community Cut Settings** from other makers who cut the same thing.
  (Toolbox and Community Cut Settings are Pro-tier, which is itself worth noting: the
  vendor charges for the machine-aware half.)
  <https://easel.com/product/easel-pro-features> · samples:
  `raw/inventables/easel-ui-vcarving.png`, `raw/inventables/easel-ui-designlibrary.webp`
- Vectric's tool database is explicitly **machine- and material-aware**: *"There is
  automatic support for machine management and material management. Tools can be filtered
  for your current material and machine settings, which makes selecting the right tool for
  the job simple."*
  <https://www.vectric.com/products/vcarve> · sample: `raw/vectric/shot-vcarve.html`
- Carbide Create ships a tool library covering the vendor's own cutters: *"All of the
  tools in the Carbide 3D tooling store are included in the tool library, so you can
  quickly select the right tool for the job."*
  <https://carbide3d.com/carbidecreate/> · sample: `raw/carbide3d/cc-tool-library.png`

**What Makera does instead.**

- **Studio**'s table is 1 328 rows keyed material × cutter with **no PLA or PETG** — the
  exact material this project prints blanks in — and **no machine column**: 32 of its rows
  exceed the Z1's 13 000 rpm spindle ceiling (local, `/Makera-Parity.md` §5.1).
- **CAM Beta is better than that and still short of the pattern.** It does tie parameters
  to a material: *"if the current stock setting is aluminum alloy, and if the aluminum
  alloy processing parameters are enabled in the selected tool, the aluminum alloy
  processing parameters entry will be automatically selected."* But the values themselves
  are not in the app — *"Select tool (thread milling bit) and modify/confirm tool processing
  parameters. See the Speeds & Feeds page of our Wiki for recommended and default cutting
  parameters."* — the recommendation is an external wiki page, and nothing in the operation
  knows the Z1's spindle and feed ceilings.

Both are quoted from source in `FEATURE-MATRIX.md` §3. The gap is not "Makera has no
material awareness"; it is that **neither product knows which machine it is planning for**,
which is the half the competitors above do get right.

**What Case Maker should take.** Machine ceilings are a **constraint applied to the
table**, not a column in it (`FEATURE-MATRIX.md` §3.1). A feed or spindle speed that
exceeds the selected machine's maximum is a validation failure, loudly reported — the same
rule as "never trust a persisted number" (`/Makera-Parity.md` §8.1 item 1).

---

## 5. Ask for clearance and retraction heights, then check them

**The pattern.** Job setup makes the two safety heights explicit fields with sensible
defaults, and then the app **warns when the toolpath violates them**.

**Evidence.**

> Note the division of labour in the two best examples below: **MillMage** makes the two
> heights explicit fields and documents what they do not cover; **Bantam** actually
> simulates the toolpath and warns. The strongest version does both.

- MillMage's Project Setup Wizard makes the safety heights two numbered steps of nine —
  *1. Choose Your Machine · 2. Set Project Units · 3. Measure and Set Stock Dimensions ·
  4. Set Z Axis Zero Point · 5. Set Project Origin/Work Offset · **6. Measure and Set Safe
  Clearance Height** · **7. Set Fast Retraction Height** · 8. Set Pocket Lift Height ·
  9. Close Project Setup Window* — and each carries a **Collision Warning** box that
  states what the number does *not* cover:

  > **Collision Warning** — Workholding fixtures are NOT included by default in the Safe
  > Clearance Height. Account for workholding fixture height and add their values into
  > calculations to prevent collisions.

  <https://docs.millmagesoftware.com/latest/GetStarted/ProjectSetupBeginners/>
  · sample: `raw/lightburn/shot-mm-projsetup.png`
- Bantam Tools **actually runs the check**: *"After opening and configuring a file, the
  software simulates its motion and determines whether the toolpaths will cause the
  milling machine to move outside its expected boundaries."* Two collision classes get
  distinct messages — *"Toolpaths may cause collision with bed"*, and for the frame
  *"Toolpaths may cause collision with frame"* / *"Toolpath may cause spindle to retract
  too far"*. It warns without blocking — *"The software will not prevent you from milling,
  but you should only do so at your own risk."* — and it names its own blind spots:
  *"The software doesn't yet have warnings for every potential type of collision… In
  particular, it can be helpful to look for these additional types of collisions:
  **Fixturing collisions**… **Material collisions**…"*
  <https://support.bantamtools.com/hc/en-us/articles/360043268194>
  · sample: `raw/bantam/art-collision-warnings.txt`

  This is the same blind spot MillMage documents, found independently in a second vendor:
  **both say the software does not count workholding.** That repetition is the evidence
  that it is a real design constraint rather than one vendor's caveat.
- Fusion advertises collision avoidance as a machining feature rather than a setup field:
  *"Additional axis controls and collision avoidance ensure safe, smooth machine motion."*
  <https://web.archive.org/web/2024/https://www.autodesk.com/products/fusion-360/manufacturing-extension>
  · sample: `raw/autodesk/txt-overview-archive.txt` (Wayback capture)

**What Makera does instead.** CAM Beta documents the field and then relies on the operator
to do the arithmetic in their head: *"The Retract Height sets a safe position for the tool
to retract to during machining operations, and must be greater than or equal to the width
and height of the stock in order to avoid potential collisions."* It is documentation, not
a check — nothing computes it, nothing warns.

This one is not abstract for this project. Case Maker's compiler has already had the
sibling bug: **there is no below-PCB clearance in the compiler**, so down-facing header
pins have to be paid for in `defaultStandoffHeight` by hand.

**What Case Maker should take.** A clearance violation is a compiler error with a
location, exactly like a geometry violation — not a warning the user is trusted to read.
And Bantam's second half is worth copying: state what the check *cannot* see (fixtures,
in Case Maker's case) rather than letting a green tick imply safety.

---

## 6. Confirm where the cut will land before it cuts

**The pattern.** The operator verifies the part's physical position on the machine **and
the extent of the toolpath**, with the tool up.

**Evidence.**

- LightBurn's **Framing** ships as **two buttons with different meanings** — a square-icon
  **Bounding Box Frame** (smallest containing rectangle) and a circle-icon **Rubber Band
  Frame** (*"useful for lining up jobs with irregular shapes where a box outline doesn't
  fit"*) — sitting beside `Start From: Absolute Coords ▾` and a 3×3 `Job Origin` picker.
  Diode users get an option to fire the laser at 0.25% while framing.
  <https://docs.lightburnsoftware.com/latest/GetStarted/FramingBeginner/>
  · sample: `raw/lightburn/screenshot-lb-Ref-LaserWindow-Unannotated.png` (the two Frame
  buttons, Start From and Job Origin, captured from the vendor's own reference page)
- gSender does *"Job outlining to see the rough bounds of your file before cutting"* — the
  machine traces the job's extents.
  <https://resources.sienci.com/view/gs-using-gsender/> · sample: `raw/sienci/gsender-readme.md`
- Shaper Origin goes furthest with **Aircut**, a preset at the top of the depth list:
  *"The Aircut option on the top of the presets list allows you to pilot a design without
  harming your material or making any noise. Clicking Aircut will set the cut depth to a
  negative value to ensure that your router bit does not touch your material."* Depth is a
  preset row plus a keypad with fraction entry (`1/32`), so a dry run is one value change
  away.
  <https://support.shapertools.com/hc/en-us/articles/115002904714>
  · samples: `raw/shaper/ui-cut-depth.html` (the quote),
  `raw/shaper/screenshot-ontool-cutdepth.png` (the on-tool depth presets)
- Carbide Motion's **Rapid Positioning**: *"You can quickly move the machine to one of the
  corners, or the center of the machine with a single click."* It is presented as the
  answer to jogging being *"tedious"* — not as a probe.
  <https://carbide3d.com/carbidemotion/> · sample: `raw/carbide3d/carbidemotion.html`

**What Makera does instead.** Makera CAM Beta has **no jog, no DRO, no machine control** —
"jog" appears zero times in the user guide. Whatever confirmation the operator does
happens in Studio, after the CAM step, on the machine. Studio's flow ends in upload.

**What Case Maker should take.** This is cheap and high-value for a case-making workflow:
a pocket for a connector is a hole in the right place or it is scrap. A dry-run mode (cut
nothing, trace everything) belongs in the run sheet next to the real run.

---

## 7. Offer a plain-language choice, not a wall of numbers

**The pattern.** The default surface is a small number of understandable options; the
numbers are one deliberate step away.

**Evidence.**

- Roland's SRP Player sells the **absence** of CNC concepts: *"You don't have to worry
  about feeds and speeds, cut depth, surface selection or G-Code programming: SRP Player
  does it all for you!"* The whole finish-vs-speed decision is one radio pair —
  **"⦿ Better surface finish ○ Faster cutting time"** — over a 3D preview.
  <https://www.rolanddga.com/applications/rapid-prototyping/srp-workflow>
  · sample: `raw/roland/srpworkflow2.jpg` (also `srpworkflow1.jpg`, `srpworkflow3.jpg`)
- Snapmaker Luban does it as a pattern rather than a mode: three preset cards
  (**Normal Print / Fast Print / Smooth Surface**), a **"Parameter Display: Recommended"**
  toggle that hides the advanced fields, and segmented controls (Fine/Medium/Rough,
  Slow/Medium/Fast) instead of raw numbers.
  <https://snapmaker.com/en-US/snapmaker-luban> · sample: `raw/snapmaker/luban-readme-screenshot.jpg`
- Pocket NC ships the same idea as a *swappable vocabulary*: *"The LANGUAGE section gives
  users the ability to change the base language of the user interface as well as change the
  dialect (lingo) that is used throughout. The "Industry" dialect option will display
  components of the UI with their common industry name, the "Intuitive" option will display
  certain components with their more common-language names."*
  <https://pentamachine.atlassian.net/wiki/spaces/KCUR/pages/1727660098>
  · samples: `raw/pocketnc/kc-software-overview.txt` (the quote),
  `raw/pocketnc/kc-software-overview.png` (docs page)

**What Makera does instead.** Studio exposes 26 fields per operation tool record, and the
supposedly friendly defaults are uninitialised or stale: `coolant: -858993460`
(`0xCCCCCCCC`, the MSVC debug fill pattern), `finishStepDown` as a denormal, and
`startDepth: 13.75` left over from whatever part was open last (local,
`/Makera-Parity.md` §8). Rolands `1 200 mm/min`-class machine ships a two-way radio; the
Z1's software ships a debug fill pattern as a cutting parameter.

**What Case Maker should take.** The honest default is the feature — which is already a
project value (no slider; two-state toggle, and the default carries the weight). The
incremental step worth stealing is Pocket NC's: keep one set of controls and change the
*wording*, rather than maintaining two UIs.

---

## 8. A failed job resumes from where it stopped, and the app can be diagnosed

**The pattern.** The job stops — power, bit break, alarm — and the operator restarts it
from the stop point, with accessory state restored.

**Evidence.**

- gSender: *"Start-from-line functionality to resume jobs part-way through in case of
  failure of abort."* The docs are specific about the hard part — it is not just a line
  number:

  > It does this by looking through the whole g-code file up to where you want to resume
  > running to see all the movements up to that point, **what accessories were turned on,
  > the power of a spindle or laser, and runs any automatic commands you've set up in
  > gSender**. This way you can be confident in returning to your projects, even when
  > something has gone awry.

  The same app ships *"Alarm warning explanations to better contextualize CNC errors"*, a
  notifications centre, and a *"Stats tool which collates your job run statistics, alarms
  and errors, maintenance tasks, and diagnostics"*.
  <https://github.com/Sienci-Labs/gsender> · <https://resources.sienci.com/view/gs-using-gsender/>
  · samples: `raw/sienci/gsender-readme.md` (feature list), `raw/sienci/doc-gs-using-gsender.clean.txt`
  (the resume-state explanation), `raw/sienci/gsender-ui.jpg`
- Easel's Pro tier: *"**Resume carve** — If a bit breaks or the power drops, pick the carve
  back up where it stopped. Works on 3D designs too."*
  <https://easel.com/product/easel-pro-features> · sample: `raw/inventables/easel-pro-features.html`
- Onefinity's Redline controller lists **Jump to Line** and **power-loss recovery** as
  headline controller features. <https://www.onefinitycnc.com/product-page/gen2eliteseries>
  · sample: `raw/onefinity/elite.html`

**What Makera does instead.** Studio produced **25 minidumps** in one install, all ending
in the same paint-time Qt exception, and a session log that ends in
`QPaintDevice: Cannot destroy paint device that is being painted` (local,
`/Makera-Parity.md` §8). There is no documented resume. The failure mode is not "the job
stopped" — it is "the app stopped, and nothing tells you where the part is".

**What Case Maker should take.** Two separate obligations, and the second is the one that
is usually skipped: (a) the app must survive a render failure and stay usable — Studio's
crash signature is a paint-time exception, and our geometry already runs in a worker;
(b) a job that stops must be restartable from a recorded line **with the machine's
accessory state replayed**, which requires the run sheet to record state, not just a
line number.

---

## 9. Print the operator a run sheet

**The pattern.** A printable/exportable summary of the job — tool, stock, zero position,
feeds, estimated time, part list — that sits beside the machine.

**Evidence.**

- Vectric: *"The create set-up job sheet command allows you to create a summary sheet that
  details all the important information you will need at your CNC machine when you come to
  run the toolpaths. This can be used as a reference to ensure you have the setup correct,
  have loaded the correct tool etc."* — and it is branded: *"You can also edit this to
  change the logo to an image of your own choice."*
  <https://www.vectric.com/products/vcarve>
  · samples: `raw/vectric/shot-vcarve.html` (the quote), `raw/vectric/shot-vcarve.png`
- Carveco: *"Carveco Maker Plus can also generate sheet reports with useful toolpath data
  you need for producing each sheet."* — the report is per nested sheet, which is the
  right unit for a shop.
  <https://carveco.com/carveco-software-range/carveco-maker-plus/>
  · sample: `raw/carveco/maker-plus.html`

**What Makera does instead.** No such feature in either Studio or CAM Beta. The
`;@MKR|` header block Studio writes into the G-code (local, `/Makera-Parity.md` §6) is
machine metadata, not an operator document.

**What Case Maker should take.** This is already in flight: `RunSheetView.tsx`,
`runSheet.ts` and `engraveRunStore.ts` exist uncommitted in the working tree. The
competitor detail worth adopting is **the unit**: Vectric and Carveco both key the sheet
to what physically changes at the machine — a sheet, a side, a tool change — not to the
project. A case has multiple sides and a mid-job tool change; the run sheet should break
on those boundaries.

---

## 10. Use the camera to *locate* the part, not just to watch it

**The pattern.** The machine's camera is calibrated to the work coordinates and used for
positioning and alignment: overlay the design on the real bed, or read a fiducial.

**Evidence.**

- LightBurn's camera is a first-class canvas: the bed image becomes the workspace
  background and artwork is placed on top of it. The **Camera Alignment wizard** burns an
  **AprilTag** feature pattern then maps camera coordinates to workspace coordinates, and
  the transform is treated as perishable: *"the Camera Alignment needs to be redone each
  time you move the camera"* (unlike the lens calibration, which is camera-only and
  reusable). **Trace Overlay** traces geometry directly from the camera image.
  <https://docs.lightburnsoftware.com/latest/Reference/Cameras/Alignment/>
  · samples: `raw/lightburn/lb-cam-align.html` (the quote),
  `raw/lightburn/shot-lb-cam-window.png` (the camera window and its overlay controls)
- Shaper Origin is the extreme case — the camera reading ShaperTape **is** the positioning
  system; the tool auto-corrects the cutter back onto the path within **12 mm** and retracts
  when it goes out of bounds.
  <https://www.shapertools.com/origin> · sample: `raw/shaper/shot-origin.png`

**What Makera does instead.** The Z1 **has** an integrated camera, and Studio shows it as
a **monitoring feed only** — no crosshair, no origin-setting overlay (confirmed by the
maintainer, 2026-10-03; local, `/Makera-Parity.md` §9). The hardware capability exists and
the vendor's software does not use it. That is not a gap to close for parity; it is an
advantage available for the taking, already scoped as #189.

**What Case Maker should take.** The competitor lesson is about **calibration discipline**,
not about cameras: LightBurn stores a camera-to-workspace transform, invalidates it when
the camera moves, and makes the user redo it — the same
default/saved/probed-with-provenance pattern this project already uses for fixture
obstacles (decision 28). A camera-derived position is a *probed* input with an
uncertainty, never a default.

---

## Runners-up — good ideas that did not make the ten

Kept because they are cheap, well-evidenced, and none of them is speculative:

| Idea | Evidence | Sample |
|---|---|---|
| **Material Test Generator** — *"By default, the Material Test Generator will create a 10x10 grid of boxes with varying Power and Speed. Use the Param dropdown to select different parameters to test."* | LightBurn, <https://docs.lightburnsoftware.com/latest/Reference/MaterialTest/> | `raw/lightburn/lb-materialtest.html`, `raw/lightburn/shot-lb-materialtest.png` |
| **Colour-coded motion** — *"we made every button in the app that moves the CNC dark blue"* | gSender, <https://resources.sienci.com/view/gs-setup-and-layout/> | `raw/sienci/doc-gs-setup-and-layout.clean.txt` |
| **Preset operation library** — save an operation, apply it to a new selection, organise into named libraries | MillMage Operations Library, <https://docs.millmagesoftware.com/latest/Reference/OperationsLibrary/> | `raw/lightburn/mm-ops-library.html` |
| **Heightmap auto-levelling** — *"Scanning a surface roughness map, correcting CP according to the specified map"* | Candle, `Candle/help/en/purpose` | `raw/genmitsu/candle-help-purpose.md`, `raw/genmitsu/candle-screenshot_heightmap_heightmap.png` |
| **Free cloud simulator with the machine's own panel** — *"Create conversational programs and test your code from the couch"* | PathPilot HUB, <https://hub.pathpilot.com/about> | `raw/tormach/pathpilot-hub-about.html` |
| **4-in-1 radial gauges** — one dial showing RPM / power / load / temperature | Kinetic Control, KCUR wiki | `raw/pocketnc/penta-software-screenshot.png` |
| **Click-to-type DRO** — the DRO readout is editable in place, so a value can be typed rather than jogged to | gSender, <https://resources.sienci.com/view/gs-using-gsender/> | `raw/sienci/gsender-ui.jpg` |
| **Workspace memory with visibility state** — *"If a Workspace was saved with a tape array that Origin cannot currently see, it will be greyed out with a 'not visible' icon."* | Shaper, <https://support.shapertools.com/hc/en-us/articles/115002904434> | `raw/shaper/ui-workspace-return.html`, `raw/shaper/screenshot-ontool-grid.png` |
| **F1 → the docs page for the control under the cursor** — *"Press F1 while hovering to launch the documentation page for that feature in your default web browser."* | LightBurn docs | `raw/lightburn/lb-ui-tour.html` |
| **Learned time estimate** — the app times a job on its first run and shows *that* as the remaining time on every later run, no Cycle Start needed | PathPilot, UM10751 (PP-1500, PP-2257) | `raw/tormach/PathPilot_UserGuide_Lathes_UM10751.pdf` |
| **Suggested vs. supplied values are colour-coded** — *"the background switches from green back to white. This helps you identify which DRO fields have suggested values (those with a green background), and which DRO fields have values you've supplied (white background)."* | PathPilot feeds/speeds, UM10751 p. 124 | `raw/tormach/PathPilot_UserGuide_Lathes_UM10751.pdf` |
| **The tool table warns about what the program actually needs** — first Cycle Start warns if a used tool entry is unconfigured, and the Tool Table shades the header of every tool the loaded program uses | PathPilot, UM10751 (PP-1673, PP-2013) | `raw/tormach/PathPilot_UserGuide_Lathes_UM10751.pdf` |
| **Automatic E-stop loop recording ("dashcam")** — *"E-stop loop recording enables analysis of the previous 30 seconds after an E-stop… enabled by default."* | PathPilot, UM10751 p. 90 | `raw/tormach/PathPilot_UserGuide_Lathes_UM10751.pdf` |
| **Optional switch test in homing setup** — *"This step includes an optional way to test all of the homing switches on each axis"* | Carbide Motion, <https://guides.carbide3d.com/start-here/setup-machine/> | `raw/carbide3d/starthere-setup-machine.html` |

---

## What this list does *not* say

Four limits, stated so the list is not over-read:

1. **These are documentation-level observations.** **No competitor software was installed
   or run** during this study — every claim rests on a vendor page, a manual, a user guide
   or a vendor screenshot. So "the manual documents scrubbing" is evidenced, and "scrubbing
   works well" is not. Where a screenshot is cited it is the **vendor's** image, not a
   capture of us using the product, except where a sample is explicitly marked as our own
   Playwright capture of a docs page. **One exception:** Tormach's *PathPilot User Guide
   for Lathes* (UM10751) was parsed with `megapdf-cli` and read **in full** (257 pages), so
   the PathPilot citations here are primary-manual evidence with page numbers, not marketing
   copy. (Second pass: Carbide 3D's five machine manuals are now parsed too.)
2. **The Makera side is the better-evidenced half.** Claims about Studio and CAM Beta come
   from reading their actual files and logs (see `/Makera-Parity.md`), so the comparison is
   between *examined* incumbent software and *documented* competitor software. That
   asymmetry is unavoidable and is why the Makera column is quoted from source rather than
   from memory.
3. **"Competitor does better" is comparative, not absolute.** Roland's SRP Player wins on
   approachability and loses badly on capability; Fusion wins on capability and is a
   subscription. The pattern is what is being copied, not the product.
4. **Ten is the brief's number, not the ceiling.** `FEATURE-MATRIX.md` §4 lists where the
   research is thinnest, and several runners-up above are as well-evidenced as the ten.
