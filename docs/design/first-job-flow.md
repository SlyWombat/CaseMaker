# The first job — the target flow (design v1, 2026-10-26)

*The screens an operator meets from "I want to cut something" to the run, as one design the panels
follow. It reconciles what `cnc-job-workflow.md` §5 proposed, what `cnc-panel-redesign.md` and
`cut-this-blank-wizard.md` refined, and what the 2026-10-26 walk-through (`first-job-audit-2026-10-26.md`)
found built. Where this document and those disagree, this one wins for the first-job path; it changes no
engine behaviour. Mockups: `first-job-flow-mockups.html` beside this file (published as the "First Job Flow"
artifact, 2026-10-26). Work items: #680–#692 under the umbrella #679. Status: PROPOSED — no implementation
until the maintainer approves the flow and the mockups.*

## 1. Principles the screens are held to

1. **One flow, one numbering.** A new job is ONE wizard of four steps, "Step n of 4 · name", in one modal
   style; it lands in the Design panel; the Design → Cut switch is the only mode change; Cut mode is the
   ONE cut flow. Nothing else counts steps.
2. **Plain language first, the number behind it.** Every screen says what it is asking in one sentence an
   operator uses, and keeps the engineering (feeds, margins, tolerances, provenance detail) behind a
   `Technical` fold. No issue numbers, no finding codes, no file names, no "the engine", "the package",
   "the release flow" on the main path.
3. **Defaults are the house's.** The machine is the location's (connected on open), the material is the
   one this house cuts, the mount is the one the stock calls for, the cutter is the recommendation. A
   default the operator must always change is a defect.
4. **Say the blocker where the button is.** A disabled action carries the one sentence that unblocks it and
   a link to the field. Never "fix the errors above" with no error above.
5. **One vocabulary.** Stock is `length X · width Y · thickness Z` in mm, everywhere; an item is an
   *operation* (the fourteen names of the picker), never also a "kind"; a cutter has one display name in
   every list; "Cut" means the mode, nothing else.
6. **Units on every field, three decimals at most**, trailing zeros dropped; a derived number is shown
   with its source in words, once, in its own place (decision 28), not as a chip on every input.
7. **Nothing is explained twice**, and a sentence that explains a disabled control is a defect: hide the
   control, or enable it.
8. **The machine's state is a fact the product reads, not a question it asks.** What is on the bed now (the
   active bed profile: the vise or the rotary on the pins, the wasteboard, the boards and tape in stock) is
   known; the job is held in what is there, or the operator is taken through changing it. **Every change to
   the machine has a wizard of its own** (fixture on or off, cutter, probe, wasteboard), entered from
   wherever the need arises and returning there.

## 2. The flow

```
 Welcome ─ [ Start a cutting job ]  (a door of its own, beside the print projects)
   │
   ▼  NEW CUTTING JOB — one modal, "Step n of 4"
   1 Machine     the house's machine, checked on open: "Makera Z1 ‘Zoomba’ · Online · Idle · homed"   [Next]
   2 Stock       material (house first) · form (picture) · L × W × T mm · shelf when it has something    [Next]
   3 Holding     in what is on the machine now (drawn) · how the stock sits in it · orientation         [Next]
   │               └─ "Change the machine…" ──▶ the machine-change wizard (§3.8) ──▶ back to step 3
   4 Operation   "What are you cutting?" (grouped picker) → the one field it needs (the text, the file)  [Create job]
   │
   ▼  DESIGN  (the panel: Job · Cutter · Hold, a sticky footer with findings + Generate)
   │     items with their chips · the recommendation applied · Generate names its blocker
   ▼  [ Cut ]  (the mode switch; greyed with the first blocking reason)
   CUT  1 Checked  ✓ · 2 Frozen ✓ · 3 Register the blank ● · 4 Run                                       ← the only cut flow
        the machine strip (one home for the machine's state); the run sheet; the record
```

## 3. The screens

### 3.1 The door

The welcome page gains a first-class entry: **Start a cutting job** as a card/section of its own
("Cut something on the CNC — a badge, a plate, a pocket, an engraving"), beside the print projects, not a
button among the board-library controls. Opening the wizard hides the board library behind it (a plain
backdrop), so the operator is in the cutting job and nowhere else. Recent jobs (the last three `.cutjob`
files) are offered on the same card.

### 3.2 Step 1 of 4 — Machine

```
 Step 1 of 4 · Machine                                                    [ Close ]
 Makera Z1 “Zoomba” · 192.168.10.43              ● Online · Idle · homed · checked 09:02
                                                          [ Check again ]   ▸ another machine…
                                                                          [ Next: stock ]
```

- The location's machine, preselected and checked when the step opens. One line of state in the machine
  strip's words. Offline reads "● Offline — last seen 2026-10-25 13:55 · [Check again]"; a job continues
  without it and Next is never gated on it.
- `another machine…` is the only fold: the address field and Connect live there. No paragraph about what
  a machine is.

### 3.3 Step 2 of 4 — Stock

```
 Step 2 of 4 · Stock                                                      [ Close ]
 Material   [ PLA ▾ ]      Plastics: PLA · PETG · ABS · ASA · PC · PA · TPU…   Woods …   Metals …
 Form       [■ Plate]  [▮ Block]  [▬ Sheet]  [● Disc]  [▬ Rod]      (pictures; the word under each)
            Plate — flat stock cut from the top; thicker than a sheet, lower than it is wide.
 Size       length X [ 76.2 ] mm   width Y [ 38.1 ] mm   thickness Z [ 3.81 ] mm
 Finish     ( as bought ▾ )  — faced first on wood and metal; plastic is cut as it is
 Shelf      On the shelf (2): ○ PLA plate 76.2 × 38.1 × 3.81 ×4   ○ offcut from job 12    ☐ keep this piece on the shelf
            Load an STL / 3MF as the stock ▸
                                                             [ Back ]   [ Next: holding ]
```

- Material defaults to the house's last material (PLA here), grouped Plastics / Woods / Metals; the
  catalogue's "plastic (unspecified)" is last in its group.
- **Forms are pictures with one defining sentence each**: Plate (flat, cut from the top), Block (as tall as
  it is wide; sides may be cut in later setups), Sheet (thin; in the vise on a waste board, or taped to the
  bed), Printed blank (from a printer, layers known), Disc and Rod (round; the vise holds a short one on
  its flat, the rotary holds a long one). Nothing is "not offered" on the default path; a round form that
  needs the rotary says so under its picture when picked.
- **The form word decides nothing by itself.** Today plate, block and sheet are the same thing in the engine
  (the same three fields, the same mount, the same facing rule); the word is a label. In the target the
  *numbers* decide: step 3 works out how this thickness sits in what is on the machine (on the ledge, on a
  waste board, gripped as a block, taped) and says so. The form stays as the picture that sets the size
  fields (Disc and Rod need a diameter) and the sentence that tells a new operator what the words mean.
- Fields are `length X · width Y · thickness Z`, each with `mm`, the same words the panel uses.
- The shelf appears only when it has something; "keep this piece on the shelf" is a tick under the size.
  Templates (badge blank, bare blank) move to the door's card as recent/starter jobs, not into this step.

### 3.4 Step 3 of 4 — Holding

```
 Step 3 of 4 · Holding                                                    [ Close ]
 On the machine now   Vise on the pins · wasteboard under · 2 mm MDF boards ×4, tape    (the active bed profile)
                                                                        [ Change the machine… ]
 How is the plate held?                         ┌ top view ─────────────┐
 ◉ In the vise, on the jaw ledge                │ fixed jaw │ plate     │   X runs between the jaws;
     3.81 mm stands 0.71 mm proud of the jaws   │     ┃     │ 76 × 38   │   the fixed jaw is on the left
 ○ In the vise, on a waste board between the jaws  (2 mm MDF ▾)  — for a through cut, or thin stock
 ○ In the vise, gripped as a block — the sides free                      └───────────────────────┘
 ○ On the bed, taped          needs the vise off the pins · Change the machine…
 ○ On the bed, bracket and clamps   needs the vise off the pins · Change the machine…
 ○ In the rotary chuck        needs the rotary on the pins · Change the machine…
 ▸ Which way round: face up (the printed face ▾) · against the fixed jaw (the long edge ▾) · nearest you (the left end ▾)
 ▸ Technical: jaw numbers (shipped defaults) · board 2 mm (typed) · beside-the-part strips
                                                             [ Back ]   [ Next: operation ]
```

- **The step opens on what is on the machine now**, read from the location's active bed profile, in one
  line. The options are *how this stock sits in that mechanism*, computed from the numbers: a 3.81 mm
  plate on the 3.1 mm ledge stands 0.71 mm proud, so the ledge is the default; a 2 mm sheet would sit
  1.1 mm below the jaw tops, so "on a waste board between the jaws" is the default and the ledge option
  says why it is not. A block taller than the jaws is gripped with its sides free. The waste board is the
  §5.2 "sacrificial under" with a name an operator uses, chosen from the boards the location has or typed.
- **Options the installed mechanism cannot give are shown, not hidden**, with their one-line cost
  ("needs the vise off the pins") and the escape: `Change the machine…` opens the machine-change wizard
  (§3.8) and returns here with the new state drawn. Nothing is "not yet offered"; an accessory the house
  does not own reads "not owned" with no further sentence.
- The picture is per mechanism (vise: fixed jaw left, X between the jaws; bed: the bracket corner or the
  front edge; rotary: the axis along X) and carries the orientation facts the panel used to print as prose.
  The three landmark questions of `cnc-job-workflow.md` §5.2 (face up, against the reference, nearest you)
  sit behind one fold and are asked only when the stock has a face worth telling apart (a finish, layers).
- Provenance (`vise-default`, the board's source) lives in the Technical fold.

### 3.5 Step 4 of 4 — Operation

```
 Step 4 of 4 · What are you cutting?                                      [ Close ]
 Engrave & carve   [ Engrave text ] [ V-carve ] [ V-carve, variable ] [ Inlay ] [ Texture ] [ Flute ] [ Prism ]
 Cut away          [ Pocket ] [ Profile ] [ Chamfer ]
 Holes             [ Hole ] [ Bore to size ] [ Thread ]
 3D                [ Surface a mesh ]        — a whole-job operation; starts an empty job with it
 ─────────────────────────────────────────────────────────────────────────────
 Engrave text:  Text [ Zoomba          ]   Depth [ 0.5 ] mm   Font [ Inter ▾ ]
                                                             [ Back ]   [ Create the job ]
```

- Grouped, with the chosen operation's ONE essential field under the grid (the text for an engraving,
  the file for a mesh, nothing for a pocket beyond the size it will get in the panel). No placeholder
  "New text" is ever created.
- "Create the job" lands in Design with the item made, its row open.

### 3.6 Design (the panel, after `cnc-panel-redesign.md` §3)

```
 ┌ Zoomba badge · saved 09:14 ▾ (Save · Save as… · Open…)      [ Design ] [  Cut  ] ┐
 ├ JOB ──────────────────────────────────────────────────────────────── open ──┤
 │ Stock   plate 76.2 × 38.1 × 3.81 mm · PLA                          ▸ edit    │
 │ Items (1)                                              [ + Add operation ▾ ]  │
 │   ▸ T  Engrave “Zoomba”   Engrave · 0.5 mm · 1 mm flat end                   │
 │ ▸ Voids under the face (0)    ▸ Target object (0)                            │
 ├ CUTTER ────────────────────────────────────────────────────────────── open ──┤
 │ 1 mm flat end  [recommended]        ▸ change (grouped list, one name form)    │
 │ Cutting — Makera’s catalogue row for PLA: 12 000 rpm · 500 mm/min    ▸ Technical │
 ├ HOLD ────────────────────────────────────────────────────────────── closed ──┤
 │ Vise · shipped defaults · the blank sits on the ledge                ▸ edit    │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ 1 note                                                              ▸ show   │
 │ [            Generate            ]   or, when blocked:                        │
 │ [ Generate ] No feeds for the 90° chamfer bit on PLA — choose a flat end mill ▸ Fix │
 │ ✓ generated · ✓ verified · ✓ simulated · ✓ matches the design   about 2 min 16 s  │
 └────────────────────────────────────────────────────────────────────────────┘
```

- **One file bar**: the job's name and saved time, with Save / Save as… / Open… in a menu; the top bar's
  project `Save · Load · New · Export…` are hidden on CNC pages (they belong to the print project).
- **Set up this job…** and **Cut this blank** leave the header: the wizard is re-entered per group's `edit`
  (Stock, Hold), and the cut is the mode switch.
- The Stock group is one line; Facing is one line only on wood/metal; Voids and Target object collapse at
  0 and open by their `+`; the "Use the badge blank" headline goes (a starter job on the door).
- **Add operation** is the grouped picker of 3.5; the "More kinds and imports" list is folded into it as
  the same operations (Circle/Slot/Polygon are Pocket shapes; Line is Engrave; Hole array is a Hole option;
  Cut out is Profile; the 3D primitives sit under Cut away as "3D shape").
- **Cutter**: the recommendation is applied and named; `change` opens a list grouped by kind (flat end ·
  ball · V and chamfer · engraver · drill · thread), one display name form (`⌀ 1 mm flat end · 7 mm flute`),
  never a vendor label as the name, never a curator's note. "Why?" becomes one line per candidate that was
  *considered and rejected for a reason the operator can act on*, and nothing else.
- **Generate** carries its blocker as its own sentence with a Fix link (the feeds refusal, a finding, a
  missing cutter); the rows after it are four ticks and one time; the "Checked / Not checked" paragraphs
  and the oracle numbers move to the simulation's own panel, where they are facts about the picture.
- The clearance acknowledgement moves to Cut step 1, where the decision is made before the machine.

### 3.7 Cut (the mode, after `cnc-panel-redesign.md` §4 — the ONE cut flow)

```
 [ Design ] [  Cut  ]                     Zoomba · 192.168.10.43 · Online · Idle · homed · T1 · vacuum off
 ✓ 1 Checked     1 program · 2 min 16 s · 1 note                                 ▸ details
 ✓ 2 Frozen      09:16 · the programs match the design                            
 ● 3 Register the blank    left edge, then the top face · 4 touches
     [ I am at the machine, probe fitted ]   [ Start ]
 ○ 4 Run         vacuum on · fit the 1 mm flat end · 2 min 16 s                  ▸ the plan
 ← Back to design
```

- The seven steps of `cut-this-blank-wizard.md` ARE these four lines (its 1 Machine = the strip; 2 Blank
  and cutter = Checked; 3–5 = Frozen; 6 = Register; 7 = Run). The full-page "Cut this blank" wizard and its
  inline Machines card are removed; machine connection has one home, the strip (Manage › Machines keeps
  the full card for the house).
- A step's body is one sentence and one action; the next thing to do is always the only open step.

### 3.8 Changing the machine (a wizard of its own)

Entered from Holding ("Change the machine…"), from Manage › Machines, and from Cut when the frozen job's
mount disagrees with what is on the machine. It is the one shape every physical change to the machine
takes: fixture off or on, cutter change, probe in or out, wasteboard resurfacing.

```
 Change the machine                                                         [ Close ]
 1 What changes      Vise off the pins → Rotary on the pins        for: Zoomba badge, held in the rotary chuck
 2 Make it safe      ● Home                 $H · Idle · homed ✓
                     ● Work light on        M821 ✓
                     ● Spindle cold, cutter out                      [ I have checked ]
 3 Take off the vise    ○ the two pin bolts   ○ lift straight up   ○ on its shelf        [ Done ]  (a picture each)
 4 Fit the rotary       ○ onto the pins   ○ the 4th-axis cable   ○ chuck key in the tray   [ Done ]
                        axis datum: shipped value (±0.5) · [ Measure now ] or [ use the shipped value ]
 5 Confirm           the bed is now: Rotary on the pins · wasteboard under
                     written to the machine's record: 2026-10-26 09:20 · vise → rotary · for Zoomba badge
                     ● Work light off · ● Home                                        [ Back to the job ]
```

- One physical action per line, the machine's own state answering it (the strip's words), per the bench
  rules: home before hands in the machine, the light on while they are there, home when done.
- The outcome is a change of the active bed profile and a history entry; the job that asked is re-checked
  against it (a frozen job's package is re-frozen when the mount changed, per the gate).
- The same wizard is the directed cutter change inside a run (`cnc-job-workflow.md` decision 15): steps 2,
  the change, 5.

## 4. Vocabulary and conventions (the rules the mockups follow)

| Thing | Word | Not |
|---|---|---|
| the mode | Design · Cut | "Cut" as a rail label, a panel title, a button |
| the item | operation (Engrave text, Pocket, Hole…) | kind, shape, trace, label, item-kind |
| stock size | length X · width Y · thickness Z, `mm` on each | L (X) / W (Y) / T |
| stock form | Plate · Block · Sheet · Printed blank · Disc · Rod | "plate block sheet" unexplained |
| a cutter | `⌀ 3.175 mm flat end · 12 mm flute` (+ "metal" tag) | the vendor label, `3.17`, `chamfer (…)` |
| provenance | one sentence in the Technical fold ("typed by you 09:12", "Makera's catalogue row") | a grey chip on every field |
| a refusal | the sentence + the fix, at the control | a disabled control with "fix the errors above" |
| what is on the machine | "On the machine now: vise on the pins · wasteboard under" | bed profile, placement, pins kind |
| the board under the part | waste board (between the jaws / on the bed) | sacrificial material, sacrificial under |
| numbers | ≤ 3 decimals, trailing zeros dropped, unit after | 1.42875 mm, 0.0000 mm² |
| codes | none on screen | `#218`, `vise-default` |

## 5. What this removes, moves, keeps

| Verdict | What |
|---|---|
| **Remove** | the second modal and its numbering; the full-page Cut-this-blank wizard; the inline Machines card; "Use the badge blank" headline; the template cards in the stock step; the disabled rotary sentence; `New text`; the "Checked / Not checked" paragraphs under Generate; issue numbers and codes in text; the top bar's project Save/Load/New/Export on CNC pages |
| **Move** | the fourteen-type picker → wizard step 4 and the Items `+ Add operation` (grouped); the machine check → the strip; the oracle numbers → the simulation panel; the clearance acknowledgement → Cut step 1; "X runs between the jaws" → the Holding picture |
| **Keep** | the gate and its four ticks; the registration plan and its words; the run sheet; provenance (in its fold); every refusal's sentence; the operations matrix's fourteen names; every testid the panel redesign kept |

## 6. Acceptance (for the whole flow, when built)

1. A new operator on this house, with no machine on the network, reaches a generated, verified, simulated
   engraving of their own text from the door in **under two minutes and eight clicks**, changing no
   default, and is never shown a disabled control without its reason.
2. Every screen of the flow has exactly one step counter, and it reads "Step n of 4" in the wizard and
   "1–4" in Cut.
3. Grep the rendered flow (the walk-through driver's transcripts): no `#\d`, no `-default`/`-refused`
   style codes, no vendor label as a cutter name, no field without a unit, no decimal beyond three places.
4. The walk-through captures of the built flow match the approved mockups screen for screen.
