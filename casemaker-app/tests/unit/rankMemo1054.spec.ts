/**
 * #1054 — THE RANK MEMO, RED-FIRST. A rank candidate is a full `planCurvedForTree` today, so the
 * chosen plan re-plans every rough/rest/pencil op it just measured for the winner (and every
 * candidate re-plans the shared rough/rest the previous one built). The memo returns one op per
 * distinct (cutter, region, params): the chosen plan's op rows carry `reused: 1` instead of being
 * planned again, and the rank's own decision does not move.
 *
 * The part is #986's `sloped` fixture (three ball candidates, fine → coarse), so the chosen plan
 * after the rank is the ⌀2 winner's own pass.
 */


import { describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { setMemTraceSink } from '@/engine/cnc/memTrace';
import { slopedInput } from './helpers/goalFixtures';


/** #986's fixture, unchanged: the sloped seed with a flat and three ball diameters. */
type Row = Record<string, unknown> & { stage: string; t: number };

describe('#1054 the rank memo', () => {
  it('the chosen plan re-plans no rough the rank just built; the rank decision does not move', async () => {
    const rows: Row[] = [];
    setMemTraceSink((line) => rows.push(JSON.parse(line) as Row));
    let output: Awaited<ReturnType<typeof planModelCam>>;
    try {
      output = await planModelCam(slopedInput('fixture-1054'));
    } finally {
      setMemTraceSink(null);
    }
    const ops = rows.filter((r) => r.stage === 'op');
    const reused = ops.filter((r) => r.reused === 1);
    // THE RED: at the pre-memo tree every stage is planned by every caller, so no op row is a hit.
    expect(reused.length, 'no op row was a memo hit — the chosen plan re-planned the rank\'s work').toBeGreaterThan(0);
    // The rough is the shared stage by construction: same flat, same region, same params.
    expect(reused.some((r) => r.kind === 'rough'), 'no rough was reused — the memo key misses the shared stage').toBe(true);
    const rankEnd = rows.findIndex((r) => r.stage === 'rank:end');
    expect(rankEnd, 'no rank:end row — the rank did not run, or the row is missing').toBeGreaterThan(-1);
    expect(rows.slice(rankEnd + 1).some((r) => r.stage === 'op' && r.reused === 1), 'the chosen plan after rank:end planned everything fresh').toBe(true);
    // The memo must not change the decision: the same winner the #986 fixture pins without it.
    const rank = output.perSetup.flatMap((s) => s.notes).find((n) => n.startsWith('ball rank'));
    expect(rank, 'no rank statement').toBeDefined();
    expect(rank!).toContain('Chosen: ball-2');
  }, 240_000);
});
