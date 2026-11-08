/**
 * #1073 — EACH SETUP'S POSTED CONTOUR LIVES IN ITS OWN FRAME.
 *
 * A two-setup bracket flip job is planned per side; setup 1's contour is planned in the document
 * frame (the job's own orientation) and setup 2's in the flipped goal's frame. A frame map applied
 * to the wrong side would mirror a contour about the stock's length (x → L − x) and cut the freeing
 * contour tens of millimetres off target at the bench — the failure this spec guards.
 *
 * The part is a 60 × 40 frustum placed ASYMMETRICALLY (x 35 on an 80 mm blank, so x 5..65): a
 * mirror about L would move it to 15..75, which the assertions below tell apart. The contour is the
 * part's silhouette offset by the cutter's radius (⌀3.175 → 1.5875).
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import { entry, FLAT3, stl } from './helpers/twoSetupBox966';

const FLAT_ENTRY: ToolLibraryEntry = entry('inv:flat-3', FLAT3);
const STOCK = { length: 80, width: 50, thickness: 20 };
const RADIUS = 3.175 / 2;

type V = [number, number, number];
type Tri = [V, V, V];

function frustumTris(): Tri[] {
  const ring = (x: number, y: number, z: number): V[] => [
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const B = ring(20, 12, -20);
  const M = ring(30, 20, -10);
  const T = ring(16, 10, 0);
  const quad = (out: Tri[], a: V, b: V, c: V, d: V): void => {
    out.push([a, b, c], [a, c, d]);
  };
  const tris: Tri[] = [];
  quad(tris, B[3]!, B[2]!, B[1]!, B[0]!);
  quad(tris, T[0]!, T[1]!, T[2]!, T[3]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(tris, B[i]!, B[j]!, M[j]!, M[i]!);
    quad(tris, M[i]!, M[j]!, T[j]!, T[i]!);
  }
  return tris;
}

function frustumGoal(): EngraveTargetObject {
  return {
    id: 'frustum-frame-1073',
    name: 'frustum.stl',
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: stl(frustumTris()),
    size: { x: 60, y: 40, z: 20 },
    // Asymmetric on X: the part is 5..65 on an 80 mm blank, so a mirror would be 15..75.
    position: { x: 35, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobForFrustum(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...STOCK },
    sacrificial: presetPartOnBoard(),
    targetObject: frustumGoal(),
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'default' } },
  };
}

/** The X/Y extent of a posted program's cutting moves. */
function postedBbox(nc: string): { min: [number, number]; max: [number, number] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const line of nc.split('\n')) {
    if (!line.startsWith('G1')) continue;
    const mx = /X(-?\d+(?:\.\d+)?)/.exec(line);
    const my = /Y(-?\d+(?:\.\d+)?)/.exec(line);
    if (mx) xs.push(Number(mx[1]));
    if (my) ys.push(Number(my[1]));
  }
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

describe('#1073 — a setup’s contour posts in its own frame', () => {
  it('setup 1 posts un-mirrored and setup 2 mirrors about the stock’s length', async () => {
    const job = jobForFrustum();
    const goal = job.targetObject!;
    const plan = planFlipSetups(job, goal, ['top', 'bottom'], [FLAT_ENTRY], {
      method: 'tabs-in-blank',
      axis: 'left-right',
    });
    if (!plan.ok) throw new Error(plan.reason);
    const sided: EngraveJob = { ...job, setups: plan.setups, targetObjects: plan.goals };
    const tl = await getToplevel();
    const result = await engraveGenerate(tl, sided, FLAT3, [], null, undefined, { tools: [FLAT_ENTRY] });
    expect(result.ok, result.errors.map((e) => e.message).join('; ')).toBe(true);

    const contourOf = (setupIndex: number): string => {
      const program = result.programs.find((p) => p.setupIndex === setupIndex && p.nc.includes('Contour'));
      if (program === undefined) throw new Error(`setup ${setupIndex} posted no contour program`);
      return program.nc;
    };
    // Setup 1: the part is X 5..65 — its contour is that outline offset by the cutter's radius.
    const one = postedBbox(contourOf(1));
    expect(one.min[0]).toBeCloseTo(5 - RADIUS, 0);
    expect(one.max[0]).toBeCloseTo(65 + RADIUS, 0);
    expect(one.min[1]).toBeCloseTo(5 - RADIUS, 0);
    expect(one.max[1]).toBeCloseTo(45 + RADIUS, 0);
    // Setup 2: the flip's mirror about the stock's length, X 15..75, Y unchanged — the MIRROR of
    // setup 1's numbers, never the same ones (the part is asymmetric on purpose).
    const two = postedBbox(contourOf(2));
    expect(two.min[0]).toBeCloseTo(15 - RADIUS, 0);
    expect(two.max[0]).toBeCloseTo(75 + RADIUS, 0);
    expect(two.min[1]).toBeCloseTo(5 - RADIUS, 0);
    expect(two.max[1]).toBeCloseTo(45 + RADIUS, 0);
    // The two frames really differ: a setup-1 program carrying setup 2's outline (or vice versa)
    // is the mirror defect this spec exists for.
    expect(Math.abs(one.min[0] - two.min[0])).toBeGreaterThan(5);
  }, 240_000);
});
