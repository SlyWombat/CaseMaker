/**
 * The exact 2.5D sweep (#182 step 5, `/Simulation.md` §3.2, §4.3).
 *
 * For a flat end mill at constant Z the swept volume of one straight move is a capsule —
 * a disc at each end and the rectangle between — extruded from that Z up through the top
 * of the stock. Per checkpoint (one segment, one quantised Z) the capsules are unioned in
 * 2D, simplified, extruded once, and the resulting solids are subtracted from the stock.
 * That is exact, with no sampled grid; it is what V1 needs (`/Simulation.md` §4.5 says
 * where it stops being the right answer).
 *
 * Measured, not estimated (`/Simulation.md` §4): the 2D union is done as CHUNKS of 64
 * contours reduced by an 8-WAY TREE with `simplify` at every level. A single call over all
 * contours is markedly slower on a real pocketing load, and `simplify` before extruding
 * stops the 3D stage growing with contour count.
 *
 * Two traps this file exists to not repeat, both from the adversarial reviews:
 *   - WINDING. The capsule's rectangle must be wound the same way as its end discs
 *     (counter-clockwise). A clockwise rectangle against counter-clockwise discs CANCELS
 *     under the 'Positive' fill rule and a capsule silently becomes half a disc: the first
 *     benchmark of this design was taken on exactly that. `capsuleContours` is asserted
 *     against the closed form `2rL + (n/2) r^2 sin(2π/n)` in its spec, FIRST.
 *   - LAZY EVALUATION. Manifold booleans are lazy; a timing that does not force a result
 *     (`volume()`, `numTri()`) times nothing. The stats here force every stage.
 *
 * This module runs in the geometry worker beside `executeProfile` and takes the Manifold
 * toplevel the same way `evaluateOp` does. Everything it is given is plain data.
 */

import type { Timeline, Checkpoint } from '@/engine/cnc/emulator/timeline';
import { partToWork } from '@/engine/cnc/frames';
import type { Setup } from '@/engine/cnc/setup';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM, segmentsForRadius } from '@/engine/compiler/arcResolution';
import { executeProfile, type ManifoldToplevel } from './evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;
type Polygon = [number, number][];

/** Capsules per 2D union chunk. Measured to be the right order; see /Simulation.md §4.3. */
export const CHUNK = 64;
/** Fan-in of the union tree. */
export const FANOUT = 8;
/** Extrusions overshoot the stock top so the subtraction has no coplanar face to argue about. */
export const OVERSHOOT_MM = 0.01;

export interface SweepDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  checkpoint?: number;
}

export interface SweepStats {
  stockVolume: number;
  resultVolume: number;
  removedVolume: number;
  checkpointsSwept: number;
  checkpointsSkipped: number;
  contours: number;
  ms: { union2d: number; extrude: number; subtract: number; total: number };
}

export interface SweepResult {
  /** The stock in WORK coordinates, before any cut. */
  stock: ManifoldInstance;
  /** Work-frame Z of the stock's top face. */
  stockTopZ: number;
  /** Everything removed, as one solid; null if nothing was. */
  removal: ManifoldInstance | null;
  /** `stock − removal`. */
  result: ManifoldInstance;
  /** One solid per timeline checkpoint, in order; null where the checkpoint removed nothing. Playback scrubs on these. */
  perCheckpoint: (ManifoldInstance | null)[];
  radius: number;
  stats: SweepStats;
  diagnostics: SweepDiagnostic[];
}

export type SweepOutcome = { ok: true; value: SweepResult } | { ok: false; diagnostics: SweepDiagnostic[] };

/** A counter-clockwise n-gon inscribed in the circle of radius r about (cx, cy). */
export function circlePolygon(cx: number, cy: number, r: number, n: number): Polygon {
  const p: Polygon = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return p;
}

/**
 * The contours of one move's swept area: a disc at each end and, for a move of nonzero
 * length, the rectangle between them. ALL COUNTER-CLOCKWISE (see the file comment). A
 * zero-length move (a plunge) is the disc alone.
 */
export function capsuleContours(x0: number, y0: number, x1: number, y1: number, r: number, n: number, out: Polygon[]): void {
  out.push(circlePolygon(x1, y1, r, n));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  out.push(circlePolygon(x0, y0, r, n));
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  // Right-hand side of the direction of travel first, then the left: counter-clockwise.
  out.push([
    [x0 - nx, y0 - ny],
    [x1 - nx, y1 - ny],
    [x1 + nx, y1 + ny],
    [x0 + nx, y0 + ny],
  ]);
}

/** Exact area of a capsule built by `capsuleContours`: rectangle plus one inscribed n-gon disc. */
export function capsuleArea(length: number, r: number, n: number): number {
  return 2 * r * length + (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
}

/**
 * Union a checkpoint's capsules into one region: chunks of CHUNK contours, each simplified,
 * reduced by a FANOUT-way tree with simplify at every level. Returns null for no contours.
 */
export function unionCapsules(tl: ManifoldToplevel, polys: Polygon[]): CrossSectionInstance | null {
  const CS = tl.CrossSection;
  if (polys.length === 0) return null;
  let level: CrossSectionInstance[] = [];
  for (let i = 0; i < polys.length; i += CHUNK) {
    const raw = CS.ofPolygons(polys.slice(i, i + CHUNK), 'Positive');
    level.push(raw.simplify(SWEEP_SIMPLIFY_EPS_MM));
    raw.delete();
  }
  while (level.length > 1) {
    const next: CrossSectionInstance[] = [];
    for (let i = 0; i < level.length; i += FANOUT) {
      const group = level.slice(i, i + FANOUT);
      if (group.length === 1) {
        next.push(group[0] as CrossSectionInstance);
        continue;
      }
      const u = CS.union(group);
      const s = u.simplify(SWEEP_SIMPLIFY_EPS_MM);
      u.delete();
      for (const g of group) g.delete();
      next.push(s);
    }
    level = next;
  }
  return level[0] as CrossSectionInstance;
}

/** The stock, in WORK coordinates, from the setup's part. V1: prisms only. */
export function stockFromSetup(tl: ManifoldToplevel, setup: Setup): { stock: ManifoldInstance; topZ: number } | SweepDiagnostic {
  const part = setup.part;
  if (part.kind !== 'prism') {
    return { severity: 'error', code: 'stock-unsupported', message: `V1 sweeps a prism stock only; the setup's part is a ${part.kind}` };
  }
  if (!(part.thickness > 0)) {
    return { severity: 'error', code: 'stock-invalid', message: `stock thickness must be positive, got ${part.thickness}` };
  }
  const cs = executeProfile(tl, part.outline);
  const inPart = tl.Manifold.extrude(cs, part.thickness);
  cs.delete();
  const origin = partToWork(setup, [0, 0, 0]);
  const rotated = inPart.rotate([0, 0, setup.placement.rotationZ]);
  inPart.delete();
  const stock = rotated.translate([origin[0], origin[1], origin[2]]);
  rotated.delete();
  const bb = stock.boundingBox();
  return { stock, topZ: bb.max[2] };
}

function isDiag(x: unknown): x is SweepDiagnostic {
  return typeof x === 'object' && x !== null && 'severity' in x && 'code' in x;
}

/** The 2D region one checkpoint removes, or null. Exposed so the oracle (§7) can compare it. */
export function checkpointRegion(tl: ManifoldToplevel, cp: Checkpoint, radius: number): { region: CrossSectionInstance | null; contours: number } {
  const n = segmentsForRadius(radius);
  const polys: Polygon[] = [];
  for (let i = 0; i + 3 < cp.xy.length; i += 4) {
    capsuleContours(cp.xy[i] as number, cp.xy[i + 1] as number, cp.xy[i + 2] as number, cp.xy[i + 3] as number, radius, n, polys);
  }
  return { region: unionCapsules(tl, polys), contours: polys.length };
}

/**
 * Sweep a whole timeline against the setup's stock with the given tool.
 *
 * Refuses (rather than approximating) a non-flat tool, an unsupported stock, and an empty
 * program. Diagnostics name the checkpoint. The caller owns every Manifold in the result and
 * must `delete()` them.
 */
export function sweepTimeline(tl: ManifoldToplevel, timeline: Timeline, tool: Tool, setup: Setup): SweepOutcome {
  const diagnostics: SweepDiagnostic[] = [];
  const rr = cuttingRadiusForSweep(tool);
  if (!rr.ok) return { ok: false, diagnostics: [{ severity: 'error', code: 'tool-refused', message: rr.reason }] };
  const radius = rr.radius;

  const st = stockFromSetup(tl, setup);
  if (isDiag(st)) return { ok: false, diagnostics: [st] };
  const { stock, topZ } = st;

  const t0 = performance.now();
  let msUnion = 0;
  let msExtrude = 0;
  let contours = 0;
  let skipped = 0;
  const perCheckpoint: (ManifoldInstance | null)[] = [];
  const solids: ManifoldInstance[] = [];

  timeline.checkpoints.forEach((cp, idx) => {
    // A checkpoint at or above the top of the stock removes nothing: the vendor's rotary files
    // feed at Z = +30 over a cylinder, and a stub prism has nothing there.
    if (cp.z >= topZ) {
      perCheckpoint.push(null);
      skipped++;
      return;
    }
    const a = performance.now();
    const { region, contours: c } = checkpointRegion(tl, cp, radius);
    contours += c;
    msUnion += performance.now() - a;
    if (!region) {
      perCheckpoint.push(null);
      skipped++;
      return;
    }
    const b = performance.now();
    const height = topZ - cp.z + OVERSHOOT_MM;
    const column = tl.Manifold.extrude(region, height);
    region.delete();
    const solid = column.translate([0, 0, cp.z]);
    column.delete();
    // Force evaluation so the timing is real (Manifold is lazy).
    void solid.numTri();
    msExtrude += performance.now() - b;
    perCheckpoint.push(solid);
    solids.push(solid);
    if (cp.nonConstantZ) {
      diagnostics.push({ severity: 'info', code: 'ramp-over-removed', checkpoint: idx, message: `checkpoint ${idx} has moves that change Z; swept at its lowest Z, which removes more than the machine would (/Simulation.md §3.2)` });
    }
  });

  const c0 = performance.now();
  let removal: ManifoldInstance | null = null;
  let result: ManifoldInstance;
  if (solids.length > 0) {
    removal = solids.length === 1 ? (solids[0] as ManifoldInstance) : tl.Manifold.union(solids);
    result = stock.subtract(removal);
  } else {
    result = stock;
  }
  const stockVolume = stock.volume();
  const resultVolume = result.volume();
  const msSubtract = performance.now() - c0;

  if (timeline.checkpoints.length === 0) {
    diagnostics.push({ severity: 'warning', code: 'nothing-to-sweep', message: 'the program has no cutting moves at a known position' });
  }
  if (timeline.summary.unsweptMoves > 0) {
    diagnostics.push({ severity: 'warning', code: 'gaps', message: `${timeline.summary.unsweptMoves} cutting move(s) could not be placed and are missing from the picture` });
  }

  return {
    ok: true,
    value: {
      stock,
      stockTopZ: topZ,
      removal,
      result,
      perCheckpoint,
      radius,
      stats: {
        stockVolume,
        resultVolume,
        removedVolume: stockVolume - resultVolume,
        checkpointsSwept: solids.length,
        checkpointsSkipped: skipped,
        contours,
        ms: { union2d: msUnion, extrude: msExtrude, subtract: msSubtract, total: performance.now() - t0 },
      },
      diagnostics,
    },
  };
}

/** The resolution facts a consumer needs to size an oracle band (/Simulation.md §7). */
export const SWEEP_TOLERANCES = {
  chord: ARC_CHORD_TOLERANCE_MM,
  simplify: SWEEP_SIMPLIFY_EPS_MM,
  /** Worst-case simplify drift: one simplify per chunk plus one per tree level. */
  simplifyLevels: (contours: number): number => 1 + Math.max(0, Math.ceil(Math.log(Math.max(1, Math.ceil(contours / CHUNK))) / Math.log(FANOUT))),
};
