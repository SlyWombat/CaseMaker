/**
 * #721 — a goal mesh made as a MOLD. The issue's fixture: a hemisphere STL made as the item (a dome)
 * and as the mold (a bowl); both generate, and the mold's finishing pass, swept through the FLAT
 * dexel engine, reproduces the bowl. Plus the mold's own checks (rim, floor, one-sided, draft) and
 * the turn-over that keeps a casting the right way round.
 */
import { afterEach, describe, expect, it } from 'vitest';

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
  generateSurface3dIR,
  moldHeightfield,
  sampleGoalHeightfield,
  type SurfaceFeeds,
  type SurfaceTool,
} from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { validateGoalObject } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { RapidEstimate, CamMove } from '@/engine/cnc/cam/ir';
import { FLAT, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };
const FEEDS: SurfaceFeeds = { feed: 500, plungeFeed: 200, stepDown: 0.5, roughStepOver: 0.8, finishStepOver: 0.4 };
const BALL: SurfaceTool = { radius: 0.5, ball: true };
const BALL_CUTTER: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: 0.5, outerRadius: 0.5 };

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** A hemisphere cap of radius R centred at (10,10), apex at z=0, rim at z=−R (local frame). */
function domeTris(R: number, seg = 48): Tri[] {
  const tris: Tri[] = [];
  const h = (x: number, y: number): number => {
    const r2 = (x - 10) ** 2 + (y - 10) ** 2;
    return r2 >= R * R ? -R : -(R - Math.sqrt(R * R - r2));
  };
  const at = (u: number, v: number): V => {
    const x = 10 + R * u * Math.cos(2 * Math.PI * v);
    const y = 10 + R * u * Math.sin(2 * Math.PI * v);
    return [x, y, h(x, y)];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = at(i / seg, j / seg), b = at((i + 1) / seg, j / seg), c = at((i + 1) / seg, (j + 1) / seg), d = at(i / seg, (j + 1) / seg);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return tris;
}

/** A wedge over [0,20]², sloping in Y only: z = −0.1·y (a chiral part along Y). */
function wedgeTris(): Tri[] {
  const p = (x: number, y: number): V => [x, y, -0.1 * y];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

let n = 0;
function goal(tris: Tri[], over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-1',
    name: 'dome.stl',
    format: 'stl',
    sha256: (n++).toString(16).padStart(64, 'b'),
    data: stl(tris),
    size: { x: 10, y: 10, z: 5 },
    position: { x: 10, y: 10, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}

function sweep(setup: Setup, moves: readonly CamMove[], pitch: number): ReturnType<typeof FLAT.buildGrid> {
  const cut: CutMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const b = moves[i]!;
    if (b.kind !== 'feed') continue;
    cut.push({ step: i, line: i, u0: a.x, u1: b.x, v0: a.y, v1: b.y, z: Math.min(a.z, b.z) });
  }
  const grid = FLAT.buildGrid(setup, BALL_CUTTER, cut, { dx: pitch, dThetaDeg: pitch });
  for (const m of cut) FLAT.applyMove(grid, m, BALL_CUTTER);
  return grid;
}

function heightAt(grid: ReturnType<typeof FLAT.buildGrid>, x: number, y: number): number {
  const i = Math.round((x - grid.u0) / grid.du);
  const j = Math.round((y - grid.v0) / grid.dv);
  return grid.h[j * grid.nu + i] as number;
}

function cellAt(hf: ReturnType<typeof sampleGoalHeightfield>, x: number, y: number): number {
  const i = Math.round((x - hf.x0) / hf.pitch);
  const j = Math.round((y - hf.y0) / hf.pitch);
  return hf.z[j * hf.nx + i] as number;
}

const R = 5;
const bowl = (x: number, y: number): number => {
  const r2 = (x - 10) ** 2 + (y - 10) ** 2;
  return r2 >= R * R ? 0 : -Math.sqrt(R * R - r2);
};

describe('#721 — the mold heightfield', () => {
  it('the dome becomes a bowl: deepest at the centre (the part height), flush at the rim', () => {
    const item = sampleGoalHeightfield(goal(domeTris(R)), { pitchMm: 0.1 });
    const mold = moldHeightfield(item, 10, -R);
    expect(cellAt(item, 10, 10)).toBeCloseTo(0, 2);
    expect(cellAt(mold, 10, 10)).toBeCloseTo(-R, 2);
    expect(cellAt(mold, 13, 10)).toBeCloseTo(bowl(13, 10), 1);
    expect(mold.minZ).toBeCloseTo(-R, 2);
    expect(mold.coveredCount).toBe(item.coveredCount);
  });

  it('the part is turned over, not reflected: a wedge high at y=20 is deepest at y=0 in the mold', () => {
    const item = sampleGoalHeightfield(goal(wedgeTris(), { size: { x: 20, y: 20, z: 2 } }), { pitchMm: 0.25 });
    const mold = moldHeightfield(item, 10, -2);
    // Item: high (z≈0) at y=0, low (z≈−2) at y=20. Part height above its base: 2 at y=0, 0 at y=20.
    // Turned over about X, the part's high edge lands at y=20: the cavity is deepest there.
    expect(cellAt(mold, 10, 19.75)).toBeCloseTo(-2 + 0.025, 1);
    expect(cellAt(mold, 10, 0.25)).toBeCloseTo(-0.025, 1);
    // The footprint stays where the part sits.
    expect(mold.y0).toBeCloseTo(item.y0, 6);
  });
});

describe('#721 — generate → simulate → match', () => {
  it('the mold’s finishing pass, swept, reproduces the bowl at the interior', () => {
    const item = sampleGoalHeightfield(goal(domeTris(R)), { pitchMm: 0.1 });
    const mold = moldHeightfield(item, 10, -R);
    const { finishing } = generateSurface3dIR({
      heightfield: mold,
      tool: BALL,
      toolObj: flatEndMill(1, { shape: 'ball', name: 'ball' }),
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal-1',
    });
    const grid = sweep(prism(40, 40, 10), finishing.moves, mold.pitch);
    const tol = FEEDS.finishStepOver + 4 * mold.pitch;
    for (const [x, y] of [[10, 10], [11, 10], [10, 11], [12, 11]] as const) {
      const got = heightAt(grid, x, y);
      expect(got).toBeGreaterThanOrEqual(bowl(x, y) - tol);
      expect(got).toBeLessThanOrEqual(bowl(x, y) + tol);
    }
  });

  function job(over: Partial<EngraveTargetObject> = {}): EngraveJob {
    return {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      targetObject: goal(domeTris(R), { position: { x: 50, y: 30, z: 0 }, ...over }),
    };
  }

  it('the same hemisphere generates as the item (a dome) and as the mold (a bowl)', () => {
    const asItem = job();
    const item = generateGoalProgram(asItem, asItem.targetObject!, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(item.ok).toBe(true);
    const asMold = job({ goalMode: 'mold' });
    const mold = generateGoalProgram(asMold, asMold.targetObject!, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(mold.ok).toBe(true);
    expect(mold.programs).toHaveLength(1);
    expect(mold.programs[0]!.surfaceCheck?.kind).toBe('surface');
    // The deepest Z in each program: the item's rim sits R below the top; the bowl's centre too.
    const deepest = (nc: string): number =>
      Math.min(...[...nc.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
    expect(deepest(item.nc!)).toBeCloseTo(-R, 0);
    expect(deepest(mold.nc!)).toBeCloseTo(-R, 0);
    // The mold's honest limit rides with the run: it is one-sided (info).
    expect(mold.findings.find((f) => f.code === 'goal-mold-one-sided')?.severity).toBe('info');
    expect(item.findings.some((f) => f.code.startsWith('goal-mold'))).toBe(false);
  });

  it('a box-shaped part has vertical walls and is warned; the hemisphere is not', () => {
    const box: Tri[] = [];
    const c: V[] = [
      [0, 0, -4], [10, 0, -4], [10, 10, -4], [0, 10, -4],
      [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
    ];
    const q = (a: number, b: number, d: number, e: number): void => {
      box.push([c[a]!, c[b]!, c[d]!], [c[a]!, c[d]!, c[e]!]);
    };
    q(4, 5, 6, 7); q(0, 3, 2, 1); q(0, 1, 5, 4); q(2, 3, 7, 6); q(1, 2, 6, 5); q(3, 0, 4, 7);
    const boxJob = { ...job(), targetObject: goal(box, { goalMode: 'mold', size: { x: 10, y: 10, z: 4 }, position: { x: 50, y: 30, z: 0 } }) };
    const out = generateGoalProgram(boxJob, boxJob.targetObject!, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(out.ok).toBe(true);
    const warn = out.findings.find((f) => f.code === 'goal-mold-no-draft');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toMatch(/a wall at 8\d(\.\d)?°/);
    // A hemisphere's wall curves away from vertical within a cell of the rim: no warning.
    const dome = job({ goalMode: 'mold' });
    const domeOut = generateGoalProgram(dome, dome.targetObject!, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(domeOut.findings.some((f) => f.code === 'goal-mold-no-draft')).toBe(false);
  });
});

describe('#721 — a mold needs a rim and a floor', () => {
  const STOCK = { length: 30, width: 30, thickness: 8 };
  it('#786 slice 2 — a cavity with no rim is INFORMED, with the shortfall per side', () => {
    const t = goal(domeTris(R), { goalMode: 'mold', size: { x: 29, y: 29, z: 5 }, position: { x: 15, y: 15, z: 0 } });
    const f = validateGoalObject(t, STOCK, { edgeMargin: 1, minFloor: 1 });
    expect(f.map((x) => x.code)).toEqual(['goal-mold-rim']);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toContain('a cavity wants a 1 mm rim of stock all round it');
    expect(f[0]!.message).toContain('0.5 mm on the left');
    expect(f[0]!.message).toContain('cuts the cavity clipped to the blank');
    // The same part as an ITEM fits: the rim is a mold's rule only.
    expect(validateGoalObject({ ...t, goalMode: undefined }, STOCK, { edgeMargin: 1, minFloor: 1 })).toEqual([]);
  });

  it('#786 slice 2 — a cavity leaving less than the minimum floor is INFORMED with the floor it leaves', () => {
    const t = goal(domeTris(R), { goalMode: 'mold', size: { x: 10, y: 10, z: 7.5 } });
    const f = validateGoalObject(t, STOCK, { edgeMargin: 1, minFloor: 1 });
    expect(f.map((x) => x.code)).toEqual(['goal-mold-floor']);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toContain('leaving 0.5 mm of stock under the cavity');
    expect(f[0]!.message).toContain('at least 1 mm');
    // A cavity that breaks through names the breakthrough instead.
    const through = goal(domeTris(R), { goalMode: 'mold', size: { x: 10, y: 10, z: 8.5 } });
    const tf = validateGoalObject(through, STOCK, { edgeMargin: 1, minFloor: 1 });
    expect(tf[0]!.message).toContain("breaks through the blank's bottom by 0.5 mm");
  });

  it('round-trips the choice; an item stays without the key', () => {
    const base = defaultEngraveJob();
    const asMold = parseEngraveJob(JSON.parse(JSON.stringify({ ...base, targetObject: goal(domeTris(R), { goalMode: 'mold' }) })));
    expect(asMold.ok).toBe(true);
    if (asMold.ok) expect(asMold.job.targetObject?.goalMode).toBe('mold');
    const asItem = parseEngraveJob(JSON.parse(JSON.stringify({ ...base, targetObject: goal(domeTris(R)) })));
    expect(asItem.ok).toBe(true);
    if (asItem.ok) expect('goalMode' in (asItem.job.targetObject ?? {})).toBe(false);
  });
});

describe('#721 review — placement', () => {
  it('#786 slice 2 — a mold that would break out of the blank side is INFORMED and still cut', () => {
    const STOCK = { length: 100, width: 60, thickness: 12 };
    const t = goal(domeTris(R), { goalMode: 'mold', size: { x: 20, y: 20, z: 5 }, position: { x: 8, y: 30, z: 0 } });
    const f = validateGoalObject(t, STOCK, { edgeMargin: 1, minFloor: 1 });
    expect(f.map((x) => x.code)).toEqual(['goal-mold-rim']);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toContain('no rim on the left (it breaks out by 2 mm)');
    expect(validateGoalObject({ ...t, position: { x: 50, y: 30, z: 0 } }, STOCK, { edgeMargin: 1, minFloor: 1 })).toEqual([]);
    // And Generate proceeds: the cavity is cut clipped to the blank, saying what broke out.
    const j = { ...defaultEngraveJob(), labels: [], shapes: [], stock: { ...defaultEngraveJob().stock, ...STOCK }, targetObject: t };
    const out = generateGoalProgram(j, t, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.findings.some((x) => x.code === 'goal-mold-rim' && x.severity === 'warning')).toBe(true);
  });

  it('a mold run says it is a mold in its facts', () => {
    const j: EngraveJob = { ...defaultEngraveJob(), labels: [], shapes: [], targetObject: goal(domeTris(R), { goalMode: 'mold', position: { x: 50, y: 30, z: 0 } }) };
    const out = generateGoalProgram(j, j.targetObject!, flatEndMill(1, { shape: 'ball' }), [], null, {});
    expect(out.surface3d?.notes.some((n) => n.startsWith('Made as a mold'))).toBe(true);
  });
});
