/**
 * #1023 — THE FINISH'S LEFTOVER IS STATED, ONCE, WITH ITS NUMBERS AND THE BALL THAT WOULD TAKE IT.
 *
 * The model engine measures the leftover on every plan (`outcome.coverage` /
 * `outcome.leftoverAboveMm`) but spoke only when the ball rank had more than one candidate to
 * explain (`cam/model/plan.ts:902`). With one ball the operator got 78.61 % coverage and 2.42 mm
 * standing with no sentence, and the shop's `rest.visibleDepthMm` / `rest.thirdToolPct`
 * thresholds had no consumer on the model path at all.
 *
 * RED at b390a9251: no `goal-rest-uncut` / `goal-rest-pass` statement is emitted, and the quiet
 * run is byte-identical to the loud one.
 *
 * The sentence is built from the plan's own stamp: `share = 1 − outcome.coverage`, the depth is
 * `outcome.leftoverAboveMm`, the cells and area are the same stamp's (`PlanOutcome` now carries
 * them). Severity is warning past the shop's thresholds, info under them; `goal-rest-pass` is the
 * info form when a smaller owned ball ran. The "ball that would take it" comes from the ideal plan
 * when the catalogue measured one (`planTwoOutcomes`), else the plan says so.
 */
import { describe, expect, it } from 'vitest';

import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';

type P = [number, number, number];
type Tri2 = [[number, number], [number, number], [number, number]];

function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0], true);
      dv.setFloat32(off + 4, p[1], true);
      dv.setFloat32(off + 8, p[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

/** The same 20 × 10 × 5 plate with a 6 mm-wide V notch as #1008, wound consistently (see there). */
function notchedPlate(): string {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [20, 0];
  const C: [number, number] = [20, 5];
  const D: [number, number] = [13, 5];
  const E: [number, number] = [10, 0.5];
  const F: [number, number] = [7, 5];
  const G: [number, number] = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: Tri2[] = [[C, D, E], [B, C, E], [A, B, E], [G, A, E], [E, F, G]];
  const cap = (y: number): readonly (readonly [P, P, P])[] =>
    capTris.map(([a, b, c]) => (y === 0
      ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
      : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]])) as readonly (readonly [P, P, P])[];
  const sideTris: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

const BALL6: Tool = { ...flatEndMill(6), name: '6 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 6, cornerRadius: 3 };
// A STATED 10 mm FLUTE so the ⌀2 reaches the 4.5 mm notch. With no flute stated, `finishBallCandidates` keeps only one of the unknown-reach balls (house order decides), and the ideal plan would never measure the ⌀2.
const BALL2: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1, fluteLength: 10 };
const SHOP_FEEDS = [
  {
    material: 'pla' as const,
    minDiameter: 1,
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

async function planWith(shop: Parameters<typeof buildModelPlanInputForGoal>[3]) {
  const target = goalTarget();
  const job = goalJob(target);
  const input = await buildModelPlanInputForGoal(job, target, BALL6, shop);
  const plan = await planModelCam(input);
  const statement = plan.perSetup.at(-1)!.statements.find((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
  return { plan, statement };
}

describe('#1023 — the finish states what it leaves', () => {
  it('with one ball, states the leftover as a warning with both numbers and the thresholds', async () => {
    const { plan, statement } = await planWith({ tools: [], feeds: SHOP_FEEDS });
    expect(plan.outcome?.coverage).toBeCloseTo(0.786, 3);
    expect(statement?.code).toBe('goal-rest-uncut');
    expect(statement?.severity).toBe('warning');
    expect(statement?.text).toContain('2.42 mm');
    expect(statement?.text).toContain('21.4 %');
    expect(statement?.text).toContain('0.10 mm');
    expect(statement?.text).toContain('2 %');
    // planModelCam alone has no measured catalogue ball; the seam's ideal plan supplies one.
    expect(statement?.text).toContain('catalogue ball was measured');
    expect(statement?.count).toBeGreaterThan(0);
  }, 180_000);

  it('states the same numbers as information when the shop thresholds hide the leftover', async () => {
    const loud = await planWith({ tools: [], feeds: SHOP_FEEDS });
    const quiet = await planWith({
      tools: [],
      feeds: SHOP_FEEDS,
      rest: {
        overlap: { value: 0.5, source: 'chosen' as const },
        thirdToolPct: { value: 30, source: 'chosen' as const },
        visibleDepth: { value: 3, source: 'chosen' as const },
      },
    });
    expect(quiet.statement?.code).toBe('goal-rest-uncut');
    expect(quiet.statement?.severity).toBe('info');
    expect(quiet.statement?.text).toContain('2.42 mm');
    expect(quiet.statement?.text).toContain('21.4 %');
    expect(quiet.statement?.text).toContain('under the 3.00 mm and 30 %');
    // Statements only: the posted programs do not move.
    expect(JSON.stringify(quiet.plan.perSetup.at(-1)!.programs))
      .toBe(JSON.stringify(loud.plan.perSetup.at(-1)!.programs));
  }, 180_000);

  it('is the info form when a smaller owned ball ran', async () => {
    const { plan, statement } = await planWith({
      tools: [{ key: 'user:ball-2-1023', tool: BALL2, provenance: 'test' }],
      feeds: SHOP_FEEDS,
    });
    expect(plan.outcome?.coverage).toBeCloseTo(0.935, 3);
    expect(statement?.code).toBe('goal-rest-pass');
    expect(statement?.severity).toBe('info');
    expect(statement?.text).toContain('0.90 mm');
    expect(statement?.text).toContain('6.5 %');
    expect(statement?.text).toContain('2 mm ball nose');
  }, 180_000);
});
