/**
 * The tray 70 STEP through planModelCam — the whole plan, measured and scored.
 *
 * #1180 — SPLIT FROM opsAcceptance959.spec.ts (773 s serial) so this case runs in its own worker
 * beside the rest of the acceptance set. The part, the catalogue and the plan helpers come from
 * `helpers/trayAcceptance.ts`; the test body is moved verbatim.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { idealWorsenings } from '../tools/tradeoff';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import {
  VENDOR_SET,
  catalogueCutters, expectSevenLinesPass, planCard,
  placedTree, sevenVerdicts, writeAcceptance, writeTwoPlans } from './helpers/trayAcceptance';

import { TRAY_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';
import { NO_SHOP } from '../tools/noShop';

const TRAY = TRAY_STEP;
const CATALOGUE = installAcceptanceCatalogue();
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(TRAY === undefined || (!CATALOGUE.installed && !CATALOGUE.optedOut))('#959 acceptance — tool tray 70, the whole plan through the one entry', () => {
  it('plans the real part through planModelCam — pockets, the curved remainder and the rims — and posts every run', async () => {
    const placed = await placedTree(TRAY!, [110, 140], -1.2);
    const goalField = sampleGoalHeightfield(placed.target, { maxCells: NO_SHOP.goalMaxCells, pitchMm: 0.1, stockTopZ: 0 });
    const { setup, runs } = await planCard(placed, { length: 110, width: 140 }, goalField);
    expect(setup.ops.length, `unreachable: ${setup.unreachable.join('; ')}`).toBeGreaterThan(0);
    expect(setup.ops.some((op) => op.kind === 'contour'), `unreachable: ${setup.unreachable.join('; ')}`).toBe(true);
    // THE MANAGER'S FINDING: the facts level planned through the pocket chain only, so the ball
    // finish never ran on the real part. The one entry plans it, and the acceptance asserts it.
    if (setup.features.remainder.length > 0) {
      expect(setup.ops.some((op) => op.kind === 'finish'), 'the ball finish never ran on the real part').toBe(true);
    }
    const measured = writeAcceptance('tray', setup.features, { ops: setup.ops, programs: runs, sequence: setup.sequence, unreachable: setup.unreachable, notes: setup.notes, choice: setup.choice }, { target: placed.target, stock: { length: 110, width: 140 } });
    // RED-FIRST (the manager's ruling): the chamfer ran a 130 mm feed along a rim whose air side
    // the goal sees as land — 0.5 mm into ground it never exposes (0.13 % adjudicated). With rims
    // covered from above skipped, that cell is not cut and the coverage that made the rebuild's
    // jump stays; the OTHER rims (real, open edges) are still broken.
    // #1092 (0f's R-b ruling, 2026-11-08) — THE OPEN RIMS' CHAMFER IS EDGE BREAK, ITS CLASS NAMED:
    // the band seeds the DESIGN SILHOUETTE (∪ the grid border), so the V's rim strokes within its
    // reach and leg are excused (`whoOk` still holds — the V is the deepest stamp there) and the
    // residual returns to 0. The cells are the 368 counted before the seed included the silhouette.
    expect(measured, 'the tray measured nothing').not.toBeNull();
    // #1186 — THE TRAY'S CYCLE IS PINNED (±5 %; RE-PIN ONLY WITH A STATED REASON). Rule 1 ranks
    // candidate chains by the time they will really take, so the tray is the acceptance tier's
    // canary for the picker: this is the whole plan's posted-text cycle through `planModelCam`.
    // RE-PINNED 2026-11-11 at 6216eaa89 (4856.7 s): the tray-top group — #1219's feed-row
    // step-over, #1227's 0.001 ring inset and #1223's nested lobe order — plans the same tray with
    // less pocket travel; measured 4856.7 s where 1186-bench/planner-time measured 5309.07 s
    // (20 pockets + 1 contour, 5 runs on 4 cutters, coverage 99.75 % against the vendor's 99.52 %,
    // cut-into 0.00 %, seven lines passing). Attribution on k3: green at 88e280183 (before the
    // group), red at 6216eaa89 and unchanged across #1225. A change that moves it is either a real
    // improvement — re-pin and say why here — or a regression to fix.
    const TRAY_CYCLE_PIN_SECONDS = 4857;
    const cycleDrift = Math.abs(measured!.ours.cycleSeconds - TRAY_CYCLE_PIN_SECONDS) / TRAY_CYCLE_PIN_SECONDS;
    expect(
      cycleDrift,
      `tray cycle ${measured!.ours.cycleSeconds.toFixed(1)} s against the ${TRAY_CYCLE_PIN_SECONDS} s pin (±5 %)`,
    ).toBeLessThanOrEqual(0.05);
    expect(measured!.adjudicatedFraction, 'the chamfer cut a rim that is covered from above').toBe(0);
    // #961 (the maintainer's 11-05 ruling): the 1-point line is 98.52 % against the vendor's
    // 99.52 %, and the picker must OFFER the rest that buys it — T1 → T2, priced. Before the
    // simulated-outcome rank the tray chose the ⌀6 primary alone and measured 98.38 %.
    // #1114 — THE OFFER IS THE FLOOR, NOT THE PICK: with the priced-cycle rank and the new
    // same-diameter picks the finish alone clears the bar (98.80 %), so the rest may lose on its
    // own price or leftover; what must hold is that it was offered and that the chosen chain is
    // one of the two measured candidates, with the reason it lost stated by the data.
    expect(measured!.coverage, 'the tray is back under the 1-point line').toBeGreaterThanOrEqual(0.9852);
    const restCandidate = setup.choice.considered.find((c) => c.steps.some((step) => step.kind === 'rest'))!;
    const aloneCandidate = setup.choice.considered.find((c) => !c.steps.some((step) => step.kind === 'rest'))!;
    expect(restCandidate, 'the rest cutter was not offered').toBeDefined();
    expect(aloneCandidate, 'the primary-alone chain was not offered').toBeDefined();
    expect(restCandidate.leftoverCells).not.toBeNull();
    expect(aloneCandidate.leftoverCells).not.toBeNull();
    const chosenHasRest = setup.choice.steps.some((step) => step.kind === 'rest');
    const chosenSignature = setup.choice.steps.map((step) => `${step.kind}:${step.cutter.key}`).join('+');
    const signatureOf = (c: typeof restCandidate): string => c.steps.map((step) => `${step.kind}:${step.cutterKey}`).join('+');
    expect([signatureOf(restCandidate), signatureOf(aloneCandidate)], 'the chosen chain is one of the measured two').toContain(chosenSignature);
    if (chosenHasRest) {
      // The surface the rest bought: fewer goal cells above the band than the primary alone.
      expect(restCandidate.leftoverCells!).toBeLessThan(aloneCandidate.leftoverCells!);
    } else {
      // The rest lost after the offer: either the finish alone already leaves as few cells, or
      // the rest's own recovery price is under the 0.01 mm²/s line (#961's gate).
      const losesOnCoverage = restCandidate.leftoverCells! >= aloneCandidate.leftoverCells!;
      const losesOnPrice = restCandidate.restPrice !== null && restCandidate.restPrice.mm2PerSecond < 0.01;
      expect(losesOnCoverage || losesOnPrice, 'the rest lost with no stated reason').toBe(true);
    }
    expect(setup.ops.filter((op) => op.kind === 'chamfer').length, 'no rim was broken at all').toBeGreaterThan(0);

    // #975 — THE IDEAL PLAN, the same entry over every bit the tool library carries beside the
    // owned set. Both plans are planned and simulated, the card prints both, and the tradeoff
    // line is composed from the two scored cards: present exactly when the threshold says so.
    const extra = catalogueCutters();
    const idealRun = extra.length === 0 ? null : await planCard(placed, { length: 110, width: 140 }, goalField, { house: [...VENDOR_SET, ...extra], catalogue: [] });
    const idealMeasured =
      idealRun === null
        ? null
        : writeAcceptance(
            'tray-ideal',
            idealRun.setup.features,
            { ops: idealRun.setup.ops, programs: idealRun.runs, sequence: idealRun.setup.sequence, unreachable: idealRun.setup.unreachable, notes: idealRun.setup.notes, choice: idealRun.setup.choice },
            { target: placed.target, stock: { length: 110, width: 140 } },
          );
    if (idealRun !== null) expect(idealRun.setup.ops.length, `the ideal plan produced nothing: ${idealRun.setup.unreachable.join('; ')}`).toBeGreaterThan(0);
    const tradeoff = writeTwoPlans('tray', { ours: measured!.ours, scored: measured!.scored }, idealMeasured === null ? null : { ours: idealMeasured.ours, scored: idealMeasured.scored });
    if (tradeoff !== null) expect(tradeoff.line !== null, JSON.stringify(tradeoff.differences)).toBe(tradeoff.material);
    // #991 (the clarified ruling) — the STEP row passes ALL SEVEN lines, not just geometry.
    console.log(`#995 tray STEP row seven lines: ${sevenVerdicts(measured!)} — ${measured!.scored.sentence}`);
    expectSevenLinesPass(measured!, 'tray STEP row');
    // #975 — THE SUPERSET RULE, RESTATED (the manager's ruling, 2026-11-05). The ideal's candidate
    // set contains the owned set, but the selector ranks by COST among plans whose outcomes do not
    // differ materially, so an extra bit can move an outcome either way. The rule the acceptance
    // holds is the MATERIAL one: the ideal is never worse than the owned plan by more than
    // PLAN_MATERIALITY allows (`idealWorsenings`). The strict form failed on differences INSIDE
    // those bounds (tray -0.06 points of coverage; organizer 1.2e-6 points of cut-into share),
    // which are trades the operator never sees. History: at 66b978a5 the strict rule caught a real
    // defect (ideal 98.38 % against owned 99.34 %) — the builder kept ONE rest tail and adding the
    // library's ⌀1 dropped the ⌀3.175 rest; that is what the strict fixture in
    // twoPlans961.spec.ts keeps alive.
    if (idealMeasured !== null) {
      const worse = idealWorsenings(measured!.ours, idealMeasured.ours).filter((w) => w.material);
      expect(worse, JSON.stringify(worse)).toEqual([]);
    }
  }, 1_800_000);
});
