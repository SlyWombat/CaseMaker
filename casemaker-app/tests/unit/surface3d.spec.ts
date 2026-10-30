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
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { parseEngraveJob } from '@/store/engraveJobSchema';
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
    // The exact-sweep verifier cannot judge a 3D ball program; the dexel check stands in for it.
    expect(out.verify).toBeNull();
    // #535 — the goal program IS a release source: one program, its check the surface sweep, never
    // a verifier report and never nothing.
    expect(out.programs).toHaveLength(1);
    const program = out.programs[0]!;
    expect(program.verify).toBeNull();
    expect(program.surfaceCheck?.kind).toBe('surface');
    expect(program.surfaceCheck?.gridPitchMm).toBeCloseTo(DEFAULT_GRID_PITCH_MM);
    expect(program.surfaceCheck?.roughingLayers).toBeGreaterThan(0);
    // #764 — the toolpath extent is the footprint (centred at (50, 30), 20 × 20 mm) GROWN by the
    // default clear ring: one cutter diameter plus one finishing step-over (3.175 + 0.45 × 3.175
    // mm), less one grid cell where the first raster column sits inside the edge.
    const bbox = program.surfaceCheck!.bbox;
    // The toolpath now reaches past the footprint on every side by at least the cutter's own
    // diameter — the #764 clear band, whose default is one diameter plus a finishing step-over.
    // (The raster's first sample sits inside the grid's edge by up to a step-over.)
    expect(bbox.min[0]).toBeLessThan(40 - 3.175);
    expect(bbox.min[1]).toBeLessThan(20 - 3.175);
    expect(bbox.max[0]).toBeGreaterThan(60 + 3.175);
    expect(bbox.max[1]).toBeGreaterThan(40 + 3.175);
    expect(program.programHash).toMatch(/^[0-9a-f]{8}$/);
    expect(program.toolKey).toBe(job.toolKey);
    // #726 W16 — the run's findings carry the DOCUMENT's, as the item pipeline's always have: the
    // shipped default vise's clearance warning is what Save/Upload/Release and Cut step 1 share.
    expect(out.findings.some((f) => f.code === 'vise-default' && f.severity === 'warning')).toBe(true);
  });
});

describe('generateGoalProgram — the goal operation’s own numbers (#535)', () => {
  /** The ramp job with the goal placed over the middle; `surface` is the operation's block. */
  function goalJob(over: Partial<EngraveTargetObject> = {}): EngraveJob {
    return {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      targetObject: goal(rampTris(), { position: { x: 50, y: 30, z: 0 }, ...over }),
    };
  }

  it('reports the defaults it ran with: the feeds row’s step-down, the shop’s grid pitch and allowance', () => {
    const job = goalJob();
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {
      finish: { stockToLeaveMm: { value: 0.25, source: 'chosen' } },
      surfaceGrid: { pitchMm: { value: 0.2, source: 'chosen' } },
    });
    expect(out.ok).toBe(true);
    expect(out.feeds?.ok).toBe(true);
    if (!out.feeds?.ok) return;
    const facts = out.surface3d!;
    // The feeds row's own numbers stand in where the operation states none.
    expect(facts.stepDownMm).toBe(out.feeds.params.stepDown);
    expect(facts.roughStepOverMm).toBe(out.feeds.params.stepOver);
    expect(facts.finishStepOverMm).toBe(out.feeds.params.stepOver);
    // The two shop defaults are the ones handed in, and the resolution sentence says the pitch.
    expect(facts.stockToLeaveMm).toBe(0.25);
    expect(facts.gridPitchMm).toBe(0.2);
    expect(facts.resolutionNote).toContain('0.2');
    expect(facts.gridCells).toBeGreaterThan(0);
    expect(facts.roughingLayers).toBeGreaterThan(0);
    // The notes are the engine's own sentences, with no issue numbers in operator-facing text.
    expect(facts.notes.join(' ')).not.toContain('#');
    expect(facts.notes.some((n) => n.startsWith('Resolution:'))).toBe(true);
  });

  it('the operation’s block overrides each default, and the facts report the numbers it ran', () => {
    const job = goalJob({
      surface: {
        roughStepDownMm: 0.25,
        roughStepOverMm: 1.2,
        finishStepOverMm: 0.15,
        gridPitchMm: 0.5,
        stockToLeaveMm: 0,
      },
    });
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {
      // The shop's own numbers are handed in too: the operation's block must win over both.
      finish: { stockToLeaveMm: { value: 0.25, source: 'chosen' } },
      surfaceGrid: { pitchMm: { value: 0.2, source: 'chosen' } },
    });
    expect(out.ok).toBe(true);
    const facts = out.surface3d!;
    expect(facts.stepDownMm).toBe(0.25);
    expect(facts.roughStepOverMm).toBe(1.2);
    expect(facts.finishStepOverMm).toBe(0.15);
    // #755 — a finish finer than the grid the operation stated refines it: the run sampled at the
    // step-over, not the coarser 0.5, and the facts report the pitch it really used.
    expect(facts.gridPitchMm).toBe(0.15);
    expect(facts.resolutionNote).toContain('0.15');
    expect(facts.stockToLeaveMm).toBe(0);
    // The ramp's top is at the stock top and its deepest point 1.0 mm down (K·20); with a 0.25 mm
    // step-down and no allowance the layers are −0.25, −0.5, −0.75 and the floor −1.0.
    expect(facts.roughingLayers).toBe(4);
  });

  it('a round cutter roughs and finishes, and the IR names both operations', () => {
    const job = goalJob({ surface: { roughStepDownMm: 0.5, gridPitchMm: 0.4 } });
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175, { shape: 'ball' }), [], null, {});
    expect(out.ok).toBe(true);
    expect(out.cam?.operations).toBe(2);
    expect(out.cam?.roughOperations).toBe(1);
    expect(out.cam?.finishOperations).toBe(1);
    // #535 — the round cutter's program is promoted too, and its check records the grid the
    // operation stated (0.4 mm), not the shop fallback.
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.verify).toBeNull();
    expect(out.programs[0]!.surfaceCheck?.gridPitchMm).toBe(0.4);
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
  it('#784 cuts a goal larger than the stock CLIPPED to the blank and says what lies outside', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      // Default stock is 100 x 60 x 12 mm; a 200 mm-wide goal overhangs both X edges by 50 mm.
      targetObject: goal(rampTris(), { position: { x: 50, y: 30, z: 0 }, size: { x: 200, y: 30, z: 5 } }),
    };
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    const warn = out.findings.find((f) => f.code === 'goal-object-oversize');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('past the left edge');
    expect(warn?.message).toContain('past the right edge');
    expect(out.nc).not.toBeNull();
    // The program cuts the stock's own X span, not 50 mm of air either side of it.
    const xs = [...(out.nc ?? '').matchAll(/X(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.001);
    expect(Math.max(...xs)).toBeLessThanOrEqual(100.001);
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

// === #671 — the scallop and pencil finishing passes =============================================

/** A closed box as 12 triangles; the heightfield's top over it is `z1`. */
function boxTris(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ] as [number, number, number][];
  const quad = (a: number, b: number, q: number, d: number): Tri[] => [
    [c[a]!, c[b]!, c[q]!],
    [c[a]!, c[q]!, c[d]!],
  ];
  return [
    ...quad(4, 5, 6, 7),
    ...quad(0, 3, 2, 1),
    ...quad(0, 1, 5, 4),
    ...quad(2, 3, 7, 6),
    ...quad(1, 2, 6, 5),
    ...quad(3, 0, 4, 7),
  ];
}

/** A step: a base slab under the whole footprint and a 0-top plateau over x < 10 (floor at −2). */
function stepTris(): Tri[] {
  return [...boxTris(0, 20, 0, 20, -4, -2), ...boxTris(0, 10, 0, 20, -2, 0)];
}

/** The step's goal height at (x, y): the plateau at 0 for x < 10, the floor at −2 beyond. */
const stepH = (x: number): number => (x < 10 ? 0 : -2);

/** A ramp of slope `k` (0.05 is the spec's gentle one; 1 is 45°). */
function rampTrisK(k: number): Tri[] {
  const p = (x: number, y: number): [number, number, number] => [x, y, -k * x];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

describe('generateSurface3dIR — the scallop and pencil passes (#671)', () => {
  function build(
    heightfield: ReturnType<typeof sampleGoalHeightfield>,
    opts: Parameters<typeof generateSurface3dIR>[0]['opts'],
  ) {
    return generateSurface3dIR({
      heightfield,
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
  }

  it('appends scallop then pencil AFTER the parallel finish, and off is the old two-pass program', () => {
    const hf = sampleGoalHeightfield(goal(stepTris()), { pitchMm: 0.4 });
    const off = build(hf, {});
    expect(off.ir.operations.map((o) => o.name)).toEqual(['[T1] 3D rough — 0.3 mm to leave', '[T1] 3D finish']);
    expect(off.scallop).toBeNull();
    expect(off.pencil).toBeNull();

    const on = build(hf, { scallop: true, pencil: true });
    expect(on.ir.operations.map((o) => o.name)).toEqual([
      '[T1] 3D rough — 0.3 mm to leave',
      '[T1] 3D finish',
      '[T1] 3D scallop',
      '[T1] 3D pencil',
    ]);
    expect(on.ir.operations.map((o) => o.passKind)).toEqual(['rough', 'finish', 'finish', 'finish']);
    // WHAT STANDS BETWEEN THEM: the roughing and the parallel finish are byte-identical when the
    // extras are switched on — same allowance, same raster, same tip field. The extras are added
    // after them, not woven through.
    expect(on.roughing.moves).toEqual(off.roughing.moves);
    expect(on.finishing.moves).toEqual(off.finishing.moves);
    expect(on.scallop!.facts.contours).toBeGreaterThan(1);
    expect(on.scallop!.facts.stepOverMm).toBe(FEEDS.finishStepOver);
    expect(on.pencil!.facts.paths).toBeGreaterThan(0);
    expect(on.notes.join(' ')).toContain('scallop pass');
    expect(on.notes.join(' ')).toContain('pencil pass');
  });

  it('spaces the scallop contours by the slope’s secant: a steep face needs more of them', () => {
    const gentle = build(sampleGoalHeightfield(goal(rampTrisK(0.05)), { pitchMm: 0.4 }), { scallop: true });
    const steep = build(sampleGoalHeightfield(goal(rampTrisK(1)), { pitchMm: 0.4 }), { scallop: true });
    // Same footprint, same step-over: the 45° face's surface step-over needs sqrt(2) more contours.
    expect(gentle.scallop!.facts.contours).toBeGreaterThan(1);
    expect(steep.scallop!.facts.contours).toBeGreaterThan(gentle.scallop!.facts.contours);
    expect(steep.scallop!.facts.clamped).toBe(false);
  });

  it('projects every scallop point onto the surface: a convex dome is followed, never cut through', () => {
    const R = 5;
    const hf = sampleGoalHeightfield(goal(domeTris(R)), { pitchMm: 0.2 });
    const on = build(hf, { scallop: true });
    const dome = (x: number, y: number): number => {
      const r2 = (x - 10) ** 2 + (y - 10) ** 2;
      return r2 >= R * R ? -R : -(R - Math.sqrt(R * R - r2));
    };
    const tol = FEEDS.finishStepOver + 3 * hf.pitch;
    let checked = 0;
    for (const m of on.scallop!.operation.moves) {
      if (m.kind !== 'feed') continue;
      // Interior only: within the tool radius of the footprint edge the ball legitimately lifts.
      if (Math.hypot(m.x - 10, m.y - 10) > R - 1) continue;
      expect(m.z).toBeGreaterThanOrEqual(dome(m.x, m.y) - tol);
      expect(m.z).toBeLessThanOrEqual(dome(m.x, m.y) + tol);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('the pencil follows the step’s crease and leaves a dome and a ramp alone', () => {
    const step = build(sampleGoalHeightfield(goal(stepTris()), { pitchMm: 0.4 }), { pencil: true });
    expect(step.pencil!.facts.paths).toBeGreaterThan(0);
    const feeds = step.pencil!.operation.moves.filter((m) => m.kind === 'feed');
    const xs = feeds.map((m) => m.x);
    const ys = feeds.map((m) => m.y);
    // A line along the wall's foot: one cell wide in X, spanning the wall in Y.
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
    expect(Math.min(...xs)).toBeGreaterThan(9.2);
    expect(Math.max(...xs)).toBeLessThan(11.2);
    // GOUGE SAFETY: every point rides the safe drop — strictly ABOVE the floor it cannot reach,
    // because the ball's flank rests on the wall, and never below the goal anywhere.
    for (const m of feeds) {
      expect(m.z).toBeGreaterThan(stepH(m.x) + 0.1);
    }

    const dome = build(sampleGoalHeightfield(goal(domeTris(5)), { pitchMm: 0.4 }), { pencil: true });
    expect(dome.pencil).toBeNull();
    const ramp = build(sampleGoalHeightfield(goal(rampTris()), { pitchMm: 0.4 }), { pencil: true });
    expect(ramp.pencil).toBeNull();
  });

  it('the new passes cut on the dexel grid, and the full program never gouges the goal', () => {
    // The heightfield's top-Z model is conservative at a vertical face (the boundary cell reads the
    // plateau's top), so the foot cell that gets the pencil path is one cell out from the wall.
    const hf = sampleGoalHeightfield(goal(stepTris()), { pitchMm: 0.4 });
    const full = build(hf, { scallop: true, pencil: true });
    const setup = prism(40, 40, 10);
    expect(full.ir.operations).toHaveLength(4);

    // THE CHECK: the full program, swept on the grid, removes material and leaves none below the goal.
    const grid = sweep(setup, BALL_CUTTER, full.ir.operations.flatMap((op) => op.moves), hf.pitch);
    for (const x of [11, 12, 14, 16, 18]) {
      for (const y of [4, 10, 16]) {
        expect(heightAt(grid, x, y)).toBeGreaterThanOrEqual(stepH(x) - 0.15);
      }
    }
    // Each new pass is REAL: swept alone from the stock top it cuts where it says and nowhere else.
    const pencilOnly = sweep(setup, BALL_CUTTER, full.pencil!.operation.moves, hf.pitch);
    const footprint = full.pencil!.operation.moves.filter((m) => m.kind === 'feed');
    const pathX = footprint[0]!.x;
    expect(heightAt(pencilOnly, pathX, 10)).toBeLessThan(-0.05); // the corner line, cut
    expect(heightAt(pencilOnly, 15, 10)).toBe(0); // the open floor, untouched
    const scallopOnly = sweep(setup, BALL_CUTTER, full.scallop!.operation.moves, hf.pitch);
    expect(heightAt(scallopOnly, 15, 10)).toBeLessThan(-0.5); // the floor, cut by the contours
  });
});

describe('generateGoalProgram — the extra finishing passes reach the program and its check (#671)', () => {
  function stepJob(surface?: EngraveTargetObject['surface']): EngraveJob {
    return {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      targetObject: goal(stepTris(), { position: { x: 50, y: 30, z: 0 }, ...(surface === undefined ? {} : { surface }) }),
    };
  }

  it('carries the pass list on the surface check and the facts on the operation', () => {
    const job = stepJob({ scallop: true, pencil: true });
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.programs[0]!.surfaceCheck?.passes).toEqual([
      '[T1] 3D rough — 0.3 mm to leave',
      '[T1] 3D finish',
      '[T1] 3D scallop',
      '[T1] 3D pencil',
    ]);
    expect(out.surface3d?.scallop?.contours ?? 0).toBeGreaterThan(0);
    expect(out.surface3d?.pencil?.paths ?? 0).toBeGreaterThan(0);
    const texts = buildRunSheet(job, out, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const surface = texts.find((t) => t.includes('Surface a mesh'));
    expect(surface).toBeDefined();
    expect(surface).toContain('scallop pass');
    expect(surface).toContain('pencil pass');
  });

  it('absent means off: the old two-pass program, and its check says two passes', () => {
    const job = stepJob();
    const out = generateGoalProgram(job, job.targetObject!, makeFlatTool(3.175), [], null, {});
    expect(out.ok).toBe(true);
    expect(out.programs[0]!.surfaceCheck?.passes).toHaveLength(2);
    expect(out.surface3d?.scallop ?? null).toBeNull();
    expect(out.surface3d?.pencil ?? null).toBeNull();
    const texts = buildRunSheet(job, out, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const surface = texts.find((t) => t.includes('Surface a mesh'));
    expect(surface).not.toContain('scallop pass');
  });

  it('round-trips the three settings; a crease outside 1–80° is refused', () => {
    // The schema wants a real 64-hex sha; the spec's goal stub uses a short test id.
    const withSha = (surface: EngraveTargetObject['surface']): EngraveJob => {
      const job = stepJob(surface);
      return { ...job, targetObject: { ...job.targetObject!, sha256: 'a'.repeat(64) } };
    };
    const parsed = parseEngraveJob(withSha({ scallop: true, pencil: true, pencilCreaseDeg: 25 }));
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.targetObject?.surface).toEqual({ scallop: true, pencil: true, pencilCreaseDeg: 25 });
    expect(parseEngraveJob(withSha({ pencilCreaseDeg: 0.5 })).ok).toBe(false);
  });
});

describe('generateSurface3dIR — every hop out of a cut is two moves (#738)', () => {
  /**
   * The house rule is stated at `rapidRate` in `ir.ts`: a stroke hops in TWO moves — a Z-only
   * retract to `HOP_Z` at the end of one stroke, then an XY-only traverse to the next stroke's
   * start. A rapid that changes X/Y on its way OUT of a cut is a `G0 X.. Z..` that climbs away
   * diagonally through material standing beside the cut — what the Z1 bench's sweep refused on
   * j06 (16 rapids) and j07 (5 and 63). Only an operation's ENTRY move may combine axes: it is
   * move 0 here, and the post times it as travel from the previous operation's `safeZ`.
   */
  function combinedRapids(moves: readonly CamMove[], op: string): string[] {
    const bad: string[] = [];
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.kind !== 'rapid' || (m.x === prev.x && m.y === prev.y)) continue;
      // An XY traverse must start where a rapid already lifted to this same Z.
      if (prev.kind === 'rapid' && Math.abs(prev.z - m.z) < 1e-9) continue;
      bad.push(
        `${op} move ${i}: rapid to (${m.x}, ${m.y}, ${m.z}) from ${prev.kind} (${prev.x}, ${prev.y}, ${prev.z})`,
      );
    }
    return bad;
  }

  it('the dome’s roughing gaps retract Z-only first — and none of the four passes combines axes', () => {
    // The dome makes the defect's site inescapable: at a roughing layer the material still to
    // remove is an ANNULUS, so a raster row cuts, crosses the apex where there is nothing to
    // remove, and cuts again. That gap is where roughing used to emit `G0 X.. Z..` straight out
    // of a cut. (A ramp or a step opens at most one gap per row and never re-enters it.)
    const hf = sampleGoalHeightfield(goal(domeTris(5)), { pitchMm: 0.2 });
    const { ir, roughing } = generateSurface3dIR({
      heightfield: hf,
      tool: BALL,
      toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
      opts: { scallop: true, pencil: true },
    });
    // The program really does hop out of a cut, or the rule below is vacuous.
    const hops = roughing.moves.filter(
      (m, i) => i > 0 && m.kind === 'rapid' && m.z === ir.hopZ && roughing.moves[i - 1]!.kind === 'feed',
    );
    expect(hops.length).toBeGreaterThan(0);
    const bad = ir.operations.flatMap((op) => combinedRapids(op.moves, op.name));
    expect(bad).toEqual([]);
  });
});
