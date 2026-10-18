# The CNC panel from a clean slate — Design, Cut and the live machine

**Status: design document, draft 1, 2026-10-18, for #521.** Nothing here is built. Every "today"
statement reads the code at `bccc2459` and the bench screenshots of the same day
(`.scratch/bench-2026-10-18/shots/05-engrave-panel.png`, `07-setups.png`). #519 (live machine,
touches, chuck + tool, camera) and #520 (the vise as it is) are held on this document and are
re-scoped in §8. The reader knows the app; sections are named by their heading and their testid.

## Contents

1. What the operator sees today, and what is wrong with it
2. The architecture: four stages, two modes, one rail
3. Design mode — what stays, collapses, moves, merges
4. Cut mode — a short checklist, not a second column
5. The live machine: a status strip and a dock, not rail sections
6. The viewport's machine layer
7. Principles, and the duplicate facts they remove
8. Migration order

## 1. Today

The right rail (`context-panel--rail`, ~360 px) holds one `panel-stack` (`engrave-panel`) that
scrolls. Design mode renders, in this order:

| # | Section (heading) | Key testids | Lines in `EngravePanel.tsx` |
|---|---|---|---|
| 0 | Mode switch | `cnc-mode-switch`, `cnc-mode-design`, `cnc-mode-cut` | 1627–1655 |
| 1 | Job file row | `EngraveJobFileBar` (Save / Save as / Open, "not saved yet") | 1661 |
| 2 | Set up this job… / Import a design (.3mf)… | `engrave-setup-open`, `engrave-design-import`, `engrave-design-notes` | 1663–1731 |
| 3 | Stock | `engrave-stock-from-badge`, `-from-blank`, `engrave-stock-*`, `engrave-stock-material` | 1734 |
| 4 | Facing (h4) | `engrave-facing-why`, `-on`, `-off`, `-state`, `-depth` | 1822 |
| 5 | Voids under the face (h4) | `engrave-keepout-count`, `engrave-add-keepout-*` | 1907 |
| 6 | Items | `engrave-item-count`, `engrave-add-menu`, item rows | 1956 |
| 7 | Design target objects | `engrave-target-count`, `engrave-target-import` | 2238 |
| 8 | Margins | `engrave-margins`, `-value`, `-source`, `-use`, `-house` | 2293 |
| 9 | Cutter | `engrave-tool`, `engrave-recommendation`, `engrave-use-recommended`, "Why? — N cutters considered" `<details>` | 2342 |
| 10 | Vise | `engrave-vise-badge`, `engrave-vise-*` fields, `-seat`, `-save`, `-measured` | 2573 |
| 11 | Sacrificial material | `engrave-sac-badge`, `-preset-*`, `-under`, `-save`, `-clear` | 2614 |
| 12 | Setups | `EngraveSetupsSection`: `engrave-setups`, `-badge`, `-replan`, `-use-plan`, `-add`, setup rows | 2735 |
| 13 | Cutting (feeds) | `engrave-feeds-status`, `-clamped`, `-refused`, `engrave-feeds-*`, Override `<details>` | 2738 |
| 14 | Findings | finding rows (code token + sentence) | 2809 |
| 15 | Generate | `engrave-generate`, `engrave-run-rows`, `engrave-last-measured`, `engrave-sim-coverage`, `engrave-ack`, `engrave-save`, `engrave-run-sheet`, `engrave-open-record` | 2838 |

Cut mode replaces 1–15 with: `EngraveRegistrationStep` (`engrave-registration-*`, incl. the
"Machine transcript" `<details>`), then `EngraveCutSurface`: the package box (`engrave-package`),
`EngravePreflight` (`engrave-preflight`, `-summary`, `-policy`, `engrave-back-to-design`), the plan
(`engrave-cut-plan`: `RunPlanView` + `MachineStrip` with `machine-strip-<feature>-switch`), and the
run (`engrave-cut-run`: `EngraveReleaseStep` for several programs or `EngraveMachineUpload` +
`EngraveMachineRun` for one). The viewport has six layer toggles (`viewport-layer-removed|path|
rapids|tool|fixture|sacrificial`), the depth legend (`engrave-legend-*`) and, in Design mode, two
plain translucent boxes for the jaws with floating labels.

What is wrong, in the operator's words (#519, #521): the column is long (two screens at 1500×850
before Setups is reached; `07-setups.png` is the *second* screen), the vise numbers appear in three
places, a finding opens with a code token (`vise-stock-not-proud`), and during a run or a
registration nothing on screen moves: the head is watched at the machine, the trace lives in a
transcript `<details>`.

What the app already knows live, from the `?` line it polls every ≥2 s (`protocol.ts`
`MIN_STATUS_POLL_MS`, `JobProgress`): the **state word** (Idle / Run / Home / Alarm), **MPos** and
**WPos** (X Y Z, A B when fitted), **F:** actual / set / override %, **S:** actual / set / override %
spindle rpm, **T:** tool number and length offset, and while a file plays **P:** line / percent /
elapsed seconds. Alarm lines arrive beside the status. The controller does not report the vacuum
as a status field; the app knows only what it last sent (M331 / M332). The camera is a separate
stream (`ws://<host>:82/ws_video`, read today by `tools/z1/camera.mjs`), not part of `?`.

## 2. The architecture

Four stages, in the order a job moves: **Design → Setups → Cut → Run.** The two existing modes
keep their buttons and testids; the stages map onto them as **Design mode = Design + Setups** and
**Cut mode = Cut + Run.** No third button: Setups is not a mode, it is the second half of describing
the job, and Run is not a mode, it is Cut with a machine answering.

What each stage needs, and what is noise there:

| Stage | The operator needs | Noise at this stage |
|---|---|---|
| Design | the stock, the items and where they sit, the cutter and whether it is recommended, the findings that make the job red | vise numbers, sacrificial presets, feed overrides, package / preflight / plan |
| Setups | how the blank is held (vise + seat), what sits under it, how many setups and what each cuts | item editing, the 159-cutter list, the file row |
| Cut | is the gate clear; is the package current; is the blank registered; what will be sent | every Design field, the vise fields, the candidate list |
| Run | what the machine is doing now, where it is, how far through, each touch and its reading, stop | everything in the rail except Stop and the end-of-run questions |

Three surfaces carry this:

- **The rail** (the existing right column) — the job's description and the operator's decisions.
  Scrolls in Design mode; a short checklist in Cut mode.
- **The status strip** — one line under the viewport, present whenever a machine is remembered.
  The live facts, and only the live facts.
- **The dock** — a collapsible band under the strip with three tabs: Touches, Transcript, Camera.
  What the machine *said and showed*. Empty tabs do not render.

The viewport is the fourth, and grows a machine layer (§6). The item editor is placed in the rail's
Job group exactly as it is today (constraint of #521: placed, not redesigned).

## 3. Design mode

The rail becomes three groups and a footer. A group is a heading with a one-line summary that is
always visible and a body that is open or closed; the summary carries the group's facts in words
so a closed group is not a blank. Groups open by default where the operator edits daily, closed
where the honest default normally stands. No new controls, no sliders; every field that survives
keeps its testid.

```
┌─ Engrave text ───────────────────────────────── × ┐
│ [  Design  ] [   Cut   ]                          │  cnc-mode-switch (unchanged)
│ Save · Save as… · Open…  "badge-F400.cmj · saved" │  EngraveJobFileBar (unchanged)
│ [ Set up this job… ]  [ Import a design (.3mf)… ] │  one row, same two testids
├─ JOB ──────────────────────────────────── open ──┤
│ Stock  25.35 × 76 × 1.5 mm · plastic · typed      │  engrave-stock-* (unchanged)
│   ▸ Facing — not offered on plastic               │  one line when not offered
│   ▸ Voids under the face (0)                      │  closed at 0
│ Items (4)              [collapse all][expand all] │  the editor, as today
│   ▸ F400  label · 0.1 mm · V-bit                  │
│   ▸ …                                             │
│   ▸ + Add…                                        │  engrave-add-menu
│   ▸ Design target objects (0)                     │  closed at 0
├─ HOLD ───────────────────────────────── closed ──┤
│ Vise — shipped defaults · blank on the ledge,     │  summary = the one vise sentence
│   1.6 mm below the jaw tops                       │
│ Sacrificial — none · Setups (1) · saved           │
├─ CUTTER ──────────────────────────────── open ──┤
│ 30° × 0.3 mm V-bit  [recommended]  [Use it]      │  engrave-tool, engrave-recommendation
│   ▸ Why? — 159 cutters considered                 │  the existing <details>
│ Cutting — no starting row for plastic; pick PLA,  │  engrave-feeds-refused, in red as today
│   PETG or a flat end mill            ▸ Override   │
│ Margin 1 mm from the edge · house                 │  engrave-margins-*, one line
├───────────────────────────────────────────────────┤
│ 2 warnings · 0 errors                      ▸ show │  footer, sticky: findings summary
│ [            Generate            ]                │  engrave-generate
│ last measured …  · simulated: swept, vise modelled│  engrave-run-rows, as today
└───────────────────────────────────────────────────┘
```

Verdict per section (numbers from the §1 table):

| # | Section | Verdict |
|---|---|---|
| 1 | Job file row | **Stays** at the top. Its sentence shrinks to `name · saved 14:02` / `not saved yet`; the "the job file is the owner…" paragraph goes to the Save button's `title`. |
| 2 | Set up / Import | **Merge** into one row of two buttons; `engrave-design-notes` stays under it. |
| 3 | Stock | **Stays**, first in the Job group. The "X runs between the vise jaws" sentence moves to the Hold group's vise card, where the jaws are. |
| 4 | Facing | **Collapses** to one line when the stock refuses facing (plastic: every bench job so far). Only wood/metal stock opens the on/off pair. |
| 5 | Voids | **Collapses** at count 0; the four-line explanation becomes the `+` button's `title`. Open when a void exists. |
| 6 | Items | **Stays**, placed. Not redesigned. |
| 7 | Targets | **Collapses** at count 0, last in the Job group. |
| 8 | Margins | **Merges** into the Cutter group as its last line (it is a cutter-clearance decision); `engrave-margins-use` / `-house` stay as the two buttons. |
| 9 | Cutter | **Stays**, opens the Cutter group. The candidate list stays inside its `<details>`. |
| 10 | Vise | **Moves** to the Hold group as a card: one sentence (source · seat · proud/below) always visible; the four number fields, the seat select and the two Save buttons open on "Edit". Same testids. |
| 11 | Sacrificial | **Moves** to the Hold group, closed when `none`. |
| 12 | Setups | **Moves** to the Hold group, below the vise, open when there is more than one setup or the plan is stale. |
| 13 | Cutting | **Stays** in the Cutter group under the tool. Override stays a `<details>`. |
| 14 | Findings | **Merges** into the sticky footer as a count that expands; the code token leaves the sentence (`data-code` keeps it for tests). |
| 15 | Generate | **Stays**, in the footer, never below the fold. |

The footer is the one place the job's state is read: findings count, Generate, and the run rows.
Nothing above it repeats a finding.

## 4. Cut mode

Cut mode today stacks five boxes whose prose explains each other. It becomes a checklist of four
numbered steps, each one line when done and open when it is the step the operator is on. The
registration step moves *below* the gate (the gate is what says whether registering is worth doing)
and its results leave the rail for the dock and the viewport.

```
┌─ Engrave text ───────────────────────────────── × ┐
│ [  Design  ] [   Cut   ]                          │
│ ✓ 1  Gate — clear                        ▸ policy │  engrave-preflight (summary line; opens when blocked)
│ ✓ 2  Package — 1 program · frozen 14:05           │  engrave-package (one line; stale ⇒ opens, Freeze again)
│ ● 3  Register the blank                           │  engrave-registration (the current step)
│      Left edge then the top face, 4 touches.      │  engrave-registration-plan-summary
│      [ I am at the machine ]  [ Start ]           │  -at-machine, -start
│      Surface spread 0.03 mm — within band.        │  -spread / -verdict, one sentence each; the
│      [ Write the offset ]                         │   touches themselves are in the dock (§5)
│   4  Run                                          │  engrave-cut-run
│      ▸ The plan — 6 min, vacuum on, spindle on    │  RunPlanView inside a <details>; MachineStrip switches
│      Send badge-F400-1.nc to Z1 at 192.168.10.43  │  engrave-upload / engrave-release-upload
│      [ Upload ]  [ Start ]  [ Stop ]              │  -start, -stop (Stop always visible once sent)
│                                                   │
│ ← Back to design                                  │  engrave-back-to-design
└───────────────────────────────────────────────────┘
```

Verdict per Cut section:

| Section | Verdict |
|---|---|
| `engrave-registration` | **Stays** as step 3. Plan summary, Start / Continue / Stop, verdict, spread sentence and Write stay. The touch list (`-surface`, per-scan readings) **moves** to the dock's Touches tab and the viewport; the "Machine transcript" `<details>` **moves** to the dock's Transcript tab. Testids travel with the elements. |
| `engrave-package` | **Collapses** to one line when current; opens with Freeze again when stale. The reservation sentence stays inside. |
| `engrave-preflight` | **Stays** as step 1, one line when clear; the policy section opens on request; opens fully when blocked, with the first blocking finding. |
| `engrave-cut-plan` | **Collapses** into step 4's `<details>`; `MachineStrip` stays visible inside it because its switches are decisions (vacuum, spindle). |
| `engrave-cut-run` | **Stays** as step 4. Upload confirm boxes stay. The progress sentence (`engrave-run-progress`, `engrave-release-progress`) and the lines log (`engrave-run-lines`) **move** to the strip and the Transcript tab. The end-of-run questions (`engrave-run-stock-question`, `-offcut-*`, `-home`) stay here: they are decisions. |

The release step's cutter-change box (`engrave-release-change`) stays in step 4 where it is a
decision ("I fitted the cutter"); the drawn tool in the viewport changes when it is confirmed.

## 5. The live machine

Not in the rail. The rail is what the operator decided; the strip and dock are what the machine
is doing. One fact, one home:

**The status strip** — a single line, full width under the viewport canvas, rendered whenever a
machine is remembered (`machineStore.machine !== null`), in both modes. Testid `machine-status`,
one child per fact:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ● Running  line 412 of 1 890 · 22 % · 1:48   X 12.350  Y 38.000  Z −0.120 (work)        │
│   spindle 10 000 rpm · vacuum on (as sent) · 30° V-bit (T6)              [ Stop ]        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Fact | Source | Shown as |
|---|---|---|
| state | `?` state word | a word the operator uses: Idle / Homing / Running / Probing / Alarm / Not answering. `Probing` is Run while a registration owns the machine. |
| position | `WPos` (work) with `MPos` on hover; A/B only when the rotary is fitted | three numbers, mm, 3 decimals |
| program | `P:` line / percent / elapsed | `line 412 of 1 890 · 22 % · 1:48`; absent when idle |
| registration step | the registration runner's current scan | `touching the left edge, point 2 of 3`, in the same slot as the program fact |
| spindle | `S:` actual rpm | `spindle 10 000 rpm` / `spindle off` |
| vacuum | what the app last sent | `vacuum on (as sent)` — the qualifier stays until the controller reports it |
| cutter | `T:` + the inventory entry the job fitted | its catalogue name; "probe" while registering |
| alarm | the alarm line beside the status | replaces the state cell, red, verbatim controller text |
| Stop | the existing stop handlers | one button, right end, visible whenever state is not Idle |

`machineStore.noteLiveStatus` already keeps `{busy, status}`; the strip needs the parsed fields
kept beside it (state, WPos, MPos, F, S, T, P) — one parser, in `protocol.ts` next to
`JobProgress`, used by the strip, the viewport and the registration runner.

**The dock** — a band under the strip, 160–220 px, collapsed to its tab bar when nothing is live.
Testid `machine-dock`, tabs `machine-dock-touches`, `-transcript`, `-camera`. Default tab: Touches
while a registration runs, Camera while a program runs and the stream answers, otherwise the last
one used. The dock opens itself when a registration or a run starts and stays as the operator left
it afterwards.

- **Touches** — the table behind the viewport's touch markers: one row per touch as it lands
  (`#`, scan, X Y commanded, Z read in work and machine mm, verdict: stock / miss / off-band),
  then the spread sentence. The rail's `engrave-registration-touches` block moves here whole.
- **Transcript** — the machine's lines (`engrave-registration-transcript`, `engrave-run-lines`,
  `engrave-release-notes` move here), newest last, monospace, unchanged content.
- **Camera** — the `ws_video` stream as an `<img>`/canvas, with one control: pause. No alignment
  overlay in this pass (UI-PATTERNS §10 is a later project); the pane answers "what is on the bed"
  without walking over. The tab is absent when the machine has no camera endpoint.

The registration runner and the run both write to the same strip and dock; neither renders a
transcript inside the rail again.

```
┌───────────────── viewport ───────────────────────┐ ┌─ rail: Cut ───────────┐
│ PERSPECTIVE TOP FRONT SIDE · ZOOM FIT             │ │ ✓ 1 Gate — clear      │
│ ☑REMOVED ☑PATH ☑RAPIDS ☑TOOL ☑FIXTURE ☑SACRIF.    │ │ ✓ 2 Package — current │
│ ☑MACHINE ☑TOUCHES                                 │ │ ● 3 Register          │
│                                                   │ │   left edge, 2 of 3   │
│        ╱chuck╲  (translucent, at WPos)            │ │   [ Stop ]            │
│         │probe│                                   │ │ 4 Run                 │
│   ┌─────┴┴────────┐  ● −0.02   ● −0.05            │ │                       │
│   │ F400  blank   │  touches with readings        │ │                       │
│ ══╧═══════════════╧══ stepped jaws, rails, grid   │ │                       │
├───────────────────────────────────────────────────┤ │                       │
│ ● Probing  left edge, point 2 of 3  X −13.0 Y 10  │ │                       │
│   Z 2.000 · spindle off · probe (T0)     [ Stop ] │ │ ← Back to design      │
├─ Touches │ Transcript │ Camera ───────────────────┤ └───────────────────────┘
│ # scan        X      Y      Z work   verdict      │
│ 1 left edge  −13.00 10.00  −0.02    stock         │
│ 2 left edge  −13.00 38.00  −0.05    stock         │
└───────────────────────────────────────────────────┘
```

## 6. The viewport's machine layer

Three additions, all drawn from facts the app already holds (the vise constants, the inventory
entry, the status line); nothing hand-placed.

**The fixture as it is (#520).** Under the existing `viewport-layer-fixture` toggle, replacing the
two boxes: two full-length rails with their screw stations (numbered on the moving-jaw rail, so
"screw 2" means something), stepped soft jaws (10 mm land, 3.1 mm step, 1.9 mm ledge, 100 long —
`DEFAULT_VISE`), the open slot between the jaws, the blank seated where the seat says (ledge /
packer / floor), and the bed: the hole grid and the two bed rails under the vise. The bed belongs
to the fixture layer because it is what the fixture sits on; it is not a separate toggle. The
floating "vise: shipped defaults" and "bar height 20 mm PROVISIONAL" labels go: provenance is one
word in the legend (`vise: saved`) and the full sentence is the Hold card's.

**The chuck and the tool (#519 item 2).** Under the existing `viewport-layer-tool` toggle, one body:
the collet nut and chuck from the machine profile, and below it the fitted tool from its inventory
entry — the wired probe's 2 mm tip while registering, the cutter's cone or flute otherwise — at
**40 % opacity**, so the jaw and clamp clearances read through it. Its position has one source at a
time: the live `WPos` when the machine is answering, else the scrubbed simulation step. During a
run the two coincide (`followProgramLine` already moves the sim step to the reported line), so the
tool marker the sim draws today *is* this body; the chuck is added to it. A cutter swap confirmed in
step 4 changes the drawn tool.

**Touches (#519 item 1).** A new toggle `viewport-layer-touches`: a dot at each touch's X Y on the
stock, coloured by verdict (stock / miss / off-band), a short label with the Z reading, appearing as
each lands and staying as a layer after the registration (the edge points, the surface map, the
jaw-top points), so the spread the sheet reports can be seen. The registration band
(`engrave-legend-registration`) stays as the ± band it is.

A seventh toggle `viewport-layer-machine` is not needed: the machine's parts are the fixture
(bed + vise) and the tool (chuck + bit), and both toggles exist. The legend gains one row,
`engrave-legend-touches`, with the three verdict colours.

Defaults: `fixture` on, `tool` on, `touches` on, as `DEFAULT_SIM_LAYERS` already has for the
first two. The honest default is the complete machine; a toggle is for the operator who wants the
toolpath alone. Nothing is on by default that the app cannot draw from a fact it holds: with no
machine remembered there is no live position, and the tool sits at the scrub step as today.

## 7. Principles, and what they remove

**One place per fact.** The duplicates visible in today's two screenshots, and their one home:

| Fact | Today | One home |
|---|---|---|
| vise source and bar height | rail fields, viewport labels ("vise: shipped defaults", "bar height 20 mm PROVISIONAL"), finding `vise-default` | Hold card sentence; legend keeps one word |
| blank 1.6 mm below the jaw tops | `stock proud −1.6` field, findings `vise-stock-not-proud` and `vise-seat` both restate it | Hold card sentence; the finding says only what follows ("the cut stays 1 mm clear of the jaws, no packer needed") |
| registration ±0.05 mm | legend row, floating viewport label, band | legend row + band; the floating label goes |
| the run's progress | `engrave-run-progress`, `engrave-release-progress`, the lines log | the strip |
| what the machine said | registration transcript, run lines, release notes | the Transcript tab |
| vacuum on | `MachineStrip` switch, release vacuum sentence, run vacuum sentence | the switch is the decision (Plan); the strip is the state ("as sent") |
| "X runs between the jaws" | Stock section | the Hold card |

**Operator sentences, never codes (#505).** Findings drop the code token from the rendered row
(`vise-stock-not-proud` → the sentence alone; `data-code` keeps it). The strip prints Idle /
Running / Probing / Alarm, never `<Run|MPos…>`; the raw line is the Transcript's. No issue number,
no `plan.*`, no `engraveRunGate` anywhere a sentence is rendered.

**The honest default carries the weight.** No new sliders, no opacity control, no poll-rate
control (the 2 s floor is the machine's, §1). Groups open where editing is daily and close where
the default stands; a closed group still states its fact. The camera tab exists only where a
camera answers.

**Testids survive where the element survives.** Every testid in §1 keeps its element; elements
that move (touches, transcripts, progress) take their testid with them. The e2e suite keys on
testids, not on scroll position, so `engrave.spec.ts` and `engrave-setups.spec.ts` need their
scroll-into-view calls updated where a group is closed by default, nothing else. New testids:
`machine-status` and its children, `machine-dock` and its tabs, `viewport-layer-touches`,
`engrave-legend-touches`, and `engrave-group-job|hold|cutter` for the three group toggles.

## 8. Migration order

Each step lands alone and leaves the app usable; later steps depend on earlier ones as noted.

| Order | Part | Issue |
|---|---|---|
| 1 | Findings rows render the sentence only; the Cut-mode boxes collapse to one line when done (package current, gate clear). Pure copy/collapse, no moves. | **new:** "rail: findings state the sentence, and a done Cut step is one line" |
| 2 | Design mode regrouped into Job / Hold / Cutter with the sticky footer (§3); vise card sentence; margins under Cutter; Stock's jaw sentence to Hold. Updates the scroll-into-view calls in the engrave specs. | **new:** "rail: Design mode as Job / Hold / Cutter with a sticky Generate footer" |
| 3 | Cut mode as the four-step checklist (§4): registration below the gate, plan inside Run's `<details>`, Back to design at the foot. | **new:** "rail: Cut mode as a four-step checklist" |
| 4 | One status parser in `protocol.ts` (state, WPos, MPos, F, S, T, P) kept in `machineStore`; the status strip under the viewport with Stop. | **#519 item 3**, re-scoped: "the live state lives in a strip under the viewport, not in the rail" |
| 5 | The vise and bed drawn as they are under `fixture`; the floating labels removed; the seat moves the blank. | **#520**, as written; plus "the floating vise labels go" |
| 6 | The chuck + tool body under `tool`, positioned from the live WPos when answering, else the scrub step; the probe while registering; the swap changes it. Needs 4 (the parser) and 5 (something to judge clearance against). | **#519 item 2**, re-scoped to the `tool` layer |
| 7 | The dock band with the Transcript tab: the three transcripts move out of the rail. Needs 3 (the rail no longer renders them). | **new:** "dock: a band under the viewport for what the machine said" |
| 8 | Touches as a viewport layer and the dock's Touches tab, fed by the registration runner as each touch lands; `engrave-registration-touches` moves. Needs 4 and 7. | **#519 item 1**, re-scoped to the `touches` layer + dock tab |
| 9 | The Camera tab from `ws_video`; absent without an endpoint. Needs 7. | **#519 item 4** (the maintainer's comment), its own slice |

So #519 splits into four slices (4, 6, 8, 9) that each land on their own, #520 is step 5 unchanged,
and three new rail issues (1–3) and one dock issue (7) carry the rest. Steps 1–3 need no machine
and can be gated on the e2e suite; 4–9 need the bench for their acceptance, with the status strip
first because everything live after it reads the same parsed line.
