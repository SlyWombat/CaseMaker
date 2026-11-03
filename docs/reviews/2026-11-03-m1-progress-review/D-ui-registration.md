# Review D — #930 / #931 / #934 + small UI-walk defects, lint/baseline moves, e2e (origin/main 829708cc)

Read-only review of 20 commits; every hunk read. Unit specs these commits touch were run in a
scratch extract of origin/main (`git archive` + read-only node_modules symlink): **11 files, 243
passed, 26 skipped, 0 failed, 52 s** (holdingStep, wizardOrder897, cutSurface, engraveRegistrationStep,
engraveSetupsSection, releaseStep, startWizard, startWizardStock, engraveTextPlacement,
bedDefects725, bedHoldStep). Playwright not run. Nothing checked out, edited or sent to k3.

## Severity-ranked findings

### HIGH

**H1 — The house stock is a hard-coded constant, not a shop fact read from the shelf the app already has.**
`2b358537` / `810314e1` / `b94c16fd`, `casemaker-app/src/components/welcome/workShape.ts:38-56`
(`HOUSE_STOCK = { form:'block', material:'hardwood', length:36, width:100, thickness:36 }`,
`houseStockProposal()` with `finish:'finished'` and a literal sentence "The house's stock: a 36 × 36 ×
100 mm hardwood stick…"). The location already has a stock shelf: `/stock` endpoint, `useStockStore`,
`StartStockStep.tsx:386-417` draws `shelfFor(items, material)` and `stockFromShelf()`; the fixture
`tests/unit/fixtures/location-doc.json:271` carries a `stock` array. `proposedStockFor()`
(`workShape.ts:62-70`) returns the constant for every non-mesh/non-PCB operation and never consults
the shelf. Failure scenario: the k3 house's shelf holds a different stick (or the maintainer answers
#936 "rough-sawn" / a different section) and the wizard still proposes 36 × 36 × 100 planed hardwood
with a sentence that calls it "the house's stock"; the memory rule for shop facts is "location.json,
never a constant" (#447–#451, the shop-default seed). The "defaults over knobs" rule covers *which*
default, not *where the fact lives*. Recommend: the proposal reads the first shelf entry that fits
the operation (fallback to the constant only when the shelf is absent/empty), and the finish comes
from that entry — the planed/rough answer is the maintainer's on #936 and belongs on the shelf row.

**H2 — Three of #934's "hidden" branches are refused LATE (at registration/release), not at the entry.**
`9c70b7fa`:
- Disc: `registrationAttempt.ts:101-106` refuses `job.stock.shape === 'disc'` — but the Stock step
  still offers Disc (UI walk A7 "Disc, Rod, Tube offered"; no hunk touches the form picker). The
  operator builds a disc job, generates to four ticks, reaches Cut step 2 and is told "use a
  rectangular blank".
- Facing re-touch: `EngraveReleaseStep.tsx:217-223` refuses at the RELEASE ("turn facing off in
  Design and generate again"). The stock step still offers finish "as bought", which seeds facing on
  (`facingForSeat`, `holdingMounts.ts:216-236`) for a rough stick (36 proud > 0.5 pass). The operator
  gets four ticks, registers, and is refused at the last press.
- PCB flip: on the design note's hide table ("the flip's second-side registration … cut one side");
  no hunk refuses it by name. Two-sided import is reachable (`OperationStep.tsx` carries `twoSided`).
  It is only *indirectly* caught when the second side registers from openings
  (`registrationAttempt.ts:87-92` reference-openings refusal), with the wrong sentence.
The issue's own rule was "UI entry removed + planner refusal" — for these three only the second
half landed. Corner mode has no UI entry and `registrationAttempt` never sets `corner`, so that one
is genuinely unreachable (fine).

### MEDIUM

**M1 — The failed-state e2e no longer drives the app's own failure; it injects one.**
`54fbc4f8`, `tests/e2e/cutVerdict931.spec.ts:154-199`: the "did not pass" walk `setState`s a
`tool-into-fixture` diagnostic into `engraveRunStore` (`oracle: null`) because #934 hid the bracket
walk that produced a real collision. The spec header still says "drives each state the way the app
reaches it". The real sweep→diagnostic→`firstRunError`→`runErrorWords` chain for a failure is now
only exercised in unit specs. Also `:231-234` — the never-simulated test asserts Design agrees only
`if (designRow !== null)`; a Design row that disappears passes silently. Not a product defect, but
the "Design and Cut agree in all three states" claim is weaker than the commit message states.

**M2 — Facing is decided on the RECOMMENDED seat at the stock step, not the seat the job ends up in.**
`2b358537`, `holdingMounts.ts:216-236` `facingForSeat()` uses `recommendedMount(stock)`; it is called
in `StartWizard.tsx:611-617` and `:720-727` BEFORE Holding. A saved vise (`applyRecommendedMount`
returns early on `source === 'saved'`, `holdingMounts.ts:247`) or an operator who picks another
radio in Holding keeps a facing seed judged on a different seat. With the house stick (planed →
facing off) this never bites; with "as bought" + a saved ledge seat it can re-create the jaw
collision #930 fixed. Low likelihood on the milestone path; worth a re-derive at Create.

**M3 — "Register again" presses a button by DOM query.**
`9c70b7fa`, `EngraveCutSurface.tsx:621-626` `registerAgain()` does
`document.querySelector('[data-testid="engrave-registration-start"]')?.click()`. That button is
rendered only in `phase idle/failed/recorded && target !== null` and is `disabled={!statementGiven}`
(`EngraveRegistrationStep.tsx:838-849`). If the at-machine statement is not given, or step 2's body
is folded (the e2e at `cutVerdict931.spec.ts:387` has to unfold it first), the press does nothing
and says nothing. A store action or a prop callback would make the offer honest.

**M4 — Ownership: lint commits crossed columns without saying so.**
`829708cc` edits `src/engine/cnc/post/z1.ts` (B's `post/**`) and `src/workers/sim/engravePreview.ts`
(A/B territory); `c97ffc7a` edits `tests/e2e/fixtures/fakeConsole.ts` (F's `tests/e2e/**`). The
11-03 progress review's rule is "declared, minimal … titled 'B's file'"; neither title declares.
Behaviour-neutral (dead-store initialisers, `replaceAll`, an unnecessary escape), so churn, not risk.
D's feature commits stayed in column except: `engraveJobStore.ts` (36f16984, unowned),
`findingFix.ts`/`registrationAttempt.ts`/`runErrorWords.ts` (c7d7c2ff — the design note flagged
these as "manager-sequenced"; the landing comment accepts them), `EngraveReleaseStep.tsx`,
`EngraveSetupRow.tsx`, `EngraveSetupsSection.tsx` (9c70b7fa, panels/ but not in D's list),
`surfaceSpread.ts` `g32Offered` (D owns "verdict sentence" only; the hunk is the recommendation),
`library/templates/specs/badge-blank.json` (3c5a8184, unowned).

**M5 — 673b3049 win32 baseline: harmless content, process breach in how it landed.**
A 27.7 KB → 24.6 KB `simulation-final-step-chromium-win32.png`. Per the local
`docs/reviews/2026-11-03-m1-progress-review.md:83-90` this one-file commit "carried the stack"
staged on local main, and "Windows moved to 1.1" makes it moot. Harmless to the Linux gate (win32
snapshots are only read on win32); churn that should not recur under "candidates land from the gate
copy".

### LOW

**L1 — Hidden-branch skips are broad.** 9c70b7fa/54fbc4f8 skip 26 unit cases + 5 e2e (incl. whole
`bedDefects725.spec.ts`, `centrePanel.spec.ts`). bedDefects725 unit `#730 — Holding's picture and
board sentence read the job's machine too` and holdingStep `#684 … Change the machine…` are skipped
although they test behaviour that still exists for the vise. Coverage of "Change the machine…" from
Holding is now nil; UI-walk defect 9 says it is not offered.

**L2 — `operatorRunError` regex is broad.** `runErrorWords.ts:19` strips any `(token.token)` /
`(token-token)` — a bare `(0.5)` would vanish; `(M3.5)`/`(right)` survive. Fine for the sweep's
messages seen so far.

**L3 — `cutVerdict` ordering.** `EngraveCutSurface.tsx:398-411`: `runRefused || errorCount>0` →
'failed' is tested BEFORE `hasProgram`, so a refused pipeline with no program shows the verdict box
(intended). `stale` wins over everything; the box is not drawn for 'stale'/'no-program'. A fourth
operator state 'not-checked' ("has not been checked against the design yet") exists beyond the three.

**L4 — The re-seat e2e seeds the registration store** (`cutVerdict931.spec.ts:320-383`) because the
console fake models one flat topZ; the commit says so. The bench is the only place the real
tilt→offer path is exercised.

**L5 — k3 smoke walk (44a0eb2a)** drives a live instance through the wizard and Generate ("Zoomba",
Create). The script itself POSTs nothing, but the app may write (job creation, machine record)
through the real API on k3 — memory rule "never seed k3". Worth a header sentence on what state it
leaves.

## Answers to the six questions

**1. #930.** Default stock = hard-coded `HOUSE_STOCK` in `workShape.ts:38-44` (H1), not the shelf.
Orientation: `810314e1` — length 36 (X, between the jaws), width 100 (Y, along the 100 mm jaws)
because the max opening is unmeasured (#208/#444); a one-off decision for this stick, not a general
rule — `proposeStock`'s other forms are untouched; only the text-direction rule generalises
(`engraveJobStore.ts:462-470`: a lineless job reads along the longer face axis). Facing: decided by
the stock FINISH field (`facingSeed` → off for `'finished'`), plus `facingForSeat`
(`holdingMounts.ts:216-236`) which drops facing when the pass would not clear the jaw tops on the
recommended seat; no "hardwood skips facing" rule. Disabled option: `HoldingStep.tsx:1620-1633`
computes `mountBlocked`; `StartWizard.tsx:1115-1119` disables Create with the reason
(`start-wizard-holding-unblock`); pinned in holdingStep.spec and `defaultJob930.spec.ts:165-217`.
Nothing-selected-with-Create-live is closed.

**2. #931.** `cutVerdict` (`EngraveCutSurface.tsx:376-411`): stale ("the program is older than the
design"), failed ("did not pass" + `operatorRunError(firstError)` + fix press), no-program (no box),
stopped ("the simulation stopped before it finished", no fix), passed ("matches the design", step 1
done, Register unfolds), not-checked, simulating, not-simulated. "matches the design" requires
staleSince null, generated.ok, no document/verifier errors, `designErrorCount === 0`
(`simErrors(simDiagnostics)`, 7882c37d), simStopped false, AND `oracle.ok === true` — oracle AND
design check. Developer tooltip gone; "Measure… on the machine card" gone (`registrationAttempt.ts:156`);
neither string remains in `tests/`. The e2e asserts agreement for passed, failed (Design text contains
Cut's sentence), stopped; not-simulated only conditionally (M1).

**3. #934.** 3D probe → planner refusal + `EngraveCentreFind` entry removed; tape/bracket → Holding
`bedOffered=false` hides the radios AND blocks bed arrival (`HoldingStep.tsx:1648-1660, 1722`),
setups editor `mountKinds` vise-only (`EngraveSetupsSection.tsx:585`), planner refusal by name;
disc → planner refusal only (H2); reference openings → planner refusal; typed seat → checkbox/field
deleted, branch gone, need-datum is the only non-datum answer; G32 → `g32Offered=false`
(`surfaceSpread.ts:732-739`); facing re-touch → release refusal (H2); PCB flip → not by name (H2);
rotary stays (ruled). Re-seat BEFORE re-post: yes — the chain effect returns on
`spreadAssessment?.verdict === 'tilt'` (`EngraveCutSurface.tsx:608`); unit
`cutSurface.spec.tsx:1139-1163` asserts `generate` NOT called before the press and called with the
surface after "Follow the tilt"; e2e `cutVerdict931.spec.ts:320`. Removed testids grepped on
origin/main: every live reference is inside `.skip`/`describe.skip` or a comment header; 54fbc4f8
skipped `bedDefects725.spec.ts` and `centrePanel.spec.ts` (specs the removal broke, not only ones the
diff touched). Holding offers vise seats + rotary only. Guide: "Partly available"/"Planned" pass
cncGuide.spec's vocabulary; `src/docs` and root `docs/cnc-guide.md` byte-identical at 4c7efd04 and
at origin/main.

**4. 3c5a8184** addresses defects **13, 14, 16, 17** (`SourceTag` already hid 'user'; the inline
replacement keeps that). Addressed elsewhere in the batch: 1, 2, 3, 4, 5, 10 (#930), 6, 7, 8, 11, 12
(#931). Remaining: **9** (Change the machine… / bed options — hidden by design, escape still absent),
**15** (Setups' disabled controls, "Plausibility width"), **18** (worker stall — dab6b19b fixes the
test flake, not the stall), **19** (hardwood vs PLA house rule — maintainer's), **20** ("Max depth
1.4 mm here" ignoring facing — moot on the planed default, still wrong with "as bought").

**5. Ownership/tiers.** See M4. Feature commits quote unit counts/typecheck/eslint; e2e runs are
quoted in the issue landing comments by the manager ("13 e2e specs … 29/29", "e2e union 42 passed |
5 skipped"), not in D's messages — consistent with F owning e2e. 673b3049: harmless, moot, process
churn (M5). 7afb15e3 is a pure move (removed/added bodies differ only in import lists).

**6. Unit specs:** 11 files / 243 passed / 26 skipped / 0 failed on origin/main (52 s). The 26 skips
are #934's hidden branches, each with the #934 header.
