/**
 * #1046 — THE CLI FLAG AND THE RECEIPT'S LADDER. Parsing is pinned here (the engrave pipeline
 * needs wasm); the receipt's `details.goal.ladder` is pinned through the same zod schema the CLI's
 * `emitReceipt` validates against, so a field the CLI writes cannot be silently stripped.
 */
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../scripts/lib/casemaker/engrave';
import { parseReceipt, RECEIPT_VERSION } from '@/platform/headless/receipt';

describe('#1046 casemaker cut --rest-ladder', () => {
  it('parses the flag as an ask, and a plain run leaves it off', () => {
    expect(parseArgs(['job.json']).restLadder).toBeUndefined();
    expect(parseArgs(['job.json', '--rest-ladder']).restLadder).toBe(true);
    // It combines with the other engrave flags, and an unknown flag still refuses by name.
    const args = parseArgs(['job.json', '--rest-ladder', '--rest', 'none', '--out', 'dist']);
    expect(args.restLadder).toBe(true);
    expect(args.rest).toBe('none');
    expect(() => parseArgs(['job.json', '--rest-ladders'])).toThrow(/unknown flag/);
  });

  it('the receipt schema carries the ladder rows under details.goal', () => {
    const receipt = {
      version: RECEIPT_VERSION,
      command: 'engrave',
      ok: true,
      stage: 'done',
      gate: 'simulated',
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        kind: 'job',
        outDir: 'dist',
        programs: [],
        coupon: null,
        pair: null,
        goal: {
          ran: true,
          reason: null,
          cutIntoFraction: 0,
          maxCutIntoMm: 0,
          maxCutIntoAt: null,
          adjudicatedFraction: 0,
          adjudicatedMaxMm: 0,
          edgeBreakFraction: 0,
          wallNotScoredFraction: 0,
          shadowNotScoredFraction: 0,
          // #1092's gate-v8 fields, required by the schema main carries.
          wallOverReliefCells: 0,
          shadowOverReliefCells: 0,
          borderOverReliefCells: 0,
          overReliefDeepest: null,
          silhouetteExcusedCells: 0,
          silhouetteDeepest: null,
          silhouetteUnavailableCells: 0,
          silhouetteByWitnessCells: 0,
          leftoverFractions: [0, 0, 0],
          passCoverage: 0.95,
          wholeSurface: null,
          columnCutInto: null,
          sentence: 'test',
          ladder: [
            { diameterMm: 2, leftoverShare: 0.065, leftoverAboveMm: 0.896, cycleSeconds: 90, feedsSource: 'the shop’s seeded bands' },
          ],
        },
      },
    };
    const parsed = parseReceipt(receipt);
    // The CLI's goal block is `runGoal` plus `ladder`; the schema must keep the field rather than
    // strip it, or a `--rest-ladder` run's receipt loses its rows.
    expect((parsed as unknown as typeof receipt).details.goal.ladder?.[0]?.diameterMm).toBe(2);
  });
});
