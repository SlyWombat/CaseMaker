# The first job, walked end to end — audit of 2026-10-26

*Build a22d782d on k3 (`http://192.168.10.38:8000`), a fresh browser profile, 1440 × 900, driven as a LAN
user with no machine on the network. Every screen is captured with its transcript in
`docs/bench/img/2026-10-26-walkthrough/` (numbered in flow order); the maintainer's three phone captures
of the same build are in `docs/bench/img/2026-10-26-phone/`. The maintainer's verdict that prompted this:
"I don't think we are following any design and this is a hacked together mess, not world class software."*

The design the flow is measured against exists: `cnc-job-workflow.md` §5 (2026-10-17, the proposed
workflow and its screens), `cnc-panel-redesign.md` (2026-10-18, the Design and Cut panels),
`cut-this-blank-wizard.md` (2026-10-24, the one guided cut flow), and the category patterns in
`../market-research/UI-PATTERNS.md`. The finding of this audit is not that there is no design; it is that
the built flow follows the designs piecemeal — each slice landed its own screen, its own numbering and its
own words, and nobody owned the path between them.

## 0. The flow as built (what the operator actually meets)

```
Welcome ("Start a New Project" — the 3D-printing board picker)
  └─ [Set up a cutting job…]  ──▶  modal "Start a cutting job"  1/3 Machine → 2/3 Stock → [Next: mount]
                                      └─▶ modal "Set up this job"  1/2 What are you cutting? → 2/2 What is holding the part? → [Finish]
                                            └─▶ the panel, titled "Cut", tabs [Design | Cut]
                                                  Design: file row · Set up/Import · Job (Stock, Facing, Voids, Items, Target) · Cutter · Cutting · Depth margins · Hold · findings · Generate
                                                  Cut:    1 Check · 2 Freeze · 3 Register · 4 Cut           ← one cut flow
                                                  [Cut this blank] ──▶ FULL-PAGE 7-step wizard               ← a second cut flow
                                                  [Set up this job…] ──▶ modal "Set up this job" 1/3 Holding… ← the wizard again, numbered a third way
```

Three modal/page sequences, three numberings (1/3, 1/2, 1/3), two cut flows, and the operator's first
dead end at Generate. The sections below take each screen in order; every issue has an id (A1…E5) that
the work items reference.

## 1. The door (capture 01)

The CNC job starts from the 3D-printing welcome page: "Start a New Project — Pick a board — its enclosure
generates around the real connector and mounting-hole geometry…", a board search, 31 boards, project-type
cards with "~2400 MIN PRINT" badges. The cutting entry is one of three buttons beside the search box.

- **A2** The cutting job has no door of its own. The wizard modal opens over the print library (the phone
  capture shows "Pelican-style protective enclosure… ~480 MIN PRINT" behind the stock step). The design's
  spine (§5.0) is "one job document, reachable with no case project open"; UI-PATTERNS §1: the first run is
  a guided wizard — of the thing being made, not a modal over something else.

## 2. "Start a cutting job" — step 1 / 3, Machine (captures 02, 03)

Verbatim: a select "Makera Z1" (one entry); "Every job is written for one machine: its work area, its
spindle ceiling and its own limits. That is true whether or not one is connected now."; "Whether a machine
is on the network. This is a check rather than a question — the machine is asked, and it answers or it does
not."; `[Check for a machine] or connect to an address [192.168.1.50] [Connect]`; after the check:
"Nothing answered the search. That is not a problem — a job can be written, verified and simulated without a
machine, and the machine can be connected later."; `[Back] [Next]`.

- **A3** Two paragraphs of explanation where the design shows one line: `Machine [Makera Z1 · Z1…010290 ▾]
  ● Idle · homed` (§5.1). The app already knows this house's machine — `location.json` holds
  `Makera_Z1_010290 · 192.168.10.43` (the Cut-this-blank page prints it, capture 55) — yet the step offers a
  placeholder `192.168.1.50` and does not check automatically. A select with one option is not a choice.
- **C3** This is the first of three places a machine is connected (the others: Manage › Machines, and the
  Cut-this-blank page's step 1), each with its own words and its own address field.

## 3. Step 2 / 3, Stock (captures 04–10; phone 06:43 and 08:54)

Verbatim: "Material — first, because it decides the feeds and which stock is on offer" over a 22-entry
select defaulting to **softwood**; radios `On the shelf · Type a piece · Load STL / 3MF`; shelf door:
"Nothing in softwood on the shelf. Type the piece, and tick "put it on the shelf" to keep it."; Type a
piece: `[plate ▾] L (X) [ ] W (Y) [ ] T [ ]`, "Rod, tube and disc are not offered: a job here cuts a
rectangular block held in the vise, and round stock needs the rotary. Sphere stock is not offered at all.",
`☐ also put it on the shelf`, `Finish [not known ▾]`, then "Plate 76.2 × 38.1 × 3.81 mm of softwood, as
typed." and "Facing: on by default — the finish is not known, so it is faced first. The job starts with a
0.2 mm skim; the Cut panel shows that depth and can change it."; below, "Or start from a template — its
blank becomes the stock, and the setup asks the rest." with two cards of 50–80 words each; `[Back]
[Next: mount]`.

- **A4** The default material is softwood, which this house does not stock ("Nothing in softwood on the
  shelf") and does not cut (the standing rule is a printed plastic blank). A default the operator must
  always change is not a default. Design: the location's material, the shelf first.
- **A5** The material list is 22 ungrouped names: woods, then PLA/PETG, then "plastic (unspecified)" in the
  middle of the plastics, "PET" next to "PETG", then metals. No groups, no house-first ordering.
- **A7** `plate | block | sheet | printed blank` — nothing on the screen (or in the guide) says what
  distinguishes them; in the code (`stockStart.ts`) they are four words whose only effect is the facing
  default and the finish. The maintainer's question "what is the difference between a plate, a block and a
  sheet" has no answer in the product.
- **A7** `L (X)`, `W (Y)`, `T` — no unit on any field, no `Z` on the thickness, no placeholder, the `T`
  field wraps to its own line on a phone. The panel it lands in labels the same numbers "length X / width Y
  / thickness". Two vocabularies for one box.
- **A7** "Rod, tube and disc are not offered… Sphere stock is not offered at all." — a refusal paragraph on
  the default path, and an overbroad one: a disc or a short rod sits in the vise or on tape for a face job
  (§5.2's mount table), and the design's Make door offers plate / block / rod / tube / disc (§5.1). The
  maintainer: "I am not allowed to put a circle or rod in the vise."
- **A8** "also put it on the shelf" introduces the shelf with no explanation at first contact; `Finish`
  lists `rough (sawn, as bought) · finished face · printed · not known` with the default last; the two
  consequence sentences (the summary and the facing paragraph) are prose where one line was designed
  (`plate 100×100×5 · 6061 · raw (sawn faces) … finish: raw ▸ face it first`).
- **A6** The template cards carry developer provenance ("ported from samples/badge-blank/make_badge.py")
  and cross-references ("For a two-colour badge with a magnet pocket, use the Name badge template
  instead.") in operator text.
- **A9** The Load door is a bare browser `Choose File | No file chosen` and a three-condition paragraph
  ("A closed, prismatic, rectangular mesh is cut as a block of its size. A PrusaSlicer project… A shaped
  (3D) blank is refused until the 3D engine lands.").
- **E2** The design's four doors (shelf · Makera sizes · load · make) are three here, and the shelf is
  empty, so a first job always types.

## 4. "Next: mount" → "Set up this job" 1 / 2 and 2 / 2 (captures 11–16)

The button says *mount*; what opens is a second modal, "Set up this job — 1 / 2 — What are you cutting?":
fourteen cards (Engrave · V-carve · V-carve (variable depth) · Inlay · Pocket · Profile · Chamfer the edge ·
Hole · Bore to size · Thread · Surface a mesh · Texture a surface · Flute along a line · Raise a prism),
no selection state, no Next; picking *Engrave* silently adds an item named "New text" at 0.5 mm with a
warning triangle and moves to "2 / 2 — What is holding the part?": `◉ Vise ○ Rotary chuck` ("A rotary chuck
is asked about here but not yet offered."), `Sacrificial material [none ▾]`, a line reading
"● vise-default Vise dimensions: shipped defaults (reference unit).", and `[Same as last job] [Back]
[Finish]`.

- **A1** One flow, three numberings: the first modal counts 1/3, 2/3 and promises "3: mount"; the second
  counts 1/2, 2/2; re-opening "Set up this job…" from the panel later shows "1 / 3" starting at holding
  (capture 57). The design is one wizard that "asks §5.1 and §5.2 in two screens and lands in Design mode".
- **A10** "What are you cutting?" is the right question (the maintainer's own ruling, #662) in the wrong
  place and form: it comes where *mount* was promised, it is a grid of fourteen equal cards with no
  grouping (engrave/carve · cut away · holes · 3D), and the choice has no visible consequence until the
  panel appears with a placeholder label.
- **E3** Picking Engrave creates "New text" instead of asking for the text. The one thing an engraving
  needs is the text.
- **A10** The holding step offers a disabled option with a sentence explaining that it is disabled ("asked
  about here but not yet offered"), prints a finding code (`vise-default`) in operator text, and asks no
  orientation question — the design's §5.2 is a mount choice with a top-view picture and three landmark
  questions (face up, reference edge, nearest you).

## 5. The Design panel (captures 17–44)

### 5.1 Header and file row

Verbatim, top to bottom: title **Cut** · `[Design] [Cut]` · `[Cut this blank]` · `[Save job] [Save job
as…] [Open job…]` · "Not saved to a file yet · unsaved changes" · "the job file is the owner — the package,
the run log and the sources live in it, not in this browser." · `[Set up this job…] [Import a design
(.3mf)…]` · "Job — Stock 76.2 × 38.1 × 3.81 mm · pla".

- **B1** "Cut" three times with three meanings: the rail entry, the panel title, and the second tab;
  then a headline "Cut this blank" button above everything. The operator has just chosen *Design*.
- **B2** Two save systems on one screen: the top bar's `Save · Load` (the 3D project) and the panel's
  `Save job · Save job as… · Open job…` (the job file), plus the top bar's `New` (a project) against the
  wizard, and `Export…` (3D) against `Save .nc…` at the bottom. The maintainer: "the save buttons still two
  of them." The job file's ownership sentence is a developer note in the operator's panel.
- **B3** `[Set up this job…]` re-opens the wizard at "1 / 3", the third numbering.

### 5.2 Job: Stock, Facing, Voids, Items, Target object

- **B4** Two headline buttons `Use the badge blank · Use the blank` (the design's §2.3 said *remove* the
  badge-blank headline; it becomes a shelf entry); every field carries a grey `typed` chip, including the
  three the operator typed thirty seconds ago; "X runs between the vise jaws. The fixed jaw is on the
  left." sits under the stock (the redesign moves it to Hold); Facing is a two-line paragraph where the
  redesign has one line ("Facing — not offered on plastic").
- **B5** "Voids under the face · 0 · collapse all · expand all", a four-sentence explanation, and four large
  buttons `Rectangle · Circle · Slot · Polygon` under "add a void:" — above the Items, for a feature the
  design itself calls ~1 % of jobs and collapses at 0.
- **B6** Items: one row `✕ ☑ ▸ T Engrave "New text" [Engrave] 0.5 mm ⚠` — the warning has no text on the
  row; "+ Add operation…" opens the same fourteen cards plus a *second* vocabulary under "More kinds and
  imports": `Circle Slot Polygon · combined: Border Frame Cut-away · single-line: Line Single-line text ·
  holes: Hole array · 3D: Box Cylinder Cone Sphere · cut-outs: Cut out` — lowercase group labels ending in
  colons, kinds beside operations, "Cut out" beside "Profile", "Hole array" beside "Hole". "Surface a mesh is
  offered on a job with nothing else in it — a goal mesh is roughed and finished as the whole program." is a
  sentence where a disabled card with a reason belongs.
- **B7** Target object: "A model the job is placed against. As a reference it is embedded and drawn but
  never cut — the stock around it is the profile cut-out work (#218)…" — an issue number in operator text;
  the phone capture shows the import refusing a 12 MB file against a 4 MB limit the operator learns of only
  after choosing the file.

### 5.3 Cutter

- **B8** The cutter select is one flat list of ~160 entries with four naming forms: `3.17 mm flat end ·
  3.175*12mm Flat End(Metal)` (3.17 against 3.175 on one line), `0.1 mm 90° chamfer · 3.175mm*90º Chamfer`
  (a tip width the record does not state), `chamfer (Chamfering Bit - 1/8" Shank 90°)` (the house bit, a
  broken form: kind then the vendor label in brackets — `toolDisplayName`'s no-cutting-size branch), and
  `3.17 mm flat end · Spiral 'O' Single Flute Bit for Metal - 1/8" Shank [diameter washed out on label; code
  says 3.175]mm * 12mm` — a curator's note from the house inventory printed as a cutter's name.
- **B8** The V-carve explanation box prints "The tip is 0.0 mm wide and its flank is 45.0° from the axis."
  and ""New text" at 0.5 mm: 0 mm groove at the plane — floor 0 mm narrower per side, top opening 0.5 mm
  wider per side; the pass pitch was not resolved for this job." — the last clause is the real blocker
  (see B9) buried in a geometry sentence.
- **B8** "Recommended: 3.175 mm V-bit — V-carve — the design is cut at the colour plane, so the groove
  width there is the design (reach not recorded). [Use it]" recommends the cutter already selected, so
  *Use it* does nothing; "No catalogue row can name this cutter — it carries no Makera cutter id — so its
  recommendation rests on the operator." is a disclaimer, not information.
- **B8** "Why? — 160 cutters considered": twenty rows read `1.0 mm flat end — not a flat end mill` (they
  are ball noses whose display name says "flat end"), forty read the same catalogue sentence; the list is
  longer than the panel and says nothing an operator can act on.

### 5.4 The dead end: Generate (captures 36–41)

With the wizard's own choices — PLA, Engrave, the recommended V/chamfer bit — `Generate toolpath` is
disabled. Its tooltip: **"Fix the errors above first."** The findings read **"1 warning · 0 errors"**.
Nothing on the screen names the blocker. The first job cannot be generated; it took changing the cutter to a
1 mm flat end mill by trial to continue (captures 42–44). In the code (`EngravePanel.tsx` ~1265)
`blocked = errors.length > 0 || blockedByFeeds` and both share the one sentence; the feeds refusal (no row
for that cutter on PLA; the V pass pitch unresolved) is never attached to the button.

- **B9** This is the headline defect of the walk-through: the product's own defaults lead to a disabled
  button with a false reason. UI-PATTERNS §4 and §7: feeds come from machine + material and are *said*; a
  refusal names the fix. `cut-this-blank-wizard.md` step 2 designed exactly this: run the cutter/material
  check *at the cutter*, with "Pick another cutter (the recommended one first)" in place.

### 5.5 Cutting, Depth margins, Hold, findings

- **B10** `Cutting [starting values]`: five numbers, "step-over 1.42875 mm" (five decimals); `Override ▸`
  explains "Leave a field empty to use the computed value. A step-over wider than the cutter's radius is
  refused rather than clamped (#191)." — an issue number again.
- **B11** `Depth margins 0.2 mm [the house default]` then "How far every floor stays clear of a plane it must
  not cross — a void's ceiling, the colour split. Z tolerance 0.05 mm; a job with no stated margins follows
  the house setting." and "For this blank: 0.2 mm — the wired probe adds 0.001 mm; flatness not yet measured:
  no bow claim." — engineering notes on the main path; the redesign folds this to one line in the Cutter
  group.
- **B12** Hold is one good line ("Vise — shipped · reference unit · blank on the ledge") — and then the
  findings repeat it as a warning ("Vise dimensions: shipped defaults (reference unit).") beside an
  information sentence styled as a finding ("The job seats the blank on the soft jaws' ledge, 3.1 mm below
  the jaw tops. It states the 3.81 mm blank stands 0.71 mm proud of the jaw tops.").
- **B13** "▸ 1 warning · 0 errors [show]": the toggle is a 4-mm `show` button; the list uses coloured dots
  with no severity word; nothing says which finding blocks.

### 5.6 After Generate (capture 44)

- **B14** Three green rows and then three paragraphs: "Checked: the tool against the stock and the modelled
  fixture (Vise fixed jaw (left), Vise moving jaw (right)). Not checked: the spindle body, head and gantry;
  anything on the bed other than the declared stock, workholding and sacrificial material; the shank of "1 mm
  flat end" above the cutter, which states no shoulder or flute length. The modelled fixture is a shipped
  default." and "Matches prediction — under-cut 0.0000 mm², over-cut 0.0000 mm², both within the 0.0010 mm²
  floor (tolerance 0.018 mm)". Honest, and unreadable at that point: the design puts the what-was-not-seen
  sentence in the as-cut preview (§5.7) and the numbers beside it, not under the button.
- **B14** `☐ I have checked clearance to the vise and the tool's reach myself.` gates `Save .nc…`, whose
  disabled note says "tick the clearance checkbox **below**" — the checkbox is above it.
- **B15** The Generate row says "~2:16"; the simulator's footer says "3:40 / 3:40 simulated" for the same
  program. Two durations for one cut, neither labelled as what it is (UI-PATTERNS §3: one time, with its
  source).
- **B16** The viewport labels "registration: the left edge ±0.05 mm" and a legend "Depth — nothing cut ·
  registration ±0.05 mm" before anything is designed, and the vise jaws are drawn as two dark blocks three
  times the blank's size.

## 6. Cut mode and the second cut flow (captures 45, 55)

Cut mode: `✓ 1 Check the job — clear` · `✓ 2 Freeze the plan — 1 program · frozen 13:07` with a box
("The package — 1 program · 1 setup · frozen 13:07 / The frozen programs still describe this job. / You're
supplying this stock yourself, so no blank needs to be held. / this job's stock is not a shelf entry, so no
blank is held.") · `● 3 Register the blank — left edge, then the top face` with "No machine is connected.
Reach it first, then come back to register." **and** "This job has no saved setup yet. Plan its
registration in Design → Setups, approve it, then run it here." · `● 4 Cut — the plan and the controls` ·
"The steps — plan, dry run, manual upload and the release flow" · "The plan".

- **C1** The freeze box says the same thing twice (once lowercase); step 3 gives two contradictory
  instructions (the header says the plan is "left edge, then the top face"; the body says there is no
  plan); step 4 speaks in developer words ("the release flow", "manual upload").
- **C2** `Cut this blank` opens a **full-page** seven-step wizard ("← Back to the panel · 1. Machine 2. Blank
  and cutter 3. Registration plan 4. Generate 5. Freeze 6. Register 7. Run") whose step 1 is the Manage ›
  Machines card dumped inline: "Case Maker build a22d782d", "Export my machine / Import", then an unstyled
  run-on "My shop default namelocation location.json · created 2026-10-17 18:52 profileZ1nameMakera_Z1_010290
  nicknameZoomba… 11 numbers unmeasured ▸ calipers list", a ten-clause "history:" sentence, and a stray bed
  thumbnail. The panel's Cut mode (4 steps), this page (7 steps) and Design's Generate rows are three cut
  flows for one job; `cut-this-blank-wizard.md` designed one.
- **C3** Machine connection, third place (see A3).

## 7. The Simulate panel (capture 52)

- **D5** `Simulate — No file open — Open .nc… / Drop a .nc, .gcode, .cnc or .tap file here (max 64 MB).` then
  a `Tool` select of the same ~160 cutters under their raw vendor labels (`3.175*12mm Flat End(Metal)`) —
  a third naming for the same cutters.

## 8. System-wide language and conventions

- **D1** Issue numbers and code tokens in operator text: `(#218)`, `(#191)`, `(#206)` in the Generate
  tooltip, `vise-default`.
- **D2** Provenance chips (`typed`, `computed`, `the house default`, `starting values`, `recommended:
  3.175 mm`) are the right idea (decision 28) applied as grey tags on every field, including the ones the
  operator just typed; they read as noise rather than as facts in their own place.
- **D3** Units: unlabelled in the wizard, `length X` without `mm` in the panel, `mm` in the sentences;
  decimals 3.17 / 3.175 / 1.42875 / 0.0000 side by side.
- **D4** Headings and casing: `Items 1`, `Voids under the face 0`, `Target object 0` (count chips as part
  of the heading), `add a void:`, `combined:`, `holes:` lowercase with colons; sentence-case buttons beside
  Title Case ones.
- **E1** No sense of place across the whole first job: four surfaces (two modals, the panel, the full
  page), no progress that spans them, no "what happens next".
- **E4** The machine is never connected automatically though the location knows it; the design's strip
  (`Z1 …010290 · 192.168.10.43 · Idle · homed`) is the one home for that fact.

## 9. What is right, and must be kept

The spine is right: one job document, Design then Cut, the gate (generate → verify → simulate → matches
prediction), the run sheet, provenance on every number, refusals by name, the registration plan, the
operations matrix now at 20/23. The audit is about the surface the operator meets, not the engine under it.

## 10. Where the issues go

Work items are filed per screen (one issue each, the audit ids inside) under the umbrella **#679**:
#680–#692, the table is in the umbrella's first comment. All are gated: nothing is implemented until the
maintainer has approved the target flow (`first-job-flow.md`) and its mockups
(`first-job-flow-mockups.html`, the "First Job Flow" artifact).
