/**
 * #829 — A GOAL THAT CHAMFERS ITS OWN EDGES. The chamfer is a property of the goal object, so the
 * pure goal stays pure and posts a SECOND program with the V-bit after its surfacing one; when no
 * V can cut it the goal is still surfaced, and the warning says why the edges are square.
 *
 * #989 — THE MODEL ENGINE'S OWN PIN. `USE_MODEL_CAM_ENGINE` on: the seam carries the goal's
 * `chamfer` as `edgeBreak.legMm = widthMm / tan(halfAngle)` of the V named by `toolKey`, pinned
 * for the rim stage. On the box fixture it plans ONE program — the V, at z = −leg, one tip radius
 * off the edge on the air side — never "no refusal" with zero programs. A 60° V proves the leg is
 * derived (0.5/tan 30° = 0.866) and the PINNED V is the one that cuts, not the first chamfer in
 * the house; no `toolKey` leaves the rims sharp with the plan's own sentence; a `toolKey` the
 * house lacks is a named `goal-chamfer-no-cutter` finding.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { generateGoalProgram, buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam, setModelCamEnabled } from '@/engine/cnc/cam/model/plan';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type P = [number, number, number];

afterEach(() => {
  setModelCamEnabled(false);
  clearTargetObjectMeshCache();
});

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
// The model engine's pocket chain prices a primary FLAT even when the tree finds no pocket — a
// real shop carries one, and the model-path blocks below plan through that same house.
const FLAT: Tool = { ...flatEndMill(6), id: 'flat-6-989', name: 'flat-6' };
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
const V60: Tool = {
  ...flatEndMill(3.175),
  name: '3.175mm*60º Chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 60,
  halfAngle: null,
  cornerRadius: null,
};
const V60KEY = 'user:v-bit-60-989';

const ENTRIES: ToolLibraryEntry[] = [
  { key: 'inv:flat-6-989', tool: FLAT, provenance: 'test' },
  { key: VKEY, tool: VBIT, provenance: 'test' },
  { key: V60KEY, tool: V60, provenance: 'test' },
];

function goalTarget(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-829',
    name: 'part',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: 'g'.repeat(64),
    data: boxBall(),
    // `placeTarget` centres the mesh's XY bbox here and puts its TOP at this Z — the box's top
    // face is the stock's own top, its rim the sharp edge the chamfer breaks.
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

describe('#829 a goal chamfers its own edges — the old engine, still the shipped default', () => {
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

/** Every feed move in the plan's own IR — the posted program's geometry, not its text. */
function plannedFeeds(ir: EngraveProgramLike): { x: number; y: number; z: number }[] {
  const feeds: { x: number; y: number; z: number }[] = [];
  for (const op of ir.operations) {
    for (const m of op.moves) if (m.kind === 'feed') feeds.push({ x: m.x, y: m.y, z: m.z });
  }
  return feeds;
}
type EngraveProgramLike = {
  operations: { moves: { kind: string; x: number; y: number; z: number }[] }[];
};

/** The plan's own programs, by the `cutterKeyOf` key the seam labels them with. */
function plannedPrograms(out: Awaited<ReturnType<typeof generateGoalProgram>>): { key: string; ir: EngraveProgramLike }[] {
  const out2: { key: string; ir: EngraveProgramLike }[] = [];
  for (const setup of out.plan?.perSetup ?? []) {
    for (const ir of setup.programs) out2.push({ key: ir.tool.id ?? ir.tool.name, ir: ir as unknown as EngraveProgramLike });
  }
  return out2;
}

describe('#989 the model engine receives the goal’s own chamfer', () => {
  // MEASURED, not assumed: on this box fixture the model plan also posts the flat's freeing
  // contour (the block is cut out of the stock, z −5…−0.5), so the V program is the SECOND
  // program, not the only one — the issue's "1 program" counts only the chamfer stage. The pin
  // asserts the V program by its own tool key and drops the old path's "no refusal" bar.
  it('width 0.5 on the 90° V: the V program posts, every feed at z = −0.5 one tip radius off the edge', async () => {
    setModelCamEnabled(true);
    const target = goalTarget({ chamfer: { widthMm: 0.5, toolKey: VKEY } });
    const out = await generateGoalProgram(goalJob(target), target, BALL, [], null, SHOP);
    expect(out.errors?.map((e) => `${e.stage}: ${e.message}`).join('\n') ?? '').toBe('');
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    const vPrograms = plannedPrograms(out).filter((p) => p.key === VBIT.name);
    expect(vPrograms).toHaveLength(1);
    const feeds = plannedFeeds(vPrograms[0]!.ir);
    expect(feeds.length).toBeGreaterThan(4);
    for (const m of feeds) {
      // The tip plane is the bevel's bottom: −leg, and never deeper (a 90° V: leg = width).
      expect(m.z).toBeCloseTo(-0.5, 6);
      // One TIP RADIUS (0.05) outside the 10 × 10 box centred at (30, 20): the sides at
      // 5 + tipRadius, the (round-join) corners on a circle of that radius about the corner.
      const edge = Math.max(Math.abs(m.x - 30), Math.abs(m.y - 20));
      expect(edge).toBeLessThanOrEqual(5 + 0.05 + 1e-6);
      expect(edge).toBeGreaterThanOrEqual(5 + 0.05 * Math.SQRT1_2 - 1e-6);
    }
  }, 120_000);

  it('a 60° V: leg = width / tan 30° = 0.866, and the PINNED V cuts — not the first chamfer in the house', async () => {
    setModelCamEnabled(true);
    const target = goalTarget({ chamfer: { widthMm: 0.5, toolKey: V60KEY } });
    const out = await generateGoalProgram(goalJob(target), target, BALL, [], null, SHOP);
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    // The 90° V is in the house too; only the pinned one may post.
    const vPrograms = plannedPrograms(out).filter((p) => p.key === V60.name || p.key === VBIT.name);
    expect(vPrograms.map((p) => p.key)).toEqual([V60.name]);
    const feeds = plannedFeeds(vPrograms[0]!.ir);
    expect(feeds.length).toBeGreaterThan(4);
    for (const m of feeds) expect(m.z).toBeCloseTo(-0.5 / Math.tan((30 * Math.PI) / 180), 6);
  }, 120_000);

  it('no toolKey: no V program, and the plan’s own sentence says the rims stay sharp', async () => {
    setModelCamEnabled(true);
    const target = goalTarget({ chamfer: { widthMm: 0.5 } });
    const out = await generateGoalProgram(goalJob(target), target, BALL, [], null, SHOP);
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    expect(plannedPrograms(out).filter((p) => p.key === VBIT.name || p.key === V60.name)).toEqual([]);
    const notes = (out.plan?.perSetup ?? []).flatMap((s) => s.notes).join('\n');
    expect(notes).toContain('the job states no edge break');
    expect(out.findings.find((f) => f.code === 'goal-chamfer-no-cutter')?.message).toContain('no V-bit has been chosen');
  }, 120_000);

  it('a toolKey the house lacks: no V program, and the finding names it', async () => {
    setModelCamEnabled(true);
    const target = goalTarget({ chamfer: { widthMm: 0.5, toolKey: 'inv:gone' } });
    const out = await generateGoalProgram(goalJob(target), target, BALL, [], null, SHOP);
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    expect(plannedPrograms(out).filter((p) => p.key === VBIT.name || p.key === V60.name)).toEqual([]);
    const finding = out.findings.find((f) => f.code === 'goal-chamfer-no-cutter');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('not in the tool library');
  }, 120_000);

  it('a pinned V key the house lacks throws by name — never a silent fallback to another V', async () => {
    // The seam cannot produce this state (it pins only a resolved V); any other caller that pins
    // a key the house does not answer is a caller bug, and the rim stage must say so rather than
    // cut with a cutter the job never named.
    const target = goalTarget({ chamfer: { widthMm: 0.5, toolKey: VKEY } });
    const job = goalJob(target);
    const input = await buildModelPlanInputForGoal(job, target, BALL, SHOP);
    await expect(
      planModelCam({ ...input, cutters: { ...input.cutters, pinned: { chamfer: 'inv:gone' } } }),
    ).rejects.toThrow(/pinned\.chamfer names "inv:gone" but the house has no cutter with that key/);
  }, 120_000);
});
