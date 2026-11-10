/**
 * The organizer STEP through planModelCam — the whole plan, measured and scored.
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

import { ORGANIZER_STEP, installAcceptanceCatalogue, clearAcceptanceCatalogue } from './helpers/trayAcceptance';

const ORGANIZER = ORGANIZER_STEP;
const CATALOGUE = installAcceptanceCatalogue();
afterAll(() => clearAcceptanceCatalogue());

describe.skipIf(ORGANIZER === undefined || (!CATALOGUE.installed && !CATALOGUE.optedOut))('#959 acceptance — tool organizer, the whole plan through the one entry', () => {
  it('plans the real part through planModelCam — pockets, the curved remainder and the rims — and posts every run', async () => {
    const placed = await placedTree(ORGANIZER!, [170, 170], -0.8);
    const goalField = sampleGoalHeightfield(placed.target, { pitchMm: 0.1, stockTopZ: 0 });
    const { setup, runs } = await planCard(placed, { length: 170, width: 170 }, goalField);
    expect(setup.ops.length, `unreachable: ${setup.unreachable.join('; ')}`).toBeGreaterThan(0);
    expect(setup.ops.some((op) => op.kind === 'contour'), `unreachable: ${setup.unreachable.join('; ')}`).toBe(true);
    if (setup.features.remainder.length > 0) {
      expect(setup.ops.some((op) => op.kind === 'finish'), 'the ball finish never ran on the real part').toBe(true);
    }
    const measured = writeAcceptance('organizer', setup.features, { ops: setup.ops, programs: runs, sequence: setup.sequence, unreachable: setup.unreachable, notes: setup.notes, choice: setup.choice }, { target: placed.target, stock: { length: 170, width: 170 } });
    // #961 (the maintainer's 11-05 ruling): the organizer's coverage must stay the same or better
    // as the picker's rule changes — 98.61 % is its recorded figure on the engine-int base.
    expect(measured, 'the organizer measured nothing').not.toBeNull();
    expect(measured!.coverage, 'the organizer fell below its recorded coverage').toBeGreaterThanOrEqual(0.9861);

    // #975 — the ideal plan beside the owned one, both simulated; the tradeoff line follows the
    // threshold (see the tray's case for the same shape).
    const extra = catalogueCutters();
    const idealRun = extra.length === 0 ? null : await planCard(placed, { length: 170, width: 170 }, goalField, { house: [...VENDOR_SET, ...extra], catalogue: [] });
    const idealMeasured =
      idealRun === null
        ? null
        : writeAcceptance(
            'organizer-ideal',
            idealRun.setup.features,
            { ops: idealRun.setup.ops, programs: idealRun.runs, sequence: idealRun.setup.sequence, unreachable: idealRun.setup.unreachable, notes: idealRun.setup.notes, choice: idealRun.setup.choice },
            { target: placed.target, stock: { length: 170, width: 170 } },
          );
    if (idealRun !== null) expect(idealRun.setup.ops.length, `the ideal plan produced nothing: ${idealRun.setup.unreachable.join('; ')}`).toBeGreaterThan(0);
    const tradeoff = writeTwoPlans('organizer', { ours: measured!.ours, scored: measured!.scored }, idealMeasured === null ? null : { ours: idealMeasured.ours, scored: idealMeasured.scored });
    if (tradeoff !== null) expect(tradeoff.line !== null, JSON.stringify(tradeoff.differences)).toBe(tradeoff.material);
    // #991 (the clarified ruling) — the STEP row passes ALL SEVEN lines, not just geometry.
    console.log(`#995 organizer STEP row seven lines: ${sevenVerdicts(measured!)} — ${measured!.scored.sentence}`);
    expectSevenLinesPass(measured!, 'organizer STEP row');
    // #975 — the superset rule on the organizer too, in its material form (see the tray's case).
    if (idealMeasured !== null) {
      const worse = idealWorsenings(measured!.ours, idealMeasured.ours).filter((w) => w.material);
      expect(worse, JSON.stringify(worse)).toEqual([]);
    }
  }, 1_800_000);
});
