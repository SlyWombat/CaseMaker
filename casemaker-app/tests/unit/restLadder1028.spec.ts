/**
 * #1028 — THE LEFTOVER'S BALL, MEASURED BY THE RANK'S OWN QUANTITY (6b's six fields, the rank scope).
 *
 * The notched plate, ⌀6 owned and no catalogue: the rank's known numbers say the ⌀6 finish leaves
 * 2.424 mm over 21.39 % of the goal while a ⌀2 ball leaves 0.896 mm over 6.50 % (goalRestPass's own
 * measurement). The ladder measures the standard rungs ⌀0.5/1/1.5/2/3/4 with the SAME call the rank
 * makes for an owned ball (`planCurvedForTree` + `goalCoverage`), coarse → fine, and stops at the
 * first rung whose own leftover is under the shop's visibility thresholds. The named ball is the
 * LARGEST rung that takes it (a finer ball costs cycle for nothing); when none takes it, the finest
 * rung is named as a reduction. The ladder is never a plan candidate, runs only on demand
 * (`restLadder`), only on the owned plan, and never when a catalogue ball was measured.
 *
 * RED at main: nothing measures the rungs — `ladderRows` is absent and the statement keeps the
 * #1027 plain absence.
 */
import { describe, expect, it } from 'vitest';
import { once } from './helpers/once';

import { planModelCam, type ModelPlanInput, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import { planTwoOutcomes } from '@/engine/cnc/cam/model/twoPlans';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { notchedPlate } from './helpers/meshes';
import { BALL6_NOTCHED_LONG as BALL6, BALL2_NOTCHED_LONG as BALL2 } from './helpers/goalFixtures';


/** The #1023 plate: 20 × 10 × 5 with a 6 mm-wide V notch, wound consistently. */
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 0.4,
    maxDiameter: 8,
    params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true },
    status: 'unmeasured' as const,
    provenance: 'test row',
  },
];

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-1023', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
    sha256: 'q'.repeat(64), data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 }, rotation: 0,
    size: { x: 20, y: 10, z: 5 },
    surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
}

function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

async function plateInput(shop: Parameters<typeof buildModelPlanInputForGoal>[3], tool: Tool = BALL6): Promise<{ input: ModelPlanInput; target: EngraveTargetObject; job: EngraveJob }> {
  // #1180 B1 — the same plate + shop is built by several cases; once per file by its own key.
  const key = `plate:${tool.id}:${(shop.tools ?? []).map((t) => t.key).sort().join('+')}:${shop.feeds?.length ?? 0}`;
  return once(key, async () => {
    const target = goalTarget();
    const job = goalJob(target);
    const input = await buildModelPlanInputForGoal(job, target, tool, shop);
    return { input, target, job };
  });
}

type LadderRowView = { diameterMm: number; leftoverShare: number; leftoverAboveMm: number; cycleSeconds: number };
function ladderRows(plan: ModelPlanOutput): LadderRowView[] | undefined {
  return (plan as unknown as { ladderRows?: LadderRowView[] }).ladderRows;
}

function statementOf(plan: ModelPlanOutput): { code: string; text: string } {
  const last = plan.perSetup.at(-1)!;
  const found = last.statements.find((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
  return { code: found?.code ?? '', text: found?.text ?? '' };
}

describe('#1028 the ladder measures the standard rungs beside the owned plan', () => {
  it('ladder ON, plate ⌀6 only: six rungs measured, the ⌀2 row at the rank\'s own numbers, monotone, and the sentence names a rung', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input, { restLadder: true });
    const rows = ladderRows(plan);
    expect(rows, 'the ladder measured no rung').toBeDefined();
    expect(rows!.length, 'the plate should measure every rung finer than ⌀6').toBe(6);
    // Coarse → fine (the fields' order), each finer rung's leftover never worse than the coarser.
    expect(rows!.map((r) => r.diameterMm)).toEqual([4, 3, 2, 1.5, 1, 0.5]);
    for (let i = 1; i < rows!.length; i++) {
      expect(rows![i]!.leftoverShare, `⌀${rows![i]!.diameterMm} is worse than the coarser rung`).toBeLessThanOrEqual(rows![i - 1]!.leftoverShare + 1e-9);
    }
    // T1-lite — THE FIRST RUN'S ROWS, PINNED (the rank's known ⌀2 numbers are the check on the
    // measurement: 6.50 %, 0.896 mm — goalRestPass's own).
    const pinnedRows = rows!.map((r) => `⌀${r.diameterMm} | ${(r.leftoverShare * 100).toFixed(2)} % | ${r.leftoverAboveMm.toFixed(3)} mm`);
    expect(pinnedRows).toEqual([
      '⌀4 | 13.46 % | 1.633 mm',
      '⌀3 | 9.55 % | 1.279 mm',
      '⌀2 | 6.50 % | 0.896 mm',
      '⌀1.5 | 4.48 % | 0.635 mm',
      '⌀1 | 2.50 % | 0.456 mm',
      '⌀0.5 | 0.52 % | 0.234 mm',
    ]);
    // T1-lite — THE STATEMENT, PINNED IN FULL. The plate has no rung under 0.10 mm / 2 %, so the
    // finest rung is named as the reduction it buys, with the cycle's source stated.
    const st = statementOf(plan);
    expect(st.code).toBe('goal-rest-uncut');
    expect(st.text).toBe(
      'The finish with the 6 mm ball nose (⌀6 mm) leaves up to 2.42 mm standing over 21.4 % of the goal (4343 cells, 43.4 mm²) where it cannot enter — past the 0.10 mm or 2 % that marks a leftover visible — and no owned ball takes it. A ⌀0.5 mm ball (a standard size, not in this shop’s catalogue) would reduce it to 0.23 mm over 0.5 % — +87 s of cycle (estimated from the shop’s seeded bands). The thresholds are this build’s labelled fallback.',
    );
  }, 180_000);

  it('ladder OFF (the default): the statement is the #1027 plain absence, byte-identical', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input);
    expect(ladderRows(plan), 'the ladder ran without being asked').toBeUndefined();
    const st = statementOf(plan);
    expect(st.text).toContain('none is configured for this shop (Manage → Tools)');
    expect(st.text).not.toContain('standard size');
  }, 180_000);

  it('the ⌀2 owned: goal-rest-pass and no ladder (a smaller owned ball ran)', async () => {
    const { input } = await plateInput({ tools: [{ key: 'user:ball-2-1028', tool: BALL2, provenance: 'test' }], feeds: SHOP_FEEDS });
    const plan = await planModelCam(input, { restLadder: true });
    expect(statementOf(plan).code).toBe('goal-rest-pass');
    expect(ladderRows(plan), 'the ladder ran although an owned ball took it').toBeUndefined();
  }, 180_000);

  it('a catalogue ball measured: the catalogue sentence, and the owned plan measured no ladder', async () => {
    const { input } = await plateInput({ tools: [], feeds: SHOP_FEEDS });
    const two = await planTwoOutcomes({ ...input, cutters: { house: input.cutters.house, catalogue: [BALL2] } }, { restLadder: true });
    expect(statementOf(two.owned).text).toContain('catalogue');
    expect(ladderRows(two.owned), 'the ladder ran although a catalogue ball was measured').toBeUndefined();
  }, 180_000);
});
