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

import type { Timeline, Checkpoint, AirMove } from '@/engine/cnc/emulator/timeline';
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
/**
 * How close a spindle-off move may come to the material or the bed before it is a fault
 * (the maintainer's rule, 2026-10-03: "unless getting near the material or vise/clamps/bed").
 * Applied around the tool's radius and above and below the move's Z.
 */
export const PROXIMITY_MARGIN_MM = 1.0;
/** Air moves checked individually; beyond this a job is summarised instead (each is a boolean). */
export const MAX_AIR_CHECKS = 4000;

export interface SweepDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  checkpoint?: number;
}

export interface SweepStats {
  airMovesChecked: number;
  /** Air moves that met the uncut blank and were re-tested against the stock-so-far. */
  airMovesRechecked: number;
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
 * Check the moves that cut nothing but can still be wrong (`/Simulation.md` §7.1):
 *
 *   rapid             through material, or below the bed             -> error
 *   feed, spindle off within PROXIMITY_MARGIN_MM of material or bed  -> error (the rule)
 *
 * "Material" means THE STOCK AS IT IS AT THAT STEP, not the uncut blank. The first version
 * tested against the uncut blank and flagged every retract in a real vendor job: a `G0 Z2`
 * from the end of a cut starts 0.3 mm deep in the hole the tool has just made, and 169 of
 * 169 errors on `ACRYLIC-Balloon.nc` were exactly that. A rapid down into a pocket cut by an
 * EARLIER pass is routine; one into a pocket that will only be cut LATER is a crash. Order
 * is the whole question, so the check is time-ordered.
 *
 * Cost: every air move gets one cheap boolean against the uncut stock, and only a HIT is
 * re-tested against the stock minus everything cut before that step. That removal is built
 * from per-checkpoint PREFIXES (the bucket's capsules with step < k), which only ever grow
 * because air moves are visited in program order, so each capsule is unioned once.
 *
 * NOT checked: the fixture — its solids do not exist yet (#188); said in a diagnostic.
 */
export function checkAirMoves(
  tl: ManifoldToplevel,
  stock: ManifoldInstance,
  topZ: number,
  bedZ: number,
  moves: AirMove[],
  checkpoints: Checkpoint[],
  radius: number,
): { diagnostics: SweepDiagnostic[]; checked: number; rechecked: number } {
  const diagnostics: SweepDiagnostic[] = [];
  const nCap = segmentsForRadius(radius);
  const nMargin = segmentsForRadius(radius + PROXIMITY_MARGIN_MM);
  let checked = 0;
  let rechecked = 0;

  // Per-checkpoint prefixes: the part of each bucket cut before the step being examined.
  interface Prefix { cp: Checkpoint; next: number; region: CrossSectionInstance | null; solid: ManifoldInstance | null; dirty: boolean }
  const prefixes: Prefix[] = checkpoints.filter((cp) => cp.z < topZ).map((cp) => ({ cp, next: 0, region: null, solid: null, dirty: false }));
  // A holder, not two `let`s: TypeScript narrows a `let x: T | null = null` to `null` across a
  // closure's assignments, and the cleanup below then cannot call `.delete()` on it.
  const held: { removed: ManifoldInstance | null; dirty: boolean } = { removed: null, dirty: false };

  /** Everything cut before `step`, as one solid, or null if nothing was. */
  const removedBefore = (step: number): ManifoldInstance | null => {
    for (const pf of prefixes) {
      const polys: Polygon[] = [];
      while (pf.next < pf.cp.steps.length && (pf.cp.steps[pf.next] as number) < step) {
        const q = pf.next * 4;
        capsuleContours(pf.cp.xy[q] as number, pf.cp.xy[q + 1] as number, pf.cp.xy[q + 2] as number, pf.cp.xy[q + 3] as number, radius, nCap, polys);
        pf.next++;
      }
      if (polys.length === 0) continue;
      const slice = unionCapsules(tl, polys) as CrossSectionInstance;
      if (pf.region) {
        const u = tl.CrossSection.union([pf.region, slice]);
        const s = u.simplify(SWEEP_SIMPLIFY_EPS_MM);
        u.delete();
        pf.region.delete();
        slice.delete();
        pf.region = s;
      } else {
        pf.region = slice;
      }
      pf.dirty = true;
    }
    for (const pf of prefixes) {
      if (!pf.dirty || !pf.region) continue;
      pf.solid?.delete();
      const col = tl.Manifold.extrude(pf.region, topZ - pf.cp.z + OVERSHOOT_MM);
      pf.solid = col.translate([0, 0, pf.cp.z]);
      col.delete();
      pf.dirty = false;
      held.dirty = true;
    }
    if (held.dirty) {
      held.removed?.delete();
      const solids = prefixes.map((pf) => pf.solid).filter((x): x is ManifoldInstance => x !== null);
      // NEVER alias a prefix's own solid: it is deleted on rebuild and again at cleanup, and a
      // shared wasm handle deleted twice throws "instance already deleted". A single solid is
      // cloned (a zero translate is a new handle); several are unioned into a new one.
      held.removed = solids.length === 0 ? null : solids.length === 1 ? (solids[0] as ManifoldInstance).translate([0, 0, 0]) : tl.Manifold.union(solids);
      held.dirty = false;
    }
    return held.removed;
  };

  for (const mv of moves) {
    if (checked >= MAX_AIR_CHECKS) {
      diagnostics.push({ severity: 'warning', code: 'air-moves-unchecked', message: `${moves.length - checked} air move(s) not checked: more than ${MAX_AIR_CHECKS} in the job` });
      break;
    }
    checked++;
    const spindleOff = mv.kind === 'feed-spindle-off';
    const margin = spindleOff ? PROXIMITY_MARGIN_MM : 0;
    const zLo = Math.min(mv.from[2], mv.to[2]) - margin;
    const zHi = Math.max(mv.from[2], mv.to[2]) + margin;
    if (zLo < bedZ) {
      diagnostics.push(
        spindleOff
          ? { severity: 'error', code: 'spindle-off-near-bed', message: `line ${mv.line}: a feed move with the spindle off within ${PROXIMITY_MARGIN_MM} mm of the bed` }
          : { severity: 'error', code: 'rapid-below-bed', message: `line ${mv.line}: a rapid to Z ${Math.min(mv.from[2], mv.to[2]).toFixed(3)}, below the bed at ${bedZ.toFixed(3)}` },
      );
      continue;
    }
    if (zLo >= topZ) continue; // entirely above the blank: nothing to hit
    const polys: Polygon[] = [];
    capsuleContours(mv.from[0], mv.from[1], mv.to[0], mv.to[1], radius + margin, spindleOff ? nMargin : nCap, polys);
    const region = tl.CrossSection.ofPolygons(polys, 'Positive');
    const col = tl.Manifold.extrude(region, Math.max(zHi - zLo, 1e-6));
    region.delete();
    const placed = col.translate([0, 0, zLo]);
    col.delete();
    const hit = placed.intersect(stock);
    placed.delete();
    // The noise floor: a boundary mismatch of (chord error + simplify drift) along the move's
    // capsule perimeter, over its Z span, is the largest volume numerical slivers can reach.
    // Below it, "overlap" is polygons disagreeing to the bit, not material: five retracts in a
    // real vendor job left 0.000 mm³ of it where a cut ended on an arc segment. A genuine graze
    // 0.05 mm deep over the same move is an order of magnitude above this floor.
    const length = Math.hypot(mv.to[0] - mv.from[0], mv.to[1] - mv.from[1]);
    const perimeter = 2 * length + 2 * Math.PI * (radius + margin);
    const levels = SWEEP_TOLERANCES.simplifyLevels(checkpoints.reduce((a, cp) => Math.max(a, cp.steps.length * 3), 0));
    const floor = (ARC_CHORD_TOLERANCE_MM + SWEEP_SIMPLIFY_EPS_MM * (1 + levels)) * perimeter * (zHi - zLo);
    let vol = hit.volume();
    if (vol > floor) {
      // It meets the uncut blank. Does it meet what is STILL there at this step?
      rechecked++;
      const gone = removedBefore(mv.step);
      if (gone) {
        const remaining = hit.subtract(gone);
        vol = remaining.volume();
        remaining.delete();
      }
    }
    hit.delete();
    if (vol > floor) {
      diagnostics.push(
        spindleOff
          ? { severity: 'error', code: 'spindle-off-near-stock', message: `line ${mv.line}: a feed move with the spindle off comes within ${PROXIMITY_MARGIN_MM} mm of material still present at that point in the program` }
          : { severity: 'error', code: 'rapid-through-stock', message: `line ${mv.line}: a rapid passes through material still present at that point in the program (${vol >= 0.01 ? vol.toFixed(3) : vol.toExponential(2)} mm³)` },
      );
    }
  }
  for (const pf of prefixes) {
    pf.region?.delete();
    pf.solid?.delete();
  }
  held.removed?.delete();
  return { diagnostics, checked, rechecked };
}

/**
 * The holder gate (`/Simulation.md` §6): the deepest cut against the tool's shank limit.
 * `shoulderLength` governs; `fluteLength` is the fallback. Makera's catalogue leaves
 * shoulderLength EMPTY for every engraver and chamfer, so when both are missing the answer
 * is "cannot be proven", as a warning — not a silent pass.
 */
export function holderGate(tool: Tool, deepestCutDepth: number | null): SweepDiagnostic | null {
  if (deepestCutDepth === null) return null;
  const limit = tool.shoulderLength ?? tool.fluteLength;
  if (limit === null) {
    return { severity: 'warning', code: 'holder-unproven', message: `the deepest cut is ${deepestCutDepth.toFixed(3)} mm below the stock top and tool "${tool.name}" states no shoulder or flute length: holder clearance cannot be proven` };
  }
  if (deepestCutDepth > limit) {
    return { severity: 'error', code: 'holder-collision', message: `the deepest cut, ${deepestCutDepth.toFixed(3)} mm below the stock top, exceeds tool "${tool.name}"'s ${tool.shoulderLength !== null ? 'shoulder' : 'flute'} length of ${limit} mm: the shank would rub` };
  }
  return null;
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
  if (timeline.summary.laser) return { ok: false, diagnostics: [{ severity: 'error', code: 'laser-job', message: 'this is a laser job (M321): a mill simulation refuses it rather than drawing a cut' }] };
  if (timeline.summary.rotary) return { ok: false, diagnostics: [{ severity: 'error', code: 'rotary-job', message: 'this job moves the A axis: V1 does not simulate rotary work (/Simulation.md §9)' }] };
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

  // The gates that need the stock: holder depth, and the air moves.
  const swept = timeline.checkpoints.filter((cp) => cp.z < topZ);
  const deepest = swept.length ? topZ - Math.min(...swept.map((cp) => cp.z)) : null;
  const hg = holderGate(tool, deepest);
  if (hg) diagnostics.push(hg);
  const bb = stock.boundingBox();
  const air = checkAirMoves(tl, stock, topZ, bb.min[2], timeline.airMoves, timeline.checkpoints, radius);
  diagnostics.push(...air.diagnostics);
  if (setup.workholding.kind !== 'tape-down' && setup.workholding.kind !== 'anchor-bracket') {
    diagnostics.push({ severity: 'info', code: 'fixture-unchecked', message: `the ${setup.workholding.kind} is not modelled as an obstacle yet (#188): proximity to the fixture is NOT checked` });
  }

  const c0 = performance.now();
  let removal: ManifoldInstance | null = null;
  let result: ManifoldInstance;
  // The caller owns `stock`, `result`, `removal` and every `perCheckpoint` entry, and may
  // delete each once. So none of them may alias another wasm handle: a lone checkpoint solid
  // is CLONED into `removal`, and an uncut `result` is a clone of the stock, not the stock.
  if (solids.length > 0) {
    removal = solids.length === 1 ? (solids[0] as ManifoldInstance).translate([0, 0, 0]) : tl.Manifold.union(solids);
    result = stock.subtract(removal);
  } else {
    result = stock.translate([0, 0, 0]);
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
        airMovesChecked: air.checked,
        airMovesRechecked: air.rechecked,
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
