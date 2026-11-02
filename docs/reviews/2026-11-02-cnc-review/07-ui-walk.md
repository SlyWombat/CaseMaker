# First-job flow — off-bench UI walk, 2026-11-02

*main 5bcc5a88, web build (`vite`, `VITE_E2E=1`) served from a `git archive` copy of HEAD on 127.0.0.1:5398 with
`~/projects/CaseMaker-demo`'s Linux `node_modules` symlinked in (the checkout's own node_modules hold Windows/ARM
binaries; rolldown has no linux-arm64 binding there). Headless Chromium 1228 (Playwright 1.61.0), 1440 × 900,
swiftshader. `/api/v1/*` served by a stateful `page.route` fake from `tests/unit/fixtures/location-doc.json`
(vise on the pins, wasteboard under); every non-localhost request aborted (none was attempted). No machine.*

Screenshots and transcripts: the key captures are in `docs/bench/img/2026-11-02-ui-walk/`; the full 262-file set and the driver stayed in the session scratchpad
(`NN-name.png` viewport, `NN-name.txt` innerText, `NN-name.facts.json` disabled controls / number fields / leak scan;
`A-log.txt` is absent — walk A was killed by its own shell timeout after the Generate failure; `B-log.txt`, `C-log.txt`
complete). Driver: `/tmp/claude-1000/-mnt-c-Projects-Case-Maker/dc9d00b5-a253-4747-89b0-74d7fe358c3d/scratchpad/ui-walk/walk.mjs`.

Three walks:

| walk | operation | stock | hold | result |
|---|---|---|---|---|
| **A** (`A01`–`A15`) | Engrave text "Zoomba", every default kept | the wizard's own: hardwood plate 60.3 × 20.1 × 1.5 mm (sized from the text) | the wizard's own (ledge) | generated ✓ checked ✓ **simulation did not pass** (facing pass cuts the vise jaw) |
| **B** (`B01`–`B24`) | Pocket (the variant), PLA, typed 76.2 × 38.1 × 3.81 mm | typed | ledge, 0.71 mm proud | generated ✓ checked ✓ **"The generator stopped reporting for 180 s"**; Cut mode and Simulate reached |
| **C** (`C01`–`C25`) | Engrave "Zoomba", one change: "on a waste board between the jaws" | wizard's own 1.5 mm hardwood | waste board 2 mm, 0.4 mm proud | generated ✓ checked ✓ **simulation did not pass** (same jaw collision); Cut mode and Simulate reached |

## 1. The flow as built today

```
Welcome ("CASE MAKER · Design it. Print it. Cut it." — four doors: Cases · Racks · Toolboxes · CNC CUTTING)
  └─ CNC CUTTING card: "Cut it on the CNC — Carve hardwood on the CNC — a name plate, a coaster, a pocket, an engraving."
       [Start a cutting job]   STARTERS: Name badge · Bare blank · Name on a dowel
       (the board library — 31 boards, "~2400 MIN PRINT" project cards — is the rest of the same page; the wizard
        opens over it with a full dark backdrop that hides it)                                               A01
  └─▶ ONE modal, "Step n of 4", one progress strip
        1 Machine      "Makera Z1 192.0.2.10 · On the machine now: Vise on the pins · wasteboard under"
                       web build: "This page was served without the machine relay, so it cannot drive a machine — open
                       Case Maker from the desktop app or from a local install."  [Continue without a machine]     A02
        2 What are you cutting?   Engrave & carve (7) · Cut away (3) · Holes (4) · From a file (2); the chosen operation's
                       one field under the grid (Text · Depth mm · Font)              [← Back] [Next: stock]        A03–A05
        3 Stock        Material (23, plastics→woods→metals, default hardwood) · Form pictures (Plate Block Sheet Printed
                       blank Disc Rod Tube) + one sentence · length X / width Y / thickness Z, mm each, prefilled "Sized
                       from the text: 50.29 × 10.11 mm, plus 5 mm each side" · Finish [as bought] · "keep this piece on
                       the shelf" · [Load an STL, 3MF, OBJ or STEP as the stock…]        [Next: holding]           A06–A07
        4 Holding      "On the machine now  Vise on the pins · wasteboard under" · three radios (ledge / waste board / block)
                       each with its computed sentence · top-view + side picture · folds "Which way round", "Technical"
                       · a finding dot                                      [← Back] [Create the job]                A08–A10
  └─▶ DESIGN panel (rail "Job"; title "Job"; [Design] [Cut]; "Untitled job · Not saved yet · unsaved changes · File ▾")
        Job (Stock line · Cutter line · Facing line · Items + Add operation ▾ · the item row open)
        Cutter (closed; "⌀ 1 mm flat end · chosen by simulation · 100 % fidelity")
        Hold (closed; "Vise — measured · this setup · blank on the ledge · edit")
        "2 warnings · 1 note ▸ show"  [Generate]  "· Facing — not generated yet"                                     A11–A14
        Generate → the viewport plays the simulation; rows "✓ generated · ✓ checked · ✗ the simulation did not pass ·
        not checked against the design yet · about 3 min 3 s"                                                        A15, C17
  └─▶ CUT mode ("‹ Design [Design] [Cut]")  1 Fit and clamp · 2 Register · 3 Start cut  (three lines)              B16, C18
  └─▶ SIMULATE panel (rail "Simulate"): "Untitled job [Open .nc…] 76.2 × 38.1 × 3.81 mm · ⌀ 1 mm flat end · the job's own
        program"; the transport sits in the viewport footer                                                          B22–B24
```

One modal, one numbering, one Cut flow with three lines. The second modal, the full-page Cut-this-blank wizard, the inline
Machines card, the "Use the badge blank" headline, "New text", and the top bar's Save/Load/New/Export on the CNC page are
gone. The spine of `first-job-flow.md` §2 is built. What is not built is §1 principle 3: **the defaults do not lead to a
cuttable job** (§3 below).

## 2. Per screen

### 2.1 The door (`A01-door.png`)
- Matches §3.1 in substance: a card of its own, starters on the card, the wizard hides the library behind a backdrop.
- Words differ: the card says "Carve **hardwood** on the CNC" (design: "a badge, a plate, a pocket, an engraving"; the
  house cuts printed plastic). "Recent jobs (the last three .cutjob files)" are not offered — only starters.
- Leak: the "Name badge blank (two-colour)" project card still reads "ported from samples/badge-blank/make_badge.py" — a
  file name in operator text (A6), present on every welcome-page capture (A01–A07, B01–B06, C01–C07).
- Dead end: none.

### 2.2 Step 1 of 4 · Machine (`A02-wizard-1-machine.png`)
- Order and counter match §3.2. The machine line is the location's ("Makera Z1 192.0.2.10 · On the machine now: Vise on
  the pins · wasteboard under"). No paragraph about what a machine is (A3 fixed).
- Web build: one quoted sentence and "Continue without a machine". The design's "● Online/Offline · Check again · another
  machine…" strip is not in the web build; the desktop-mode server was not reached in the time box, so that strip, the
  fold and E4 are **not verified**. Next is not gated (correct).

### 2.3 Step 2 of 4 · What are you cutting? (`A03`, `A04`, `A05`, `B04`)
- **Order:** built as Machine → Operation → Stock → Holding (#897), not the design's Machine → Stock → Holding →
  Operation; step 3 says why ("Sized from the text"). "Step 2 of 4" — exactly one counter per screen, everywhere.
- Grouped grid with the one essential field. No "New text": the text field starts empty and Next is disabled with the
  reason "Type the text to engrave." (facts A03/A04). E3 and A10 fixed.
- Groups differ from §3.5: "3D — Surface a mesh" became "From a file — Surface a mesh · Circuit board (Gerbers)";
  "Thread a boss (external)" was added under Holes.
- Pocket (`B04`): nothing under the grid — no sentence that the size comes in the panel.

### 2.4 Step 3 of 4 · Stock (`A06`, `A07`, `B05`, `B06`)
- Vocabulary fixed (A7, D3): `length X · width Y · thickness Z` with `mm` on each; form pictures with one sentence each;
  Disc, Rod, Tube offered (refusal paragraph gone); shelf is a tick; template cards gone from the step; the Load door is
  one button (A9).
- **Default material is hardwood** (A4 was changed by #879, not to the design's "house material"). The 23-entry select is
  ordered plastics / woods / metals but has no visible group headings; "plastic (unspecified)" is last in its group.
- **Default size for an engraving: 60.3 × 20.1 × 1.5 mm.** 1.5 mm is a sheet by the design's own words, and on hardwood the
  product faces 0.5 mm off it ("Facing — 0.5 mm off the top") then engraves 0.5 mm. This default is the root of the
  Generate failure.
- Pocket variant: size fields **empty**, Next disabled with reason "Choose the stock: a size you type, a piece on the
  shelf, or a file." — reason present (principle 4), but a pocket has no default stock.

### 2.5 Step 4 of 4 · Holding (`A08`, `A09`, `A10`, `B07`, `C09`)
- Matches §3.4 in shape: "On the machine now · Vise on the pins · wasteboard under", three "how this stock sits" options
  with their computed sentence, top view with "X runs between the jaws", side picture with the proud number, "Which way
  round" and "Technical" folds (jaw numbers behind the fold; `vise-default` gone).
- **Missing:** the design's "On the bed, taped", "On the bed, bracket and clamps", "In the rotary chuck" lines with their
  cost, and **"Change the machine…"** (`engrave-setup-change-machine` never rendered in three walks). §3.8 is
  unreachable from the flow.
- **Default hold for the default stock (A08):** the ledge radio is disabled ("it would sit 1.6 mm below the jaw tops"), no
  radio is selected, the picture caption says "the blank sits on the soft jaws' ledge", the dot says "Only 1.5 mm of the
  stock is gripped below the jaw tops; under 3 mm the part can lift (a provisional threshold)", and **Create the job is
  enabled** — the job it creates is "blank on the ledge, 1.6 mm below the jaw tops" (`A13`). Design: the waste board is
  the default for thin stock.
- Choosing the waste board (`C09`): the caption and proud number change (0.4 mm) — but the job's Hold reads "blank on the
  ledge, **0.3999999999999999** mm proud of the jaw tops" (`C14`) and Cut step 1's note says "The job seats the blank on
  the soft jaws' ledge, 3.1 mm below the jaw tops. It states the 1.5 mm blank stands 0.4 mm proud" (`C18`).
- Disabled control without a reason-testid: the ledge radio after the board is chosen (`C09`–`C11`); its sentence is still
  on screen, so borderline.

### 2.6 Design panel (`A11`–`A14`, `B10`–`B13`, `C12`–`C15`)
- Matches §3.6 in structure: title "Job", [Design][Cut], one file row with File ▾, Job/Cutter/Hold groups, a findings
  line, Generate with its rows. B1–B5 fixed; the top bar on this page is Manage · Undo · Redo · Parts · Docs.
- Generate carries its blocker as a sentence when blocked ("Nothing to cut yet — add an operation, or turn one back on.
  Open the add menu"; "The stock is rough — rough stock is faced first…") — B9's shape is fixed.
- Remaining against §1/§3.6:
  - Provenance chips on fields are back as `computed`, `measured`, `starting values`, `recommended`, `provisional —
    measuring…` (D2 reduced, not gone).
  - Cutter: "measured: ⌀1 [measured] · Chosen by simulation: 100 % fidelity on the worst item, 0 tool changes, about
    208 s. ⌀1 mm cuts one item and its worst item is "Zoomba" at 100 % fidelity." — engineering on the main path; "Why? —
    1 cutter rejected" is one line now (B8 largely fixed; a dev browser lists 3 cutters, so the 160-entry list was not
    judged). "Strokes thinner than 1 mm cannot be cut — the cutter opens them away entirely." sits unfolded.
  - Item row: two paragraphs ("Max depth 1.4 mm here — the stock thickness less the minimum floor…" / "Recommended
    0.5 mm — …"); the 1.4 mm ignores the 0.5 mm facing that runs first.
  - Hold edit (`A13`): still "Sacrificial material" (design: waste board) with a four-line explanation; the Setups block
    shows four disabled controls each with an explanatory sentence ("type a tolerance to save it", "Add setup is
    unavailable: every cut opens to the top face, which is already a setup") — principle 7; "Plausibility width" label.
  - Vise number fields `stock proud · fixed jaw · moving jaw · jaw length · jaw start Y · uncertainty` carry no unit in
    their label (facts `A11-design-panel.facts.json`, `engrave-vise-*`).
  - "Cutting [starting values]" prints five numbers unfolded (B10's chip remains; the five-decimal step-over is gone).
  - The findings fold ("▸ show") was not opened by the driver — its body is unverified.
- Leaks: `0.3999999999999999` (C14–C17); after Generate, `(flat-1.0)` and `(vise-moving-jaw)` in the error text (A15,
  C17). No `#nnn`, no `-default`, no dev words on any Design capture.

## 3. Does Generate succeed with defaults?

**No.** Three attempts, none reached the four ticks.

- **A — all defaults** (`A15-generate-in-flight.png`): toolpath ✓ and check ✓ at once; the simulation played in the
  viewport (365 steps, "about 3 min 3 s") and failed: "✗ the simulation did not pass · not checked against the design
  yet / Facing — 1 mm flat end, ⌀ 1 mm flat, 2 × 0.3 mm passes / the facing pass (flat-1.0): checkpoint 0: the cutter
  drives 0.477 mm² into the fixture 'Vise moving jaw (right)' (vise-moving-jaw) (+27 more errors)". The 1.5 mm blank sits
  1.6 mm below the jaw tops and the facing pass runs full-width into the jaws. No fix sentence, no link; the button stays
  "Generate".
- **C — waste board chosen** (`C17-design-panel-generated.png`): 154 s to the verdict; same failure ("checkpoint 1: the
  cutter drives 0.308 mm³ into the fixture 'Vise moving jaw (right)'") — a 0.4 mm-proud blank faced 0.5 mm deep still cuts
  the jaws. Findings after: "1 warning · 1 note".
- **B — pocket, PLA, 3.81 mm** (`B15-design-panel-generated.png`): toolpath ✓ and check ✓ after 183 s (three swiftshader
  browsers ran at once — take the time with that caveat), then "The generator stopped reporting for 180 s. Its worker may
  have stopped. Try again" and "✓ generated · ✓ checked · not simulated yet · not checked against the design yet · about
  1 min 54 s". Whether worker or environment, one run cannot say; recorded as observed. Findings: "2 notes".

## 4. How far Cut mode gets with no machine

The switch is enabled after a failed or stalled Generate in both B and C. Its tooltip: "Ask every preflight owner about
this job and show what they say." — a developer sentence.

- **B** (`B16-cut-mode.png`): "✓ 1 Fit and clamp — Program checked · **matches the design** · about 1 min 54 s · 2 notes"
  while Design says "not simulated yet · not checked against the design yet". Step 2 Register (open): "Registration — find
  the stock, then set the origin / No machine is connected. Reach it first, then come back to register. / tap the jaw
  first — Measure… on the machine card, or run the registration: its first touch is that tap". Step 3: "○ Start cut —
  vacuum on · fit the ⌀ 1 mm flat end · about 1 min 54 s". Three lines, the design's shape; the second Register sentence
  names a card and a button not on this screen.
- **C** (`C18-cut-mode.png`): "● 1 Fit and clamp — clearance not acknowledged"; body: "I turned the stock…", the
  acknowledgement sentence, a labelled photo of the spindle head (probe connector), "You're supplying this stock yourself,
  so no blank needs to be held.", "details — The check found nothing blocking — 1 warning carried." **Nothing in Cut says
  the simulation failed.** Step 3: "2 programs · vacuum on · about 3 min 3 s".
- With no machine, Cut stops at step 2 with one sentence — a correct stop, not a dead end, but without a link to where
  "reach it" happens (strip: "No machine yet · Add"; footer: "Manage › Machines"). `engrave-cut-no-machine` rendered
  empty; `engrave-cut-change-machine` never rendered.

## 5. The Simulate panel

`B22-simulate-panel.png`: "Untitled job [Open .nc…] 76.2 × 38.1 × 3.81 mm · ⌀ 1 mm flat end · the job's own program". The
transport (⏮ ◀ ▶ ▶ ⏭ · 1×/5×/20×/100× · scrubber · "about 1 min 54 s · step 164 / 164 · line 183" · "Material updates at
2 points in this program — between them the tool moves over a static stock. Ticks are the program's pause points.") is in
the viewport footer. The program was already at its last step (Generate had played it); Play and ⏭ left it at 164/164 (B)
and 365/365 (C). So the job's program is loaded and is at its end; a from-the-start replay was not driven. No vendor-label
Tool select for the job's own program (D5 unverified for an opened .nc). No oracle numbers here (§3.6's move not done —
they are nowhere, which for a failed oracle is right). In B the panel offered "the job's own program" although Design said
it was never simulated.

## 6. Console

Per walk: 4 × "Failed to load resource: 404" (the fake's misses: `/feeds`, `/feed-table` and two others), "THREE.Clock:
This module has been deprecated. Please use THREE.Timer instead." (one warning), swiftshader "GPU stall due to ReadPixels"
performance warnings. **No pageerror, no app-level console error** in any walk. No non-localhost request was attempted.

## 7. Defects seen

1. **The default job cannot be generated.** Engrave "Zoomba" with every default → "✗ the simulation did not pass — the
   facing pass … drives 0.477 mm² into the fixture 'Vise moving jaw (right)' (+27 more errors)"; no fix, no link.
   `A15-generate-in-flight.png`, `A08-wizard-4-holding.png`.
2. **Holding creates the job in a hold it has just refused.** Ledge radio disabled, nothing selected, Create enabled, job
   lands "on the ledge, 1.6 mm below the jaw tops". `A08-wizard-4-holding.png`, `A13-design-panel-hold-open-full.png`.
3. **The waste-board choice is not carried into the job's words** (Hold: "on the ledge, 0.3999… mm proud"; Cut note:
   "seats the blank on the soft jaws' ledge, 3.1 mm below the jaw tops"). `C09`, `C14`, `C18`.
4. **Floating-point number on screen:** "0.3999999999999999 mm proud of the jaw tops". `C14-design-panel-hold-open.png`.
5. **Default thickness 1.5 mm on hardwood with a 0.5 mm facing pass** — collides with the jaws whichever vise option is
   taken. `A07-wizard-3-stock.png`, `A11-design-panel.png`.
6. **Cut step 1 claims "matches the design" for a program never simulated.** `B15` vs `B16-cut-mode.png`.
7. **Cut mode does not say the simulation failed** ("The check found nothing blocking — 1 warning carried."). `C18`, `C19`.
8. **Codes after Generate:** "(flat-1.0)", "(vise-moving-jaw)", "checkpoint 0", "mm²/mm³ into the fixture". `A15`, `C17`.
9. **"Change the machine…" not offered on Holding; bed/tape/bracket/rotary options absent.** `A08`, `B07`.
10. **Pocket has no default stock** (fields empty, Next disabled with its reason). `B05-wizard-3-stock-defaults.png`.
11. **Cut switch tooltip is a developer sentence** ("Ask every preflight owner…"). facts B15/C17.
12. **Register's second sentence** refers to a card and a "Measure…" button not on the screen. `B16-cut-mode.png`.
13. **File name on the door** ("ported from samples/badge-blank/make_badge.py"). `A01-door.png`.
14. **"Sacrificial material"** in Hold edit, four-line explanation. `A13`.
15. **Four disabled controls with explanatory sentences** in the Setups block; "Plausibility width". `A13-…-full.png`.
16. **Vise fields without a unit in their label.** `A11-design-panel.facts.json`.
17. **Provenance chips on fields** (computed / measured / starting values / provisional / recommended). `A12`, `A15`.
18. **Generate worker stall** (B) — observed once under load; the message is fine, the Cut line it leaves is defect 6. `B15`.
19. Door card and default material say hardwood; the house rule is a printed plastic blank (A4 vs #879 — a decision to
    reconcile). `A01`, `A06`.
20. "Max depth 1.4 mm here" ignores the facing pass that runs first. `A11`.

## 8. The 45 audit findings

| id | status | evidence |
|---|---|---|
| A1 three numberings | fixed — one modal, "Step n of 4" once per screen | A02–A08 |
| A2 no door of its own | fixed — CNC CUTTING card + backdrop | A01, A02 |
| A3 Machine paragraphs | fixed in the web build (desktop strip unverified) | A02 |
| A4 softwood default | changed to hardwood (#879), not the house's PLA | A06 |
| A5 ungrouped materials | mostly fixed — ordered, no headings | B05 log |
| A6 template provenance | moved to the door; make_badge.py still printed | A01 |
| A7 forms unexplained; L/W/T no units | fixed | A07 |
| A7 rod/disc refusal | fixed — Disc, Rod, Tube offered | A07 |
| A8 shelf/finish | fixed | A07 |
| A9 bare file input | fixed | A07 |
| A10 picker | fixed — grouped, step 2, one field | A05 |
| A10 holding codes/disabled rotary/no orientation | fixed — but bed/rotary options now absent entirely | A08 |
| B1 "Cut" ×3 | fixed | A11 |
| B2 two save systems | fixed | A11 |
| B3 re-open at 1/3 | fixed | A11 |
| B4 headline buttons, typed chips, jaw prose | fixed | A11 |
| B5 Voids block | fixed | A11 |
| B6 Items row, second vocabulary | fixed | A11 |
| B7 "#218" | fixed — no `#` anywhere | all facts |
| B8 cutter names / Why / disclaimer | largely fixed; new "100 % fidelity" prose | A14 |
| B9 Generate disabled, false reason | shape fixed; the default path now fails at simulation with codes and no fix (defect 1) | A15 |
| B10 five decimals, #191 | fixed; `starting values` chip remains | A14 |
| B11 Depth margins prose | fixed — under Technical | A14 |
| B12 Hold repeated as a finding | fixed in Design; Cut note restates it | C18 |
| B13 "show" toggle | partly — severities named; fold not opened | A11 |
| B14 Checked/Not checked paragraphs, clearance "below" | fixed — ticks + one time; clearance in Cut step 1 | A15, C18 |
| B15 two durations | fixed — one "about …" everywhere | C17, C18, C25 |
| B16 viewport labels on an empty job, huge jaws | remains | A08, A11 |
| C1 freeze box, contradictory Register, dev words | fixed (defect 12 aside) | B16 |
| C2 full-page 7-step wizard | fixed — gone | B16 |
| C3 three connection places | fixed in the flow (desktop unverified) | A11 |
| D1 issue numbers and codes | mostly fixed; codes in the failure text | A15, C17 |
| D2 provenance chips | reduced, remains | A12, A15 |
| D3 units/decimals | fixed on wizard and rows; vise fields, one 16-decimal number | A11, C14 |
| D4 headings/casing | fixed | A11 |
| D5 Simulate vendor-label select | not shown for the job's program; .nc case unverified | B22 |
| E1 no sense of place | fixed | A02–B16 |
| E2 four doors / empty shelf | partly — shelf untested with stock | A07 |
| E3 "New text" | fixed | A04 |
| E4 machine never auto-connected | web build n/a; desktop unverified | A02 |
| E5 umbrella | spine built; defaults are the gap | §1 |

## 9. Not seen within the time budget

Desktop-mode server (step 1's Online/Offline/Check again/another machine… strip, E4); the findings fold's body; the
Simulate panel with an opened `.nc` and a from-start replay; a passing Generate (none passed); the shelf door with stock;
the door's recent jobs.
