# Makera Z1 accessories: how Makera says to install them

Research note, 2026-10-27. The maintainer said: *"the waste board is removed when installing the vise,
you should look for installation manuals for each."* This note collects Makera's own install and removal
instructions for every Z1 accessory and bed setup the app models. The "Change the machine" wizard, the
bed-profile defaults and the run sheet should quote these. The last section lists each place where the
app currently says something different.

**Evidence rules.** "Makera:" plus a quote means an exact phrase from an official Makera source. **Inferred**
marks anything read from Makera's illustrations, CAD files or the absence of a step, not from text; each
one needs a bench look before it becomes a rule. Sources from the Carvera or Carvera Air (sibling machines)
are labelled as such and never stand in for a Z1 rule.

## Sources

Raw text for each page is in `docs/market-research/raw/makera/` (fetched 2026-10-27). That folder is
**gitignored** (`.gitignore:34`, `docs/market-research/**`), so it exists only on the machine that fetched it.

**Official Makera**

| Topic | URL | Raw capture |
|---|---|---|
| Z1 Quick Start (unboxing, kit, tool change, workholding/L-bracket, probes, first job) | https://wiki.makera.com/en/Z1/QuickStart | `Z1-QuickStart.txt` |
| Printed Quick Start Guide V2 (PDF, same text as the wiki plus the kit list with counts) | https://www.makera.com/cdn/shop/files/MakeraZ1-Quick_Start_Guide-V2.pdf | `Z1-Quick-Start-Guide-V2-pdf.txt` |
| Z1 accessories index | https://wiki.makera.com/en/Z1/Accessories | `Z1-Accessories-index.txt` |
| Low-Profile Vise Quick Start | https://wiki.makera.com/en/Z1/Accessories/Low-Profile-Vise | `Z1-Accessories-Low-Profile-Vise.txt` |
| 4th Axis Module Quick Start | https://wiki.makera.com/en/Z1/Accessories/4Axis | `Z1-Accessories-4Axis.txt` |
| 4th Axis Headstock Replacement Guide | https://wiki.makera.com/en/Z1/Accessories/4Axis/HRG | `Z1-Accessories-4Axis-Headstock-Replacement.txt` |
| Vacuum Bed Quick Start | https://wiki.makera.com/en/Z1/Accessories/VacuumBed | `Z1-Accessories-VacuumBed.txt` |
| Ionizer Module Quick Start | https://wiki.makera.com/en/Z1/Accessories/Ionizer | `Z1-Accessories-Ionizer.txt` |
| 3D Probe Quick Start | https://wiki.makera.com/en/Makera-Accessories/Makera-3D-Probe | `Makera-3D-Probe.txt` |
| Engraving (laser) module | https://wiki.makera.com/en/Makera-Accessories/Engraving-Module | `Makera-Engraving-Module.txt` |
| Z1 Maintenance (video index, incl. tool setter replacement) | https://wiki.makera.com/en/Z1/new-page/Maintenance | `Z1-Maintenance.txt` |
| Z1 Manual (index only, mirrors the Quick Start) | https://wiki.makera.com/en/Z1/Manual | `Z1-Manual-index.txt` |
| Store: vise, 4th axis, vacuum bed, MDF bed, L-bracket, clamps, screws, tape, 3D probe | makera.com / eu.makera.com product JSON | `makera-store-z1-workholding-products.txt` |
| Z1 MDF bed CAD (`Makera-Z1_MDF-v2.1.STEP`) | https://github.com/MakeraInc/CarveraProfiles/tree/main/Machine_Design_Files | `makera-z1-mdf-bed-step-geometry.txt` (derived numbers) |
| Official YouTube install videos (titles and URLs) | youtube.com/c/makera | `makera-youtube-z1-install-videos.txt` |

The YouTube videos are all on Makera's channel:
- Low-profile vise: *Low Profile Vise - Makera Z1 & Z1 Pro Tutorial for Beginners*, https://youtu.be/Iqy27HT48Kw
- 4th axis: *4th Axis Module - …*, https://youtu.be/Z3ALfDke6qU
- Vacuum bed: *Vacuum Bed - …*, https://youtu.be/TU1L6R7Vlto
- L-bracket and clamps: *Workpiece Fixing - …*, https://youtu.be/TiexQK14zKg
- Wired probe: *Wired Z Probe - …*, https://youtu.be/612p-Kt_2I4
- 3D probe rod: *3D Probe Rod - …*, https://youtu.be/CF0iAjE12ww
- 3D probe: *Makera Z1 - 3D Wired Probe*, https://youtu.be/_fKaCgN8EAE
- 4th-axis motor: *Makera Z1-unplug the 4th axis*, https://youtu.be/SJ-odNetxp0, and *Z1 instal 4th axis*, https://youtu.be/CvKd0_QSm_0
- Tool setter: *Z1 Maintenance - Tool Setter Replacement*, https://youtu.be/rC06cV3QWZw
- 3D probe calibration: *Z1 Maintenance - 3D Probe Calibration*, https://youtu.be/FgkTq1Fz724

Only the titles and descriptions were read. The descriptions are boilerplate.

**Official Makera, but for a sibling machine (not the Z1)**

- The Carvera "Swapping 4th-axis jaws" guide, https://wiki.makera.com/en/carvera/maintenance/swapping-jaws (`carvera-swapping-4th-axis-jaws.txt`). The Z1 4Axis page says only *"See wiki.makera.com for details"* for jaw swaps, and this is the only jaw-swap guide on the wiki.
- Carvera Air *Preparation*, https://wiki.makera.com/en/Air/Manual/Preparation, on the thin spoil board (`carvera-air-preparation-spoilboard.txt`).
- Carvera *Three-axis relief*, https://wiki.makera.com/en/carvera/manual/three-axis-relief, on the MDF wasteboard aligned to the L-bracket (`carvera-three-axis-relief-wasteboard.txt`).

**Community, on Makera's wiki** (the "Knowledge Sharing" section, not Makera's own instructions)

- *4th axis chuck basics* (Carvera chuck), https://wiki.makera.com/en/knowledge-sharing/knowledge-sharing/4th-axis-chuck-basics (`carvera-4th-axis-chuck-basics.txt`).

**Third-party.** None used for any rule. A web search found retailer listings (core-electronics.com.au,
filament2print.com) that repeat Makera's L-bracket text, and reviews (hackster.io, cnx-software). None of
them adds install detail.

**Searched for and not found:**
- A Z1 wasteboard resurfacing procedure
- A Z1 taping procedure
- Removal steps for the vise, the 4th axis or the vacuum bed
- A Z1 fixture plate
- Screw sizes for the MDF wasteboard
- Torque values for any Z1 accessory

## What sits on what

"Wasteboard" is the **MDF bed** that ships screwed to the Z1's aluminium table. Makera sells it as a
replacement part named "Makera Z1 MDF Bed 2PC".

| Setup | Wasteboard | Sits on | Located by | Fastened by | Power | Source |
|---|---|---|---|---|---|---|
| **Low-profile vise** | **off**: Makera: *"Remove the MDF wasteboard"* (step 1.3) | bare aluminium table | two *"4×11 mm locating pins"* | *"six M5×20 screws"*, with the left fixed jaw removed first and refitted after | *"Home the machine … then power it off"* | wiki Low-Profile-Vise |
| **4th-axis module** | **off**: *"Remove the MDF wasteboard"* (step 2.3) | bare aluminium table | two 4×11 mm locating pins | *"3 M5×10 screws"* | home, then power off; *"Do not plug or unplug the 4th-axis cable while the machine is powered on"* | wiki 4Axis |
| **Vacuum bed** | **off**: *"Remove the MDF wasteboard"* (step 2.3), then the vacuum bed's own *"dedicated MDF board"* goes on top of it | bare aluminium table | two 4×11 mm locating pins | *"four M5×20 screws"* | home, then power off | wiki VacuumBed |
| **L-bracket at anchor 1 or 2** | **not mentioned**. **Inferred: on** (see §4) | the bed as shipped (MDF on the table, inferred) | *"two 4 mm dowel pins"* | *"three M5×20 screws (Use longer screws for the thick bracket)"* | not mentioned | wiki QuickStart §Workholding |
| **Top clamps** | as for the bracket | the bed, at the stock's far corner | none | one M5 screw each through its slot | not mentioned | QuickStart, first job |
| **Double-sided tape** | not mentioned | not stated | none | the tape | none | kit list only |
| **Wasteboard itself** | — | aluminium table | its countersunk holes over the table's holes (inferred) | screws, count and size not stated; **4 countersunk** screws in Makera's figures (inferred) | as for whatever it is swapped with | figures 1.3 / 2.3 |
| **Bare bed** | off | — | — | — | — | the state the vise, 4th axis and vacuum bed require |

**Exclusions that follow from Makera's text.** The vise, the 4th axis and the vacuum bed each start with
"Remove the MDF wasteboard". All three locate on two 4×11 mm pins: the vise's and the vacuum bed's figures
show the same two holes, one at the left edge and one at the right edge. So they are one at a time, and
none of them shares the bed with the wasteboard. Makera never says that the L-bracket cannot share the bed
with the vise. The vise sits over the middle of the table, so in practice it covers anchor 1.

**What must come off first**
- Rotary to vise: power off, unplug the cable, then 3 screws. **The wasteboard stays off.**
- Vise to rotary: the vise comes off. **The wasteboard is already off.**
- Bracket/bed setup to vise or rotary: the bracket, the clamps and the stock come off, **then the
  wasteboard comes off**.
- Vise or rotary to a bracket or tape job: the fixture comes off, then the wasteboard goes back on if the
  job wants it. This last step is inferred: Makera gives no removal steps for any accessory.

## 1. Low-profile vise

Source: https://wiki.makera.com/en/Z1/Accessories/Low-Profile-Vise. Video: https://youtu.be/Iqy27HT48Kw.
Store page: https://www.makera.com/products/makera-z1-low-profile-vise.

**Install, in Makera's order:**
1. *"Home the machine in the control software, then power it off (spindle at the far right, table at the front)"*.
2. *"Remove any tool from the spindle"*.
3. *"Remove the MDF wasteboard"*. The figure shows the blue MDF lifting off the aluminium table after four countersunk screws come out.
4. *"Insert two 4×11 mm locating pins"*. The figure shows one pin at the left edge and one at the right edge of the table.
5. *"Position the low-profile vise on the locating pins and remove the left fixed jaw using the included hex key"*.
6. *"Secure the vise with six M5×20 screws, then reinstall the fixed jaw (ensure the locating key is properly seated)"*. The figure shows the six countersunk screws in two rows along the rails, reached with the fixed jaw off.

**Clamping:**
1. Loosen screw 3 on the movable jaw.
2. Adjust screw 2 to bring the movable jaw close to the jaw carrier.
3. Loosen screw 1 on the jaw carrier.
4. Open the jaws and insert the work.
5. Tighten screw 1, adjust screw 2 to clamp, then tighten screw 3.

Note: *"slotted soft jaws by default, suitable for thin workpieces. For taller parts, clamp directly
against the bottom of the jaws"*.

**Remove.** Not documented by Makera. The reverse is inferred: home, power off, cutter out, take off the
left fixed jaw, remove the six M5×20 screws, lift the vise off, pull the pins, then put the wasteboard
back if the next setup wants it.

**Wasteboard.** It comes **off**. That is Makera's step 1.3, and it is what the maintainer confirms. The
store page explains why: *"The Vise elevates your material for clean, full-depth through-cuts without
scarring your CNC bed"* and *"Save money on replacement MDF"*.

**Warnings.**
- Power off for the install.
- No tool in the spindle.
- The fixed jaw's locating key must be seated.
- The vise is *"Optimized exclusively for the Makera Z1 (not compatible with Carvera/Air)"*.

## 2. 4th-axis rotary module

Source: https://wiki.makera.com/en/Z1/Accessories/4Axis. Video: https://youtu.be/Z3ALfDke6qU. Headstock
replacement: https://wiki.makera.com/en/Z1/Accessories/4Axis/HRG.

**Preparation, first time only.** *"For shipping, the 4th-axis headstock is positioned to the right. It
must be adjusted before use"*: loosen the 4 mounting screws, slide the headstock left until it is aligned
with the base, then retighten. The figure is captioned *"Align to base here, then fasten 4 screws"*.

**Install, in Makera's order:**
1. *"Home the machine in the control software, then power it off (spindle at the far right, machine bed at the front)"*.
2. *"Remove any tool from the spindle to avoid injury"*.
3. *"Remove the MDF wasteboard"*.
4. *"Insert two 4×11 mm locating pins into the table as shown"*. In the figure, one pin is under the chuck end and one at the tailstock end.
5. *"Position the 4th-axis module using the locating pins and secure it with 3 M5×10 screws"*.
6. **Cable, last:** *"Route the cable as shown, bending it from the left side through the lower-left opening of the frame, and connect it to the 4th-axis port at the rear-left inside the machine"*. The figure shows the cable looping out of the motor on the left and up to a port on the rear wall, left side.

**Clamping:**
1. *"Rotate the chuck by hand to set an appropriate opening"*.
2. Insert the work and clamp it lightly.
3. *"Loosen the tailstock screws, adjust it to support the workpiece, then tighten"*.
4. *"Use the adjustment knob to secure the workpiece (do not overtighten; drilling a center hole at the end is recommended)"*.
5. *"Tighten the chuck using the chuck key"*.

**Notes on the page:**
1. *"Do not plug or unplug the 4th-axis cable while the machine is powered on"*.
2. *"The 4th-axis zero point is preset in the software at the center of the right edge of the spindle"*. The figure labels the chuck face *"0 position in X direction"*.
3. *"The chuck uses reverse jaws by default for larger workpieces. For smaller parts, switch to standard jaws. See wiki.makera.com for details"*.

**Chuck jaws (standard/reverse).** The only jaw-swap procedure on the wiki is the **Carvera's** (sibling
machine). For forward (standard) jaws: back the jaws all the way out, then insert No.1 to No.4 in order,
turning the scroll (rear nut) 90° between jaws. For reverse jaws: insert No.4 to No.1. It warns that *"the
rear nut will become very tight just before the jaws are almost completely loosened"*. That guide numbers
**four** jaws. The Z1 page does not give the Z1 chuck's jaw count, so whether the Z1 chuck has three or
four jaws is unconfirmed (see Corrections C12). The jaw-size rule (under ⌀20 standard; ⌀20–35 reverse
inner; over ⌀35 reverse outer) comes from decompiled Makera Studio (`Rotary.md`), not from the wiki.

**Tailstock.** It slides on the base rail. Loosen its screws, slide it up to the work, tighten, then use
the knob. Drill a centre hole first.

**Remove.** No Makera text. The headstock guide's safety line is the nearest thing: *"Disconnect the 4th
Axis module from the device to ensure it is completely powered off"*. The video titled *Makera Z1-unplug
the 4th axis* covers this. The reverse is inferred: home, power off, unplug the cable at the rear left,
remove the 3 M5×10 screws, lift the module, pull the pins, then put the wasteboard back if wanted.

**Headstock or motor replacement (maintenance only).**
- Tools: H2.5 and H3.0 hex drivers and the chuck key.
- Chuck removal: lock the spindle with the H3.0 driver through the viewing hole, squeeze it and the chuck key together in one hand, then unscrew the chuck counter-clockwise.
- Install: thread the chuck on clockwise until hand-tight, then lock it with both tools pushed apart.

## 3. MDF wasteboard ("Makera Z1 MDF Bed")

Sources:
- The vise, 4th-axis and vacuum-bed pages (removal is step 1.3 or 2.3 on each).
- Store: https://www.makera.com/products/makera-z1-mdf-bed: *"CNC machined MDF bed. This is a Replacement Part for your Makera Z1. For Makera Z1 only."* It is sold as "2PC".
- CAD: `Makera-Z1_MDF-v2.1.STEP` in MakeraInc/CarveraProfiles.

**What it is.** The machine ships with it on. Every accessory page starts by removing it, and the
figures show it screwed over the aluminium table. **Inferred from the STEP geometry** (no CAD kernel, so
confirm with calipers):
- About **206 × 206 × 6 mm**.
- 36 counterbored M5 clearance holes (⌀5.5, with a ⌀10 recess 2 mm deep).
- Per the figures, a large clearance hole at the back-right corner over the auto tool setter.

**Install and remove.** Makera's only words are "Remove the MDF wasteboard". Its figures show **four
countersunk screws** (fig. 1.3 vise, fig. 2.3 4th axis). The screw size is not stated. Reinstalling is
the reverse: line the board's holes up with the table's, then fit the four screws.

**Resurfacing.** **Makera publishes no Z1 resurfacing procedure.** It sells the board as a cheap
replacement part and pitches the vise as a way to *"Save money on replacement MDF"*. Sibling-machine
practice (Carvera and Carvera Air, not Z1) is a *thin* sacrificial board on top: the Air ships *"a thin
Spoil Board, featuring the same hole positions as the desktop density board … You can secure it to the
desktop before machining"*. The Carvera relief example has you *"Cut the 2mm MDF board … as the
wasteboard"* and fix it *"to the table … Align it to the L-bracket at anchor point 1"*.

## 4. Anchor brackets (L-bracket, anchor 1/2) and top clamps

Sources:
- Wiki QuickStart §Workholding & Positioning and §Your First Job, plus the printed QSG V2 p.3. Video: https://youtu.be/TiexQK14zKg.
- Store pages: L Bracket, Top Clamp Set, Side Clamp Set, Stainless Steel Low Profile Hex Screw.

**Kit (QSG V2):**
- 1 L Bracket
- 2 Top Clamps
- 15 M5 screws (*"M5x20mm Screws x 10, M5x30mm Screws x 5"*, with the note *"M5 × 30 mm screws are for thick materials only. They may bottom out when used with thin materials"*)
- *"4mm Dowel Pin x 5"*
- 2 × 100×100×2 MDF boards (stock, not the wasteboard)

**Install, in Makera's order:**
1. *"Secure the L-bracket at the anchor position using two 4 mm dowel pins and three M5×20 screws (Use longer screws for the thick bracket)"*.
2. *"Place the workpiece against the inner side of the bracket for initial positioning"*.
3. *"Insert two M5 screws into the semi-circular openings of the bracket to fix the lower-left corner"*.
4. *"Use top clamps to secure the upper-right corner and complete the setup"*.
5. Origin: *"Set Work Origin relative to Anchor 1, with X Offset = 0 and Y Offset = 0"*. The store says *"Each L-Bracket can be secured at one of two anchor points"*. That store text is written for the Carvera and the Carvera Air but is listed in the Z1 accessories collection.

**First job:** *"Use four M5×20 screws and two top clamps to firmly secure the included 100 × 100 × 5 mm
aluminum plate"*. The top-view figure shows the bracket at the front-left, two screws in the bracket's
openings and one screw through each clamp's slot.

**Warnings:**
- *"Do not overtighten the top clamps"*.
- *"Use screws of appropriate length based on the workpiece thickness to prevent scratching the base plate"*.
- Top clamps are *"typically used to secure workpieces less than 2 cm thick, in conjunction with the thin L-Bracket"*.
- *"For workpieces thicker than 1 cm, we recommend using shims at the ends of the top clamps"*.
- Side clamps go *"with the thick L-Bracket to secure workpieces thicker than 2 cm"*.

**Wasteboard under the bracket. Makera does not say. Inferred: it stays on.**
1. The vise, 4th-axis and vacuum pages each list "Remove the MDF wasteboard" as an explicit step. The QuickStart's bracket section has no such step.
2. The QuickStart figure shows the auto tool setter rising through a large hole at the back-right corner of the top plate, and a small hole at mid-right. That matches the MDF board's features in fig. 2.3.
3. The QuickStart is the out-of-box flow, and the machine ships with the MDF on.

A bench look settles it. Either way the dowels and M5×20 screws pass through the MDF's holes into the
table.

**Remove.** Not documented. The reverse: clamps, stock, then the 3 screws and the bracket.

## 5. Double-sided tape

Sources: QSG V2 kit list (*"Double-side Tape x 1"*) and the store's *"Strong Fixation Transparent
Double-Sided Tape"* (variant *"20mm / 50m"*). The store says the tape is *"approximately 0.2mm thick,
leaves minimal residue"* and that *"The tape that comes with the machine is 20mm wide and 10 meters
long"*.

**Makera gives no Z1 taping procedure**: nothing on strip count, pressure, surface prep or removal.
Neither page states the thickness of the roll in the box. Only the store roll's ~0.2 mm is published.

## 6. Wired probe, 3D probe rod, 3D probe, tool setter

**Wired probe.** It is *"(Pre-installed)"* per the QSG kit list, and the machine overview labels it "4.
Wired Probe" on the head. It needs no fitting, only a tool change: *"Follow the prompt in the control
software to switch to the probe"*, install it like a tool, then *"Click Continue or press the main button
to start probe calibration"*. Makera sells a "Wired Probe V2.0" spare.

**3D Probe Rod** (in the box):
1. Switch to it in the software.
2. Install it like a tool.
3. *"Disconnect the Wired Probe and connect the 3D Probe Rod cable"*.
4. Click Continue to calibrate.

Constraint: *"The 3D Probe Rod only works with conductive materials. The workpiece must be electrically
connected to the aluminum table via locating pins, screws, or other conductive methods"*. A part sitting
on the MDF wasteboard or on tape is therefore not connected unless a screw or pin bridges it. A part in
the vise sits on the bare table.

**3D Probe** (sold separately; *"Exclusively designed for Makera Z1 and Carvera Air"*):
1. Switch to it on screen.
2. Remove the current tool and install the probe.
3. *"Unplug the wired probe connector and connect the 3D probe cable"*.
4. Calibrate automatically.

Notes: use the matching adapter sleeve after a collet change, and *"Recalibration is required after
collisions or when changing the probe holder"*. Video: *Z1 Maintenance - 3D Probe Calibration*.

**Auto tool setter.** It is fixed at the back-right of the table ("5. Auto Tool Setter"). There is no
install step for users. The only document is the maintenance video *Z1 Maintenance - Tool Setter
Replacement* (https://youtu.be/rC06cV3QWZw). The wasteboard has a clearance hole for it (inferred from
fig. 2.3).

## 7. Other Z1 workholding and fitting accessories

The store's "accessories-z1" collection, fetched 2026-10-27, plus the add-ons collection:
- **Vacuum Bed** (wiki VacuumBed, video https://youtu.be/TU1L6R7Vlto). Install steps:
  1. Connect the two suction tubes to the table.
  2. Home, then power off, then take the tool out.
  3. *"Remove the MDF wasteboard"*.
  4. Insert the two 4×11 mm pins.
  5. Seat the table with *"four M5×20 screws, and install the dedicated MDF board"*.
  6. Route the tubes under the machine to the rear ports.
  7. Swap the internal rear air tubes for the suction tubes, plugging the removed ones.
  8. Put the collector hose on the upper rear port.

  It *"must be used in conjunction with the Makera Cyclone Dust Collector (Standard or Lite version)"*. It is for *"thin, flat materials … Do not use it for thick or metal workpieces"*.
- **Side Clamp Set (2 pcs).** Used with the thick L-bracket for stock thicker than 2 cm. The store wording is the Carvera's.
- **Stainless Steel Low Profile Hex Screw** (M5×20, M5×30 or M5×40, 10 pcs). *"used for securing the L Bracket, Top Clamp, and Side Clamp"*.
- **PCB Rivets.** Consumable, not workholding.
- **Ionizer Module** (spindle-side, not the bed). Install steps:
  1. Move the spindle to mid-X.
  2. Remove 2 M3 placeholder screws.
  3. Fit the module with 2 × M3×8 screws.
  4. Plug it into the 3-pin port on the right of the spindle.
  5. Enable it in the software.
- **Laser / engraving module** (spindle-side). It goes into the collet like a tool, label facing out, and plugs into the same 3-pin port.
- **Fixture plate: Makera sells none for the Z1.** It is absent from every Z1 collection.

## Corrections the app needs

Each item gives the file and line, what the app says now, and Makera's answer. "Makera" means the
official text above. "Inferred" means a bench look should confirm it first.

**The vise and the wasteboard (the maintainer's point)**

- **C1 · `casemaker-app/src/platform/machineChange.ts:171-173`** (`fitSteps('vise')`). It puts *"the wasteboard back on", "its screws"* before seating the vise. **Makera: the wasteboard comes OFF for the vise** (vise page step 1.3). Delete the `'back'` branch for the vise.
- **C2 · `machineChange.ts:276-296`** (`surfaceChangeFor`). Two problems:
  - Rotary to vise *"restores the newest saved wasteboard surface … and says 'wasteboard under'"* (lines 289-296). It should stay bare-bed.
  - Bed to vise keeps a wasteboard surface (the fall-through at the end). It should make the surface bare-bed and add a "take off the wasteboard" step, as bed to rotary already does.

  The rule should be: **vise, rotary and vacuum bed ⇒ bare bed**, Makera's identical step on all three pages.
- **C3 · `machineChange.ts:124-127` and `:392-394`.** The comments say *"rotary → vise puts it back"* and *"the vise's return puts the board back"*. Both are wrong for the same reason.
- **C4 · `machineChange.ts:139-141`.** The vise take-off adds *"the wasteboard's screws", "the wasteboard on its shelf"* after the vise when `wasteboard === 'off'`. With the vise on, the wasteboard is already off. This case can only arise from the C2 bug.
- **C5 · `casemaker-app/src/components/machine-change/MachineChangeWizard.tsx:266-275`.** `plannedWasteboard === 'back'` renders "wasteboard under" on the confirm step for a vise. It follows C1–C2.
- **C6 · `casemaker-app/src/components/welcome/holdingMounts.ts:196`.** The comment quotes the mockup line *"Vise on the pins · wasteboard under …"*. It should read *"Vise on the pins · bare bed"*.
- **C7 · Design docs, the same line.** Each of these says "wasteboard under" with the vise (or with nothing on the pins after a vise change) and should say "bare bed":
  - `docs/design/first-job-flow.md:116` and `:261`
  - `docs/design/first-job-flow-mockups.html:361` and `:532`
  - `docs/design/bed-mounts-flow.md:100`, `:127` and `:138`
  - `bed-mounts-flow.md:165`, `:206`, `:517` and `:656`: after the vise comes off, the wasteboard is still off unless a step puts it back (see C10).
  - `bed-mounts-flow.md:707`, §10 Q1: now answered by Makera's text and the maintainer, so close it as "bare bed".
- **C8 · `docs/design/rotary-flow.md:205-206`.** *"Take off the vise and the wasteboard … the wasteboard's screws"*. With the vise on, the wasteboard is already off. Step 3 should be "Take off the vise" alone.

**Vise fastening and safety**

- **C9 · `machineChange.ts:139` and `:173`.** *"the two pin bolts"* is wrong. Makera uses **two 4×11 mm locating pins** (pins, not bolts) plus **six M5×20 screws**, and the **left fixed jaw comes off first** so the screws can be reached, then goes back on with its locating key seated.
  - Fit should read: home → power off → cutter out → wasteboard off (if on) → two pins → vise onto the pins → fixed jaw off → six M5×20 → fixed jaw back on (key seated).
  - Take-off is the reverse (inferred).
  - The same "two pin bolts" wording is in `docs/design/first-job-flow.md:235`, `first-job-flow-mockups.html:413`, `rotary-flow.md:206` and `bed-mounts-flow.md:203`.
- **C10 · Power-off for the vise.**
  - Makera starts the vise install with *"Home the machine … then power it off"*, exactly as for the 4th axis and the vacuum bed. `machineChange.ts:136-174` has a power-off line only for the rotary.
  - The wizard's "Make it safe" step (Home, work light on, spindle cold and cutter out; `MachineChangeWizard.tsx:686-720`) covers Makera's "home" and "remove any tool". It does not cover "power it off".
  - Note the conflict with the house rule "work light on for hands in the machine": powering off kills the light. That is a question for the maintainer, not something to fix silently.
- **C11 · `casemaker-app/src/engine/cnc/engrave/runSheet.ts:3390-3392`.** *"Remove the MDF wasteboard. Seat the vise on its two locating pins; fasten with six M5×20 screws."* This is **correct** and matches Makera. It omits:
  - "home, then power off" and "remove any tool" first
  - "remove the left fixed jaw before the screws; refit it with the locating key seated"
  - the 4×11 pin size

  Not a contradiction, but the run sheet and the wizard should use the same words (C9).
- **C12 · `casemaker-app/src/engine/cnc/fixture.ts:398-402`.** `VISE_MOUNT_SCREWS = 4` (PROVISIONAL #520). Makera says **six** M5×20, drawn in two rows of three along the rails in fig. 1.6. The drawing should place 6.

**Rotary**

- **C13 · `machineChange.ts:178-189`** (rotary fit). This matches Makera's order: power off, pins, 3 × M5×10, cable rear-left. It lacks two things:
  - Makera's **"home first"** before power-off. The wizard's step 2 does home, so this is fine in the wizard; the run sheet should say it.
  - The **one-time headstock shipping adjustment** (slide the headstock left, align it to the base, 4 screws). This belongs on the first fit only.
- **C14 · `docs/design/first-job-flow.md:236` and `first-job-flow-mockups.html:416`.** *"onto the pins · the 4th-axis cable · chuck key in the tray"* has **no power-off and no 3 × M5×10**, against Makera's *"Do not plug or unplug the 4th-axis cable while the machine is powered on"*. The code (#706) is right and the first-job doc is stale. Update it to the `rotary-flow.md:207-211` wording.
- **C15 · Chuck jaw count.** The app calls it a **"three-jaw chuck"** in `holdingMounts.ts:20`, `engine/cnc/engrave/setupFlow.ts:90`, `store/engraveJobStore.ts:897` and the schema descriptions (`platform/headless/schemas/engrave-job.json:6433`). No Z1 text says three. The only Makera jaw guide (Carvera) numbers four jaws and turns the scroll 90° between them. Unconfirmed: count the jaws at the bench before keeping "three-jaw" in user-facing text.

**Bracket and wasteboard**

- **C16 · `docs/design/bed-profiles.md:130` and `:248`.** *"Makera kit: bare bed, L-bracket (thin) at anchor 1"*. Makera ships the Z1 **with the MDF bed on**, and its bracket section never removes it (inferred: the bracket sits on the wasteboard; see §4). The "what Makera ships" profile should be **wasteboard + bracket at anchor 1 + 2 top clamps**. `bed-mounts-flow.md:708` (§10 Q2, "the Makera kit profile is bare bed") follows the same assumption and needs a bench look.
- **C17 · Wasteboard size and thickness.** Makera's CAD (`Makera-Z1_MDF-v2.1.STEP`) gives about **206 × 206 × 6 mm** (inferred from the geometry; confirm with calipers).
  - `docs/design/bed-profiles.md:65` uses 200 × 200 × 2.0 as its example. The 2 mm is the in-box *stock* MDF (100×100×2), not the bed.
  - `casemaker-app/src/engine/cnc/bedScene.ts:94-95` reasons from *"a 10 mm wasteboard (−80 + 10 ≈ −70)"*.
  - Neither matches. `BED_TOP_Z = −80` is derived from that 10 mm assumption and is PROVISIONAL. If the bracket seat −70.2 was measured on the MDF, the table top is nearer −76.2 (minus the 6 mm board).
- **C18 · `bed-mounts-flow.md:218-220`** (*"The wasteboard does not move … `surfaceChangeFor` keeps it for every change but the rotary's"*) and `:579`. It must also move for the vise and the vacuum bed (C2). A change *from* the vise or rotary *to* a bracket or tape job needs an explicit "wasteboard back on (four screws)" step if the profile wants it under. Today none exists, because the wizard assumed the board stayed under the vise.
- **C19 · Bracket screw length.** `casemaker-app/src/engine/cnc/mounts/bracket.ts:6`, `bed-mounts-flow.md:16-17`, `:204` and `:534` say *"three M5 screws"*. Makera says **"three M5×20 screws (Use longer screws for the thick bracket)"**, and the kit's longer screw is M5×30. Add the length. `Fabrication.md:95` already has it. The *"two M5 screw heads in its slots"* at `bracket.ts:87` is right: those are the two workpiece screws in the semicircular openings.
- **C20 · Bracket source path.** `bracket.ts:5` cites the capture `docs/market-research/raw/makera/Z1-QuickStart.txt`. It now exists again on this machine, but the folder is gitignored, so the citation should name the URL (https://wiki.makera.com/en/Z1/QuickStart) as well.

**Tape**

- **C21 · Tape thickness.** The default is *"0.1 mm typed"* in `engine/cnc/engrave/jobSetup.ts:698`, `components/welcome/holdingMounts.ts:467` and `types/engraveJob.ts:1086`. Makera's store states *"approximately 0.2mm thick"* for its 20 mm double-sided tape. The thickness of the roll in the box is not published. Make the default 0.2 mm with provenance "Makera store, Strong Fixation tape, ~0.2 mm", or keep 0.1 mm and label it as the house's own figure.
- **C22 · "Tape-down is mutually exclusive with the vise/rotary because the wasteboard is off"** (`Fabrication.md:1741`, `Fabrication.md:56`, `Rotary.md:197-199`). This is the app's own inference, not Makera's. Makera says nothing about tape needing the wasteboard. Exclusivity holds only because the vise and rotary occupy the middle of the table, so state that as the reason.

**Probes**

- **C23 · 3D Probe Rod and the wasteboard.** No app text was found that warns about this. Makera: *"The workpiece must be electrically connected to the aluminum table via locating pins, screws"*. A blank taped to the MDF, or sitting on it, will not register with the 3D Probe Rod unless a screw or pin bridges it. If the app ever offers the 3D Probe Rod for a bed or tape job, it needs that line. The wired probe and the 3D Probe have no such limit.

**Accessories that need no change**

- Vacuum bed: not owned and not built (`Fabrication.md:1543`). When it is built, it follows the same "wasteboard off, pins, 4 × M5×20, its own MDF on top" rule.
- Fixture plate: `docs/design/bed-profiles.md:33,138` lists "Fixture plate" as a surface kind. Makera sells none for the Z1. Keep it as a user-made surface only.
