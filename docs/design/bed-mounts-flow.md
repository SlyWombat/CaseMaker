# Bed mounts — taped, and bracket + clamps (design v1, 2026-10-26)

*The screens an operator meets for a job held on the bed — taped down, or pushed into the bracket's corner
and clamped — from Holding to the run. It extends `first-job-flow.md` (the shipped first-job flow, #679) and
follows its principles and vocabulary exactly; where this document is silent, that one holds. It is the
sibling of `rotary-flow.md` and has the same shape. Mockups: `bed-mounts-flow-mockups.html` beside this file,
one station per screen, with the exact copy. Tracker: #707 (the maintainer asked whether taping to the bed
and the other mounting options are fully supported, then: "Do it"). It folds in #513 (a job binds to the
active bed profile). Status: PROPOSED — no implementation of the screens until the maintainer approves the
flow and the mockups.*

**Source rule.** Every option and default names where it comes from, in one of four words — **M** Makera's
value, **D** derived, **T** typed (Case Maker's default or the operator's), **R** read from the machine or
the location — and the place it was found:

- *Makera's Z1 QuickStart*, as the code quotes its cached capture (`engine/cnc/mounts/bracket.ts` header,
  `src-tauri/src/defaults.rs` seed notes): the L-bracket is pinned at the anchor with two 4 mm dowels and
  three M5×20 screws (the kit's longer M5×30 screws are for the thick bracket); the stock is pushed into its inside corner (its front-left corner); the top clamps hold
  the far side; the work origin is "relative to Anchor 1, X offset 0, Y offset 0". *The Z1 vise page*, as
  `/Fabrication.md` §7.3 reads it: the vise mounts on two 4 × 11 mm pins and six M5×20 screws **after
  removing the MDF wasteboard**. *Makera's accessory list* (`cnc-job-workflow.md` §3, "What Makera sells"):
  top clamp set, side clamps, L-bracket, **20 mm double-sided tape**; in the box, MDF 100 × 100 × 2.
  The captures themselves (`docs/market-research/raw/makera/`) are **not on this checkout** (#626's sweep
  and #607's review found the folder absent); nothing here is quoted from them directly.
- *This machine's config read* (`calibration.ts`, #279): anchor 1 and anchor 2's positions, `anchor_length`
  100 and `anchor_width` 15 (`bed-profiles.md` §3 S0).
- *The shop defaults* (`defaultsClient.ts`, `defaults.rs`): the bracket's and the clamps' sizes, every one
  seeded "default, not measured"; `bracket.seatMachineZ` and `bracket.armTopMm`, measured-only.
- *The engine as built*: `registration/plan.ts` (the tape and bracket touch plans), `mounts/bracket.ts`
  (obstacles, the default clamp places, the mount findings), `mounts/inPath.ts` (`clamp-in-path`,
  `bracket-in-path`), `sacrificial.ts` and `jobSetup.ts` (`through-needs-board`, the 0.3 mm breakthrough),
  `wasteboard.ts` (#417), `engrave/surfaceSpread.ts` (five top touches), `plan/features.ts` (auto-level on
  tape), `platform/machineChange.ts` (#693/#706), `bed-profiles.md` (#509–#514).
- *The market* (`docs/market-research/`): Makera Studio presents the bracket only as an origin preset,
  `Relative to: Anchor1` (`MAKERA-VS-CASEMAKER.md` row "Mount datum"); Makera CAM leaves the retract height
  over fixtures to the operator's arithmetic, and Bantam and MillMage both say their software does not check
  fixtures (`UI-PATTERNS.md` §5); Bantam's setup has a fixturing dropdown and a **tape thickness** field
  (`cnc-job-workflow.md` §3.6); the feature matrix rates workholding Studio P · Carbide Create + Motion Y ·
  Bantam Y · Easel P (`FEATURE-MATRIX.md` §2.E). The per-vendor notes and raw captures behind that row are
  not on this checkout, so this design takes no wording from Carbide Motion or Easel.

A value nobody has published or measured is shown as a value, with its provenance in the Technical fold —
"Makera's value", "read from this machine", "Case Maker's default until calipered", "measured 2026-10-17" —
never guessed silently (`feedback_no_defensive_qualifiers_in_ui`). §10 lists what this design could not settle
and the default it took.

## 0. What exists, and what is missing

| Area | Built | Missing |
|---|---|---|
| Job model | `JobWorkholding` = `vise` \| `rotary-chuck`; the board under the part (`Sacrificial.under`, `attach: 'tape' \| 'glue' \| 'screws' \| 'loose'`); per-setup `MountSpec.kind` = `vise` \| `bracket` \| `tape` (#419) | the bed kinds on the job itself; the tape and the clamp places; the job's bed |
| Holding (`holdingMounts.ts`) | six options; the two bed options are machine-change escapes; with nothing on the pins they read "the job is held in the vise" and write nothing | the bed options as real choices, their lines and pictures |
| Change the machine (#693, #706) | vise ↔ rotary ↔ bed (nothing on the pins); the wasteboard off for the rotary, back for the vise | fitting the bracket at an anchor; the words for a bed job |
| CAM, verifier, simulation | the bracket's arms and the clamps as obstacles and as the sweep's fixture (`bracketMount`, `mountEnvelope`); `clamp-in-path` / `bracket-in-path` on every move, rapids included; the vise envelope replaced on the bracket | the job's own clamp places (today always the two defaults); a clearance; the travel height over the clamps; the bed, the tape and the board drawn; the tape-hold rules |
| Through cuts | `through-needs-board` (a board ≥ breakthrough + 1 mm); `loose-piece` / `released-onto-board`; wasteboard depth and scar findings (#417) | the wasteboard counted as the board under; a board on the bare bed; the free piece held by tape |
| Registration | the tape plan (left edge twice, front edge) and the bracket plan (origin from the anchor, optional right/back confirm, the clamp confirm, `G53` moves); the bracket arm tap, dormant until `bracket.armTopMm` is measured (#607); five top touches and the plane fit (#475, #608) | the plans driven by the job's mount; the bed beside the stock as tape's tap; the seat touch inside Cut the first time |
| Run sheet | nine vise sections ("Remove the MDF wasteboard. Seat the vise…") | the mounting sections for tape and the bracket |
| Bed binding (#513) | the profile model, Switch, "I changed the bed" (#510, #511); `profileHolds` | `job.bed`, the profile version, `bed-changed` and the other findings for bed jobs |

## 1. Principles the screens are held to

**Inherited, unchanged:** first-job §1 items 1–8 — one flow and one numbering ("Step n of 4"; Cut is four
lines); plain language first, the number behind a `Technical` fold; the house's defaults; the blocker at the
button; one vocabulary; units on every field and ≤ 3 decimals; nothing explained twice; the machine's state
is read, and every change to the machine has a wizard of its own.

**Added for the bed mounts:**

9. **A bed job is a first-job job.** No new step and no new mode. The same four steps make it; what makes it a
   bed job is the answer to Holding, which the step already asks. Makera Studio offers the bracket only as an
   origin preset; Bantam asks fixturing and tape thickness at setup. We ask nothing new: Holding's two bed
   options become real choices.
10. **Nothing on the pins, or the job is taken there — and what is under the part is read.** Tape and the
    bracket need the pins clear (`machineChange.ts` `mountTargetFor`: both ask the wizard for `bed`). When the
    vise or the rotary is there, the option carries its cost and the change wizard takes it off and returns.
    The surface under the part (bare bed, wasteboard) is the active bed profile's, shown in Holding's top
    line, never asked again.
11. **What holds the part is drawn where it is, at its height.** The tape, the board under, the bracket's
    arms and each clamp come from one model and are the same shapes in Holding's picture, the Design preview,
    Simulate and the run sheet. A clamp is placed on the picture, not typed as a coordinate
    (`feedback_landmark_geometry_comms`: "the clamp on the back edge, 15 mm in from the left-hand corner").
12. **The cutter keeps clear of what stands above the part.** Every move, rapids included, stays a clearance
    away from each clamp and arm; a move that does not is refused at Generate by name, with the fix in
    physical words ("slide the clamp along the back edge"). Bantam and MillMage say their software does not
    check fixtures; this one does.
13. **Tape holds what it can be shown to hold, and a through cut always has something under it.** A piece the
    tape cannot hold against the cutter is refused at its item (fix: tabs, or a smaller cutter); a through cut
    goes into the wasteboard or into a board under the part, never into the bed.
14. **The bench's numbers are values, used.** The bracket's offset, its arm height, the clamp sizes, the tape's
    hold: Case Maker's or Makera's values until calipered, with provenance in Technical. None of them refuses a
    run; where one decides the XY origin (the bracket's offset from the anchor), a confirming touch measures it
    on every run until it is measured once (the rule `plan.ts` already enforces).

## 2. The flow

```
 Welcome ─ [ Start a cutting job ]
   │
   ▼  NEW CUTTING JOB — one modal, "Step n of 4"
   1 Machine     "Makera Z1 ‘Zoomba’ · Online · Idle · homed" · on the machine now: Vise on the pins · bare bed
   2 Stock       material · form · length X · width Y · thickness Z                                   [Next]
   3 Holding     ○ In the vise …   ◉ On the bed, taped   ○ On the bed, bracket and clamps
   │               └─ needs the vise off the pins · Change the machine… ──▶ back to step 3, the bed drawn
   │             taped:   on the wasteboard · two strips of the 20 mm tape · a board under (through cuts)
   │             bracket: at anchor 1 · two clamps on the back edge (drag on the picture)          [Next]
   4 Operation   unchanged                                                                        [Create the job]
   ▼  DESIGN
   │   the preview draws the bed, the tape or the bracket and clamps
   │   the panel: Job · Cutter · Hold (the bed line) · Generate names a clamp, the tape, the board
   │   SIMULATE: the bed, the tape, the board, the arms and the clamps as solids
   ▼  [ Cut ]
   CUT  1 Checked ✓ · 2 Frozen ✓ · 3 Register the plate ● · 4 Run
          taped:   the bed beside it, the top at five places, the left edge twice, the front edge · 9 touches
          bracket: the bracket's arm, the top, then the right and back edges · 4 touches
        the run sheet: prepare the bed · tape it down / into the bracket and clamp it · the origin
```

## 3. The screens

### 3.1 Step 1 of 4 — Machine

Unchanged. Its existing line "On the machine now" carries the surface, which a bed job reads:

```
 Step 1 of 4 · Machine                                                    [ Close ]
 Makera Z1 “Zoomba” · 192.168.10.43              ● Online · Idle · homed · checked 09:02
 On the machine now: Vise on the pins · bare bed                            [ Check again ]
                                                                          [ Next: stock ]
```

### 3.2 Step 3 of 4 — Holding: the bed options as real choices

**With the vise on the pins** (the house's usual state), the two bed options are shown with their cost, as
today, and are the way into the change wizard:

```
 Step 3 of 4 · Holding                                                    [ Close ]
 On the machine now   Vise on the pins · bare bed · 2 mm MDF boards ×4 · tape   [ Change the machine… ]
 How is the plate held?
 ◉ In the vise, on the jaw ledge            3.81 mm stands 0.71 mm proud of the jaws
 ○ In the vise, on a waste board between the jaws
 ○ In the vise, gripped as a block
 ○ On the bed, taped                        needs the vise off the pins · Change the machine…
 ○ On the bed, bracket and clamps           needs the vise off the pins · Change the machine…
 ○ In the rotary chuck                      needs the rotary on the pins · Change the machine…
```

**What each option writes** (today the two bed rows write nothing; this is the change):

| Option | Writes `workholding` | Writes `sacrificial.under` | Writes `bed` (§3.10) |
|---|---|---|---|
| In the vise, … (three) | `{ kind: 'vise', vise }` — unchanged | unchanged (`applyMount`) | the profile, placement `pl-vise`, manner `jaws` |
| **On the bed, taped** | `{ kind: 'tape', tape: { tapeWidth, tapeThickness, inset, at, source } }` | the board under when there is one (`attach: 'tape'`), else null | the profile, placement null, manner `tape` |
| **On the bed, bracket and clamps** | `{ kind: 'bracket', bracket: { anchor, variant, clamps: ClampPlacement[], source } }` | the board under when there is one | the profile, placement = the anchor placement's id, manner `corner+clamps` |
| In the rotary chuck | `{ kind: 'rotary-chuck', rotary }` — `rotary-flow.md` | null | the profile, `pl-rotary`, manner `chuck` |

The kind words `tape` and `bracket` are the ones the setups engine, the registration planner, `jobMount` and
`bracketMount` already use (`Mount = 'vise' | 'bracket' | 'tape'`), so the job's first setup and its
workholding name the mount one way. `jobMount(job)` reads the workholding when the job has no stored setup.

**After the change wizard has taken the vise off** (§3.3), the step comes back with the bed drawn:

```
 Step 3 of 4 · Holding                                                    [ Close ]
 On the machine now   Nothing on the pins · wasteboard under · 2 mm MDF boards ×4 · tape  [ Change the machine… ]
 How is the plate held?                         ┌ top view of the bed ──────────────────────┐
 ○ In the vise, …     needs the vise on the pins · Change the machine…                       │
 ◉ On the bed, taped                            │   ┌─────────────── wasteboard ───────────┐ │
     two strips of the 20 mm tape, 2 mm in       │   │        ┌──────────────┐               │ │
     from every edge                             │   │        │ plate 76 × 38│ ┊ tape ┊      │ │
   Under it    wasteboard                        │   │        └──────────────┘               │ │
   Board under ( none ▾ )                        │   └───────────────────────────────────────┘ │
   Where       the middle of the bed (drag)      │   front · you                                │
 ○ On the bed, bracket and clamps                └──────────────────────────────────────────────┘
     needs the bracket at anchor 1 · Change the machine…
 ▸ Technical: the tape (Makera's 20 mm roll, ~0.2 mm from its store) · the hold rule · the surface's top
                                                             [ Back ]   [ Next: operation ]
```

- **The default** is the mount the active profile prefers for this stock **among those the bed carries now**
  (`preferredMounting`, bed-profiles S4); with no preference, `cnc-job-workflow.md` §5.2's rule — sheet
  ≤ 3 mm on tape, plates and blocks in the bracket — and then whichever of the two the bed can give without
  another change (tape needs nothing; the bracket needs its anchor placement). On the house's profile after
  the vise comes off, that is tape.
- **What is under the part** is the profile's surface, in the top line's words: "wasteboard under" or "bare
  bed". It is not asked here. Where the vise came off, the surface is what the profile recorded under it —
  §10 Q1 is the one disagreement in the sources about which that is on this machine.
- **No machine record (the web build).** The bed options are offered against the Z1's shipped "Makera kit"
  profile (bare bed, the thin bracket at anchor 1, two top clamps — bed-profiles §7), so a bed job can be
  authored and simulated; the Hold line says "On the bed · the Z1's bed" and nothing else (as
  `rotary-flow.md` principle 10 does for the rotary).

### 3.3 Change the machine → the bed

The #693 wizard already takes the vise off for `bed` (`takeOffSteps('vise')`, `fitSteps('bed') = null`). It
gains one fit step for the bracket and the bed job's words:

```
 Change the machine · Vise off · bracket on                                 [ Close ]
 1 What changes      Vise on the pins → Nothing on the pins, bracket at anchor 1
                     for: Tray, held in a bracket and clamps on the bed
 2 Make it safe      ● Home   $H · Idle · homed ✓   ● Work light on  M821 ✓   ● Spindle cold, cutter out ✓
 3 Take off the vise ○ the left fixed jaw off  ○ the six M5 × 20 screws  ○ lift it straight up off the two pins  ○ on its shelf [Done]
 4 Fit the bracket   ○ the thin L-bracket into anchor 1's corner   ○ its two 4 mm dowels
                     ○ its three M5 × 20 screws   ○ two top clamps in the tray                           [Done]
 5 Confirm           the bed is now: Nothing on the pins · bracket at anchor 1 · wasteboard under
                     written to the machine's record: 2026-10-26 09:20 · vise off, bracket on · for Tray
                     ● Work light off · ● Home                                        [ Back to the job ]
```

- **For a taped job** step 4 is absent and step 5 reads "the bed is now: Nothing on the pins · wasteboard
  under". Tape needs nothing fitted.
- **Step 4 for the bracket** appears only when the profile has no anchor placement; it writes one
  (`where: { kind: 'anchor', anchor: 1 }`, the thin bracket's fixture record, Makera kit's variant). The words
  are the QuickStart's as the code quotes them: two 4 mm dowels and three M5×20 screws (longer for the thick bracket). Anchor 1 is the default
  (Makera's origin is "relative to Anchor 1"); anchor 2 is a choice in step 1 (`anchor 2 = anchor 1 + its
  offset, read from the machine`).
- **The wasteboard and the fixtures are mutually exclusive (Makera, #717).** The vise and the 4th
  axis each mount on the **bare bed** — both pages begin "Remove the MDF wasteboard" — so a change to
  either takes the board off and never puts it back. The one change that puts it back is a change to
  a bed job (nothing on the pins), which adds a "the wasteboard back on" step (`fitSteps('bed')`):
  the bed job then reads what is under it and plans the board under (§3.5). §10 Q1–Q2.
- **The clamps go on after the stock** (run sheet §3.9); the wizard only checks they are in the tray.
- Bench rules as in every change: home before hands in the machine, the work light on, home when done.

### 3.4 Holding — taped: the tape, its footprint, and the hold

```
 ◉ On the bed, taped
     two strips of the 20 mm tape, 2 mm in from every edge
   Under it    wasteboard
   Board under ( none ▾ )      none · 2 mm MDF (×4) · typed…
   Where       the middle of the bed (drag on the picture)
   Square to   the front edge of the bed
```

- **The footprint.** The tape runs in strips along the stock's length, side by side, inside the footprint,
  **2 mm in from every edge** (`tape.insetMm`, T). Inside, because the edge scans touch just past each edge
  (`plan.ts`: a scan brackets the edge from ON the stock to OFF it), and tape past an edge would be read as a
  step and cut into by a profile. Strips: `ceil((width − 2 × inset) / tape width)`, the last trimmed — two
  for the badge's 38.1 mm. The tape's width is the house's roll (R `consumables.tape.widthMm`), Makera's
  20 mm by default (M accessory list); its thickness is ~0.2 mm — Makera's store page for the 20 mm
  tape states "approximately 0.2mm thick" (C21) — typed on the profile until a coupon measures the
  roll in hand.
- **The hold rule — side load against footprint.** The cutter pushes the stock sideways with a force that
  grows with its bite — its diameter times the deepest pass's step-down — and tape resists with its area. So:

  > **taped area ≥ hold ratio × (cutter ⌀ × step-down)**, hold ratio **100** (`tape.holdRatio`, a shop
  > setting with a per-job recommendation, `feedback_thresholds_setting_plus_recommendation`).

  The ratio is the one unknown, T Case Maker's default until a tape coupon at the bench measures it (§7). For
  the badge on a ⌀1 mm flat end at 0.5 mm: 72.2 × 34.1 = 2 462.02 mm² taped, 50 mm² needed — holds. For a
  ⌀3.175 mm flat end at 1 mm a pass: 317.5 mm² needed, about an 18 × 18 mm piece. The rule is checked at
  Generate, when the cutter and passes are known (§3.7), against **the stock** and against **every piece a
  through cut leaves free** (the `loose-piece` / `released-onto-board` analysis, #218): a released piece
  that passes needs no tabs — tape is why a bed job can cut a part out clean.
- **Tall stock on tape** (a warning, not a refusal): a stock taller than its narrowest width is levered off
  tape by the same side load at its top — *"The block is 30 mm tall and 25 mm wide: tape alone may let it tip
  — hold it in the bracket and clamps."* (D, the moment arm; the bracket is the fix the bed already has).
- **Squareness.** Nothing on tape fixes rotation; registration measures it (left edge twice), and the program
  is not rotated, so the turn must stay inside the edge margin (`margins.edgeMarginMm`, 1 mm, T). The line
  "Square to: the front edge of the bed" is the instruction, and Cut refuses a plate taped crooked (§3.8).
- **Where.** The default spot is the middle of the surface (the wasteboard's footprint, or the work area on the
  bare bed): clear of the anchors, the pins and any scar. Dragging it on the picture moves the expected
  position the registration starts from; the probe finds the real one.
- **The picture** is the bed seen from above: the surface (the wasteboard as a slab when it is under, its
  scars faint), the stock where it will go, the tape strips dashed under it, the board under when chosen,
  "front · you" at the bottom. It is the bed scene of bed-profiles §4 with the stock on it.

### 3.5 The board under — and the through-cut rule

```
   Board under ( 2 mm MDF ▾ )   the through cut goes into the board, not the bed
               tape the board to the bed, then the plate to the board
```

- **A through cut needs something under it to cut into** (`through-needs-board`: at least breakthrough + 1 mm
  = 1.3 mm, with the 0.3 mm breakthrough, T `DEFAULT_BREAKTHROUGH`). On the bed that is:
  - **the wasteboard, when it is under.** The wasteboard is the machine's sacrificial board (decision Q7); the
    through gate counts it as the board under, and its own findings apply: the cut may go `wasteboard.
    depthLimitMm` (0.5 mm, T) into it, the scar is recorded after the run (#417), and a cut over an existing
    scar is warned. Board under: **none** is the default.
  - **a board, on the bare bed.** The board under is **required** for a through cut; the default is the
    thinnest house board that is thick enough (R `consumables.boards`: 2 mm MDF ×4; Makera's box carries
    MDF 100 × 100 × 2). The stack is **bed · tape · board · tape · plate**: the board is taped to the bed, the
    plate taped to the board. No through cut → none, and the option is not shown.
- **The board must cover the stock.** A stock larger than the board in either direction is refused at the
  field: *"The 2 mm MDF boards are 100 × 100 mm; this plate is 120 mm long — tape it to the wasteboard, or
  choose a larger board."* (D, the board's size from the consumable).
- **The stack enters Z only as the registration's expectation.** Depths are measured from the probed top
  (decision 24); the stack (tape ~0.2 + board 2 + tape ~0.2 + plate) is where the surface touch expects the top,
  and the tape's thickness is recorded on the job (bed-profiles Q C).
- **Bracket jobs use the same rule.** The board sits inside the bracket under the stock; it lifts the stock,
  so the arms stand that much lower above the top (`bracketObstacles(…, underMm)`, built).

### 3.6 Holding — bracket and clamps: the corner, the clamps, their heights

```
 ◉ On the bed, bracket and clamps               ┌ top view ─────────────────────────────────────┐
     the plate in the bracket's corner at anchor 1│        ▬▬ clamp        ▬▬ clamp               │
   Bracket   thin, at anchor 1                  │ ┃┌──────────────────────────────────────┐      │
   Clamps    2 top clamps · 12 mm tall          │ ┃│  plate 100 × 60 × 6                  │      │
             drag a clamp along the back or      │ ┃│                                      │      │
             right edge · [ + clamp ]            │ ┃└──────────────────────────────────────┘      │
   Board under ( none ▾ )                        │ ┗━━━━━━━━━━━━ front arm ━━━━━━━━━━━━━━━━━      │
   the arms stand 4 mm above the plate           │ X 0 · Y 0 at the bracket's corner     front · you │
 ▸ Technical: the bracket and clamp sizes (Makera's and Case Maker's, until calipered) · anchor 1 read from this machine
```

- **The bracket's corner is X 0 · Y 0.** The work origin is the stock's front-left corner, pushed into the
  bracket's inside corner, at anchor 1 plus the bracket's offset from it (`bracketDatum`): the anchor is read
  from this machine (R), the offset is Makera's 0, 0 (M QuickStart) until measured. Z 0 is the stock's top,
  probed. The picture prints "X 0 · Y 0 at the bracket's corner" at the corner, not as a sentence.
- **The clamps** go on the free edges — back and right; the bracket holds the front and the left
  (`ClampEdge = 'back' | 'right'`). **Default: two top clamps on the back edge, 15 mm in from each corner**
  (`defaultClampPlacements`: M QuickStart "the top clamps hold the far side"; 15 mm, T
  `clamps.topInFromCornerMm`, chosen). **Editing is on the picture:** each clamp is a handle dragged along an
  edge and across the corner onto the other free edge; `+ clamp` adds one on the longer free edge, a clamp's
  `×` removes it; one to four. The label under a selected clamp is its landmark sentence ("the clamp on the
  back edge, 15 mm in from the left-hand corner", `clampLabel`). The job stores the places
  (`bracket.clamps`), and **the CAM, the verifier, the simulation and the registration read the job's
  places**, not the defaults (today `bracketMount` always uses the defaults: §8 BM-6).
- **Clamp heights and sizes are obstacles.** Each clamp is a box: its footprint (30 × 15 mm, reaching 8 mm onto
  the stock) from the bed up to its top, 12 mm above the stock's top (`clamps.top*`, T, "default, not
  measured"); the arms are 100 mm long and 10 mm wide, their top 10 mm above the surface (T seeds; §10 Q7 on
  the width). The main line says "12 mm tall" once; the sizes are in Technical.
- **The mount's own checks** show under the picture, as they are built (`validateBracketMount`) and in the
  operator's words: a clamp hanging past the end of its edge (*"the clamp on the back edge hangs past the end
  of the 60 mm edge — it would not hold"*, error); two clamps on top of each other (error); a stock longer
  than the arm (*"the plate's front edge is 120 mm and the bracket's arm 100 mm: the edge is squared only along
  the arm"*, warning).
- **The arms above the stock.** When the arms stand above the stock's top (a 6 mm plate in a 10 mm bracket:
  4 mm), the line says so once — "the arms stand 4 mm above the plate" — and Generate refuses a cut that comes
  within the clearance of them (§3.7). With a board under, the number drops by the board.
- **Side clamps** (Makera sells them) are not offered in v1: no job has asked (`feedback_demand_driven_features`;
  §10 Q6).

### 3.7 Design — the panel's Hold group, and Generate's blockers

The panel keeps its three groups (first-job §3.6). The Hold group is one line per mount; `edit` re-enters
Holding.

```
 ├ HOLD ──────────────────────────────────────────────────────────────────── closed ┤
 │ On the bed, taped · wasteboard under · 20 mm tape · the middle of the bed   ▸ edit │
 ├ HOLD ──────────────────────────────────────────────────────────────────── closed ┤
 │ On the bed, taped · bare bed · a 2 mm MDF board under · 20 mm tape          ▸ edit │
 ├ HOLD ──────────────────────────────────────────────────────────────────── closed ┤
 │ Bracket at anchor 1 · 2 clamps on the back edge, 12 mm tall · X 0 Y 0 at its corner  ▸ edit │
```

The Design preview draws the bed under the stock: the surface, the tape strips (thin, under the stock), the
board, the bracket's arms and each clamp at its height, from the same boxes the verifier checks.

**The clearance.** Every clamp and arm is grown, for every move, by the widest part of the tool alongside it
(the cutter or its shank, `inPath.ts`), the mount's fit (0.1 mm, T `bracket.fitMm`) and **the fixture
clearance, 1 mm** — the job's jaw clearance (`margins.jawClearanceMm`, chosen, a new job's copy of the shop
value), renamed "fixture clearance" in the panel because it now applies to clamps and arms too. **The travel
height** of a bracket program is at least the tallest clamp's top plus the clearance (13 mm above the plate
for the defaults); a rapid below it over a clamp is refused as a cutting move is (`clamp-in-path` counts
rapids).

**Generate's blockers, in the first-job form** (the sentence + Fix, at the button; codes and line numbers in
the program's Technical fold only):

| Blocker | Sentence | Fix → | Code (built / new) |
|---|---|---|---|
| a cut under a clamp | *"“Tray” runs under the clamp on the back edge, 15 mm in from the left-hand corner — slide the clamp along the back edge, or move it to the right edge, clear of the cut."* | the Hold picture, that clamp selected | `clamp-in-path` (built; words new) |
| a cut into an arm | *"“Tray” comes within 1.2 mm of the bracket's front arm, which stands 4 mm above the plate — keep the cut 2.688 mm inside the front edge."* | the item | `bracket-in-path` (built; words new) |
| the tape cannot hold a piece | *"“Star” is cut free as a 12 × 12 mm piece; the tape under it cannot hold it against the ⌀ 3.175 mm flat end — leave two tabs, or cut it with a smaller cutter."* | the item's tabs | `tape-hold-piece` (new) |
| the tape cannot hold the stock | *"The tape under this 15 × 10 mm plate cannot hold it against the ⌀ 3.175 mm flat end — clamp it in the bracket, or cut it with a smaller cutter."* | Hold | `tape-hold-stock` (new) |
| a through cut over the bed | *"“Outline” cuts through the sheet, and only the bed is under it — put a 2 mm MDF board under it, or tape it on the wasteboard."* | Hold, Board under | `through-needs-board` (built; words new) |
| the board is too small | *"The 2 mm MDF boards are 100 × 100 mm; this plate is 120 mm long — tape it to the wasteboard, or choose a larger board."* | Hold | `board-too-small` (new) |
| tall on tape (warning) | *"The block is 30 mm tall and 25 mm wide: tape alone may let it tip — hold it in the bracket and clamps."* | Hold | `tape-tall-stock` (new) |

The hold numbers ("2 462.02 mm² taped; 50 mm² needed at 100 × the cutter's bite") sit in the finding's
Technical line. Each new code gets its cnc-guide chapter-8 row (`feedback_new_diag_code_guide_row`).

**The vise-only checks are skipped for bed jobs**: no jaw envelope, no `vise-*` findings, no "X runs between
the jaws"; the fixture is the bracket's boxes or, on tape, none (`toSetup`'s `fixture` already replaces the
vise envelope on the bracket; tape passes an empty envelope).

### 3.8 Simulate — the bed, the tape, the bracket, the clamps

```
 ┌ Simulate ────────────────────────────────────────────────── [ Top | Side ] ┐
 │   ▬▬ clamp 12 mm        ▬▬ clamp 12 mm                                     │
 │ ┃ ┌──────────────── plate ─────────────────┐                               │
 │ ┃ │      ▒▒▒▒▒▒▒ Tray ▒▒▒▒▒▒▒               │   wasteboard                  │
 │ ┃ └────────────────────────────────────────┘                               │
 │ ┗━━━━ bracket ━━━━                                                         │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ▶ ━━━━━━━━━━━━━━━●──────────────  step 1 412 of 3 980   Z −1.5 mm          │
 │ Matches the design ✓   ▸ Technical: grid · what was not checked             │
 └────────────────────────────────────────────────────────────────────────────┘
```

- **What is drawn**, from the job's mount, in the simulation's fixture grey with provenance by line style
  (solid measured or Makera's, dashed Case Maker's default until calipered — the bed scene's rule, #511):
  the bed plate; the wasteboard slab when it is under, its scars faint; the board under; the tape as a thin
  layer under the stock (~0.2 mm, drawn 0.5 mm so it is visible, labelled with its true thickness); the
  bracket's two arms; each clamp at its place and height. The camera frames the stock and its mount, not the
  whole bed.
- **Side** shows the stack with each height labelled: "plate 2 · tape ~0.2 · board 2 · tape ~0.2 · bed", and the
  breakthrough into the board drawn (0.3 mm) with the board's floor.
- **A collision is drawn where it happens.** A move that reaches a clamp or an arm is never generated (Generate
  refuses it), but a program **opened from a file** is simulated against the job's mount: the clamp turns red
  at the first move into it, the scrubber stops there, and the line reads *"Move 1 412 takes the cutter into the
  clamp on the back edge, 15 mm in from the left-hand corner. The simulation stops there."*
- **Through cuts** show the cut piece released onto the tape, drawn in place, and the scar the cut will leave on
  the wasteboard ghosted where it lands.
- **The oracle line** is unchanged from the flat jobs (first-job §3.6, #691): the bed mounts change what holds
  the part, not how the cut is judged.

### 3.9 Cut — registration on each mount

The existing plans, driven by the job's mount (`registrationFor(setup, mount)` with `mount.kind` from the
workholding). One touch per instruction (`feedback_bench_one_step_at_a_time`); home before hands in the
machine, the work light on, home when done.

**Taped — 9 touches:**

```
 ● 3 Register the plate    the bed beside it, the top at five places, the left edge twice, the front edge · 9 touches
     [ I am at the machine, the probe is fitted ]   [ Start registering ]
```

1. **The bed beside it** — the surface's top, 10 mm in front of the stock's front edge at its middle (T
   `tape.surfaceTapOffsetMm`: past the front scan's 5 mm outward look, so the two never share a spot). It is
   tape's mount tap: it writes the profile's `surfaceTopZ` with the probe's id and date (bed-profiles §2; the
   v2 write-back of #600), and with it the next touch's expected height. With no surface top measured yet it
   is a search down from the travel height (registration v2, #592), not a band.
2. **The top at five places** — the cut area's centre and its four extents (`surfaceSpreadPlan`,
   `DEFAULT_SURFACE_TOUCH_COUNT` 5). Taped stock does not sit dead flat (`autoLevelRule`: on for tape); a tilt
   that fits a plane is posted against (#608); one that does not is the existing spread refusal. This
   replaces the `G32` auto-level on tape until that sequence is proven (#176).
3. **The left edge twice** — position and turn (`plan.ts`: `mount === 'tape'` scans the left edge at two
   points).
4. **The front edge** — Y.

What the result does, in the operator's words:
- **The stack check:** the top less the bed beside it, less the stock's thickness, is the tape and board under
  it — *"the plate sits 0.12 mm above its thickness: the tape"* on the Found line. More than the stack plus the
  surface tolerance refuses: *"The plate sits 0.6 mm higher than the tape and its thickness allow — a chip or a
  fold of tape under it. Lift it, clean both faces and press it down again."* (D; the band is the registration's
  `surfaceToleranceMm`).
- **The turn:** within the edge margin, the origin follows the found corner; beyond it, *"The plate is turned
  1.2° — its far end is 1.6 mm off square, more than the 1 mm edge margin. Lift it and tape it square to the
  bed's front edge."* (built: `rotationShiftMm` against `edgeMarginMm`; the program is not rotated).

**Bracket and clamps — 4 touches:**

```
 ● 3 Register the plate    the bracket's arm, the top, then the right and back edges · 4 touches
     ☐ the clamps are where the picture puts them: two on the back edge, 15 mm in from each corner
     [ I am at the machine, the probe is fitted ]   [ Start registering ]
```

1. **The bracket's arm** — the front arm's top face at the middle of its exposed length (`bracketTapPoint`,
   #607): confirms the bracket is on and writes the seat back. It is offered when `bracket.armTopMm` has been
   measured (once, at the bench); **until then touch 1 is "the bed beside the bracket"**, the seat itself
   (`bracket.seatMachineZ` / the profile's `bracketSeatZ`), taken inside Cut instead of today's refusal that
   sends the operator off to touch it by hand. Either way, one touch.
2. **The top** — at the cut area's centre, clear of every clamp grown by the probe's rim (the plan's
   surface-point check, built). Z 0.
3. **The right edge, then the back edge** — the confirming touch, scanned on lines clear of the clamps
   (`clearLine`); they confirm the plate is pushed into the corner and never move the origin. **Required
   while the bracket's offset from the anchor is not measured** (built: `plan.ts` refuses without it); once
   the offset is measured they are a tick, off by default, and the line reads "the bracket's arm, the top · 2
   touches".

- **The clamp check before anything moves sideways** is the existing confirm-mount prompt, now a tick on the
  step in the picture's words: "the clamps are where the picture puts them: two on the back edge, 15 mm in
  from each corner". The executor's `mountConfirmText` keeps its sentence for the console.
- **XY are the bracket's** (anchor 1 read from this machine + the offset); every XY move is sent in machine
  coordinates (`G53`, built). The Found line says *"X and Y from the bracket; the confirming touch found the
  right edge 0.04 mm and the back edge 0.07 mm from where the corner puts them"* (`summarizeOutcome`, built).
- **A clamp too tall for the probe's travel** is the plan's own refusal, in words: *"The clamp on the back edge
  stands 12 mm above the plate, up to the probe's travel height — use lower clamps or thinner stock."*

**The Run line** is first-job's for both mounts: *"vacuum on · fit the ⌀ 3.175 mm flat end · about 6 min"*.
Nothing about a bed mount refuses the run once registration is done (principle 14).

### 3.10 The job binds to the active bed (#513, folded in)

- **What the job stores** (bed-profiles §6, #513): `bed: { machineId, bedProfileId, profileVersion,
  placementId, manner }` plus a snapshot of the datums it used (`surfaceTopZ`, `bracketSeatZ`, the anchor
  read). **`profileVersion` is the `at` of the profile's last history entry** — the profile has no version
  field (#513's review); a change, a Measure or "I changed the bed" each add a history line and so a version.
  `workholding` and the setups' `MountSpec` stay the compatibility reading (the #419 pattern).
- **Holding writes it** when the step is left (any of the six mounts); Generate re-reads it; the receipt
  carries `bedProfileId` / `profileVersion` (#478).
- **On load, and at Cut step 1,** a job whose profile is not the machine's active one says so in words, with the
  two actions — the change wizard, or holding it in what is there:

  ```
  This job was set up on “Nothing on the pins · wasteboard under” (2026-10-26 09:20); the machine now has the
  vise on the pins.            [ Change the machine… ]   [ Hold it in what is there ]
  ```

  In Design it is a note; at Cut it blocks step 1 (`bed-changed`, error before a run, warning in design). The
  sentence lists the differences in the change wizard's words ("the vise is on the pins", "the wasteboard was
  replaced on 10-20, its top is not measured").
- **The other #513 findings, for bed jobs:** `mount-not-on-bed` (*"the bracket is not on the bed — Change the
  machine…"*), `surface-top-unmeasured` (no longer a refusal on tape or the bracket: touch 1 measures it),
  `stock-off-surface` (*"the plate hangs 12 mm off the wasteboard's front edge"*, warning), `bed-unmeasured`
  (info, the calipers list), `fixture-overlap` (the bed scene's).
- **Readers move onto the profile:** the expected surface (surface top + stack, or the bracket seat), the
  obstacles (the anchor placement + the job's clamps), the wasteboard findings (the surface's footprint and
  scars), the run sheet's stack line.

### 3.11 The run sheet — the mounting sections

The run sheet's §2 "Mount the vise" and §3 "Load the blank" become the mount's own (`runSheet.ts`); every
number keeps its source in the sheet's column.

**Taped:**

```
 2  Prepare the bed           Nothing on the pins · wasteboard under. Wipe the wasteboard and the plate's
                              underside clean and dry.
 3  Tape the plate down       two strips of the 20 mm tape along its length, 2 mm in from every edge ·
                              the plate in the middle of the bed, square to its front edge · press it down
                              firmly for ten seconds · tape ~0.2 mm
       (with a board)         tape the 2 mm MDF board to the bed first, then the plate to the board —
                              the board under the whole plate
 5  The origin                X 0 · Y 0 at the plate's front-left corner and Z 0 on its top, found by the
                              probe (9 touches)
 9  After the run             $H · lift the part with a thin blade; peel the tape · the wasteboard's new mark
                              is recorded
```

**Bracket and clamps:**

```
 2  Mount the bracket         Nothing on the pins. The thin L-bracket in anchor 1's corner: two 4 mm dowels,
                              three M5 × 20 screws.
 3  The plate in the bracket  push the plate into the bracket's corner — front edge against the front arm,
                              left edge against the left arm, flat on the bed · two top clamps on the back
                              edge, 15 mm in from each corner · tighten them
 5  The origin                X 0 · Y 0 at the bracket's corner (anchor 1, read from this machine 2026-10-07);
                              Z 0 on the plate's top, probed · the clamps stand 12 mm above it; travel at 13 mm
 9  After the run             $H · loosen the clamps · the bracket stays for the next plate
```

- The tape's "clean both faces, two strips, press for ten seconds, note the tape thickness" and the bracket's
  "push the stock into the bracket's corner on both faces, clamps on the back edge at the marked places" are
  `cnc-job-workflow.md` §5.8's words. The 2 mm MDF board and its size are the house's (R); the dowels and
  screws, Makera's (M QuickStart); the tape thickness, typed; the clamp height, Case Maker's default.
- **Need list (§1):** "20 mm double-sided tape" for tape; "two top clamps and their screws" for the bracket;
  "a thin blade" for tape.
- **Vacuum on** for every cut (`feedback_vacuum_default_on_cuts`), unchanged.

## 4. Vocabulary additions (to first-job §4)

| Thing | Word | Not |
|---|---|---|
| the two bed mounts | "On the bed, taped" · "On the bed, bracket and clamps" | tape-down, anchor-bracket, corner+clamps, bed-tape, bed mount |
| nothing on the pins | "Nothing on the pins · wasteboard under" / "· bare bed" | bed kind, bed mode, `bed` |
| the machine's MDF plate | the **wasteboard** | spoilboard, MDF plate, sacrificial bed |
| the board under a taped part | a **board under** ("a 2 mm MDF board under") | sacrificial under, shim, spacer |
| the tape | tape · "two strips of the 20 mm tape" (the run sheet's need list says "20 mm double-sided tape" once) | DST, adhesive, double-sided |
| the L-bracket | the **bracket** · "at anchor 1" · its front arm · its left arm · its corner | anchor bracket, L-bracket (only in the run sheet's mount line), fixture, jig |
| the anchor | anchor 1 · anchor 2 (Makera's word) | anchor hole, datum pin |
| a clamp | a clamp · "the clamp on the back edge, 15 mm in from the left-hand corner" | top-clamp, hold-down, obstacle, clamp-1 |
| how far a cut stays from them | the **fixture clearance** · "clear of the clamps by 1 mm" | keep-out zone, envelope, obstacle box, grow |
| the origin on the bracket | "X 0 · Y 0 at the bracket's corner" | anchor-relative origin, G54 from anchor |
| the tape's grip | "the tape under it cannot hold it against the ⌀ 3.175 mm flat end" | hold ratio, side load, shear (Technical only) |
| refusal words | "runs under the clamp…" · "comes within … of the bracket's front arm" · "the tape under it cannot hold it" · "cuts through …, and only the bed is under it" · "was set up on …; the machine now has …" | `clamp-in-path`, `bracket-in-path`, `tape-hold-*`, `through-needs-board`, `bed-changed` |

## 5. Options matrix — every option a bed job exposes

*Default* is what the job gets with no answer. *From*: **M** Makera's value (where), **D** derived (from what),
**T** typed (Case Maker's default or the operator's), **R** read from the machine or the location. *Bench?*
marks a value a measurement replaces.

| Screen | Option | Default | From | Bench? |
|---|---|---|---|---|
| Holding | The mount | the profile's preferred mount the bed carries now; else sheet ≤ 3 mm → tape, plates and blocks → bracket; else tape | R `preferredMounting` + D `cnc-job-workflow.md` §5.2 | — |
| Holding | Under it | the profile's surface (wasteboard under / bare bed) | R active bed profile | answered: bare bed under the vise (§10 Q1) |
| Change | Pins cleared for a bed job | vise or rotary off | R `mountTargetFor` (both bed mounts → `bed`) | — |
| Change | The wasteboard on a change to the bed | off for the vise and the rotary; back on for a bed job | M Makera's install steps; R `surfaceChangeFor` | §10 Q1–Q2 |
| Tape | Tape width | 20 mm | M Makera's 20 mm tape; R `consumables.tape.widthMm` | — |
| Tape | Tape thickness | ~0.2 mm | M Makera's store (~0.2 mm); T typed on the profile until a coupon measures the roll | yes |
| Tape | Layout | strips along the length, 2 mm in from every edge | D the edge scans land just past each edge (`plan.ts`) + T `tape.insetMm` 2 | — |
| Tape | Strips | ceil((width − 2 × inset) / tape width) | D | — |
| Tape | Where on the bed | the middle of the surface | T | — |
| Tape | Square to | the bed's front edge | D the program is not rotated; the turn must sit inside the edge margin | — |
| Tape | Hold ratio | 100 × (cutter ⌀ × step-down) of taped area | T shop setting `tape.holdRatio`, per-job recommendation | yes, tape coupon §7 |
| Tape | Tall-stock warning | height > narrowest width | D the side load's moment at the top | — |
| Board | Board under, on the wasteboard | none — the wasteboard takes the through cut | D decision Q7 (the wasteboard is the sacrificial board) | — |
| Board | Board under, on the bare bed, through cut | the thinnest house board ≥ breakthrough + 1 mm (2 mm MDF) | D `through-needs-board` + R `consumables.boards` (M Makera's box: MDF 100 × 100 × 2) | — |
| Board | Breakthrough | 0.3 mm | T `DEFAULT_BREAKTHROUGH` (provisional) | yes |
| Board | Into the wasteboard, at most | 0.5 mm | T `wasteboard.depthLimitMm` | — |
| Bracket | Variant | thin | M Makera kit profile (bed-profiles §7) | — |
| Bracket | Anchor | 1 | M QuickStart "relative to Anchor 1" | — |
| Bracket | Anchor position | this machine's anchor 1 | R config read (#279) | — |
| Bracket | Corner's offset from the anchor | 0, 0 | M QuickStart X offset 0, Y offset 0 (`bracket.originOffset*`) | yes |
| Bracket | Fit | ±0.1 mm | T `bracket.fitMm` | yes |
| Bracket | Arm length | 100 mm each | M the 100 mm plate Makera ships for it; R config `anchor_length` 100 | yes |
| Bracket | Arm width | 10 mm | T seed `bracket.armWidthMm`; the config reads `anchor_width` 15 — §10 Q7 | yes |
| Bracket | Arm height | 10 mm (to the screw heads) | T `bracket.heightMm` | yes |
| Bracket | Arm top for the tap | none until measured | measured-only `bracket.armTopMm` (#607) | yes |
| Bracket | Seat | none until touched | measured-only `bracket.seatMachineZ` / `bracketSeatZ` | touch 1 in Cut |
| Clamps | Count and places | 2 on the back edge, 15 mm in from each corner | M QuickStart "top clamps hold the far side" + T `clamps.topInFromCornerMm` | — |
| Clamps | Edges allowed | back, right | D the bracket holds front and left (`ClampEdge`) | — |
| Clamps | Size, reach, height | 30 × 15 mm, 8 mm onto the plate, 12 mm above it | T `clamps.top*` seeds | yes |
| Clamps | Side clamps | not offered | T demand-driven (§10 Q6) | — |
| CAM | Fixture clearance | 1 mm | T the job's jaw clearance (`margins.jawClearanceMm`), renamed | — |
| CAM | Obstacle grow | tool radius (or shank) + fit + clearance | D `inPath.ts` + the clearance | — |
| CAM | Travel height on the bracket | tallest clamp top + clearance (13 mm) | D | clamp height |
| Simulate | Fixture drawn | the job's surface, board, tape, arms, clamps | R/D | — |
| Simulate | Tape drawn | 0.5 mm, labelled ~0.2 mm | T display only | — |
| Cut | Taped touch plan | bed beside 1 · top 5 · left 2 · front 1 = 9 | D `plan.ts` tape row + `surfaceSpreadPlan` 5 + the surface tap | — |
| Cut | Surface tap offset | 10 mm in front of the front edge | T `tape.surfaceTapOffsetMm` | — |
| Cut | Bracket touch plan | arm (or bed beside) 1 · top 1 · right 1 · back 1 = 4 | D `plan.ts` bracket row (confirm required while the offset is unmeasured) + #607 | offset measured → 2 |
| Cut | Turn on tape, at most | the edge margin, 1 mm over the length | T `margins.edgeMarginMm` | — |
| Cut | Stack check band | the registration's surface tolerance | R registration settings | — |
| Bed | Profile version | the `at` of the last history line | D #513 review | — |
| Run sheet | Mount words | the QuickStart's and `cnc-job-workflow.md` §5.8's | M + T | — |

## 6. Simulate before the bench

Each mount gets fixture jobs that are generated, verified and simulated in the app and in the unit suite, with
oracles that need no bench number. No machine on the network.

| Fixture job | What it proves | Oracle |
|---|---|---|
| **1. Taped badge** — PLA plate 76.2 × 38.1 × 3.81 mm, on the bed, taped, on the wasteboard, no board; `Engrave text “Zoomba”` 0.5 mm, ⌀ 1 mm flat end; every default | the whole taped flow; the hold passes; no fixture obstacle; the vise checks skipped | the flat engraving's oracle, unchanged (golden: the same floors as the vise badge); taped area 2 462.02 mm² ≥ 50 mm²; expected top = surface top + 0.1 + 3.81; the plan is 9 touches in the §3.9 order; the run sheet's §2/§3 read the taped words |
| **2. Through-cut tag on tape over a board** — PLA sheet 80 × 60 × 2 mm on the **bare bed**, a 2 mm MDF board under; `Profile` cut-out “Tag”, a 40 × 30 mm rounded rectangle, no tabs; ⌀ 3.175 mm flat end, 1 mm a pass | the board rule, the stack, a released piece held by tape | the kerf's floor at Z −2.3 (0.3 into the board), nothing below −4; released piece 36 × 26 = 936 mm² ≥ 317.5 mm² — no `loose-piece`, no tabs asked; expected top = bed + 0.1 + 2 + 0.1 + 2 |
| 2a. the same, **no board** | the refusal | Generate's sentence *"“Tag” cuts through the sheet, and only the bed is under it — put a 2 mm MDF board under it, or tape it on the wasteboard."*, Fix → Hold |
| 2b. the same, cut-out “Star” 12 × 12 mm | the tape-hold refusal | *"“Star” is cut free as a 12 × 12 mm piece; the tape under it cannot hold it against the ⌀ 3.175 mm flat end — leave two tabs, or cut it with a smaller cutter."* (64 mm² < 317.5 mm²); with two tabs it generates |
| 2c. the same on the **wasteboard**, no board | the wasteboard as the board | generates; the wasteboard finding: 0.3 mm in, under the 0.5 mm limit; the scar footprint ready to record |
| **3. Bracket pocket with a clamp in the path** — PLA plate 100 × 60 × 6 mm in the thin bracket at anchor 1, two clamps at the defaults (back edge, 15 mm in from each corner: X 15–30 and 70–85, reaching Y 52–60 on the plate); `Pocket “Tray”` 70 × 30 × 2 mm at X 15–85, Y 25–55; ⌀ 3.175 mm flat end | the clamps as obstacles with the clearance; the refusal at Generate | **refused**, two findings, one per clamp, the first: *"“Tray” runs under the clamp on the back edge, 15 mm in from the left-hand corner — slide the clamp along the back edge, or move it to the right edge, clear of the cut."* (the cutter's centre reaches Y 53.413; the clamp, grown by 1.588 + 0.1 + 1, starts at Y 49.313); Fix → the picture with that clamp selected |
| 3a. the same, both clamps dragged to the right edge (Y 15–30 and 30–45, reaching X 92–100) | the edit on the picture clears it | generates: the grown clamps start at X 89.313, the pocket’s cutter centre stops at X 83.413; the travel height 13 mm above the top; Simulate draws both clamps and no collision; the plan is 4 touches with the confirming scans on lines clear of both clamps |
| 3b. the program of fixture 3 opened from a file | Simulate's collision drawing | the clamp turns red at the first move into it; the scrubber stops; the sentence of §3.8 |
| 4. Bracket, a 3.81 mm plate | the arms above the stock | the line "the arms stand 6.19 mm above the plate"; a pocket within 2.688 mm of the front edge refused with the arm sentence |
| 5. Bed changed | #513 | the taped badge reloaded with the vise on the pins: the §3.10 sentence, Cut step 1 blocked, both actions |

**What stays bench-only:** which surface sits under the vise on this machine (§10 Q1); whether the bracket
seats on the wasteboard or the bed (§10 Q2); the bracket's corner from anchor 1, its fit and arm sizes, the
arm's top face (`bracket.armTopMm`) and the seat; the clamps' size, reach and height; the tape's real
thickness and **its hold** — a **tape coupon**: PLA squares 10, 15, 20, 30 mm taped on the wasteboard, each
cut round its edge with the ⌀ 3.175 mm flat end at 1 mm a pass until one lets go, which sets
`tape.holdRatio`. Each appears in the app as a value with its provenance until then; none of them is a
sentence on the main path.

## 7. Acceptance (for the bed flow, when built)

1. **The e2e walk, taped.** From the door, with no machine on the network (the Makera kit profile), an operator
   picks a PLA plate, *On the bed, taped*, Engrave text, types a name, and reaches a **generated, verified,
   simulated** engraving — four ticks — **changing no default**, never seeing a disabled control without its
   reason. One spec, run alone (`feedback_e2e_single_spec`).
2. **Holding writes the bed.** Selecting either bed option, with nothing on the pins, stores `tape` or
   `bracket` (with the clamp places) and `bed`; the "the job is held in the vise" sentence is gone; reloading
   the job shows the same option selected.
3. **The change wizard** takes the vise off for a bed job, fits the bracket at anchor 1 when the profile has
   none (two dowels, three screws), leaves the wasteboard as it was, and writes "Nothing on the pins · bracket
   at anchor 1 · wasteboard under (put back on by the change) — Makera takes it off for the vise and the rotary".
4. **Fixture 3 is refused** with its two sentences and the Fix opening the picture; dragging the clamps to the
   right edge generates (fixture 3a). The verifier, the simulation and the registration plan read the job's
   clamp places, not the defaults (one spec asserts the same boxes reach all three).
5. **The tape rules:** fixtures 2a and 2b refuse with their sentences; 2 and 2c generate; the hold numbers are
   only in Technical.
6. **Cut:** the taped badge plans 9 touches and the bracket pocket 4, in §3.9's order and words; the bracket's
   first touch is the bed beside it while the arm's top is unmeasured; the clamp tick is required before the
   bracket plan starts.
7. **The run sheet** prints §3.11's sections for each mount, with the board line only when there is a board.
8. **Bed binding:** fixture 5's sentence and both actions; the receipt carries the profile and its version.
9. **Words.** The walk's transcripts contain no `#\d`, no code (`clamp-in-path`, `tape-hold-*`,
   `bed-changed`, …), no "spoilboard", "sacrificial", "obstacle", "fixture plate" on the main path, no length
   without `mm`, no decimal past three.
10. **The built screens match `bed-mounts-flow-mockups.html`**, station for station.

## 8. Work items (proposed, to be filed under #707)

*Depends on* names the item or issue that must land first. BM-1 is the engine; the UI items start from this
design once approved.

| # | Title | Scope | Depends on |
|---|---|---|---|
| BM-1 | bed mounts: `JobWorkholding` gains `tape` and `bracket` | the two arms (`TapeHold`, `BracketHold` with `clamps`), the job schema and the MCP/headless schemas (`reference_board_zod_schema_strips`: name every field), `applyHoldAnswers` keeps them, `jobMount`/`jobVise`/`workholdingFor` read them, the vise-only checks skipped | — (the #240 slice-1 pattern) |
| BM-2 | bed mounts: Holding writes the bed — the two options, their lines, the bed pictures | `mountOptions` with nothing on the pins; tape's lines (under it, board, where, square to); the bracket's lines and the clamp editing on the picture; the default from `preferredMounting`; the web build's Makera kit profile | BM-1 |
| BM-3 | bed mounts: Change the machine → the bed, fitting the bracket | the bracket fit step when the profile has no anchor placement (anchor 1/2, two 4 mm dowels, three M5 × 20 screws, clamps in the tray); the confirm words; the wasteboard back on (Makera takes it off for the vise and the rotary — #717) | #693, #706 (landed) |
| BM-4 | bed mounts: the tape rules | taped area vs the cutter's bite for the stock and every released piece; `tape-hold-stock`, `tape-hold-piece`, `tape-tall-stock`; settings `tape.holdRatio`, `tape.insetMm` (the three-edit seed rule); chapter-8 rows | BM-1, #218 (landed) |
| BM-5 | bed mounts: the through cut on the bed | the wasteboard counted as the board under; the board on the bare bed (the thinnest house board that passes); `board-too-small`; the stack for the expected surface; tape thickness on the job | BM-1, #417 (landed) |
| BM-6 | bed mounts: the job's clamps as obstacles, with the fixture clearance | `bracketMount` reads the job's places, not the defaults; the clearance in `mountInPath` and the sweep; the travel height over the clamps; the arms above the stock; the verifier's sentences in the operator's words | BM-1, #427 (landed) |
| BM-7 | bed mounts: the Design panel's Hold lines and Generate's blockers | the Hold line per mount; the preview's bed, tape, board, arms and clamps; the §3.7 blockers with their Fix targets | BM-2, BM-4, BM-6, #686 (landed) |
| BM-8 | bed mounts: Simulate draws the bed, the tape, the bracket and the clamps | the fixture boxes with provenance styling; Top/Side with the stack; the collision drawn at its move for an opened file; the released piece and the scar ghost | BM-6, #691 (landed) |
| BM-9 | bed mounts: Cut registers on the job's mount | `registrationFor` from the workholding; tape's surface tap (writes `surfaceTopZ`), five top touches and the plane fit, the stack check and the turn refusal; the bracket's first touch (arm when measured, else the seat, taken in Cut), the clamp tick | BM-1, #607 (landed), #592 |
| BM-10 | bed mounts: the run sheet's mounting sections | §3.11 for tape (with and without a board) and the bracket; the need list | BM-1, BM-5 |
| BM-11 | bed mounts: the job binds to the active bed (#513) | `job.bed` + the datums snapshot; `profileVersion` = the last history `at`; `bed-changed` with the two actions; `mount-not-on-bed`, `stock-off-surface`, `bed-unmeasured`; readers on the profile; the receipt | #510 (landed); this item IS #513 |
| BM-12 | bed mounts: the simulate-before-bench fixtures and the acceptance e2e | §6's fixtures as specs; §7 items 1, 2, 9 as one e2e spec; lands last | all above |

The bench (a session of its own, `project_next_bench_session_agenda`) then measures §6's bench-only list —
the tape coupon first — and replaces each value with its measurement; the screens change nowhere.

## 9. What this removes, moves, keeps

| Verdict | What |
|---|---|
| **Remove** | the bed options' "the job is held in the vise" sentence; the "touch the bed beside the bracket once and save its machine Z" refusal (Cut takes the touch); the run sheet's fixed "Mount the vise" section on a bed job |
| **Move** | the clamp places from the shop default into the job (the default stays as the starting place); the confirm-mount prompt → a tick on Cut step 3; the jaw clearance → the fixture clearance |
| **Keep** | the tape and bracket touch plans and their refusals; the `G53` moves on the bracket; `clamp-in-path` and `bracket-in-path` on every move; `through-needs-board`; the wasteboard's findings and scars; the change wizard's shape; every number's provenance |

## 10. Questions this design could not settle — and the default it takes

| | Question | Default taken | Why |
|---|---|---|---|
| Q1 | What is under the vise on this machine — the wasteboard or the bare bed? | **Bare bed.** Makera's vise page begins "Remove the MDF wasteboard", and the maintainer confirmed it (2026-10-27); the vise, the rotary and the vacuum bed all mean a bare bed, and only a change to a bed job puts the board back (#717) | Makera's own install steps + `docs/design/z1-accessory-install.md` |
| Q2 | Does the bracket seat on the wasteboard or the bare bed? | **As the profile says**; the seat is touched on whatever is there. Makera's pictures show the bracket used with the MDF board on (inferred — bench look), so the shipped kit profile keeps the wasteboard | the anchors are in the bed; the source is Makera's illustrations, not text |
| Q3 | Can a bed mount share the bed with the vise? | **No** — the bed options need the pins clear | the shipped first-job rule; the vise sits over the bed's middle, and one mechanism at a time keeps the obstacles one set |
| Q4 | The tape's hold ratio | **100 × (cutter ⌀ × step-down)**, a shop setting | no source publishes tape hold; the coupon (§6) measures it; a setting with a per-job recommendation, never a constant |
| Q5 | Should a taped job put the wasteboard on when the bed is bare? | **No**; a through cut on the bare bed gets a board under | tape holds on the bed; the board rule covers the only case the bare bed cannot take |
| Q6 | Side clamps (Makera sells them) | **Not offered** in v1 | no job has asked; the top clamps are Makera's QuickStart default |
| Q7 | The arm's width: the seed says 10 mm, the machine's config reads `anchor_width` 15 | **10 mm (the seed) until calipered**, with the config's 15 named beside it in Technical | it is unclear the config's anchor width is the arm's; the 1 mm clearance and the 0.1 mm fit sit on top either way |
| Q8 | Thin or thick bracket; anchor 1 or 2 | **Thin, anchor 1** | the Makera kit profile; Makera's origin is "relative to Anchor 1" |
| Q9 | Auto-level (`G32`) on tape? | **The five top touches and the plane fit** (#475, #608) | `G32`'s sequence is not proven (#176); the spread and the fit are built and measured |
| Q10 | Where the tape tap lands, and how often | **10 mm in front of the front edge, every run** | it is tape's mount tap: it measures the surface and checks the stack each time, as the vise tap checks the jaw |
| Q11 | One clearance for clamps and jaws? | **Yes**, the job's jaw clearance renamed "fixture clearance", 1 mm | one number an operator sets for "how close to what holds it"; a second would be a knob nobody asked for (`feedback_defaults_over_knobs`) |
| Q12 | `profileVersion` | **the `at` of the profile's last history line** | #513's review; the profile has no version field and every change adds a line |
| Q13 | The bed options in the web build | **Offered**, against the Makera kit profile | a bed job can then be authored and simulated anywhere, as the rotary is |
