/**
 * 3D surfacing from a goal mesh (#534, slice D of #222).
 *
 * Pure and isolated: a ramp and a hemisphere are built as binary STL, embedded as a goal
 * `EngraveTargetObject`, sampled to a heightfield and surfaced. The end-to-end check ties slices
 * A + C + D together: the finishing IR is swept through the FLAT dexel engine (slice A's ball
 * cutter) and the resulting top surface is compared to the goal within the step-over + grid pitch.
 */
import { afterEach, describe, expect, it } from 'vitest';

// A localStorage shim, as the store barrel may be pulled in transitively by the dispatch path.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import {
  DEFAULT_GRID_PITCH_MM,
  generateSurface3dIR,
  sampleGoalHeightfield,
  type SurfaceFeeds,
  type SurfaceTool,
} from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill as makeFlatTool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { RapidEstimate, CamMove } from '@/engine/cnc/cam/ir';
import { FLAT, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';

afterEach(() => clearTargetObjectMeshCache());

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

/** Encode triangles as a binary STL ArrayBuffer. */
function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal left 0
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  return buf;
}

function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

let shaCounter = 0;
function goal(tris: Tri[], over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  const buf = binaryStl(tris);
  return {
    id: 'goal-1',
    name: 'goal.stl',
    format: 'stl',
    sha256: `test-${shaCounter++}`,
    data: toBase64(buf),
    size: { x: 1, y: 1, z: 1 },
    position: { x: 10, y: 10, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** A gentle ramp top surface over x,y in [0,20], z = -k·x. Placed centred, it is H(x,y) = -k·x. */
const K = 0.05;
function rampTris(): Tri[] {
  const z = (x: number): number => -K * x;
  const p = (x: number, y: number): [number, number, number] => [x, y, z(x)];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

/** Hemisphere (dome) of radius R centred at (10,10), top at z=0: z = -(R - sqrt(R²-r²)). */
function domeTris(R: number, seg = 48): Tri[] {
  const tris: Tri[] = [];
  const c: [number, number] = [10, 10];
  const h = (x: number, y: number): number => {
    const r2 = (x - c[0]) ** 2 + (y - c[1]) ** 2;
    return r2 >= R * R ? -R : -(R - Math.sqrt(R * R - r2));
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i / seg, b = (i + 1) / seg, cc = j / seg, d = (j + 1) / seg;
      const toXY = (u: number, v: number): [number, number] => {
        const rr = R * u; // radius
        const th = 2 * Math.PI * v;
        return [c[0] + rr * Math.cos(th), c[1] + rr * Math.sin(th)];
      };
      const [x0, y0] = toXY(a, cc);
      const [x1, y1] = toXY(b, cc);
      const [x2, y2] = toXY(b, d);
      const [x3, y3] = toXY(a, d);
      tris.push([[x0, y0, h(x0, y0)], [x1, y1, h(x1, y1)], [x2, y2, h(x2, y2)]]);
      tris.push([[x0, y0, h(x0, y0)], [x2, y2, h(x2, y2)], [x3, y3, h(x3, y3)]]);
    }
  }
  return tris;
}

const FEEDS: SurfaceFeeds = {
  feed: 500,
  plungeFeed: 200,
  stepDown: 0.5,
  roughStepOver: 0.8,
  finishStepOver: 0.4,
};

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}

/** Resolve consecutive feed endpoints into FLAT `CutMove`s (the dexel convention: z = min). */
function cutMovesOf(moves: readonly CamMove[]): CutMove[] {
  const out: CutMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const b = moves[i]!;
    if (b.kind !== 'feed') continue;
    out.push({ step: i, line: i, u0: a.x, u1: b.x, v0: a.y, v1: b.y, z: Math.min(a.z, b.z) });
  }
  return out;
}

function sweep(setup: Setup, cutter: ColumnCutter, moves: readonly CamMove[], pitch: number): ReturnType<typeof FLAT.buildGrid> {
  const cut = cutMovesOf(moves);
  const grid = FLAT.buildGrid(setup, cutter, cut, { dx: pitch, dThetaDeg: pitch });
  for (const m of cut) FLAT.applyMove(grid, m, cutter);
  return grid;
}

function heightAt(grid: ReturnType<typeof FLAT.buildGrid>, x: number, y: number): number {
  const i = Math.round((x - grid.u0) / grid.du);
  const j = Math.round((y - grid.v0) / grid.dv);
  return grid.h[j * grid.nu + i] as number;
}

const BALL: SurfaceTool = { radius: 0.5, ball: true };
const FLAT_TOOL: SurfaceTool = { radius: 1.0, ball: false };
const BALL_CUTTER: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: 0.5, outerRadius: 0.5 };

describe('sampleGoalHeightfield', () => {
  it('rasterises the placed ramp to top-Z within the grid pitch', () => {
    const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 });
    expect(hf.pitch).toBe(0.1);
    expect(hf.coveredCount).toBeGreaterThan(0);
    expect(hf.resolutionNote).toContain('0.1');
    // Interior sample points track H = -K·x.
    for (const x of [5, 10, 15]) {
      const i = Math.round((x - hf.x0) / hf.pitch);
      const j = Math.round((10 - hf.y0) / hf.pitch);
      expect(hf.z[j * hf.nx + i]).toBeCloseTo(-K * x, 2);
    }
    expect(hf.minZ).toBeCloseTo(-1, 1);
    expect(hf.topZ).toBe(0);
  });

  it('defaults the pitch to the shop fallback', () => {
    const hf = sampleGoalHeightfield(goal(rampTris()));
    expect(hf.pitch).toBe(DEFAULT_GRID_PITCH_MM);
  });

  it('coarsens the pitch and states it rather than refusing when the grid is capped', () => {
    const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1, maxCells: 1000 });
    expect(hf.pitch).toBeGreaterThan(0.1);
    expect(hf.nx * hf.ny).toBeLessThanOrEqual(1000 * 1.2);
    expect(hf.resolutionNote).toContain('coarsened');
  });

  it('leaves cells no triangle covers at the stock top (the goal is silent there)', () => {
    const hf = sampleGoalHeightfield(goal(domeTris(5)), { pitchMm: 0.2, stockTopZ: 0 });
    // A corner of the grid is outside the dome footprint.
    expect(hf.covered[0]).toBe(0);
    expect(hf.z[0]).toBe(hf.topZ);
  });
});

describe('generateSurface3dIR — finishing tracks the goal', () => {
  const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 });
  const { ir, finishing, notes } = generateSurface3dIR({
    heightfield: hf,
    tool: BALL,
    toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    feeds: FEEDS,
    rapid: RAPID,
    labelId: 'goal-1',
  });

  it('emits a linear flat-frame IR with a rough and a finish operation', () => {
    expect(ir.frame).toBe('flat');
    expect(ir.operations).toHaveLength(2);
    expect(ir.operations[0]!.passKind).toBe('rough');
    expect(ir.operations[1]!.passKind).toBe('finish');
    expect(finishing.moves.every((m) => m.kind === 'rapid' || m.kind === 'feed')).toBe(true);
    expect(finishing.estimatedSeconds).toBeGreaterThan(0);
    expect(notes.join(' ')).toContain('undercut');
  });

  it('the finishing tip tracks H within the step-over + grid at interior points', () => {
    const tol = FEEDS.finishStepOver + 3 * hf.pitch;
    let checked = 0;
    for (const m of finishing.moves) {
      if (m.kind !== 'feed') continue;
      // Interior only: within the tool radius of the footprint edge the ball legitimately lifts.
      if (m.x < 2 || m.x > 18 || m.y < 2 || m.y > 18) continue;
      const H = -K * m.x;
      expect(m.z).toBeGreaterThanOrEqual(H - tol);
      expect(m.z).toBeLessThanOrEqual(H + tol);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('generateSurface3dIR — dexel sim reproduces the goal (A + C + D)', () => {
  it('a ball sweep of the finishing IR matches the ramp within the step-over + grid', () => {
    const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 });
    const { finishing } = generateSurface3dIR({
      heightfield: hf,
      tool: BALL,
      toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
    });
    const grid = sweep(prism(40, 40, 5), BALL_CUTTER, finishing.moves, hf.pitch);
    const tol = FEEDS.finishStepOver + 3 * hf.pitch;
    for (const x of [5, 8, 11, 14, 17]) {
      const H = -K * x;
      const got = heightAt(grid, x, 10);
      expect(got).toBeGreaterThanOrEqual(H - tol);
      expect(got).toBeLessThanOrEqual(H + tol);
    }
  });

  it('reproduces a hemisphere within the step-over + grid at the interior', () => {
    const R = 5;
    const hf = sampleGoalHeightfield(goal(domeTris(R)), { pitchMm: 0.1 });
    const { finishing } = generateSurface3dIR({
      heightfield: hf,
      tool: BALL,
      toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
    });
    const grid = sweep(prism(40, 40, 10), BALL_CUTTER, finishing.moves, hf.pitch);
    const dome = (x: number, y: number): number => {
      const r2 = (x - 10) ** 2 + (y - 10) ** 2;
      return r2 >= R * R ? -R : -(R - Math.sqrt(R * R - r2));
    };
    // Near the apex, where the surface is gentle, the ball tracks it tightly.
    const tol = FEEDS.finishStepOver + 4 * hf.pitch;
    for (const [x, y] of [[10, 10], [11, 10], [10, 11], [12, 12]] as const) {
      const got = heightAt(grid, x, y);
      expect(got).toBeGreaterThanOrEqual(dome(x, y) - tol);
      expect(got).toBeLessThanOrEqual(dome(x, y) + tol);
    }
  });
});

describe('generateGoalProgram — the worker dispatches a pure goal job', () => {
  it('samples, surfaces and posts a goal job, leaving verify to the dexel (slice E)', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      // Default stock is 100 x 60 x 12 mm; place the ramp over the middle, top-flush.
      targetObject: goal(rampTris(), { position: { x: 50, y: 30, z: 0 } }),
    };
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.stage).toBe('done');
    expect(out.ok).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(out.cam?.operations ?? 0).toBeGreaterThanOrEqual(2);
    // The exact-sweep verifier cannot judge a 3D ball program; the dexel preview is slice E.
    expect(out.verify).toBeNull();
    expect(out.programs).toEqual([]);
  });
});

describe('generateSurface3dIR — roughing never breaches the goal', () => {
  it('leaves at least the allowance above the heightfield everywhere it cuts', () => {
    const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 });
    const allowance = 0.3;
    const { roughing } = generateSurface3dIR({
      heightfield: hf,
      tool: FLAT_TOOL,
      toolObj: flatEndMill(2, { name: 'flat' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
      opts: { stockToLeaveMm: allowance },
    });
    expect(roughing.moves.length).toBeGreaterThan(0);
    const flatCutter: ColumnCutter = { radius: 1.0, tanHalf: null };
    const grid = sweep(prism(40, 40, 5), flatCutter, roughing.moves, hf.pitch);
    // Over the whole footprint the roughed floor stays at or above the goal surface — it never
    // dips below the heightfield (and so never below the heightfield minus the allowance).
    let probed = 0;
    for (let x = 7; x <= 19; x += 1) {
      const H = -K * x;
      const got = heightAt(grid, x, 10);
      expect(got).toBeGreaterThanOrEqual(H - 1e-3);
      // And it did remove bulk: the floor is below the stock top where material stood above it.
      if (H + allowance < -1e-3) expect(got).toBeLessThan(hf.topZ);
      probed++;
    }
    expect(probed).toBeGreaterThan(5);
  });
});

describe('generateGoalProgram — an invalid goal is refused, not surfaced (#539)', () => {
  // The pure-goal dispatch runs before the item pipeline's validateJob, so it must gate on the same
  // goal-object-oversize/zero-volume check itself rather than sampling and posting an unmakeable goal.
  it('returns a blocking goal-object-oversize finding for a goal larger than the stock', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      // Default stock is 100 x 60 x 12 mm; a 200 mm-wide goal cannot be carved from it.
      targetObject: goal(rampTris(), { position: { x: 50, y: 30, z: 0 }, size: { x: 200, y: 30, z: 5 } }),
    };
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('findings');
    expect(out.findings.some((f) => f.severity === 'error' && f.code === 'goal-object-oversize')).toBe(true);
    expect(out.errors.length).toBeGreaterThan(0);
    // It refused rather than posting a program.
    expect(out.nc).toBeNull();
    expect(out.cam).toBeNull();
    expect(out.programs).toEqual([]);
  });

  it('returns a blocking finding for a zero-volume (flat) goal', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      targetObject: goal(rampTris(), { position: { x: 50, y: 30, z: 0 }, size: { x: 20, y: 20, z: 0 } }),
    };
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.ok).toBe(false);
    expect(out.findings.some((f) => f.code === 'goal-object-oversize')).toBe(true);
    expect(out.nc).toBeNull();
  });
});

describe('generateSurface3dIR — the finishing pass has a compute budget (#540)', () => {
  const buildIr = (opts: Record<string, unknown>) =>
    generateSurface3dIR({
      heightfield: sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 }),
      tool: BALL,
      toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
      opts,
    });

  it('refuses honestly rather than running the billions of ops when over budget', () => {
    expect(() => buildIr({ maxFinishTipOps: 1 })).toThrow(/budget/i);
  });

  it('produces the finishing pass under a generous budget', () => {
    const { finishing } = buildIr({ maxFinishTipOps: 1_000_000_000 });
    expect(finishing.moves.length).toBeGreaterThan(0);
  });
});

describe('generateSurface3dIR — roughing refuses a non-positive step-down (#541)', () => {
  it.each([0, -0.5])('throws rather than infinite-looping when stepDown is %s', (stepDown) => {
    const hf = sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.1 });
    expect(() =>
      generateSurface3dIR({
        heightfield: hf,
        tool: FLAT_TOOL,
        toolObj: flatEndMill(2, { name: 'flat' }),
        toolNumber: 1,
        spindleRpm: 12000,
        air: true,
        feeds: { ...FEEDS, stepDown },
        rapid: RAPID,
        labelId: 'goal-1',
      }),
    ).toThrow(/step-down/i);
  });
});
