/**
 * #1037 — THE WIZARD'S REACH GATE JUDGES THE BALL BY THE GOAL'S FULL DEPTH. On the M1 tray
 * (110 × 140 × 27.2 hardwood, vise) the owned k3 set reaches every surface: the ball finishes the
 * curved remainder (1.2 → 4.2 mm, its deepest op at −4.199) and the ⌀3.175 × 42 flat frees the
 * 27.2 mm contour. The gate compares the CHOSEN cutter's known reach against the goal's whole
 * depth instead, so it refuses the job the engine plans.
 *
 * RED at 9d371549f: `goal-reach-short` (the ball's 22 mm flute against the goal's 26 mm).
 *
 * The engine's own per-feature rule is `cam/model/sequence.ts depthRefusal` — a cutter is judged
 * against each feature it is ASSIGNED (the ball: the curved features at 4.2 mm; the flat: the
 * contour at 27.2). The gate must agree with it, and 6b's constraint holds: reach resolves from
 * the stated `fluteLength` only (the owned cutters carry no ids, and no catalogue row is read).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { stepToMesh } from '@/engine/import/stepMesh';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_VISE, seatedVise } from '@/engine/cnc/fixture';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const TRAY = process.env.CM_959_TRAY_STEP;

/** The k3 owned set, as the issue's table states it — id null, reach stated by fluteLength only. */
const flat = (flute: number, name: string): Tool => ({ ...flatEndMill(3.175), name, fluteLength: flute });
const OWNED: Tool[] = [
  flat(42, '3.175 x 42 flat'),
  flat(25, '3.175 x 25 flat'),
  { ...flatEndMill(3.175), name: '3.175 x 22 ball nose', shape: 'ball', typeText: 'Ball Nose', fluteLength: 22 },
  { ...flatEndMill(3.175), name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', halfAngle: 45, angle: 90 },
  { ...flatEndMill(1), name: '1 x 7 corn', fluteLength: 7 },
];
const entry = (tool: Tool, i: number): ToolLibraryEntry => ({ key: `inv:owned-${i}`, tool, provenance: 'test' });

async function placedTray(file: string): Promise<EngraveTargetObject> {
  const stock: [number, number] = [110, 140];
  const modelTop = -1.2;
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const stl = buildBinaryStl([{ positions: read.mesh.positions, indices: read.mesh.indices }]);
  const sha256 = createHash('sha256').update(Buffer.from(stl)).digest('hex');
  return {
    id: sha256.slice(0, 16),
    name: path.basename(file),
    format: 'stl',
    sha256,
    data: Buffer.from(stl).toString('base64'),
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    position: { x: stock[0] / 2, y: stock[1] / 2, z: modelTop },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function trayJob(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'M1 tray',
    labels: [],
    shapes: [],
    drills: [],
    stock: { length: 110, width: 140, thickness: 27.2, material: 'hardwood' },
    workholding: { kind: 'vise', vise: seatedVise(DEFAULT_VISE, 27.2), sacrificial: null },
    toolKey: 'inv:owned-2',
    targetObject: target,
  } as EngraveJob;
}

describe.skipIf(TRAY === undefined)('#1037 the M1 tray reaches Generate with the owned set', () => {
  it('the ⌀3.175 x 22 ball is not refused by the goal’s whole depth, and its plan cuts ≤ 4.2 mm', async () => {
    const target = await placedTray(TRAY!);
    const job = trayJob(target);
    const ball = OWNED[2]!;
    const out = await generateGoalProgram(job, target, ball, null, {
      shop: { tools: OWNED.map(entry) },
    });
    expect(out.errors.map((e) => e.message).join('; ')).not.toContain('reach');
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
    // The engine's own assignment: the ball's ops stop at the curved remainder's floor.
    const plan = out.plan;
    expect(plan, 'the model plan ran').toBeDefined();
    const ops = plan!.perSetup.flatMap((s) => s.ops);
    let ballDeepest = 0;
    let flatDeepest = 0;
    for (const op of ops) {
      let deepest = 0;
      for (const ir of op.outcome.ir.operations) for (const m of ir.moves) deepest = Math.min(deepest, m.z);
      if (op.outcome.cutter.includes('ball')) ballDeepest = Math.min(ballDeepest, deepest);
      else flatDeepest = Math.min(flatDeepest, deepest);
    }
    expect(ballDeepest, 'the ball never runs below the curved remainder').toBeGreaterThanOrEqual(-4.21);
    expect(flatDeepest, 'the flat frees the 27.2 mm contour').toBeLessThanOrEqual(-27.0);
    // The inverse pin: the contour op is the ×42's, specifically — the one cutter that reaches.
    const contourOps = ops.filter((o) => o.kind === 'contour');
    expect(contourOps.length, 'one freeing contour is posted').toBe(1);
    expect(contourOps[0]!.outcome.cutter).toContain('42');
    expect(out.findings.some((f) => f.code === 'goal-not-freed')).toBe(false);
  }, 600_000);

  it('a house flat whose stated flute reaches but is not in the chain says so, never "longest is 42 mm" contradicting itself', async () => {
    const target = await placedTray(TRAY!);
    const job = trayJob(target);
    // The 42-flute flat is in the HOUSE but cannot enter the chain (it states no cutting diameter),
    // so no step of the chosen chain covers the profile — the warning's cause is the CHAIN, not a
    // short set, and the sentence must name the reaching flat rather than call the set short.
    const blind = { ...flat(42, '42 x blind flat'), diameter: null, tipDiameter: null } as Tool;
    const set = OWNED.filter((_, i) => i !== 0).concat(blind);
    const out = await generateGoalProgram(job, target, OWNED[2]!, null, { shop: { tools: set.map(entry) } });
    expect(out.ok).toBe(true);
    const contourOps = out.plan!.perSetup.flatMap((s) => s.ops).filter((o) => o.kind === 'contour');
    expect(contourOps.length, 'no chain link covers the profile').toBe(0);
    const warned = out.findings.find((f) => f.code === 'goal-not-freed');
    expect(warned?.severity).toBe('warning');
    expect(warned?.message).toContain('the chosen chain does not free the part');
    expect(warned?.message).toContain('42 mm flute that reaches it');
    expect(warned?.message).toContain('no step of the chosen chain covers the profile');
    // The self-contradicting form the Manager's review named is not what is said.
    expect(warned?.message).not.toContain('longest stated flute');
  }, 600_000);

  it('with the ×42 flat removed the run POSTS with no freeing contour and STATES it: goal-not-freed, 27.2 and 25', async () => {
    const target = await placedTray(TRAY!);
    const job = trayJob(target);
    const set = OWNED.filter((_, i) => i !== 0);
    const out = await generateGoalProgram(job, target, OWNED[2]!, null, { shop: { tools: set.map(entry) } });
    // 6b's ruling: an unfreed part is a STATEMENT, never a refusal — the plan posts.
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(out.plan!.perSetup.flatMap((s) => s.ops).some((o) => o.kind === 'contour')).toBe(false);
    // The silence was the bug: the warning names the profile floor, the longest stated flute and
    // the action, and it is never the old whole-goal ball verdict.
    const warned = out.findings.find((f) => f.code === 'goal-not-freed');
    expect(warned?.severity).toBe('warning');
    expect(warned?.message).toContain('floor is 27.2 mm');
    expect(warned?.message).toContain('25 mm');
    expect(warned?.message).toContain('free it by hand');
    expect(out.findings.some((f) => f.code === 'goal-reach-short')).toBe(false);
  }, 600_000);
});
