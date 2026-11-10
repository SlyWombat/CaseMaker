# The wizard's copy pass (#1109)

One pass over the four steps, under three rules:

1. **Glossary rule.** Every term a woodworker would not know either becomes plain words in the
   label, or gets a one-line *what this means* under the control — visible, not hover — through one
   `Explain` component whose strings live in `src/components/welcome/glossary.ts`.
2. **Validation proposes the value.** Every blocker names the field, the rule and a number to type.
3. **One component set.** `sw-btn` / `sw-field` / `sw-fold` / `sw-note` everywhere; one fold title
   per topic; the stock provenance survives a typo and goes on blur; the "shipped dimensions" line
   lives in Technical unless the blank's proud height is under 0.5 mm (the only case it decides).

The approved term list is on #1109 (issuecomment-6769589449) with the maintainer's "boss" tweak:
**a raised post or stud (to thread on the outside)**.

## 1. Glossary (`components/welcome/glossary.ts`)

| Term | Where it appears today | Today | The operator's word (new) | Why |
|---|---|---|---|---|
| V-carve | Step 2, "V-carve" / "V-carve, variable depth" | A region cut by the job's V-bit / The V follows the design's width down to its centre | *Carve with a V-bit — lines get wider as they go deeper* | Names the tool and the visible effect, not the operation's name |
| variable depth | Step 2, "V-carve, variable depth" | The V follows the design's width down to its centre | *Deeper where the drawing is wide, shallower where it is narrow* | Says what varies |
| inlay | Step 2, "Inlay" | A female pocket, and the male plug to glue into it | *A pocket and the matching plug* — the pocket is the female, the plug the male | Two words for one idea |
| prism | Step 2, "Prism" | A shape standing on sloped sides, cut by the V-bit | *Raised letters with sloped sides* | The visible result |
| flute | Step 2, "Flute" | A groove that ramps in and out along its ends | *A groove that ramps in and out* | Shorter, same fact |
| texture | Step 2, "Texture" | A seeded pattern of short strokes over a region | *A pattern of small marks, the same every run* | "Seeded" is programming |
| medial axis | Panel/text hints | "medial axis" | *The line down the middle of a shape* | Geometry term |
| relief | Goal/3D copy | "relief" | *A surface you cut down into, not through* | Distinguishes it from a cut-out |
| Gerber | Step 2, "Circuit board (Gerbers)" | A board's copper, holes and outline, from its Gerber and drill files | *The file a circuit-board design comes as* — then the existing sentence | The format is not the thing |
| boss | Step 2, "Thread a boss (external)" | A milled thread around the outside of a boss or rod | *A raised post or stud (to thread on the outside)* | The maintainer's tweak: it is the raised post, not a pocket island |
| helixed | "Bore to size" blurb | A hole wider than the cutter, helixed down its wall | *A hole wider than the cutter, cut in a spiral down its wall* | "Helixed" is jargon |
| simulate only | Build/feature sentences | "simulate only" | *check it on screen; this build cannot run it on the machine* | Says what it means for the operator |
| proud | Holding rows, board hints | "… mm proud of the jaw tops" | *standing … mm above the jaw tops* | The spec's word, with the plain gloss |
| jaw ledge | Holding seats | "on the jaw ledge" | *the step on the vise jaws a thin blank rests on* | The ledge is not visible to a new operator |
| stick-out | Rotary fields | "Stick-out" | *how far the rod sticks out of the chuck* | The same number, one gloss |
| neck for parting | Rotary fields | "Neck for parting" | *a thin groove that lets the finished part break off* | The purpose, not the machinist's word |
| self-centring scroll | Rotary copy | "self-centring scroll" | *the chuck jaws that close together as they turn* | The mechanism, in the visible effect |
| run-out | Rotary/round-stock hints | "run-out" | *how far the stock wobbles off true* | Measured, not jargon |
| anchor 1 | Holding/bracket rows | "anchor 1" | *the bracket's pin position, front-left* | The spec's word |
| reverse inner / reverse outer teeth | Rotary jaws select | "Reverse inner teeth" / "Reverse outer teeth" | *the chuck jaws turned round for larger stock* (inner/outer from the picture) | The picture carries the distinction |
| broadcasts | Machine step, probe copy | "broadcasts" / "the network search heard nothing" | *found on the network* | The mechanism is not the operator's concern |
| recorded address | Machine step, route line | "at its recorded address" | *at the address you wrote* | Possessive, plain |
| homed | Machine state line | "Online · Idle · homed" | *Online · idle · knows where it is* | The spec's word |
| the house's stock | Stock step, provenance | "the house's stock" | *the stock this workshop keeps* | "House" is internal |
| machine relay | Machine step, web build | the relay sentence | dropped — positive sentence (#1106): *This page can write, check and simulate; to run the machine, open the desktop app.* | Says what it can do |

## 2. Step 1 — Machine

| File / key | Today | New | Why |
|---|---|---|---|
| `MachineStep.tsx` state line (`machineWords.ts`) | `Offline` / `Not answering` / `Waiting for the cutter` / `Homing` | *Offline* / *Offline — no answer on the network* / *Waiting for a cutter* / *Homing (finding its rest)* | One word for "not answering"; homing gets a gloss |
| `MachineStep.tsx` state line | `Online · Idle · homed` | *Online · idle · knows where it is* | See glossary |
| `MachineStep.tsx` route line | "Reached at its recorded address — the network search heard nothing…" | *Found at the address you wrote — the network search heard nothing, which is normal for a server that cannot receive broadcasts.* | Plain words; keep the fact |
| `MachineStep.tsx` profile-only row (#1106) | (new) | *profile only — vendor defaults; connect it at Cut* | Approved with #1106 |
| Wizard footer / Cut and Holding "Change the machine…" | "Change the machine…" (step 1 points here) | Same words; the actions open this step's change button | One phrase, one place |

## 3. Step 2 — What are you cutting?

The chip labels stay; the `blurb` currently lives in a `title` only. It becomes one visible line under
the chip (or on the preset card), through `Explain` where a term needs a gloss.

| File / key | Today (title only) | New (visible) | Why |
|---|---|---|---|
| `operationTypes.ts` engrave | Text, or single-stroke lines | *Text, or a single line the cutter traces* | Plain |
| v-carve | A region cut by the job's V-bit | *Carve with a V-bit — lines get wider as they go deeper* | Glossary |
| v-carve-variable | The V follows the design's width down to its centre | *Deeper where the drawing is wide, shallower where it is narrow* | Glossary |
| inlay | A female pocket, and the male plug to glue into it | *A pocket and the matching plug* | Glossary |
| pocket | A flat-bottomed region | *A flat-bottomed recess* | The mockup's word |
| profile | A cut-out through the blank, held with tabs | *Cut out through the blank, held by small tabs* | Plain |
| chamfer | Break a profile's or pocket's edge at an angle | *A sloped edge on a cut-out or pocket* | Plain |
| hole / bore / thread | A hole, or a grid of them / … helixed … / A milled internal thread | *A hole, or a grid of them* / *A hole wider than the cutter, cut in a spiral down its wall* / *A thread cut inside a hole* | Glossary |
| thread-external | A milled thread around the outside of a boss or rod | *A thread cut on the outside of a raised post or stud* | The maintainer's tweak |
| surface | Rough and finish a goal mesh or picture | *Rough and finish a 3D mesh or picture* | "Goal" is the app's word |
| pcb | A board's copper, holes and outline, from its Gerber and drill files | *A circuit board's copper, holes and outline, from its design files* | Glossary |
| texture | A seeded pattern of short strokes over a region | *A pattern of small marks, the same every run* | Glossary |
| flute | A groove that ramps in and out along its ends | *A groove that ramps in and out* | Glossary |
| prism | A shape standing on sloped sides, cut by the V-bit | *Raised letters with sloped sides* | Glossary |

## 4. Step 3 — Stock

| File / key | Today | New | Why |
|---|---|---|---|
| `StartStockStep.tsx` material groups (#1105) | Woods → Boards & foams → Plastics → Metals → Circuit board | unchanged | Approved with #1105 |
| `StartStockStep.tsx` provenance | "The house's stock: a … stick" | *The stock this workshop keeps: a … stick* | Glossary |
| `StartStockStep.tsx` provenance lifetime | vanishes on the first keystroke | survives typing, disappears on blur only when a *different valid* number is committed | Rule 3 |
| `StartStockStep.tsx` finish hint (#1105) | per-family sentence | unchanged | Approved with #1105 |
| `StartStockStep.tsx` shelf sentence (#1105) | "the shelf also holds N blanks in other materials" | unchanged | Approved with #1105 |
| `stockStart.ts` `shelfPickProblem` | "none left — consumed by job-12" | *None left — used by job 12* | Sentence case, plain |

## 5. Step 4 — Holding

| File / key | Today | New | Why |
|---|---|---|---|
| `HoldingStep.tsx` hold words (#1101) | mount-aware "… between the jaws" / "left to right" | unchanged | Approved with #1101 |
| `HoldingStep.tsx` vice provenance | "Vise: the shipped dimensions, not measured on this machine." on every default-vise job | *The vise is the app's model, not measured on this machine.* — moved into Technical unless the blank's proud height is under 0.5 mm, where it says: *It matters here: the blank stands 0.1 mm proud, inside the 0.5 mm the model could be wrong by.* | Rule 3 |
| `HoldingStep.tsx` seats | "on the jaw ledge" / "gripped as a block" / "on a waste board" | Add the glossary gloss under the first: *the step on the vise jaws a thin blank rests on*; the block/board words stay | Glossary |
| `holdingMounts.ts` refusals (#1104) | capitalised, action-ending | unchanged | Approved with #1104 |
| `holdingMounts.ts` disc caption | "take light cuts, or tape it" | *… or tape it* only when the bed is offered and the stock is not round (#1104 remainder) | Copy must not name an option the state lacks |
| `holdingMounts.ts` board hint | "a thicker board, or tape it to the bed" | the same condition | as above |
| `HoldingStep.tsx` rotary fields | "Stick-out", "Neck for parting", "Chuck jaws", "Reverse inner/outer teeth" | Gloss each per §1 | Glossary |

## 6. Validation (`operationCreate.ts`, `stockStart.ts`)

| File / key | Today | New | Why |
|---|---|---|---|
| `operationCreate.ts:13` | "Type the text to engrave." | *Type the text to engrave — for example, a name.* | Already an action; add a value |
| `operationCreate.ts:44` | "Across flats must be above 0 mm." | *Across flats needs a size — the rod is ⌀20, so up to 17 mm; try 15.* | Proposes a value |
| `stockStart.ts:440` | "the <field> needs a number in mm, above 0" | *<Field> needs a size — type a number above 0 (for example 80).* | Sentence case; a value |
| `stockStart.ts:475` | "the <field> needs a number in mm, above 0" | the same, with the field's own example | as above |
| `StartStockStep.tsx:515` (copper) | "the copper thickness needs a number in mm, above 0" | *The copper thickness needs a size above 0 — 1 oz is 0.035 mm.* | Proposes a value |
| `stockStart.ts` rod problems | "the vise holds a rod up to 20 mm standing on its end — this rod is 100 mm; hold it in the rotary chuck" | *The vise holds a rod up to 20 mm standing on its end — this one is 100 mm; hold it in the rotary chuck.* | Sentence case; the action stays |

## 7. Component set

| Place | Today | New | Why |
|---|---|---|---|
| `MachineStep.tsx` buttons | raw `<button>` + inline styles | `sw-btn` / `sw-field` | One set |
| `HoldingStep.tsx` folds (#1101) | one "Which way round" fold | unchanged | Done |
| `StartStockStep.tsx` provenance | hides on keystroke | blur, only on a different valid number | Rule 3 |
| Wizard footers | mixed labels | `sw-btn` everywhere; the primary carries the action word | One set |
| All refusal sentences | mixed case | capitalised, ending with the action | #1104 rule 6 |

## 8. Specs and baselines

- `wizardCopy.spec.tsx`: no element whose only help is a `title`; `glossaryTerms.json` covers every
  term the steps render (a new term without an entry fails).
- `blockers.spec.ts`: every blocker contains a digit, or the words "type"/"pick".
- RTL: the provenance sentence survives typing "3" then "36" and disappears after blur with 40.
- Playwright baselines of all four steps on the house app (web) and the dev build (vise), approved by
  the maintainer.

## 9. Not in this pass

The run sheet's wording (#1070); panel copy; translations. The code lands last in land18, on top of
land17 `029bda8d2`.
