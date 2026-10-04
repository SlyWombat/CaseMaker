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
import { DIAGNOSTIC_CAP } from '@/engine/cnc/emulator/timeline';
import { partToWork } from '@/engine/cnc/frames';
import type { ObstacleBox, Setup } from '@/engine/cnc/setup';
import type { MachineProfile } from '@/engine/cnc/machine';
import { inflate } from '@/engine/cnc/fixture';
import { hasSacrificial, sacrificialBoxes } from '@/engine/cnc/sacrificial';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM, segmentsForRadius } from '@/engine/compiler/arcResolution';
import { executeProfile, type ManifoldToplevel } from './evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;
type Polygon = [number, number][];
type Box = ReturnType<ManifoldInstance['boundingBox']>;

/**
 * Axis-aligned box overlap, TOUCHING COUNTED AS OVERLAPPING (#194). Used to cull the parts a
 * recheck has to subtract: a part that merely touches the move's box must be kept, because
 * culling is only sound in the direction that keeps more.
 */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1] && a.min[2] <= b.max[2] && b.min[2] <= a.max[2];
}

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
/** Gouge solids kept; beyond this a rapid is still reported, just not drawn (memory, and the transfer to the viewport). */
export const MAX_GOUGES = 200;
/**
 * Checkpoints the 2.5D sweep will take on. A program with more causal runs of cuts at one
 * (segment, Z) than this is a 3D or dense job (`/Simulation.md` §4.4, §9): the vendor's
 * fatigue-test.nc has 685 200 and ran the wasm heap out before the first subtraction.
 * (The 108 744 quoted here before 2026-10-04 was the OLD (segment, Z) count, taken before
 * checkpoints became causal runs; recounted with `probe-checkpoints.mts`.) Refused by name,
 * with the count, rather than attempted. A CLASSIFIER, not a timed budget: causal runs are
 * not Z levels — PCB-NO-UV-MASK.nc has 9 distinct Z but 298 runs — and nothing between
 * Balloon's 10 and the refusals has been timed (#182).
 */
export const MAX_CHECKPOINTS = 1000;
/**
 * Below this an intersection with the UNCUT blank is floating-point dust, not material: the
 * blank and the air solid are both exact polygons, so a real overlap is far larger.
 */
export const SLIVER_MM3 = 1e-6;

export interface SweepDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  checkpoint?: number;
}

/** A volume for a diagnostic, in mm³: three decimals for anything a person can see, else exponential. */
export function formatVolume(v: number): string {
  return v >= 0.01 ? v.toFixed(3) : v.toExponential(2);
}

/**
 * Cap repeated diagnostics of one code, exactly as the timeline does (#204): keep the first
 * `DIAGNOSTIC_CAP`, fold the rest into one `<code>-more` line, and remember the worst severity
 * so the fold is never calmer than what it hid. `sweep.ts` had no repeated-code gate before;
 * the fixture checks are the first that can fire once per checkpoint.
 */
class DiagnosticFolder {
  private readonly counts = new Map<string, number>();
  private readonly worst = new Map<string, SweepDiagnostic['severity']>();
  private readonly kept: SweepDiagnostic[] = [];
  private static readonly RANK = { info: 0, warning: 1, error: 2 } as const;
  push(d: SweepDiagnostic): void {
    const n = (this.counts.get(d.code) ?? 0) + 1;
    this.counts.set(d.code, n);
    const w = this.worst.get(d.code);
    if (w === undefined || DiagnosticFolder.RANK[d.severity] > DiagnosticFolder.RANK[w]) this.worst.set(d.code, d.severity);
    if (n <= DIAGNOSTIC_CAP) this.kept.push(d);
  }
  finish(): SweepDiagnostic[] {
    const out = this.kept.slice();
    for (const [code, n] of this.counts) {
      if (n > DIAGNOSTIC_CAP) {
        out.push({ severity: this.worst.get(code) ?? 'info', code: `${code}-more`, message: `…and ${n - DIAGNOSTIC_CAP} more '${code}' (${n} in all)` });
      }
    }
    return out;
  }
}

export interface SweepStats {
  airMovesChecked: number;
  /** Air moves that met the uncut blank and were re-tested against the stock-so-far. */
  airMovesRechecked: number;
  /**
   * Air moves proved in air analytically, with no boolean at all (#194 step 7): a rapid that
   * leaves X and Y alone and moves only +Z out of the exact end point of the immediately
   * preceding cutting move. The extremely common `G0 Z<n>` retract.
   */
  airMovesClearedByConstruction: number;
  stockVolume: number;
  resultVolume: number;
  /** Volume removed from the PART. Kept under its old name for existing consumers; equals `removedFromPart`. */
  removedVolume: number;
  /** Volume removed from the part body (#213), intersected with the part stock. */
  removedFromPart: number;
  /** Volume removed from the sacrificial body (#213); 0 when the job has none. */
  removedFromSacrificial: number;
  checkpointsSwept: number;
  checkpointsSkipped: number;
  contours: number;
  ms: { union2d: number; extrude: number; subtract: number; airCheck: number; total: number };
}

/**
 * A rapid that passes through material still present at that step (`/Simulation.md` §9 q5).
 * It is NEVER subtracted from the stock — the picture does not show the machine eating the
 * part — but the solid it would have removed is kept, so the viewport can draw it. Work
 * frame; caller-owned exactly like `perCheckpoint`.
 */
export interface Gouge {
  step: number;
  line: number;
  /** The tool body swept along the rapid, intersected with the stock as it was at `step`. */
  solid: ManifoldInstance;
}

export interface SweepResult {
  /** The stock in WORK coordinates, before any cut. */
  stock: ManifoldInstance;
  /**
   * The sacrificial material as one solid, WORK coordinates, before any cut (#213 §4); null
   * when the job has none. A materialised LEAF, safe to subtract from on every playback seek.
   * Caller-owned exactly like `stock`: delete it once.
   */
  sacrificial: ManifoldInstance | null;
  /** Work-frame Z of the stock's top face. */
  stockTopZ: number;
  /** Everything removed, as one solid; null if nothing was. */
  removal: ManifoldInstance | null;
  /** `stock − removal`. */
  result: ManifoldInstance;
  /** One solid per timeline checkpoint, in order; null where the checkpoint removed nothing. Playback scrubs on these. */
  perCheckpoint: (ManifoldInstance | null)[];
  /** One per rapid-through-stock diagnostic, up to `MAX_GOUGES`; caller-owned, delete each once. */
  gouges: Gouge[];
  radius: number;
  stats: SweepStats;
  diagnostics: SweepDiagnostic[];
}

export type SweepOutcome = { ok: true; value: SweepResult } | { ok: false; diagnostics: SweepDiagnostic[] };

/** A sweep that must not run forever (#194). */
export interface SweepOpts {
  /**
   * Wall clock in ms, counted from the start of the checkpoint loop. Checked between
   * checkpoints and between air-move rechecks — the finest grain a synchronous wasm call
   * allows, so this is an early exit, not a hard bound on a single call. The HARD bound is
   * the client's timer, which terminates the worker (#194).
   */
  budgetMs?: number;
  /** Once per checkpoint, after its solid is built. `done` runs 1…total. */
  onProgress?: (done: number, total: number) => void;
  /**
   * The machine in use (#204). Its `holder` is the collet nut above the cutter, needed for the
   * holder-into-fixture check. Absent, or `holder: null`, means the nut is unmeasured — the
   * sweep says clearance "cannot be proven" rather than guessing a cylinder.
   */
  machine?: MachineProfile;
}

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
 * The tool's body — a flat end mill is a cylinder from its tip up — swept along one straight
 * move, EXACTLY: the swept volume of a convex solid along a segment is the convex hull of
 * its two end placements. Each end's cylinder rises to `zTop`, which is above every point of
 * interest (the stock top plus the overshoot), so the hull covers the tool everywhere it is
 * below the top; whatever it covers above the top is harmless, because every consumer
 * intersects the result with the stock.
 *
 * This replaces the first version's capsule prism from the move's lowest Z to its highest,
 * which was wrong in both directions: a diagonal descent into a pocket was tested as if the
 * tool were at its final depth along the WHOLE move (a false crash), and a horizontal move
 * was a 1 µm sheet with a zero noise floor (false slivers). Both ends `null`-free.
 */
export function sweptToolBody(
  tl: ManifoldToplevel,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  radius: number,
  n: number,
  zTop: number,
): ManifoldInstance {
  const cylAt = (x: number, y: number, z: number): ManifoldInstance => {
    const c = tl.Manifold.cylinder(Math.max(zTop - z, 1e-6), radius, radius, n, false);
    const placed = c.translate([x, y, z]);
    c.delete();
    return placed;
  };
  const a = cylAt(from[0], from[1], from[2]);
  if (from[0] === to[0] && from[1] === to[1] && from[2] === to[2]) return a;
  const b = cylAt(to[0], to[1], to[2]);
  const h = tl.Manifold.hull([a, b]);
  a.delete();
  b.delete();
  return h;
}

/**
 * An `ObstacleBox` as a Manifold, in the WORK frame (#204). The caller owns and deletes it.
 * Used both for the inflated fixture solids the sweep tests against, and — un-inflated, by the
 * session — for the boxes the viewport draws where the user said the jaws are.
 */
export function boxSolid(tl: ManifoldToplevel, box: ObstacleBox): ManifoldInstance {
  const size: [number, number, number] = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const c = tl.Manifold.cube(size, false);
  const placed = c.translate(box.min);
  c.delete();
  return placed;
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
 * A move that is provably in air is not tested at all (#194 step 7): a retract straight up out
 * of the cut just made — same X,Y, +Z, the immediately preceding event being that cut — is
 * counted in `airMovesClearedByConstruction` and skipped before any tool body is built. On the
 * vendor files this is most of the air moves, because the vendor retracts after every cut
 * (`G0 Z<n>`), and each was one boolean against the accumulated removal.
 *
 * Cost (#194, measured): every OTHER air move gets one boolean against the uncut stock, and
 * only a HIT is re-tested against the removal that can reach it. That removal is built from
 * per-checkpoint PREFIXES (the moves with step < k), which only ever grow because air moves
 * are visited in program order. Within a prefix, constant-Z moves are grouped by their OWN Z
 * and swept as 2D capsule columns; a move whose Z changes is swept as the exact hull of the
 * tool at both ends — NOT at the checkpoint's lowest Z, which would credit a ramp with
 * material it has not reached and let a rapid through that material pass.
 *
 * The re-test is LOCAL. The question is "is there still material where THIS ONE MOVE passes",
 * so only the parts whose bounding box overlaps the move can change the answer. Each part
 * records its box when it is made, and the re-test subtracts the union of the overlapping
 * ones alone. What this replaced kept ONE running union of every part and rebuilt it on every
 * recheck, so Manifold re-evaluated the whole program's removal to answer a question about a
 * few cubic millimetres: 6.3 s of Balloon's 7.6 s sweep, and past the 120 s budget on all four
 * files measured in #194. There is no running union now.
 *
 * What that bought, measured 2026-10-04 in one quiet-machine run of the corpus (scripts/
 * sweep-timing.ts, machine Z1, 3.175 mm flat end, outputs left in scripts/sweep-timing-out/
 * 194-after): the air gate is BOUNDED rather than unbounded. Three of the four files that used to
 * run past 120 s now RETURN a sweep — 60.6 s for PCB-NO-UV-MASK (298 checkpoints), 80.0 s for
 * pcb-test-air (912) and 106.8 s for TopClamp (609) — and the fourth, PCB-UV-MASK PART2, still
 * exceeds 120 s inside the air gate. It did NOT make them simulable (the accept bar is 10 s), so
 * the time budget, not this rewrite, is what refuses them. On Balloon it is a wash: 4.2 s against
 * the recorded 4.1 s. On TopClamp the FINAL `Manifold.union(solids)` over all columns is
 * co-dominant at 50.9 s — and TopClamp's air gate costs 54.1 s for only 28 air moves, so there
 * the prefix construction, not the rechecks, is what the gate spends. The playback anchor chain
 * still costs seconds per cold seek (3.2 s and 7.4 s worst on two of the files).
 *
 * One run each: this machine's spread is wide (Balloon's air gate has measured 4.1-6.9 s across
 * runs), so treat these as observations, not tight bounds.
 *
 * NOT checked here: the fixture, when there is none (#204). When `setup.fixture` is present the
 * caller passes the (inflated, unioned) fixture and each move's exact tool body is intersected
 * with it as well — `rapid-into-fixture` / `feed-into-fixture`. `fixtureTop` widens `zTop` so a
 * fixture that rises above the stock top is still covered.
 */
export function checkAirMoves(
  tl: ManifoldToplevel,
  /**
   * The material a move is tested against (#213): the PART body, unioned with the sacrificial
   * body by the caller when the job has one. "Material" still means the stock as it is at that
   * step; a rapid through either body is `rapid-through-stock`.
   */
  stock: ManifoldInstance,
  topZ: number,
  bedZ: number,
  moves: AirMove[],
  checkpoints: Checkpoint[],
  radius: number,
  /** Wall-clock deadline from `performance.now()`, or null for none (#194). */
  deadline: number | null = null,
  /** The fixture obstacles, pre-inflated and unioned, in the work frame (#204). null = none. */
  fixture: ManifoldInstance | null = null,
  /** The fixture's top Z, so the tool body rises far enough. -Infinity when there is none. */
  fixtureTop = Number.NEGATIVE_INFINITY,
  /** Where fixture diagnostics go, so they fold with the checkpoint and holder codes (#204). */
  pushFixture: (d: SweepDiagnostic) => void = () => {},
): { diagnostics: SweepDiagnostic[]; gouges: Gouge[]; checked: number; rechecked: number; cleared: number; budgetExceeded: boolean } {
  const diagnostics: SweepDiagnostic[] = [];
  const gouges: Gouge[] = [];
  const nCap = segmentsForRadius(radius);
  const nMargin = segmentsForRadius(radius + PROXIMITY_MARGIN_MM);
  // Rise to whatever is taller, the stock top or the fixture (#204): a jaw below the top needs
  // no extra height, but a box above it does, or the body would stop short of the collision.
  const zTop = Math.max(topZ, fixtureTop) + OVERSHOOT_MM;
  // "Entirely above everything that can be hit": the stock top, and the fixture when there is one.
  const reachTop = fixture === null ? topZ : Math.max(topZ, fixtureTop);
  // Whether the step-7 retract shortcut (below) is sound for this sweep (#204 follow-up). It is
  // sound while the retract is contained in check (a)'s checkpoint column — and check (a) only
  // tests a column that rises from the stock top, which contains the retract exactly when the
  // fixture's top sits at or below the stock top. A fixture rising above the top is outside that
  // column and can be hit by a retract the shortcut would wave through, so whenever one is
  // present the shortcut is disabled and those rapids take the normal path instead: body built
  // and tested against both stock and fixture. Computed once here, not per move.
  const retractCoveredByColumn = fixture === null || fixtureTop <= topZ;
  let checked = 0;
  let rechecked = 0;
  let cleared = 0;
  let budgetExceeded = false;
  const overBudget = (): boolean => deadline !== null && performance.now() > deadline;

  // #194 step 7. Most air moves are a retract straight up out of the cut just made, and that
  // move needs no geometry: if its IMMEDIATELY PRECEDING event is the cut, it leaves X and Y
  // alone, and it moves only +Z, it travels inside that cut's own removal. The cut's removal is
  // the tool's own cross-section at that X,Y — its constant-Z column, or a ramp's hull —
  // extruded from the cut's Z to above the stock top, and the retract is that same cross-section
  // from there up. So the end point of every swept cutting move is recorded here, keyed by its
  // event index (the same index space as `AirMove.step`); a rapid that lands on one is cleared
  // analytically. This is exact, not the noise floor: it is the fact the floor exists to
  // tolerate, stated once instead of measured through tessellation slivers. It holds only while
  // `retractCoveredByColumn` — see that flag: a fixture above the stock top escapes the column
  // and must be tested like any other obstacle, so the shortcut is then disabled (#204 follow-up).
  const cutEndByStep = new Map<number, readonly [number, number, number]>();
  for (const cp of checkpoints) {
    if (cp.z >= topZ) continue; // not swept: its cuts removed nothing, so they prove nothing
    for (let k = 0; k < cp.steps.length; k++) {
      cutEndByStep.set(cp.steps[k] as number, [cp.xy[k * 4 + 2] as number, cp.xy[k * 4 + 3] as number, cp.zs[k * 2 + 1] as number]);
    }
  }

  // Per-checkpoint prefixes. Constant-Z moves accumulate into one 2D region per distinct Z
  // (`groups`); ramps become individual hull solids. Every solid made here is owned here.
  interface Group { z: number; region: CrossSectionInstance | null; solid: ManifoldInstance | null; box: Box | null; pending: Polygon[] }
  interface Ramp { solid: ManifoldInstance; box: Box }
  interface Prefix { cp: Checkpoint; next: number; groups: Map<number, Group>; ramps: Ramp[] }
  const prefixes: Prefix[] = checkpoints.filter((cp) => cp.z < topZ).map((cp) => ({ cp, next: 0, groups: new Map(), ramps: [] }));
  // Columns replaced by a larger one, and ramp solids: deleted at the end, never now (a lazy
  // subtract may still refer to them until it is forced).
  const retired: ManifoldInstance[] = [];

  /** Bring every prefix up to `step`: every move before it now exists as a part with a box. */
  const advanceTo = (step: number): void => {
    for (const pf of prefixes) {
      const touched: Group[] = [];
      while (pf.next < pf.cp.steps.length && (pf.cp.steps[pf.next] as number) < step) {
        const q = pf.next * 4;
        const x0 = pf.cp.xy[q] as number;
        const y0 = pf.cp.xy[q + 1] as number;
        const x1 = pf.cp.xy[q + 2] as number;
        const y1 = pf.cp.xy[q + 3] as number;
        const z0 = pf.cp.zs[pf.next * 2] ?? pf.cp.z;
        const z1 = pf.cp.zs[pf.next * 2 + 1] ?? pf.cp.z;
        pf.next++;
        if (Math.min(z0, z1) >= topZ) continue;
        if (z0 !== z1 && (x0 !== x1 || y0 !== y1)) {
          const ramp = sweptToolBody(tl, [x0, y0, z0], [x1, y1, z1], radius, nCap, zTop);
          pf.ramps.push({ solid: ramp, box: ramp.boundingBox() });
          continue;
        }
        const z = Math.min(z0, z1);
        const key = Math.round(z * 1000);
        let g = pf.groups.get(key);
        if (!g) {
          g = { z, region: null, solid: null, box: null, pending: [] };
          pf.groups.set(key, g);
        }
        if (g.pending.length === 0) touched.push(g);
        capsuleContours(x0, y0, x1, y1, radius, nCap, g.pending);
      }
      for (const g of touched) {
        const slice = unionCapsules(tl, g.pending) as CrossSectionInstance;
        g.pending = [];
        if (g.region) {
          const u = tl.CrossSection.union([g.region, slice]);
          const s = u.simplify(SWEEP_SIMPLIFY_EPS_MM);
          u.delete();
          g.region.delete();
          slice.delete();
          g.region = s;
        } else {
          g.region = slice;
        }
        const col = tl.Manifold.extrude(g.region, zTop - g.z);
        const solid = col.translate([0, 0, g.z]);
        col.delete();
        // The old column is a subset of the new one, so it can never overlap a move that the
        // new one does not: replacing it cannot lose a hit. Retired, not deleted now — a lazy
        // subtract may still refer to it until it is forced.
        if (g.solid) retired.push(g.solid);
        g.solid = solid;
        g.box = solid.boundingBox();
      }
    }
  };

  /**
   * The parts that exist now whose box could reach `box`. Everything else cannot change the
   * answer, so the subtract below never looks at it. This is the whole of #194's fix: a move
   * crosses a few millimetres, and the parts it can meet are the ones whose boxes it touches.
   */
  const overlapping = (box: Box): ManifoldInstance[] => {
    const out: ManifoldInstance[] = [];
    for (const pf of prefixes) {
      for (const g of pf.groups.values()) if (g.solid && g.box && boxesOverlap(g.box, box)) out.push(g.solid);
      for (const r of pf.ramps) if (boxesOverlap(r.box, box)) out.push(r.solid);
    }
    return out;
  };

  const levels = SWEEP_TOLERANCES.simplifyLevels(checkpoints.reduce((a, cp) => Math.max(a, cp.steps.length * 3), 0));
  for (const mv of moves) {
    if (checked >= MAX_AIR_CHECKS) {
      diagnostics.push({ severity: 'warning', code: 'air-moves-unchecked', message: `${moves.length - checked} air move(s) not checked: more than ${MAX_AIR_CHECKS} in the job` });
      break;
    }
    checked++;
    const spindleOff = mv.kind === 'feed-spindle-off';
    const margin = spindleOff ? PROXIMITY_MARGIN_MM : 0;
    const zLo = Math.min(mv.from[2], mv.to[2]) - margin;
    if (zLo < bedZ) {
      diagnostics.push(
        spindleOff
          ? { severity: 'error', code: 'spindle-off-near-bed', message: `line ${mv.line}: a feed move with the spindle off within ${PROXIMITY_MARGIN_MM} mm of the bed` }
          : { severity: 'error', code: 'rapid-below-bed', message: `line ${mv.line}: a rapid to Z ${Math.min(mv.from[2], mv.to[2]).toFixed(3)}, below the bed at ${bedZ.toFixed(3)}` },
      );
      continue;
    }
    if (zLo >= reachTop) continue; // entirely above the blank AND the fixture: nothing to hit
    // Step 7: a retract straight up out of the cut just made. The immediately preceding event
    // must be that cut (so any other move in between disqualifies it), X and Y must not change,
    // and the move must go +Z. Then it is inside the cut's own removal and needs neither a tool
    // body nor a boolean. Every other move takes the geometric path below. Gated on
    // `retractCoveredByColumn`: the argument needs the retract to stay inside the cut's column,
    // which fails as soon as a fixture rises above the stock top (#204 follow-up).
    if (retractCoveredByColumn && mv.kind === 'rapid' && mv.to[2] > mv.from[2] && mv.to[0] === mv.from[0] && mv.to[1] === mv.from[1]) {
      const end = cutEndByStep.get(mv.step - 1);
      if (end && mv.from[0] === end[0] && mv.from[1] === end[1] && mv.from[2] === end[2]) {
        cleared++;
        continue;
      }
    }
    // The tool body (grown by the margin for the proximity rule) swept along the move.
    const body = sweptToolBody(
      tl,
      [mv.from[0], mv.from[1], mv.from[2] - margin],
      [mv.to[0], mv.to[1], mv.to[2] - margin],
      radius + margin,
      spindleOff ? nMargin : nCap,
      zTop + margin,
    );
    const hit = body.intersect(stock);
    // (b) The same exact tool body against the fixture (#204), before the body is deleted. Both
    // solids are exact — the body a hull of cylinders, the fixture a union of boxes — so
    // anything above float dust is real, no derived floor needed.
    if (fixture !== null) {
      const fhit = body.intersect(fixture);
      const fvol = fhit.volume();
      fhit.delete();
      if (fvol > SLIVER_MM3) {
        pushFixture(
          spindleOff
            ? { severity: 'error', code: 'feed-into-fixture', message: `line ${mv.line}: a feed move with the spindle off drives the tool ${formatVolume(fvol)} mm³ into the fixture` }
            : { severity: 'error', code: 'rapid-into-fixture', message: `line ${mv.line}: a rapid drives the tool ${formatVolume(fvol)} mm³ into the fixture` },
        );
      }
    }
    body.delete();
    let vol = hit.volume();
    // The solid that is actually in the way, for a rapid: what survives the re-test below.
    let gouge: ManifoldInstance | null = null;
    // Against the uncut blank both solids are exact, so anything beyond float dust is real.
    if (vol > SLIVER_MM3) {
      // It meets the uncut blank. Does it meet what is STILL there at this step?
      rechecked++;
      advanceTo(mv.step);
      const reachable = overlapping(hit.boundingBox());
      if (reachable.length > 0) {
        // Only the parts that can reach this move. One part is subtracted directly; several are
        // unioned first, and that temporary union is deleted as soon as the subtract is forced.
        const scope = reachable.length === 1 ? (reachable[0] as ManifoldInstance) : tl.Manifold.union(reachable);
        const remaining = hit.subtract(scope);
        vol = remaining.volume(); // forces evaluation, so `scope` can be deleted here
        if (reachable.length > 1) scope.delete();
        // The noise floor applies HERE, where the removal is a simplified union: a boundary
        // mismatch of (chord error + simplify drift) along the move's footprint perimeter,
        // over the depth the tool PENETRATES the stock, is the largest volume numerical slivers
        // can reach. Below it, "overlap" is polygons disagreeing to the bit, not material. The
        // first version scaled the floor by the move's whole Z span, so a plunge from 5 mm up
        // to 0.3 mm deep had a floor five times its own volume and was never reported.
        const length = Math.hypot(mv.to[0] - mv.from[0], mv.to[1] - mv.from[1]);
        const perimeter = 2 * length + 2 * Math.PI * (radius + margin);
        const penetration = Math.min(topZ, Math.max(mv.from[2], mv.to[2])) - zLo + OVERSHOOT_MM;
        const floor = (ARC_CHORD_TOLERANCE_MM + SWEEP_SIMPLIFY_EPS_MM * (1 + levels)) * perimeter * penetration;
        if (vol <= floor) vol = 0;
        if (vol > 0 && !spindleOff) gouge = remaining;
        else remaining.delete();
      } else if (!spindleOff) {
        // No part that was cut before this move can reach it, so nothing removed the material
        // the move passes through: the whole overlap with the blank is the gouge.
        gouge = hit.translate([0, 0, 0]);
      }
    } else {
      vol = 0;
    }
    hit.delete();
    if (vol > 0) {
      diagnostics.push(
        spindleOff
          ? { severity: 'error', code: 'spindle-off-near-stock', message: `line ${mv.line}: a feed move with the spindle off comes within ${PROXIMITY_MARGIN_MM} mm of material still present at that point in the program` }
          : { severity: 'error', code: 'rapid-through-stock', message: `line ${mv.line}: a rapid passes through material still present at that point in the program (${vol >= 0.01 ? vol.toFixed(3) : vol.toExponential(2)} mm³)` },
      );
    }
    if (gouge) {
      if (vol > 0 && gouges.length < MAX_GOUGES) gouges.push({ step: mv.step, line: mv.line, solid: gouge });
      else gouge.delete();
    }
    // Between rechecks is as fine-grained as this can be: one synchronous call cannot be
    // interrupted from inside, so the client's timer is what bounds a single overrun (#194).
    if (overBudget()) {
      budgetExceeded = true;
      break;
    }
  }
  for (const pf of prefixes) {
    for (const g of pf.groups.values()) {
      g.region?.delete();
      g.solid?.delete();
    }
    for (const r of pf.ramps) r.solid.delete();
  }
  for (const r of retired) r.delete();
  return { diagnostics, gouges, checked, rechecked, cleared, budgetExceeded };
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
 * must `delete()` them — including on the `sweep-budget-exceeded` refusal, which deletes
 * everything it built before it returns (#194).
 */
export function sweepTimeline(tl: ManifoldToplevel, timeline: Timeline, tool: Tool, setup: Setup, opts?: SweepOpts): SweepOutcome {
  const diagnostics: SweepDiagnostic[] = [];
  if (timeline.summary.laser) return { ok: false, diagnostics: [{ severity: 'error', code: 'laser-job', message: 'this is a laser job (M321): a mill simulation refuses it rather than drawing a cut' }] };
  if (timeline.summary.rotary) return { ok: false, diagnostics: [{ severity: 'error', code: 'rotary-job', message: 'this job moves the A axis: V1 does not simulate rotary work (/Simulation.md §9)' }] };
  const rr = cuttingRadiusForSweep(tool);
  if (!rr.ok) return { ok: false, diagnostics: [{ severity: 'error', code: 'tool-refused', message: rr.reason }] };
  const radius = rr.radius;

  if (timeline.checkpoints.length > MAX_CHECKPOINTS) {
    return {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'dense-3d-refused', message: `this program cuts in ${timeline.checkpoints.length} separate runs of cuts at one (segment, Z), more than the ${MAX_CHECKPOINTS} the 2.5D sweep takes on: a 3D or dense job V1 does not simulate (/Simulation.md §4.4, §9)` }],
    };
  }
  const st = stockFromSetup(tl, setup);
  if (isDiag(st)) return { ok: false, diagnostics: [st] };
  const { stock, topZ } = st;

  // The sacrificial material as a SECOND body (#213 §4): the union of the job's boxes, in the
  // work frame, materialised into a true LEAF (a mesh round-trip, the same trick `playback.ts`
  // uses for anchors). A leaf shares nothing with a lazy tree, so the session may subtract from
  // it on every seek without tripping the ONE MANIFOLD TRAP (playback.ts file comment). null
  // when the job has none — and then every path below is byte-for-byte the pre-#213 sweep.
  let sacrificial: ManifoldInstance | null = null;
  if (setup.sacrificial && hasSacrificial(setup.sacrificial)) {
    // The part occupies work X [0, L], Y [0, W], Z [-T, 0] by construction (`stockFromSetup`
    // anchors the top-front-left corner at the work origin). Its bounding box is the stock size
    // the pure `sacrificialBoxes` is expressed against.
    const sb = stock.boundingBox();
    const parts = sacrificialBoxes(
      { length: sb.max[0] - sb.min[0], width: sb.max[1] - sb.min[1], thickness: sb.max[2] - sb.min[2] },
      setup.sacrificial,
    ).map((b) => boxSolid(tl, { id: b.id, label: b.id, min: b.min, max: b.max }));
    const raw = parts.length === 1 ? (parts[0] as ManifoldInstance) : tl.Manifold.union(parts);
    if (parts.length > 1) for (const p of parts) p.delete();
    sacrificial = new tl.Manifold(raw.getMesh());
    raw.delete();
  }

  // The fixture as solids the tool must not hit (#204, /Simulation.md §1.1). Each box is grown
  // by the envelope's `uncertainty` before any check (decision 28): a shipped default is never
  // a measurement. One box per obstacle, PLUS their union for the checks — kept per-box so a
  // message can name WHICH jaw. Built here and deleted on EVERY exit path below, refusals too.
  const fixtureBoxes: { box: ObstacleBox; solid: ManifoldInstance }[] = [];
  let fixture: ManifoldInstance | null = null;
  let fixtureBB: Box | null = null;
  let fixtureTop = Number.NEGATIVE_INFINITY;
  if (setup.fixture && setup.fixture.boxes.length > 0) {
    for (const raw of setup.fixture.boxes) {
      const box = inflate(raw, setup.fixture.uncertainty);
      fixtureBoxes.push({ box, solid: boxSolid(tl, box) });
      fixtureTop = Math.max(fixtureTop, box.max[2]);
    }
    // A single box aliases `fixture`; the union is a separate handle only when there is more
    // than one, so the delete below never touches a handle twice.
    fixture = fixtureBoxes.length === 1 ? (fixtureBoxes[0] as { solid: ManifoldInstance }).solid : tl.Manifold.union(fixtureBoxes.map((b) => b.solid));
    fixtureBB = fixture.boundingBox();
  }
  const disposeFixture = (): void => {
    if (fixture && fixtureBoxes.length !== 1) fixture.delete();
    fixture = null;
    for (const b of fixtureBoxes) b.solid.delete();
    fixtureBoxes.length = 0;
  };
  // The fixture diagnostics fold together (one bad label must not print 400 lines).
  const fixtureDiag = new DiagnosticFolder();
  const holder = opts?.machine?.holder ?? null;
  const stickout = tool.stickout;
  // (c-precondition) An unknown nut or stick-out is "cannot be proven", a warning — never a
  // refusal (#182), or every tool with unstated lengths would be refused.
  if (fixture) {
    if (holder === null || stickout === null) {
      fixtureDiag.push({
        severity: 'warning',
        code: 'holder-vs-fixture-unproven',
        message: `the collet nut's size or the tool's stick-out is not known: clearance to the vise cannot be proven`,
      });
    }
  }
  const nutKnown = holder !== null && stickout !== null;

  const t0 = performance.now();
  const total = timeline.checkpoints.length;
  const deadline = opts?.budgetMs === undefined ? null : t0 + opts.budgetMs;
  const overBudget = (): boolean => deadline !== null && performance.now() > deadline;
  let msUnion = 0;
  let msExtrude = 0;
  let contours = 0;
  let skipped = 0;
  const perCheckpoint: (ManifoldInstance | null)[] = [];
  const solids: ManifoldInstance[] = [];
  /**
   * Give up without leaking. `perCheckpoint` aliases `solids`, so deleting `solids` covers
   * both; `stock` is the only other handle alive at either call site.
   */
  const refuseBudget = (done: number): SweepOutcome => {
    const elapsed = Math.round(performance.now() - t0);
    for (const s of solids) s.delete();
    disposeFixture();
    sacrificial?.delete();
    stock.delete();
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'sweep-budget-exceeded',
          message: `the sweep stopped after ${elapsed} ms, at checkpoint ${done} of ${total}: this program is too slow to simulate at this size (/Simulation.md §4.4). Raise the time limit and try again`,
        },
      ],
    };
  };

  let budgetHit = false;
  let done = 0;
  for (let idx = 0; idx < total; idx++) {
    const cp = timeline.checkpoints[idx] as Checkpoint;
    // A checkpoint at or above the top of the stock removes nothing: the vendor's rotary files
    // feed at Z = +30 over a cylinder, and a stub prism has nothing there.
    if (cp.z >= topZ) {
      perCheckpoint.push(null);
      skipped++;
    } else {
      const a = performance.now();
      const { region, contours: c } = checkpointRegion(tl, cp, radius);
      contours += c;
      msUnion += performance.now() - a;
      if (!region) {
        perCheckpoint.push(null);
        skipped++;
      } else {
        const b = performance.now();
        // (c) Holder into fixture (#204): the collet nut is a cylinder whose bottom face sits
        // `stickout` above the tool tip, and its footprint is this checkpoint's own 2D region
        // offset outward to the nut radius. Checked only when both the nut and the stick-out
        // are known; otherwise the warning above stands and there is nothing to test.
        if (fixture && nutKnown && holder && stickout !== null) {
          const offsetBy = holder.nutDiameter / 2 - radius;
          const nutRegion = region.offset(offsetBy, 'Round', 2, segmentsForRadius(Math.abs(offsetBy)));
          const nutColumn = tl.Manifold.extrude(nutRegion, holder.nutLength);
          nutRegion.delete();
          const nutSolid = nutColumn.translate([0, 0, cp.z + stickout]);
          nutColumn.delete();
          const nutHit = nutSolid.intersect(fixture);
          nutSolid.delete();
          const nutVol = nutHit.volume();
          nutHit.delete();
          if (nutVol > SLIVER_MM3) {
            fixtureDiag.push({
              severity: 'error',
              code: 'holder-into-fixture',
              checkpoint: idx,
              message: `checkpoint ${idx}: the collet nut (⌀${holder.nutDiameter} mm) at ${stickout} mm stick-out overlaps the fixture by ${formatVolume(nutVol)} mm³`,
            });
          }
        }
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
        // (a) Cutter into fixture (#204): the removal column this checkpoint already built,
        // intersected with the fixture. The jaws are below the stock top, so a column that rises
        // from cp.z past the top already covers any fixture a cutting move can reach. Culled by
        // bounding box, so a checkpoint nowhere near the vise costs one cheap test.
        if (fixture && fixtureBB && boxesOverlap(solid.boundingBox(), fixtureBB)) {
          const hit = solid.intersect(fixture);
          const vol = hit.volume();
          hit.delete();
          if (vol > SLIVER_MM3) {
            // Name the box: test each separately when the union intersects, so the message can
            // say WHICH jaw.
            let named: ObstacleBox | null = null;
            let best = 0;
            for (const fb of fixtureBoxes) {
              const one = solid.intersect(fb.solid);
              const v = one.volume();
              one.delete();
              if (v > best) { best = v; named = fb.box; }
            }
            fixtureDiag.push({
              severity: 'error',
              code: 'tool-into-fixture',
              checkpoint: idx,
              message: `checkpoint ${idx}: the cutter drives ${formatVolume(best > 0 ? best : vol)} mm³ into the fixture '${named?.label ?? '?'}' (${named?.id ?? '?'})`,
            });
          }
        }
        if (cp.nonConstantZ) {
          diagnostics.push({ severity: 'info', code: 'ramp-over-removed', checkpoint: idx, message: `checkpoint ${idx} has moves that change Z; swept at its lowest Z, which removes more than the machine would (/Simulation.md §3.2)` });
        }
      }
    }
    done = idx + 1;
    opts?.onProgress?.(done, total);
    // Between checkpoints is as fine-grained as this can be: a wasm call is not interruptible.
    if (overBudget()) {
      budgetHit = true;
      break;
    }
  }
  if (budgetHit) return refuseBudget(done);

  // The gates that need the stock: holder depth, and the air moves.
  const swept = timeline.checkpoints.filter((cp) => cp.z < topZ);
  const deepest = swept.length ? topZ - Math.min(...swept.map((cp) => cp.z)) : null;
  const hg = holderGate(tool, deepest);
  if (hg) diagnostics.push(hg);
  // The material the air moves are tested against: the part, plus the sacrificial body when
  // the job has one (#213 §4). A rapid through the board breaks the cutter exactly as one
  // through the part does, so both are `rapid-through-stock`. The recheck (subtract the
  // per-checkpoint removal) then works unchanged: a cut removes material from either body.
  // Materialised into a true LEAF (mesh round-trip): a leaf has no lazy children to flatten, so
  // deleting it below cannot disturb the gouge solids that were built against it (ONE MANIFOLD
  // TRAP, playback.ts).
  let airMaterial: ManifoldInstance = stock;
  if (sacrificial) {
    const u = tl.Manifold.union([stock, sacrificial]);
    airMaterial = new tl.Manifold(u.getMesh());
    u.delete();
  }
  // "The bed" is what the bodies rest on: with an under-board that is the board's underside,
  // so a rapid below IT is `rapid-below-bed` and one inside the board is `rapid-through-stock`.
  const bb = airMaterial.boundingBox();
  const a0 = performance.now();
  const air = checkAirMoves(tl, airMaterial, topZ, bb.min[2], timeline.airMoves, timeline.checkpoints, radius, deadline, fixture, fixtureTop, (d) => fixtureDiag.push(d));
  if (airMaterial !== stock) airMaterial.delete();
  const msAir = performance.now() - a0;
  if (air.budgetExceeded) {
    for (const g of air.gouges) g.solid.delete();
    return refuseBudget(done);
  }
  diagnostics.push(...air.diagnostics);
  // The fixture checks fold together and go in after the stock gates, so the picture reads in
  // the order the tool meets things.
  diagnostics.push(...fixtureDiag.finish());
  if (air.gouges.length < air.diagnostics.filter((d) => d.code === 'rapid-through-stock').length) {
    diagnostics.push({ severity: 'info', code: 'gouges-truncated', message: `only the first ${MAX_GOUGES} rapids through the stock are returned as solids; the rest are reported but not drawn` });
  }
  // When the fixture is modelled the checks above ran; only an absent fixture leaves the
  // proximity unproven (#204).
  if (!fixture && setup.workholding.kind !== 'tape-down' && setup.workholding.kind !== 'anchor-bracket') {
    diagnostics.push({ severity: 'info', code: 'fixture-unchecked', message: `the ${setup.workholding.kind} is not modelled as an obstacle yet (#188): proximity to the fixture is NOT checked` });
  }
  // Every check against it is done; the fixture is not part of the result, so release it now.
  disposeFixture();

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

  // Split the removal between the two bodies (#213 §4). The PART's share is `stock − result`
  // exactly as before — a cut that runs off the edge removes nothing more from the part, so the
  // part's result is unchanged by sacrificial material. The SACRIFICIAL share is the removal
  // intersected with the board/strips.
  const removedFromPart = stockVolume - resultVolume;
  let removedFromSacrificial = 0;
  if (sacrificial && removal) {
    const cut = removal.intersect(sacrificial);
    removedFromSacrificial = cut.volume();
    cut.delete();
  }

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
      sacrificial,
      stockTopZ: topZ,
      removal,
      result,
      perCheckpoint,
      gouges: air.gouges,
      radius,
      stats: {
        airMovesChecked: air.checked,
        airMovesRechecked: air.rechecked,
        airMovesClearedByConstruction: air.cleared,
        stockVolume,
        resultVolume,
        removedVolume: removedFromPart,
        removedFromPart,
        removedFromSacrificial,
        checkpointsSwept: solids.length,
        checkpointsSkipped: skipped,
        contours,
        ms: { union2d: msUnion, extrude: msExtrude, subtract: msSubtract, airCheck: msAir, total: performance.now() - t0 },
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
