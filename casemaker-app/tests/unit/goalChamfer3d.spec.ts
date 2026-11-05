/**
 * #829 — A GOAL THAT CHAMFERS ITS OWN EDGES. The chamfer is a property of the goal object, so the
 * pure goal stays pure and posts a SECOND program with the V-bit after its surfacing one; when no
 * V can cut it the goal is still surfaced, and the warning says why the edges are square.
 */
import { describe, expect, it } from 'vitest';

import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type P = [number, number, number];

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

/** A 10 × 10 × 5 box whose bottom sits on the stock's top face. */
function boxBall(): string {
  const v: P[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
    [0, 0, 5],
    [10, 0, 5],
    [10, 10, 5],
    [0, 10, 5],
  ];
  return stlBase64([
    [v[0]!, v[2]!, v[1]!],
    [v[0]!, v[3]!, v[2]!],
    [v[4]!, v[5]!, v[6]!],
    [v[4]!, v[6]!, v[7]!],
    [v[0]!, v[1]!, v[5]!],
    [v[0]!, v[5]!, v[4]!],
    [v[1]!, v[2]!, v[6]!],
    [v[1]!, v[6]!, v[5]!],
    [v[2]!, v[3]!, v[7]!],
    [v[2]!, v[7]!, v[6]!],
    [v[3]!, v[0]!, v[4]!],
    [v[3]!, v[4]!, v[7]!],
  ]);
}

const BALL: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1 };
const VBIT: Tool = {
  ...flatEndMill(3.175),
  name: '3.175mm*90º Chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
  cornerRadius: null,
};
const VKEY = 'user:v-bit-829';

const ENTRIES: ToolLibraryEntry[] = [{ key: VKEY, tool: VBIT, provenance: 'test' }];

function goalTarget(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-829',
    name: 'part',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: 'g'.repeat(64),
    data: boxBall(),
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    size: { x: 10, y: 10, z: 5 },
    ...over,
  } as EngraveTargetObject;
}

/** A PURE goal job: the target is the work, no items and no setups. */
function goalJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: '',
    tool: BALL,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

const SHOP = { tools: ENTRIES, feeds: null };

describe('#829 a goal chamfers its own edges', () => {
  it('posts a second program with the chosen V-bit, after the surfacing one', async () => {
    const target = goalTarget({ chamfer: { widthMm: 1, toolKey: VKEY } });
    const job = goalJob(target);
    const out = await generateGoalProgram(job, target, BALL, [], null, SHOP);
    expect(out.errors?.map((e) => e.message).join(' ') ?? '').not.toMatch(/refus/i);
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(2);
    expect(out.programs[0]!.toolKey).toBe('');
    expect(out.programs[1]!.toolKey).toBe(VKEY);
    // A 1 mm bevel at 45° is 1 mm deep, i.e. at z = 0 − 1 = −1 on the part's top face.
    expect(out.programs[1]!.nc).toMatch(/G1 Z-1(?:\.0+)? F/);
    // The V program is a real posted file, not a placeholder.
    expect(out.programs[1]!.nc).toContain('M02');

    // #982 pin — the fixture's OWN set (a ball and a V, NO flat) through the ONE model entry:
    // the pocket floors fall back to the ball, never a refusal. RED at the parent.
    {
      const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
      const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
      const modelInput = await buildModelPlanInputForGoal(job, target, BALL, SHOP);
      const modelOut = await planModelCam(modelInput);
      expect(modelOut.perSetup[0]!.programs.length, 'no program was planned').toBeGreaterThan(0);
      expect(modelOut.perSetup.flatMap((s) => s.notes).join('\n')).toContain('no flat end mill');
    }
  }, 120_000);

  it('surfaces the goal and says why the edges are square when no V is chosen', async () => {
    const target = goalTarget({ chamfer: { widthMm: 1 } });
    const job = goalJob(target);
    const out = await generateGoalProgram(job, target, BALL, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    const finding = out.findings.find((f) => f.code === 'goal-chamfer-no-cutter');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('are not chamfered');
  }, 120_000);

  it('warns when the chosen key is not in the library, and when the width is clamped', async () => {
    const missing = goalTarget({ chamfer: { widthMm: 1, toolKey: 'inv:gone' } });
    const outMissing = await generateGoalProgram(goalJob(missing), missing, BALL, [], null, SHOP);
    expect(outMissing.programs).toHaveLength(1);
    expect(outMissing.findings.find((f) => f.code === 'goal-chamfer-no-cutter')?.message).toContain('not in the tool library');

    // A 3 mm bevel at 45° is 3 mm deep — deeper than the 3.175 mm cone's own one-pass reach is
    // fine at 45°, so this asks the WIDTH clamp: the cone's flute (±45° over 1.5375 mm) reaches
    // 1.5375 mm. The cut is that wide, and the sentence says the shortfall.
    const wide = goalTarget({ chamfer: { widthMm: 3, toolKey: VKEY } });
    const outWide = await generateGoalProgram(goalJob(wide), wide, BALL, [], null, SHOP);
    const tooWide = outWide.findings.find((f) => f.code === 'chamfer-too-wide');
    expect(tooWide?.severity).toBe('warning');
    expect(outWide.programs).toHaveLength(2);
  }, 120_000);
});
