/**
 * #1014 — THE FINISH MASK MUST USE ONE DATUM. E's review of e5b215423 found the mix: `flatAbs`
 * answers MESH-ABSOLUTE (`dropCutter` + z0) while the curved pipeline's `base.zTop/zBottom` are
 * REBASED (stock top = 0). At stockTop 0 they coincide, so the wedge/bowl/card numbers held — but
 * on any other stock top (every FLIPPED setup: the #966 datum fixture's second setup states
 * `stockTop: 30`) the CL sat z0 above the levels, no level was ever `>= cl + band`, the helper
 * returned the rebased zTop, and the finish mask came out EMPTY: the setup silently lost its
 * finish op (E measured it: the parent posts `finish curved-0` at minZ −10.541, e5b215423 none).
 *
 * RED at e5b215423 (setup 1: no finish op); green with the datum shift `roughLeftAbove(f - z0,
 * …) + z0`.
 */
import { describe, expect, it } from 'vitest';

import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import { buildDatumGoal } from './helpers/datumTwoSetup966';

const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose', fluteLength: 30 });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3', fluteLength: 30 });
const entry = (key: string, tool: Tool): ToolLibraryEntry => ({ key, tool, provenance: 'test' });
const SHOP = { tools: [entry('inv:ball-2', BALL), entry('inv:flat-3', FLAT)] };

describe('#1014 — the finish mask’s datum', () => {
  it('a setup whose frame states a non-zero stock top keeps its finish op: the #966 datum fixture posts both, at minZ ≈ −10.541', async () => {
    const { goal, stock } = await buildDatumGoal();
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      stock: { ...base.stock, ...stock },
      targetObject: goal,
    };
    const input = await buildModelPlanInputForGoal(job, goal, BALL, SHOP);
    // The setup under test is the one whose own frame puts the stock top away from zero — the
    // flipped setup (`{up: [0, 0, -1], stockTop: 30}`), where the two datums used to part.
    const flipped = input.setups.findIndex((s) => Math.abs(s.frame.stockTop) > 1e-9);
    expect(flipped, 'the fixture no longer has a setup with a non-zero stock top').toBeGreaterThanOrEqual(0);
    const output = await planModelCam(input);
    const setup = output.perSetup[flipped]!;
    const finishes = setup.ops.filter((o) => o.kind === 'finish');
    expect(
      finishes.length,
      `the stockTop-${input.setups[flipped]!.frame.stockTop} setup lost its finish op: ${setup.notes.filter((n) => /finish/i.test(n)).join(' | ')}`,
    ).toBeGreaterThan(0);
    const feedZs = finishes.flatMap((o) => o.outcome.ir.operations.flatMap((x) => x.moves.filter((m) => m.kind === 'feed').map((m) => m.z)));
    expect(feedZs.length).toBeGreaterThan(0);
    const minZ = Math.min(...feedZs);
    // The parent's own number (E's measurement): the sphere's finish bottoms at −10.541 mm.
    expect(Math.abs(minZ + 10.541), `finish minZ ${minZ.toFixed(3)}`).toBeLessThan(0.01);
    // And the ordinary top setup still finishes at the same place.
    const top = output.perSetup[1 - flipped] ?? output.perSetup.find((s) => s.setupIndex !== setup.setupIndex)!;
    const topFinishes = top.ops.filter((o) => o.kind === 'finish');
    expect(topFinishes.length).toBeGreaterThan(0);
  }, 300_000);
});
