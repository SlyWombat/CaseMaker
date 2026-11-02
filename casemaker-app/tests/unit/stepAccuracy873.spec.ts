/**
 * #873 — THE STEP-ACCURACY CHECK: one solid, saved twice, read through the app's own door.
 *
 * `step-accuracy.step` is a hand-authored AP214 B-rep (see `scripts/gen-step-fixture.mts`): a
 * 60 × 40 × 10 mm plate with a 2 mm quarter-cylinder fillet at the (60,40) corner, a 3 mm through
 * hole at (20,20), and a shallow spherical cap (R20, centred (45,20,-8)) standing 2 mm off the
 * top. `step-accuracy-fine.3mf` is the SAME solid, built in Manifold and tessellated finely.
 *
 * A STEP has exact surfaces and no triangles of its own: `readTargetObjectFile` tessellates it
 * through the kernel (`stepMesh.ts`) and the job stores that mesh. So the question here is not
 * "does the STEP hold the right shape" — it does — but "is the mesh the kernel hands the rest of
 * the app close enough to that shape for a 0.05 mm oracle to judge it honestly".
 *
 * Three checks, in the order the issue asks for them:
 *
 *  1. DEVIATION. At each curved feature the imported mesh's worst triangle is measured against
 *     the analytic surface. The maximum over a triangle is at its closest point to the feature's
 *     axis or centre — a vertex-only measure would understate the chord sag this fixture exists
 *     to catch. The measured maxima are pinned and held to `COVERAGE_DEFAULTS.reachedMm`, the
 *     band the goal oracle calls "reached".
 *  2. SIZE. Both files import to the same 60 × 40 × 12 mm box and place to the same work box.
 *  3. SAME PROGRAM, SAME SWEEP. Both drive a pure-goal job on a blank sized to them; the posted
 *     programs and the swept flat fields are compared. The two programs are NOT text-identical —
 *     each is a raster laid over its own tessellation, so two raster edges land on opposite sides
 *     of a cell — and the comparison below is the equivalence that inspection justifies, with
 *     every difference pinned and confined to its two known places.
 *
 * `stepMesh.ts` was NOT changed. occt-import-js's defaults are a bounding-box-ratio linear
 * deflection of 0.001 (0.037333 mm for this solid's mean bbox extent) with 0.5 rad angular, and
 * the worst feature here is the dome at 0.019 mm — inside the bar with room to spare. These pins
 * fail loudly if a future importer version moves the tessellation rather than letting the oracle
 * quietly misjudge it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { sampleGoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { COVERAGE_DEFAULTS, goalCoverage, type CoverageMesh, type ResultTop } from '@/engine/cnc/engrave/goalCoverage';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { Z1 } from '@/engine/cnc/machine';
import { readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { createSimSession } from '@/workers/sim/session';
import type { FlatField } from '@/workers/geometry/carriedField';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const STEP = 'step-accuracy.step';
const FINE = 'step-accuracy-fine.3mf';

/**
 * The solid's own bounding box: the plate is 60 × 40 × 10 and the dome adds 2 mm. A goal job is
 * sized to its target, so both programs cut the same blank from the same setup.
 */
const STOCK = { length: 60, width: 40, thickness: 12 } as const;

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

type ReadOk = Extract<Awaited<ReturnType<typeof readTargetObjectFile>>, { ok: true }>;

/** The fixture read through the app's own door, exactly as the goal picker reads it. */
async function read(name: string): Promise<ReadOk> {
  const bytes = readFileSync(here(name));
  const result = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result;
}

interface Pair {
  step: ReadOk;
  fine: ReadOk;
  /** Cold wall clock of the STEP read, including the kernel wasm's own load. */
  stepMs: number;
  fineMs: number;
}

let pairPromise: Promise<Pair> | null = null;

/**
 * Read both files ONCE for this worker. The STEP is read first so the wall clock recorded for it
 * is the cold one; the 3MF read is the app's plain parse.
 */
function loadPair(): Promise<Pair> {
  pairPromise ??= (async () => {
    const stepStart = performance.now();
    const step = await read(STEP);
    const stepMs = performance.now() - stepStart;
    const fineStart = performance.now();
    const fine = await read(FINE);
    const fineMs = performance.now() - fineStart;
    return { step, fine, stepMs, fineMs };
  })();
  return pairPromise;
}

/** The goal object the picker builds, with `position` on the blank's centre. */
function targetOf(read: ReadOk, stock: { length: number; width: number }): EngraveTargetObject {
  return {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: stock.length / 2, y: stock.width / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

/** A pure-goal job on a blank sized to the mesh — the corpus spec's job shape, unchanged. */
function goalJob(target: EngraveTargetObject, stock: { length: number; width: number; thickness: number }): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: target.name,
    labels: [],
    shapes: [],
    drills: [],
    stock: { ...stock, material: 'softwood' },
    toolKey: 'flat-1.0',
    targetObject: target,
  };
}

/** The target's triangles in the WORK frame — the same placement the sampler cuts from. */
function workMesh(target: EngraveTargetObject): CoverageMesh {
  const mesh = targetObjectMesh(target);
  const { place } = placeTarget(target, mesh);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = place(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  return { positions, indices: mesh.indices };
}

/** The min/max of a work-frame mesh over all three axes. */
function placedBounds(mesh: CoverageMesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = mesh.positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

/** The swept result's top at a work XY, bilinear on the column engine's own grid. */
function resultTopOf(field: FlatField): ResultTop {
  return (x, y) => {
    const fi = (x - field.u0) / field.du;
    const fj = (y - field.v0) / field.dv;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 + 1 >= field.nu || j0 + 1 >= field.nv) return null;
    const tx = fi - i0;
    const ty = fj - j0;
    const at = (i: number, j: number): number => field.top[j * field.nu + i]!;
    const z0 = at(i0, j0) * (1 - tx) + at(i0 + 1, j0) * tx;
    const z1 = at(i0, j0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1) * tx;
    return z0 * (1 - ty) + z1 * ty;
  };
}

// ── The analytic features and the exact maximum distance to them ─────────────────────────────

type V3 = { x: number; y: number; z: number };

type Feature = 'hole' | 'fillet' | 'dome';

interface FeatureDeviation {
  feature: Feature;
  triangles: number;
  maxMm: number;
}

const HOLE = { x: 20, y: 20, r: 1.5 } as const;
const FILLET = { x: 58, y: 38, r: 2 } as const;
const DOME = { x: 45, y: 20, z: -8, r: 20 } as const;

/**
 * The min distance from (px,py) to the XY projection of triangle abc. A vertical wall triangle
 * has two vertices at the same XY, so its projection is often a segment; the inside test is kept
 * for the general case.
 */
function distance2D(px: number, py: number, a: V3, b: V3, c: V3): number {
  const pts: Array<[number, number]> = [
    [a.x, a.y],
    [b.x, b.y],
    [c.x, c.y],
  ];
  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % 3]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
  }
  const sign = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number =>
    (x0 - x2) * (y1 - y2) - (x1 - x2) * (y0 - y2);
  const d1 = sign(px, py, pts[0]![0], pts[0]![1], pts[1]![0], pts[1]![1]);
  const d2 = sign(px, py, pts[1]![0], pts[1]![1], pts[2]![0], pts[2]![1]);
  const d3 = sign(px, py, pts[2]![0], pts[2]![1], pts[0]![0], pts[0]![1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return hasNeg && hasPos ? best : 0;
}

/** The min distance from p to triangle abc in 3-D (Ericson's closest-point-on-triangle). */
function distance3D(p: V3, a: V3, b: V3, c: V3): number {
  const sub = (u: V3, v: V3): V3 => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u: V3, v: V3): number => u.x * v.x + u.y * v.y + u.z * v.z;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(ap.x, ap.y, ap.z);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bp.x, bp.y, bp.z);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const q = { x: a.x + ab.x * v, y: a.y + ab.y * v, z: a.z + ab.z * v };
    const pq = sub(p, q);
    return Math.hypot(pq.x, pq.y, pq.z);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cp.x, cp.y, cp.z);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const q = { x: a.x + ac.x * w, y: a.y + ac.y * w, z: a.z + ac.z * w };
    const pq = sub(p, q);
    return Math.hypot(pq.x, pq.y, pq.z);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const q = { x: b.x + (c.x - b.x) * w, y: b.y + (c.y - b.y) * w, z: b.z + (c.z - b.z) * w };
    const pq = sub(p, q);
    return Math.hypot(pq.x, pq.y, pq.z);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const q = { x: a.x + ab.x * v + ac.x * w, y: a.y + ab.y * v + ac.y * w, z: a.z + ab.z * v + ac.z * w };
  const pq = sub(p, q);
  return Math.hypot(pq.x, pq.y, pq.z);
}

/**
 * The worst distance from each curved feature's TRUE surface to the imported triangles.
 *
 * A triangle is admitted only when all three vertices lie on the feature's analytic set (within
 * 2e-4 mm — the kernel puts vertices on the surface, so this only absorbs float noise):
 *
 *  - hole: XY distance 1.5 from (20,20), z on the plate, and the triangle spans at least 1 mm of
 *    Z. The Z-span clause rejects flat top/bottom triangles whose three vertices happen to lie on
 *    the rim circle; such a triangle is a chord across the circle and would report a sag that is
 *    not the hole's.
 *  - fillet: XY distance 2 from (58,38), x ≥ 58 and y ≥ 38 (the quarter-cylinder occupies only
 *    that quadrant), z on the plate, and the same Z-span clause.
 *  - dome: 3-D distance 20 from (45,20,-8), z ≥ 10 (the cap stands above the top face), and a
 *    non-flat triangle.
 *
 * The deviation is then the exact maximum over the triangle, not just at its vertices: every
 * point of an admitted triangle is on the bounded side of the true surface (no farther than R
 * from the axis or centre), so its distance to the surface is R minus its own radius, and the
 * worst point is the triangle's closest point to the axis or centre.
 */
function featureDeviations(mesh: CoverageMesh): Record<Feature, FeatureDeviation> {
  const pos = mesh.positions;
  const idx = mesh.indices;
  const at = (i: number): V3 => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });
  const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;
  const stats: Record<Feature, FeatureDeviation> = {
    hole: { feature: 'hole', triangles: 0, maxMm: 0 },
    fillet: { feature: 'fillet', triangles: 0, maxMm: 0 },
    dome: { feature: 'dome', triangles: 0, maxMm: 0 },
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = at(idx[t]!);
    const b = at(idx[t + 1]!);
    const c = at(idx[t + 2]!);
    const vs = [a, b, c];
    const zSpan = Math.max(a.z, b.z, c.z) - Math.min(a.z, b.z, c.z);
    const onPlate = vs.every((p) => p.z >= -1e-4 && p.z <= 10 + 1e-4);

    const rh = vs.map((p) => Math.hypot(p.x - HOLE.x, p.y - HOLE.y));
    if (rh.every((r) => near(r, HOLE.r, 2e-4)) && onPlate && zSpan > 1) {
      const deviation = HOLE.r - distance2D(HOLE.x, HOLE.y, a, b, c);
      stats.hole.triangles += 1;
      stats.hole.maxMm = Math.max(stats.hole.maxMm, deviation);
    }

    const rf = vs.map((p) => Math.hypot(p.x - FILLET.x, p.y - FILLET.y));
    if (
      rf.every((r) => near(r, FILLET.r, 2e-4)) &&
      vs.every((p) => p.x >= FILLET.x - 1e-4 && p.y >= FILLET.y - 1e-4) &&
      onPlate &&
      zSpan > 1
    ) {
      const deviation = FILLET.r - distance2D(FILLET.x, FILLET.y, a, b, c);
      stats.fillet.triangles += 1;
      stats.fillet.maxMm = Math.max(stats.fillet.maxMm, deviation);
    }

    const rd = vs.map((p) => Math.hypot(p.x - DOME.x, p.y - DOME.y, p.z - DOME.z));
    if (rd.every((r) => near(r, DOME.r, 2e-4)) && vs.every((p) => p.z >= 10 - 1e-4) && zSpan > 1e-4) {
      const deviation = DOME.r - distance3D(DOME, a, b, c);
      stats.dome.triangles += 1;
      stats.dome.maxMm = Math.max(stats.dome.maxMm, deviation);
    }
  }
  return stats;
}

// ── The two posted programs ─────────────────────────────────────────────────────────────────

interface Visit {
  pass: number;
  rapid: boolean;
  x: number;
  y: number;
  z: number[];
}

interface Program {
  moves: number;
  visits: Map<string, Visit>;
}

/**
 * A posted program reduced to the facts the comparison needs: how many motion lines it has, and
 * what Z it posts at each (pass, G0/G1, X, Y). Comments and the post's modal formatting are gone
 * by construction. Positions are keyed at the post's own three decimals.
 */
function parseProgram(nc: string): Program {
  let x = 0;
  let y = 0;
  let z = 0;
  let pass = 0;
  let moves = 0;
  const visits = new Map<string, Visit>();
  for (const rawLine of nc.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith(';@MKR|TOOLPATH_START')) {
      const m = line.match(/toolpath_number=(\d+)/);
      pass = m ? Number(m[1]) : pass + 1;
      continue;
    }
    if (line === '' || line.startsWith(';') || line.startsWith('(')) continue;
    const parts = line.split(/\s+/);
    const code = parts[0];
    if (code !== 'G0' && code !== 'G1') continue;
    let nx = x;
    let ny = y;
    let nz = z;
    for (const word of parts.slice(1)) {
      const value = Number(word.slice(1));
      if (!Number.isFinite(value)) continue;
      if (word[0] === 'X') nx = value;
      else if (word[0] === 'Y') ny = value;
      else if (word[0] === 'Z') nz = value;
    }
    moves += 1;
    const key = `${pass}|${code}|${nx.toFixed(3)}|${ny.toFixed(3)}`;
    const visit = visits.get(key);
    if (visit) visit.z.push(nz);
    else visits.set(key, { pass, rapid: code === 'G0', x: nx, y: ny, z: [nz] });
    x = nx;
    y = ny;
    z = nz;
  }
  return { moves, visits };
}

interface ProgramComparison {
  onlyA: string[];
  onlyB: string[];
  multiplicity: Array<{ key: string; a: number; b: number }>;
  sharedUnique: number;
  identicalZ: number;
  maxDz: number;
  maxDzKey: string;
  overBar: number;
}

/**
 * Where BOTH programs visit a position exactly once, their posted Z is directly comparable. A
 * position either file visits more than once (a plunge column) has no order to its Z multiset,
 * so it is excluded here and handled by the zone assertion instead.
 */
function comparePrograms(a: Program, b: Program, bar: number): ProgramComparison {
  const onlyA = [...a.visits.keys()].filter((key) => !b.visits.has(key));
  const onlyB = [...b.visits.keys()].filter((key) => !a.visits.has(key));
  const multiplicity: Array<{ key: string; a: number; b: number }> = [];
  let sharedUnique = 0;
  let identicalZ = 0;
  let maxDz = 0;
  let maxDzKey = '';
  let overBar = 0;
  for (const [key, va] of a.visits) {
    const vb = b.visits.get(key);
    if (!vb) continue;
    if (va.z.length !== vb.z.length) {
      multiplicity.push({ key, a: va.z.length, b: vb.z.length });
      continue;
    }
    if (va.z.length !== 1) continue;
    sharedUnique += 1;
    const dz = Math.abs(va.z[0]! - vb.z[0]!);
    if (dz < 1e-9) identicalZ += 1;
    if (dz > maxDz) {
      maxDz = dz;
      maxDzKey = key;
    }
    if (dz > bar) overBar += 1;
  }
  return { onlyA, onlyB, multiplicity, sharedUnique, identicalZ, maxDz, maxDzKey, overBar };
}

function keyParts(key: string): { pass: number; rapid: boolean; x: number; y: number } {
  const [pass, code, x, y] = key.split('|');
  return { pass: Number(pass), rapid: code === 'G0', x: Number(x), y: Number(y) };
}

/**
 * The two places the inspection found a difference between the files:
 *  - the dome, where the rough pass's "surface + 0.3 mm" contour crosses the stock top and one
 *    raster row lands on opposite sides of the tessellated cap (the dome's rim radius is
 *    sqrt(76) = 8.718 mm). #889 — a tie there now moves the end of a merged level run, which lies
 *    where the cap first comes under the 1 mm cutter's disc: the zone is the rim plus one cutter
 *    diameter and a cell, 9.9 mm;
 *  - the rounded corner's vertical wall, which the finish clears as a full-depth column at one
 *    raster row: y = 38.7 in one file, y = 39.2 in the other.
 */
const inDomeZone = (x: number, y: number): boolean => Math.hypot(x - DOME.x, y - DOME.y) <= 9.9;
const inCornerZone = (x: number, y: number): boolean => x >= 59.5 && y >= 38;
const zoneOf = (x: number, y: number): 'dome' | 'corner' | 'other' =>
  inDomeZone(x, y) ? 'dome' : inCornerZone(x, y) ? 'corner' : 'other';

// ── The two generated goal programs, built once ─────────────────────────────────────────────

interface RunHalf {
  target: EngraveTargetObject;
  job: EngraveJob;
  generated: ReturnType<typeof generate>;
  ms: number;
}

interface Run {
  a: RunHalf;
  b: RunHalf;
}

let runPromise: Promise<Run> | null = null;

/** Generate both goal jobs from the pair. Sync work inside; cached so the tests share it. */
function loadRun(): Promise<Run> {
  runPromise ??= (async () => {
    const pair = await loadPair();
    const targetA = targetOf(pair.step, STOCK);
    const targetB = targetOf(pair.fine, STOCK);
    const jobA = goalJob(targetA, STOCK);
    const jobB = goalJob(targetB, STOCK);
    const aStart = performance.now();
    const generatedA = generate(tl, jobA);
    const aMs = performance.now() - aStart;
    const bStart = performance.now();
    const generatedB = generate(tl, jobB);
    const bMs = performance.now() - bStart;
    return {
      a: { target: targetA, job: jobA, generated: generatedA, ms: aMs },
      b: { target: targetB, job: jobB, generated: generatedB, ms: bMs },
    };
  })();
  return runPromise;
}

/** The sweep of one posted program, on the setup its own job states. */
function sweep(nc: string, job: EngraveJob): FlatField {
  const tool = jobTool(job);
  if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);
  const session = createSimSession(tl);
  try {
    const load = session.load(nc, toSetup(job, Z1), tool, Z1.id);
    if (!load.ok || !load.flatField) {
      throw new Error(`the sweep refused: ${load.diagnostics.map((d) => d.message).join('; ')}`);
    }
    return load.flatField;
  } finally {
    session.dispose();
  }
}

describe('#873 STEP accuracy: one solid, two files, the same cut', () => {
  const bar = COVERAGE_DEFAULTS.reachedMm; // 0.05 mm — the same band the goal oracle calls reached

  it('tessellates every curved feature inside the oracle band, from a B-rep with no triangles', async () => {
    const pair = await loadPair();
    const stepMesh = targetObjectMesh(pair.step);
    const fineMesh = targetObjectMesh(pair.fine);
    const stepTriangles = stepMesh.indices.length / 3;
    const fineTriangles = fineMesh.indices.length / 3;

    // The facts the issue asks to record: triangle count and cold import wall clock.
    console.log(
      `${STEP}: ${stepTriangles} triangles, imported in ${pair.stepMs.toFixed(0)} ms; ` +
        `${FINE}: ${fineTriangles} triangles, imported in ${pair.fineMs.toFixed(0)} ms`,
    );
    expect(stepTriangles).toBe(989);
    expect(fineTriangles).toBe(3554);
    // The numbers above are the record; these loose caps only catch a pathologically slow import.
    expect(pair.stepMs).toBeLessThan(10_000);
    expect(pair.fineMs).toBeLessThan(5_000);

    // Both files are the same 60 × 40 × 12 mm solid, and both place to the same work box.
    for (const size of [pair.step.size, pair.fine.size]) {
      expect(size.x).toBeCloseTo(60, 2);
      expect(size.y).toBeCloseTo(40, 2);
      expect(size.z).toBeCloseTo(12, 2);
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(pair.step.size[axis] - pair.fine.size[axis])).toBeLessThanOrEqual(1e-2);
    }
    const placedStep = placedBounds(workMesh(targetOf(pair.step, STOCK)));
    const placedFine = placedBounds(workMesh(targetOf(pair.fine, STOCK)));
    expect(placedStep.min[0]).toBeCloseTo(0, 2);
    expect(placedStep.min[1]).toBeCloseTo(0, 2);
    expect(placedStep.min[2]).toBeCloseTo(-12, 2);
    expect(placedStep.max[0]).toBeCloseTo(60, 2);
    expect(placedStep.max[1]).toBeCloseTo(40, 2);
    expect(placedStep.max[2]).toBeCloseTo(0, 2);
    for (let k = 0; k < 3; k += 1) {
      expect(Math.abs(placedStep.min[k]! - placedFine.min[k]!)).toBeLessThanOrEqual(1e-2);
      expect(Math.abs(placedStep.max[k]! - placedFine.max[k]!)).toBeLessThanOrEqual(1e-2);
    }

    const stepDev = featureDeviations(stepMesh);
    const fineDev = featureDeviations(fineMesh);
    const line = (label: string, d: Record<Feature, FeatureDeviation>): string =>
      `${label}: hole ${d.hole.maxMm.toFixed(9)} mm (${d.hole.triangles} tris), ` +
      `fillet ${d.fillet.maxMm.toFixed(9)} mm (${d.fillet.triangles} tris), ` +
      `dome ${d.dome.maxMm.toFixed(9)} mm (${d.dome.triangles} tris)`;
    console.log(line(`STEP worst deviation (bar ${bar} mm)`, stepDev));
    console.log(line('3MF worst deviation', fineDev));

    // The STEP baseline — the kernel's default tessellation, measured exactly. The hole's 26
    // segments and the fillet's 7-per-quarter are what occt chose; the dome's 791 triangles span
    // the cap.
    expect(stepDev.hole.triangles).toBe(52);
    expect(stepDev.fillet.triangles).toBe(14);
    expect(stepDev.dome.triangles).toBe(791);
    expect(stepDev.hole.maxMm).toBeCloseTo(0.010936737, 6);
    expect(stepDev.fillet.maxMm).toBeCloseTo(0.012575947, 6);
    expect(stepDev.dome.maxMm).toBeCloseTo(0.019248796, 6);
    for (const d of Object.values(stepDev)) expect(d.maxMm, `STEP ${d.feature}`).toBeLessThanOrEqual(bar);

    // The fine 3MF is the reference the oracle judges against; it must be finer than the bar by a
    // wide margin, and these pins catch a fixture regeneration at a coarser tessellation.
    expect(fineDev.hole.triangles).toBe(512);
    expect(fineDev.fillet.triangles).toBe(128);
    expect(fineDev.dome.triangles).toBe(1804);
    expect(fineDev.hole.maxMm).toBeCloseTo(0.000113841, 6);
    expect(fineDev.fillet.maxMm).toBeCloseTo(0.000152247, 6);
    expect(fineDev.dome.maxMm).toBeCloseTo(0.003331744, 6);
    for (const d of Object.values(fineDev)) expect(d.maxMm, `3MF ${d.feature}`).toBeLessThanOrEqual(bar);
  });

  it('posts the same goal program, bar the raster ties the inspection pins', async () => {
    const run = await loadRun();
    expect(run.a.generated.ok, run.a.generated.findings.map((f) => f.code).join(', ')).toBe(true);
    expect(run.b.generated.ok, run.b.generated.findings.map((f) => f.code).join(', ')).toBe(true);
    expect(run.a.generated.stage).toBe('done');
    expect(run.b.generated.stage).toBe('done');
    if (run.a.generated.nc === null || run.b.generated.nc === null) throw new Error('a goal job posted no program');

    const a = parseProgram(run.a.generated.nc);
    const b = parseProgram(run.b.generated.nc);
    const cmp = comparePrograms(a, b, bar);
    console.log(
      `goal program: STEP ${a.moves} moves in ${run.a.ms.toFixed(0)} ms; ` +
        `3MF ${b.moves} moves in ${run.b.ms.toFixed(0)} ms; A - B = ${a.moves - b.moves}`,
    );
    console.log(
      `shared positions visited once by both: ${cmp.sharedUnique}; identical Z ${cmp.identicalZ}; ` +
        `max |dz| ${cmp.maxDz.toFixed(6)} mm at ${cmp.maxDzKey}; over ${bar} mm: ${cmp.overBar}`,
    );

    /**
     * The two programs cannot be text-identical: each is a raster laid over its own tessellation,
     * so an edge that sits within half a cell of a raster row resolves to one side in one file
     * and the other side in the other. The ties sit at the same TWO places they always did:
     *
     *  - the dome, where the rough pass's "surface + 0.3 mm" contour crosses the stock top and a
     *    raster row lands on opposite sides of the tessellated cap. #889 — the rough's level
     *    stretches and the finish's level floor are now merged into single moves, so a tie there
     *    moves the END of a level run; that end is where the cap first comes under the cutter's
     *    disc, so the zone reaches one cutter diameter past the rim (`inDomeZone`). All 224
     *    multiplicity differences are rough G1 moves on the dome, where a run ends or a crossing
     *    turns one cell over;
     *  - the rounded corner's vertical wall, which the finish clears as a full-depth column at one
     *    raster row: y = 38.7 in one file, y = 39.2 in the other.
     *
     * At every XY both programs visit exactly once (9,559 of them) the posted Z agrees to at most
     * 0.019 mm — the STEP's own dome sag — and never past the 0.05 bar. The assertion below is that
     * equivalence, not byte identity. #889 re-pinned the counts: merged level runs and the rough's
     * crossings of finished points take each program from about 1.2 M moves to about 13,500.
     */
    expect(a.moves).toBe(13_496);
    expect(b.moves).toBe(13_596);
    expect(a.moves - b.moves).toBe(-100);
    expect(cmp.sharedUnique).toBe(9_559);
    expect(cmp.identicalZ).toBe(1_033);
    expect(cmp.maxDz).toBeCloseTo(0.019, 4);
    expect(cmp.maxDzKey).toBe('1|G1|52.900|18.500');
    expect(cmp.overBar).toBe(0);
    expect(cmp.maxDz).toBeLessThanOrEqual(bar);

    // Both files post the same two toolpaths, and only those.
    const classes = (program: Program): string[] =>
      [...new Set([...program.visits.values()].map((v) => `${v.pass}|${v.rapid ? 'G0' : 'G1'}`))].sort();
    expect(classes(a)).toEqual(['1|G0', '1|G1', '2|G0', '2|G1']);
    expect(classes(b)).toEqual(['1|G0', '1|G1', '2|G0', '2|G1']);

    // Every key either program has and the other lacks, or visits a different number of times,
    // sits at one of the two inspected places.
    const differing = [...cmp.onlyA, ...cmp.onlyB, ...cmp.multiplicity.map((m) => m.key)];
    for (const key of differing) {
      const p = keyParts(key);
      expect(zoneOf(p.x, p.y), key).not.toBe('other');
    }
    expect(cmp.onlyA.length).toBe(208);
    expect(cmp.onlyB.length).toBe(310);
    expect(cmp.multiplicity).toHaveLength(224);
    for (const m of cmp.multiplicity) {
      const p = keyParts(m.key);
      expect(p.pass, m.key).toBe(1);
      expect(p.rapid, m.key).toBe(false);
      expect(zoneOf(p.x, p.y), m.key).toBe('dome');
    }
    const corner = differing.filter((key) => {
      const p = keyParts(key);
      return zoneOf(p.x, p.y) === 'corner';
    });
    expect(corner.sort()).toEqual(['2|G0|59.995|38.700', '2|G0|59.995|39.200', '2|G1|59.995|38.700', '2|G1|59.995|39.200']);
  });

  it('sweeps both programs to the same goal surface inside the oracle band', async () => {
    const run = await loadRun();
    if (run.a.generated.nc === null || run.b.generated.nc === null) throw new Error('a goal job posted no program');
    const fieldA = sweep(run.a.generated.nc, run.a.job);
    const fieldB = sweep(run.b.generated.nc, run.b.job);

    const grid = (f: FlatField): number[] => [f.u0, f.v0, f.du, f.dv, f.nu, f.nv];
    expect(grid(fieldA)).toEqual(grid(fieldB));
    expect(fieldA.nu).toBe(612);
    expect(fieldA.nv).toBe(412);
    expect(fieldA.du).toBeCloseTo(0.1, 9);
    expect(fieldA.dv).toBeCloseTo(0.1, 9);
    expect(fieldA.top.length).toBe(fieldA.nu * fieldA.nv);
    console.log(`swept grid: ${fieldA.nu} x ${fieldA.nv} at ${fieldA.du} mm from (${fieldA.u0}, ${fieldA.v0})`);

    // Compare the two swept tops. Inside the stock's footprint the only place over the bar is the
    // rounded corner's wall; outside it the columns are tool positions, not material.
    let cells = 0;
    let insideMax = 0;
    let insideOver = 0;
    let outsideOver = 0;
    let awayMax = 0;
    let awayOver = 0;
    const over: Array<{ x: number; y: number; d: number }> = [];
    for (let j = 0; j < fieldA.nv; j += 1) {
      const y = fieldA.v0 + j * fieldA.dv;
      for (let i = 0; i < fieldA.nu; i += 1) {
        const x = fieldA.u0 + i * fieldA.du;
        const d = Math.abs(fieldA.top[j * fieldA.nu + i]! - fieldB.top[j * fieldA.nu + i]!);
        if (!Number.isFinite(d)) continue;
        cells += 1;
        const inside = x >= 0 && x <= 60 && y >= 0 && y <= 40;
        const away = x < 59.5 || y < 38;
        if (inside) {
          insideMax = Math.max(insideMax, d);
          if (d > bar) insideOver += 1;
        } else if (d > bar) {
          outsideOver += 1;
        }
        if (away) {
          awayMax = Math.max(awayMax, d);
          if (d > bar) awayOver += 1;
        }
        if (d > bar) over.push({ x, y, d });
      }
    }
    console.log(
      `swept tops: ${cells} cells; inside the stock max |d| ${insideMax.toFixed(9)} mm; ` +
        `away from the corner (x < 59.5 or y < 38) max |d| ${awayMax.toFixed(9)} mm; ` +
        `cells over ${bar} mm: ${over.length} (${insideOver} inside the stock, ${outsideOver} outside)`,
    );

    // Away from the rounded corner's wall the two sweeps agree to 0.019 mm — the STEP's own dome
    // sag — with no cell past the bar. That is the same-result claim the rest of the part gets.
    expect(cells).toBe(612 * 412);
    expect(awayMax).toBeCloseTo(0.019, 4);
    expect(awayOver).toBe(0);
    expect(awayMax).toBeLessThanOrEqual(bar);

    // The corner tie: 50 cells over the bar, all in the wall band. The 25 inside the stock are the
    // rough pass's 0.3 mm leave left standing where the finish's row moved; the 25 outside carry
    // no material. Both are the same tie the program comparison pinned above.
    expect(insideMax).toBeCloseTo(0.3, 5);
    expect(insideMax).toBeGreaterThan(0.29);
    expect(insideOver).toBe(25);
    expect(outsideOver).toBe(25);
    expect(over.length).toBe(50);
    const bx = [Math.min(...over.map((c) => c.x)), Math.max(...over.map((c) => c.x))];
    const by = [Math.min(...over.map((c) => c.y)), Math.max(...over.map((c) => c.y))];
    expect(bx[0]).toBeCloseTo(59.55, 3);
    expect(bx[1]).toBeCloseTo(60.45, 3);
    expect(by[0]).toBeCloseTo(38.25, 3);
    expect(by[1]).toBeCloseTo(38.95, 3);
    for (const cell of over) {
      expect(cell.x >= 59.5 && cell.y >= 38, `${cell.x},${cell.y}`).toBe(true);
    }

    // The oracle's own measure, both sweeps judged against the SAME fine 3MF goal at the same
    // 0.05 mm band. The 3MF's finer tessellation reaches 13.25 mm² more of the 4,490 mm² of
    // judged surface (the bottom faces away and is excluded); the fraction gap is 0.001926.
    const goal = sampleGoalHeightfield(run.b.target, { stockTopZ: 0, pitchMm: 0.1 });
    const goalMesh = workMesh(run.b.target);
    const coverage = (field: FlatField): ReturnType<typeof goalCoverage> =>
      goalCoverage(goalMesh, goal, resultTopOf(field), { reachedMm: bar });
    const covA = coverage(fieldA);
    const covB = coverage(fieldB);
    const describe = (label: string, c: ReturnType<typeof goalCoverage>): string =>
      `${label} coverage: fraction ${c.fraction.toFixed(6)}, reached ${c.reachedAreaMm2.toFixed(3)} mm², ` +
      `missed ${c.missedAreaMm2.toFixed(3)} mm², away ${c.facingAwayAreaMm2.toFixed(3)} mm²`;
    console.log(describe('STEP', covA));
    console.log(describe('3MF ', covB));

    expect(covA.fraction).toBeCloseTo(0.63035, 5);
    expect(covB.fraction).toBeCloseTo(0.62842, 5);
    expect(Math.abs(covA.fraction - covB.fraction)).toBeLessThanOrEqual(0.005);
    expect(covA.missedAreaMm2).toBeCloseTo(151.994, 2);
    expect(covB.missedAreaMm2).toBeCloseTo(165.247, 2);
    expect(covA.facingAwayAreaMm2).toBeCloseTo(2392.073, 2);
    expect(covB.facingAwayAreaMm2).toBeCloseTo(2392.073, 2);
  }, 300_000);
});
