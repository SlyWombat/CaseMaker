/**
 * The column engine (#239 R-2, `/Rotary.md` §4): a 2D grid of columns, each a single height,
 * with a tool subtracted by per-column `min`. ONE engine, two parameterisations (decision R7);
 * the rotary one is built first and is the simpler, because its footprint is a closed form
 * (§4.2) while the flat one needs a tool height profile (#222).
 *
 * What is here:
 *   - the grid: columns over (θ, X) holding the remaining RADIUS ρ from the rotary axis (R6);
 *   - the tool footprint: a flat end mill whose tip is at radius Z_t, cut to `ρ = Z_t/cos φ`
 *     over `|φ| ≤ φ_max = atan(r_eff/Z_t)` with `r_eff = √(r_t² − dx²)` along X (§4.2);
 *   - the axis rule (§4.3, decision R8, amended 2026-10-05): a single-valued radius column cannot
 *     hold the interval a sub-axis cut leaves on the far side, so the rule is **clamp shallow,
 *     refuse deep, threshold at the TOOL RADIUS**. A move whose tip dips below the axis within one
 *     tool radius is clamped to the axis, reported as `axis-clamped` (warning) and the sweep
 *     continues; a move whose tip reaches or passes one tool radius below the axis is a genuine
 *     crossing and is refused `axis-crossing` by name, with the step;
 *   - gouge detection in column space (§4.4): a rapid whose tip is below a column's remaining ρ;
 *   - a DISPLAY-resolution heightfield mesh, rebuilt from a snapshot without a boolean;
 *   - snapshot anchors on the pattern `playback.ts` uses: a full grid copy every N checkpoints,
 *     with the moves between replayed to reach any frame.
 *
 * ONE ENGINE, TWO PARAMETERISATIONS (decision R7). `columnSweep` owns the grid walk, the budget,
 * the anchors, the mesh cadence and the refusal vocabulary, and delegates every axis-specific
 * thing to a `ColumnParameterisation` (build the grid, apply one move, mesh, volume). Both exist:
 * `ROTARY` (columns over (θ, X) holding radius ρ, §4.2) and `FLAT` (#222, columns over (x, y)
 * holding the remaining top Z — the dexel parameterisation). The flat one is chosen for a
 * non-rotary job against a prism stock; the rotary one for an A-axis job against a cylinder.
 *
 * NO WASM. Unlike the exact sweeper this holds no Manifold handle: it produces `NodeMeshOutput`
 * directly from typed arrays. That is what lets it run for a 100 k-move program without the wasm
 * heap the exact path needs, and it is why `session.ts` can route a rotary job here without the
 * anchor/trap machinery `playback.ts` documents.
 *
 * Every number this file reports is a SAMPLED number: `stats.engine === 'column'` and
 * `stats.resolution` carry the grid it is good to (§5.5). It is never presented with the exact
 * sweeper's confidence.
 */

import type { Timeline, Checkpoint } from '@/engine/cnc/emulator/timeline';
import { partToWork } from '@/engine/cnc/frames';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { Setup } from '@/engine/cnc/setup';
import { cuttingDiameter, cuttingForTrace, drillPointAngle, type Tool } from '@/engine/cnc/tool';
import type { NodeMeshOutput } from './meshOutput';
import type { SweepDiagnostic, SweepStats } from './sweep';
import { MAX_AIR_CHECKS, MAX_GOUGES, holderGate } from './sweep';

/**
 * The cutter a column sweep removes material with (#405).
 *
 * A FLAT end mill is a disc of `radius` at the tip plane — the whole of V1 until #405. A V-bit is
 * a CONE: the same flat tip of `radius`, then a flank rising at `1/tanHalf` away from the axis, so
 * the floor a move leaves at a column depends on how far that column is from the tool's path. The
 * exact 2.5D sweeper has no form for that (`cuttingRadiusForSweep` refuses it by name); here it is
 * a height profile over the disc, which is exactly what a column grid holds.
 */
export interface ColumnCutter {
  /** Cutting radius at the tip plane, mm. */
  radius: number;
  /** The cone's rise per mm of radial distance, or `null` for a flat end (a level floor). */
  tanHalf: number | null;
  /**
   * The cone's OUTER radius, mm, where it meets the cutter's cylindrical body — or absent for a cone
   * with no stated end (a V-bit, #405, whose flank is taken to run to the top face). A DRILL has one
   * (#382): its point is a cone from a sharp tip out to the drill's radius, and past that radius the
   * drill is a wall, so nothing beyond it is cut however deep the tip goes. Ignored for a flat end,
   * whose `radius` already is its outer edge.
   */
  outerRadius?: number;
}

/** The surface a column at radial distance `rho` from the tool axis is left at: tip Z + this. */
export function surfaceAboveTip(cutter: ColumnCutter, rho: number): number {
  if (cutter.tanHalf === null) return rho <= cutter.radius ? 0 : Infinity;
  if (cutter.outerRadius !== undefined && rho > cutter.outerRadius) return Infinity;
  const h = (rho - cutter.radius) / cutter.tanHalf;
  return h > 0 ? h : 0;
}

/**
 * The furthest a cutter can reach in XY from its own axis when its tip sits `aboveTip` mm below
 * the stock's top: the tip radius for a flat end, and the radius at which the cone's flank meets
 * the top face for a V-bit. The loop bounds and the grid's padding both need it.
 *
 * THE INVERSE OF {@link surfaceAboveTip}, not another reading of it (#405 review). The flank RISES
 * `1/tanHalf` per mm of radial distance — `h = (ρ − r_t)/tanHalf` — so the radial distance that
 * reaches a given rise is the rise TIMES the tangent: `ρ = r_t + h·tanHalf`. The two agree at 45°
 * and part company either side of it, and the form that matters is the one that UNDER-SCANS when
 * it is wrong: `r_t + h/tanHalf` reads the flank as if it were the steep one everywhere, so above
 * 45° it stops the sweep short of where the bit actually cuts (a 120° chamfer 1 mm down reaches
 * 0.58 mm where the real flank is 1.73 mm out) and the groove is drawn about a third of its width.
 * Below 45° it over-scans by `1/tanHalf²` and only wastes time.
 */
export function cutterReach(cutter: ColumnCutter, aboveTip: number): number {
  if (cutter.tanHalf === null) return cutter.radius;
  const cone = cutter.radius + aboveTip * cutter.tanHalf;
  // A bounded cone (a drill, #382) reaches no further than its body, however deep the tip is.
  return cutter.outerRadius !== undefined && cone > cutter.outerRadius ? cutter.outerRadius : cone;
}

/**
 * The point angle for a drill that states none: the shop default `drill.pointAngleDeg` as the CALLER
 * read it — or, for the app's own drilling job, the value the #434 CAM planned the hole with
 * (`DrillBitPlan.simDrillPoint`), so the simulation sweeps the point the plan used rather than
 * re-reading a setting that may have changed since. Passed in, never read here: the geometry worker
 * does not import the location client (#382 review).
 */
export interface DrillPointDefault {
  /** `drill.pointAngleDeg`, included, degrees. */
  deg: number;
  /** That reading's source (`chosen`, `measured`, `seeded`, or `fallback` with no location). */
  source: string;
}

export type ColumnCutterResult =
  | { ok: true; cutter: ColumnCutter; kind: 'flat' | 'v' | 'drill' | 'thread-envelope'; diagnostics: SweepDiagnostic[] }
  | { ok: false; reason: string };

/**
 * The cutter the column engine sweeps for a `Tool`, or a refusal naming why (#382). The SIMULATOR's
 * resolver only: `cuttingForTrace` stays the CAM's contract (a drill is not a trace tool), and this
 * one adds the shapes the column engine has a model for and the CAM does not trace with.
 *
 *   - flat end mill, V-bit (engraving, chamfer): exactly `cuttingForTrace`'s reading (#405);
 *   - DRILL: a sharp cone of the drill's point angle — `drillPointAngle`, the same rule the #434 CAM
 *     plans the hole by — bounded at the drill's radius by its body. An `info` names the angle and
 *     whether the drill stated it or the shop default supplied it;
 *   - THREAD MILL: its cutting diameter as a flat cylinder at the tip — an ENVELOPE, conservative
 *     over-removal, and a `warning` says so: the teeth on a helix are not a solid of revolution, and
 *     the thread form is not modelled. Never sized from the thread spec (an M5 mill does not cut a
 *     5 mm hole: it orbits). A thread mill that states no cutting diameter is refused by name.
 *
 * A ball, a bull nose, an unknown shape: refused, as before (#222).
 */
export function columnCutterFor(tool: Tool, drillDefault?: DrillPointDefault | null): ColumnCutterResult {
  if (tool.shape === 'drill') {
    const d = cuttingDiameter(tool);
    if (d === null || !(d > 0)) {
      return { ok: false, reason: `drill "${tool.name}" states no cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})` };
    }
    const stated = tool.angle !== null && tool.angle > 0;
    if (!stated && !drillDefault) {
      return {
        ok: false,
        reason: `drill "${tool.name}" states no point angle and no shop default (drill.pointAngleDeg) was passed to the simulation; type the drill's angle, or load it through the app, which passes the location's default`,
      };
    }
    const point = drillPointAngle(tool, drillDefault ?? { deg: tool.angle as number, source: 'unused' });
    if (!point.ok) return { ok: false, reason: `drill "${tool.name}": ${point.reason}` };
    const half = (point.deg / 2) * (Math.PI / 180);
    return {
      ok: true,
      kind: 'drill',
      cutter: { radius: 0, tanHalf: Math.tan(half), outerRadius: d / 2 },
      diagnostics: [
        {
          severity: 'info',
          code: 'drill-point-angle',
          message: `drill "${tool.name}" (⌀${d}) is simulated with a ${point.deg}° point from ${point.from}; its point length is ${(d / 2 / Math.tan(half)).toFixed(3)} mm`,
        },
      ],
    };
  }
  if (tool.shape === 'thread') {
    const d = cuttingDiameter(tool);
    if (d === null || !(d > 0)) {
      return {
        ok: false,
        reason: `thread mill "${tool.name}" states no cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter}); the thread size it is for is not its cutting diameter, so nothing is assumed`,
      };
    }
    return {
      ok: true,
      kind: 'thread-envelope',
      cutter: { radius: d / 2, tanHalf: null },
      diagnostics: [
        {
          severity: 'warning',
          code: 'thread-envelope',
          message: `thread mill "${tool.name}" is simulated as a ⌀${d} mm cylinder (its cutting diameter) all the way up: around the teeth and the neck that over-removes, but the wider shank above the neck is not modelled, so a cut deeper than the neck shows less than the shank would take (the neck check, holder-collision / holder-unproven, says whether it is), and the thread form itself is not modelled`,
        },
      ],
    };
  }
  const trace = cuttingForTrace(tool);
  if (!trace.ok) return trace;
  return trace.tool.shape === 'v'
    ? { ok: true, kind: 'v', cutter: { radius: trace.tool.cone.tipRadius, tanHalf: trace.tool.cone.tanHalf }, diagnostics: [] }
    : { ok: true, kind: 'flat', cutter: { radius: trace.tool.radius, tanHalf: null }, diagnostics: [] };
}

/** A column grid. Rotary: `u` is work X, `v` is the stock angle θ in degrees, `h` is radius ρ. */
export interface ColumnGrid {
  readonly kind: ColumnParameterisation['kind'];
  /** Columns along `u` (rotary: X; flat: X). */
  readonly nu: number;
  /** Columns along `v` (rotary: θ; flat: Y). */
  readonly nv: number;
  /** Work coordinate of column (0,0)'s centre on the first axis (rotary: X, flat: X, mm). */
  readonly u0: number;
  /** First-axis pitch (rotary: mm; flat: mm). */
  readonly du: number;
  /** Work coordinate of column (0,0)'s centre on the second axis (rotary: 0; flat: Y, mm). */
  readonly v0: number;
  /** Second-axis pitch (rotary: degrees; flat: mm). */
  readonly dv: number;
  /** The untouched column value (rotary: the stock radius R; flat: the top-face work Z). */
  readonly initial: number;
  /**
   * The untouched LOWER bound (rotary: 0, the axis; flat: the stock's bottom-face work Z). Only
   * the flat parameterisation cuts towards it, and a cut is clamped to it — nothing can be
   * removed below the blank.
   */
  readonly base: number;
  /** Remaining value: `h[j*nu + i]`. Rotary: remaining radius from the axis. Flat: remaining top Z. */
  readonly h: Float32Array;
}

/** One cutting move, resolved to the parameterisation's own axes. */
export interface CutMove {
  step: number;
  line: number;
  /** First-axis span (rotary: work X, mm). */
  u0: number;
  u1: number;
  /** Second-axis span (rotary: A in degrees, unwound). */
  v0: number;
  v1: number;
  /** The move's LOWEST tip value (rotary: the tool tip's radius, mm) — the conservative rule. */
  z: number;
}

/** What `applyMove` changed, or why it could not. */
export interface MoveResult {
  /** Columns written. */
  written: number;
  /** Non-null when the move violates the single-valued model (rotary: the tip crossed the axis). */
  crossed: { z: number } | null;
  /**
   * Rotary only, and the amendment to decision R8: the tip dipped below the axis but within one
   * tool radius, so the cut was clamped to the axis and the sweep continued. The far-side hollow
   * is not modelled — a clamped cut did not come out the depth that was asked for.
   */
  clamped: { z: number } | null;
}

export interface ColumnResolution {
  /** Spacing along the first axis (work X), mm — rotary and flat alike. */
  dx: number;
  /**
   * Spacing along the second axis: **rotary θ in DEGREES**; **flat Y in MM**. The two engines
   * share this type but not the unit, and `stats.resolution` (the exact sweeper's field) mirrors
   * the same pair — so a reader of a `'column'` result must read the unit from `kind`.
   */
  dThetaDeg: number;
}

/**
 * The X pitch, mm, when the caller passes none (#451) — the LABELLED FALLBACK for the shop's
 * `sim.columnPitchXMm`, and the same number it is seeded with. Rotary and flat share it: the grid's
 * first axis is work X either way, and the sim's memory and time grow as 1/pitch.
 */
export const COLUMN_PITCH_X_FALLBACK_MM = 0.1;
/**
 * The ROTARY grid's θ pitch, degrees, when the caller passes none (#451) — the LABELLED FALLBACK
 * for the shop's `sim.rotaryPitchDeg`, and the same number it is seeded with. A FLAT job never
 * reads it: its second axis is Y millimetres and takes the pitch below (#438).
 */
export const COLUMN_ROTARY_PITCH_FALLBACK_DEG = 0.25;
/**
 * The §4.4 estimate for the ENVELOPE, to be measured against a real load: the ROTARY grid's X mm ×
 * θ degrees, built from the two labelled fallbacks above. It is also the `resolution` a caller may
 * pass explicitly; a FLAT job otherwise takes its `dx` and its own Y pitch (#438, below).
 */
export const COLUMN_SIM_RESOLUTION: ColumnResolution = { dx: COLUMN_PITCH_X_FALLBACK_MM, dThetaDeg: COLUMN_ROTARY_PITCH_FALLBACK_DEG };
/**
 * The FLAT grid's Y pitch, mm, when the caller passes none (#438) — the LABELLED FALLBACK for the
 * shop's `sim.columnFlatPitchYMm`, and the same number it is seeded with. Before #438 a flat job
 * reused `COLUMN_SIM_RESOLUTION.dThetaDeg` (the rotary's 0.25°) as 0.25 mm, which made the cell
 * 0.1 × 0.25 mm and the oracle's grid term `hypot(du, dv) / 2` 0.135 mm — nearly the whole 0.15 mm
 * half-width of a 0.3 mm V tip's floor. At 0.1 mm the term is 0.071 mm. The rotary keeps its 0.25°.
 */
export const COLUMN_FLAT_PITCH_Y_FALLBACK_MM = 0.1;
/** The §4.4 estimate for the display mesh — coarser on purpose; the mesh is not the answer. */
export const COLUMN_DISPLAY_RESOLUTION: ColumnResolution = { dx: 0.5, dThetaDeg: 1 };
/** Full grid snapshots kept per job; the cadence grows with the checkpoint count to bound memory. */
export const COLUMN_MIN_ANCHOR_EVERY = 16;
export const COLUMN_MAX_ANCHORS = 32;

export interface ColumnParameterisation {
  readonly kind: 'rotary' | 'flat';
  /** Build the initial grid from the setup, the cutter and the program's own extent. */
  buildGrid(setup: Setup, cutter: ColumnCutter, moves: readonly CutMove[], res: ColumnResolution): ColumnGrid;
  /**
   * Subtract one move. `crossed` is set when the model cannot hold the cut (rotary: a genuine
   * axis crossing), `clamped` when a shallow axis dip was clamped and the sweep may continue.
   * The threshold is the tool radius — see `ROTARY.applyMove`, decision R8.
   */
  applyMove(grid: ColumnGrid, m: CutMove, cutter: ColumnCutter): MoveResult;
  /** The grid's surface at display resolution. */
  mesh(grid: ColumnGrid, res: ColumnResolution): NodeMeshOutput;
  /** Removed and (uncut) stock volume, mm³, from the grid. */
  volume(grid: ColumnGrid): { removed: number; stock: number };
}

export interface ColumnSweepOpts {
  budgetMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** Override the §4.4 sim-resolution estimate (a spec and the probe set this). */
  resolution?: ColumnResolution;
  /**
   * The shop's `drill.pointAngleDeg`, read by the caller, for a drill that states no angle (#382).
   * Absent: the registry's labelled fallback, reported with source `fallback`.
   */
  drillPointDefault?: DrillPointDefault | null;
  /**
   * The FLAT grid's Y pitch, mm: the shop's `sim.columnFlatPitchYMm`, read by the caller (#438) —
   * the worker cannot read the location. Absent: {@link COLUMN_FLAT_PITCH_Y_FALLBACK_MM}. Ignored by
   * a rotary job (its second axis is degrees) and when `resolution` overrides the whole grid.
   */
  flatPitchYMm?: number | null;
  /**
   * The grid's X pitch, mm: the shop's `sim.columnPitchXMm`, read by the caller (#451) — the worker
   * cannot read the location. Absent: {@link COLUMN_PITCH_X_FALLBACK_MM}. Ignored when `resolution`
   * overrides the whole grid.
   */
  columnPitchXMm?: number | null;
  /**
   * The ROTARY grid's θ pitch, degrees: the shop's `sim.rotaryPitchDeg`, read by the caller (#451).
   * Absent: {@link COLUMN_ROTARY_PITCH_FALLBACK_DEG}. Ignored by a flat job (its second axis is
   * millimetres) and when `resolution` overrides the whole grid.
   */
  rotaryPitchDeg?: number | null;
}

export interface ColumnSweepOk {
  ok: true;
  /** Checkpoints; valid `meshAt` indices are -1 … count-1. */
  count: number;
  /** Work-frame Z of the stock's top: for a rotary job, the stock RADIUS (R6). */
  stockTopZ: number;
  radius: number;
  /**
   * The FINAL grid — the material as the sweep left it, which is the whole answer this engine has
   * (#408). `meshAt(count - 1)` gives the same state as a display mesh; this is the sim-resolution
   * field itself, which is what the oracle reads a level's cut area off (`gridSliceAt`), since a
   * column live has no removal solid to slice. Shared, not a copy: nothing mutates a grid after
   * its sweep returns.
   */
  grid: ColumnGrid;
  stats: SweepStats;
  diagnostics: SweepDiagnostic[];
  /** Uncut stock, display resolution. */
  stock: NodeMeshOutput;
  /** Final stock, display resolution. */
  result: NodeMeshOutput;
  /** Gouges found in column space. No solids yet — see the file note on `gouges`. */
  gouges: { step: number; line: number }[];
  /**
   * Rotary only: how many cutting moves dipped below the axis within one tool radius and were
   * clamped to it, with the deepest such Z. `null` when none did. A clamped cut did not come out
   * the depth that was asked for, so this is carried OUTSIDE `diagnostics` — the panel shows it
   * where a user reads the result, not only in the diagnostic list (#239, decision R8).
   */
  axisClamped: { count: number; deepestZ: number } | null;
  /** The stock after checkpoints 0..k, display resolution; `k = -1` (or < 0) is uncut. */
  meshAt(k: number): NodeMeshOutput;
}

export interface ColumnSweepRefused {
  ok: false;
  diagnostics: SweepDiagnostic[];
  /** Present when the refusal came after the grid was built (a crossing at a known step). */
  stats?: SweepStats;
}

export type ColumnOutcome = ColumnSweepOk | ColumnSweepRefused;

const DEG = Math.PI / 180;

/** Reduce an unwound degree count to (−180, 180]. */
function wrap180(d: number): number {
  return ((d + 180) % 360 + 360) % 360 - 180;
}

/**
 * The signed angular offset of a column at stock angle `theta` from the tool, at its CLOSEST
 * approach while A sweeps `[aLo, aHi]` — `φ = θ − A` (right-hand rule about +X; the sign is a
 * convention, §9, and only picks the chirality of a partial turn). Returns a value in (−180, 180];
 * `0` when the sweep passes the tool over the column exactly.
 */
export function closestAngularOffset(thetaDeg: number, aLo: number, aHi: number): number {
  const pLo = thetaDeg - aHi;
  const pHi = thetaDeg - aLo;
  if (pHi - pLo >= 360) return 0;
  // Any multiple of 360 inside the swept interval is a dead-centre pass.
  if (Math.ceil(pLo / 360) <= Math.floor(pHi / 360)) return 0;
  const wLo = wrap180(pLo);
  const wHi = wrap180(pHi);
  return Math.abs(wLo) <= Math.abs(wHi) ? wLo : wHi;
}

/**
 * The ROTARY parameterisation: columns over (θ, X) holding radius ρ (`/Rotary.md` §4.1, §4.2).
 * Work frame: X along the axis, Z = radius from the axis, Y ≡ 0 (R6) — so a surface point at
 * stock angle θ and radius ρ is `(x, ρ sin θ, ρ cos θ)` in work coordinates (θ measured from +Z
 * toward +Y, i.e. θ = 0 is directly under the tool at A = 0).
 */
export const ROTARY: ColumnParameterisation = {
  kind: 'rotary',

  buildGrid(setup, cutter, moves, res) {
    const part = setup.part;
    if (part.kind !== 'cylinder') {
      throw new Error(`the rotary column engine sweeps a cylinder stock; the setup's part is a ${part.kind}`);
    }
    const toolRadius = cutter.radius;
    const R = part.diameter / 2;
    // The grid spans the STOCK's axial extent in work coordinates, widened to cover every move
    // (plus one tool radius) so a program that reaches past the stub's placement is still
    // represented. The stub placement (#237) is approximate; covering the moves is the honest
    // conservative reading, and the range is reported in `stats.resolution`'s company.
    const w0 = partToWork(setup, [0, 0, 0])[0];
    const w1 = partToWork(setup, [part.length, 0, 0])[0];
    let xMin = Math.min(w0, w1);
    let xMax = Math.max(w0, w1);
    for (const m of moves) {
      xMin = Math.min(xMin, m.u0, m.u1);
      xMax = Math.max(xMax, m.u0, m.u1);
    }
    xMin -= res.dx + toolRadius;
    xMax += res.dx + toolRadius;
    const nu = Math.max(1, Math.ceil((xMax - xMin) / res.dx));
    const nv = Math.max(1, Math.round(360 / res.dThetaDeg));
    const h = new Float32Array(nu * nv);
    h.fill(R);
    return { kind: 'rotary', nu, nv, u0: xMin + res.dx / 2, du: (xMax - xMin) / nu, v0: 0, dv: 360 / nv, initial: R, base: 0, h };
  },

  applyMove(grid, m, cutter) {
    // A cone never reaches here: `columnSweep` refuses a V-bit on a rotary job by name. The
    // rotary model's whole premise is a vertical flat tip, and a cone about a turntable axis is a
    // different body (#221's chamfer profiles).
    const toolRadius = cutter.radius;
    // R8, amended 2026-10-05 — clamp shallow, refuse deep, threshold at the TOOL RADIUS. A dip
    // within one tool radius is a shallow graze: clamp it to the axis, report `axis-clamped` and
    // continue. At or past one tool radius below the axis the cut genuinely crosses, and a
    // single-valued radius column cannot hold it.
    if (m.z <= -toolRadius) return { written: 0, crossed: { z: m.z }, clamped: null };
    const clamped = m.z < 0 ? { z: m.z } : null;
    const zt = m.z > 0 ? m.z : 0; // the clamped floor: never below the axis
    const rt = toolRadius;
    const { nu, nv, u0, du, dv, h } = grid;
    const xLo = Math.min(m.u0, m.u1);
    const xHi = Math.max(m.u0, m.u1);
    const aLo = Math.min(m.v0, m.v1);
    const aHi = Math.max(m.v0, m.v1);
    let written = 0;
    const iLo = Math.max(0, Math.floor((xLo - rt - u0) / du));
    const iHi = Math.min(nu - 1, Math.ceil((xHi + rt - u0) / du));
    for (let i = iLo; i <= iHi; i++) {
      const x = u0 + i * du;
      const dx = x < xLo ? xLo - x : x > xHi ? x - xHi : 0;
      if (dx > rt) continue;
      const reff = Math.sqrt(Math.max(0, rt * rt - dx * dx));
      const phiMax = zt > 0 ? Math.atan2(reff, zt) / DEG : 90; // degrees
      // θ window: φ = θ − A ∈ [−φmax, φmax] for some A in the sweep ⇒ θ ∈ [aLo−φmax, aHi+φmax].
      let jLo = Math.floor((aLo - phiMax) / dv);
      let jHi = Math.ceil((aHi + phiMax) / dv);
      if (jHi - jLo >= nv) {
        jLo = 0;
        jHi = nv - 1;
      }
      for (let jj = jLo; jj <= jHi; jj++) {
        const j = ((jj % nv) + nv) % nv;
        const theta = j * dv;
        const phi = closestAngularOffset(theta, aLo, aHi);
        if (Math.abs(phi) > phiMax) continue;
        const floor = zt > 0 ? zt / Math.cos(phi * DEG) : 0;
        const idx = j * nu + i;
        if (floor < (h[idx] as number)) {
          h[idx] = floor;
          written++;
        }
      }
    }
    return { written, crossed: null, clamped };
  },

  mesh(grid, res) {
    return meshRotary(grid, res);
  },

  volume(grid) {
    // Cross-section area of the remaining star-shaped section at X is ∫ ½ ρ(θ)² dθ; the removed
    // ring from the uncut disc (R²) is therefore ½ (R² − ρ²) dθ per column, × dx.
    const R = grid.initial;
    const dThetaRad = grid.dv * DEG;
    const dx = grid.du;
    let removed = 0;
    for (let k = 0; k < grid.h.length; k++) {
      const rho = grid.h[k] as number;
      const rr = rho < R ? rho : R;
      removed += 0.5 * (R * R - rr * rr) * dThetaRad * dx;
    }
    const stock = Math.PI * R * R * (grid.du * grid.nu);
    return { removed, stock };
  },
};

/** Euclidean distance from (px, py) to the segment (ax, ay)–(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The FLAT parameterisation (#222, `/Rotary.md` §4.1): columns over (x, y) holding the remaining
 * top Z. A vertical cutter's footprint is the disc of radius `r_t` swept along the move's XY
 * segment, and the floor it leaves is FLAT at the move's lowest tip Z — no `1/cos φ` falloff,
 * which is the curved-surface case of §4.2 and belongs to the rotary engine. This is the dexel
 * engine #222 asks for: the cost is the columns a move touches, not the number of Z levels.
 *
 * Work frame: the ordinary 3-axis frame. The stock's top face is `initial`, its bottom `base`; a
 * cut is clamped to `base` because nothing can be removed below the blank.
 *
 * A NON-FLAT footprint is a height profile over that disc, and this is where it is modelled
 * (#405, the hook #221 reserved here): a V-bit's floor at a column is `tipZ + (ρ − r_t)/tan`, ρ
 * being the column's distance from the move's segment, so the groove it leaves is a V and not a
 * slot of the tip's width. A DRILL is the same cone with a sharp tip, BOUNDED at the drill's radius
 * (`ColumnCutter.outerRadius`, #382), and a THREAD MILL is swept as its cutting-diameter cylinder, an
 * envelope (`columnCutterFor`). A BALL or a BULL nose is still refused before the sweep reaches this
 * parameterisation: their constant-Z footprint is a profile too, but it is #222's, and a wrong
 * profile is worse than a refusal.
 */
export const FLAT: ColumnParameterisation = {
  kind: 'flat',

  buildGrid(setup, cutter, moves, res) {
    const part = setup.part;
    if (part.kind !== 'prism') {
      throw new Error(`the flat column engine sweeps a prism stock; the setup's part is a ${part.kind}`);
    }
    const bb = aabbOfProfile(part.outline);
    const initial = partToWork(setup, [0, 0, part.thickness])[2];
    const base = partToWork(setup, [0, 0, 0])[2];
    // The widest the cutter can be over this program: its tip radius, or — for a cone — the radius
    // at which the flank meets the top face at the DEEPEST tip the moves reach. Padding the grid by
    // anything less would clip the outer edge of a deep V groove.
    let aboveTip = 0;
    for (const m of moves) aboveTip = Math.max(aboveTip, Math.max(0, initial - m.z));
    const toolRadius = cutterReach(cutter, aboveTip);
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    // The top-face rectangle's four corners in WORK coordinates (handles a placed/rotated part).
    // An empty outline has no bbox; the moves alone then define the extent.
    const corners: [number, number][] = bb
      ? [
          [bb.min[0], bb.min[1]],
          [bb.max[0], bb.min[1]],
          [bb.max[0], bb.max[1]],
          [bb.min[0], bb.max[1]],
        ]
      : [];
    for (const [cx, cy] of corners) {
      const w = partToWork(setup, [cx, cy, part.thickness]);
      xMin = Math.min(xMin, w[0]);
      xMax = Math.max(xMax, w[0]);
      yMin = Math.min(yMin, w[1]);
      yMax = Math.max(yMax, w[1]);
    }
    for (const m of moves) {
      xMin = Math.min(xMin, m.u0, m.u1);
      xMax = Math.max(xMax, m.u0, m.u1);
      yMin = Math.min(yMin, m.v0, m.v1);
      yMax = Math.max(yMax, m.v0, m.v1);
    }
    xMin -= res.dx + toolRadius;
    xMax += res.dx + toolRadius;
    yMin -= res.dThetaDeg + toolRadius;
    yMax += res.dThetaDeg + toolRadius;
    const nu = Math.max(1, Math.ceil((xMax - xMin) / res.dx));
    const nv = Math.max(1, Math.ceil((yMax - yMin) / res.dThetaDeg));
    const h = new Float32Array(nu * nv);
    h.fill(initial);
    return {
      kind: 'flat',
      nu,
      nv,
      u0: xMin + res.dx / 2,
      du: (xMax - xMin) / nu,
      v0: yMin + res.dThetaDeg / 2,
      dv: (yMax - yMin) / nv,
      initial,
      base,
      h,
    };
  },

  applyMove(grid, m, cutter) {
    const { nu, nv, u0, du, v0, dv, h, initial, base } = grid;
    if (m.z >= initial) return { written: 0, crossed: null, clamped: null }; // wholly above the blank
    const xLo = Math.min(m.u0, m.u1);
    const xHi = Math.max(m.u0, m.u1);
    const yLo = Math.min(m.v0, m.v1);
    const yHi = Math.max(m.v0, m.v1);
    // The cutter's XY reach at THIS tip Z: a flat end's radius, or the radius at which a cone's
    // flank is at the top face. Columns past it cannot be touched by the move.
    const reach = cutterReach(cutter, Math.max(0, initial - m.z));
    let written = 0;
    const iLo = Math.max(0, Math.floor((xLo - reach - u0) / du));
    const iHi = Math.min(nu - 1, Math.ceil((xHi + reach - u0) / du));
    const jLo = Math.max(0, Math.floor((yLo - reach - v0) / dv));
    const jHi = Math.min(nv - 1, Math.ceil((yHi + reach - v0) / dv));
    for (let j = jLo; j <= jHi; j++) {
      const y = v0 + j * dv;
      for (let i = iLo; i <= iHi; i++) {
        const x = u0 + i * du;
        // The move's OWN segment, `(u0,v0)–(u1,v1)` — NOT the bbox diagonal `(xLo,yLo)–(xHi,yHi)`.
        // The two agree for an axis-aligned move and differ for a diagonal one, which is most of a
        // glyph's strokes: using the bbox diagonal cuts the wrong columns, and since the gouge
        // check reads the segment it should have used, the cut and the check then disagree by the
        // difference (#405 — FLAT was unreachable until a V trace, so nothing had compared them).
        const rho = distToSegment(x, y, m.u0, m.v0, m.u1, m.v1);
        if (rho > reach) continue;
        // The floor this column is left at: the tip plane for a flat end, and the cone's flank
        // height above it for a V-bit (#405). Clamped to the blank's bottom.
        const f = m.z + surfaceAboveTip(cutter, rho);
        const floor = f < base ? base : f;
        const idx = j * nu + i;
        if (floor < (h[idx] as number)) {
          h[idx] = floor;
          written++;
        }
      }
    }
    return { written, crossed: null, clamped: null };
  },

  mesh(grid, res) {
    return meshFlat(grid, res);
  },

  volume(grid) {
    const { initial, base, du, dv } = grid;
    const cellArea = du * dv;
    let removed = 0;
    for (let k = 0; k < grid.h.length; k++) {
      const top = Math.max(base, Math.min(initial, grid.h[k] as number));
      removed += (initial - top) * cellArea;
    }
    const stock = (initial - base) * du * grid.nu * dv * grid.nv;
    return { removed, stock };
  },
};

/**
 * Mesh a rotary grid at display resolution. The surface is a heightfield: a vertex at every
 * (X, θ) node of the DISPLAY grid (each down-sampled from the sim grid by `min`, the conservative
 * rule), joined as quads, with a triangle fan closing each axial end. The section is star-shaped
 * by construction (a single-valued radius), so the fan is always valid.
 */
export function meshRotary(grid: ColumnGrid, res: ColumnResolution): NodeMeshOutput {
  const R = grid.initial;
  const xMin = grid.u0 - grid.du / 2;
  const xMax = grid.u0 + (grid.nu - 0.5) * grid.du;
  const L = Math.max(1e-6, xMax - xMin);
  const nuD = Math.max(1, Math.round(L / res.dx));
  const nvD = Math.max(3, Math.round(360 / res.dThetaDeg));

  // Down-sample the sim grid to the display grid, cell (I, J), by nearest column.
  const rho = new Float32Array((nuD + 1) * nvD);
  const xOf = (I: number): number => xMin + (I / nuD) * L;
  const thetaOf = (J: number): number => (J / nvD) * 360;
  const sample = (x: number, theta: number): number => {
    const i = Math.min(grid.nu - 1, Math.max(0, Math.round((x - grid.u0) / grid.du)));
    const j = ((Math.round(theta / grid.dv) % grid.nv) + grid.nv) % grid.nv;
    return grid.h[j * grid.nu + i] as number;
  };
  for (let I = 0; I <= nuD; I++) {
    const x = xOf(I);
    for (let J = 0; J < nvD; J++) rho[I * nvD + J] = sample(x, thetaOf(J));
  }

  const vertexCount = (nuD + 1) * nvD + 2;
  const positions = new Float32Array(vertexCount * 3);
  const put = (v: number, x: number, y: number, z: number): void => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
  };
  for (let I = 0; I <= nuD; I++) {
    const x = xOf(I);
    for (let J = 0; J < nvD; J++) {
      const r = Math.min(R, rho[I * nvD + J] as number);
      const t = thetaOf(J) * DEG;
      put(I * nvD + J, x, r * Math.sin(t), r * Math.cos(t));
    }
  }
  const cap0 = vertexCount - 2;
  const cap1 = vertexCount - 1;
  put(cap0, xMin, 0, 0);
  put(cap1, xMax, 0, 0);

  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  for (let I = 0; I < nuD; I++) {
    for (let J = 0; J < nvD; J++) {
      const Jn = (J + 1) % nvD;
      quad(I * nvD + J, (I + 1) * nvD + J, (I + 1) * nvD + Jn, I * nvD + Jn);
    }
  }
  for (let J = 0; J < nvD; J++) {
    const Jn = (J + 1) % nvD;
    idx.push(cap0, Jn, J); // end at xMin, wound the other way
    idx.push(cap1, nuD * nvD + J, nuD * nvD + Jn);
  }

  const indices = Uint32Array.from(idx);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3] as number,
      y = positions[v * 3 + 1] as number,
      z = positions[v * 3 + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions,
    indices,
    triangleCount: indices.length / 3,
    vertexCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    componentCount: 1,
  };
}

/**
 * Mesh a flat grid at display resolution. The surface is a heightfield over the stock's XY
 * extent: a vertex at every (x, y) node of the DISPLAY grid (each nearest-sampled from the sim
 * grid), with a bottom face at `base` and four side skirts closing it. A rectangular blank is not
 * star-shaped like the rotary stock, so the closure is a box, not a triangle fan.
 */
export function meshFlat(grid: ColumnGrid, res: ColumnResolution): NodeMeshOutput {
  const xMin = grid.u0 - grid.du / 2;
  const xMax = grid.u0 + (grid.nu - 0.5) * grid.du;
  const yMin = grid.v0 - grid.dv / 2;
  const yMax = grid.v0 + (grid.nv - 0.5) * grid.dv;
  const L = Math.max(1e-6, xMax - xMin);
  const W = Math.max(1e-6, yMax - yMin);
  const nuD = Math.max(1, Math.round(L / res.dx));
  const nvD = Math.max(1, Math.round(W / res.dThetaDeg));
  const nx = nuD + 1;
  const ny = nvD + 1;
  const topCount = nx * ny;
  const vertexCount = topCount * 2; // a top grid and a bottom grid
  const positions = new Float32Array(vertexCount * 3);
  const put = (v: number, x: number, y: number, z: number): void => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
  };
  const sample = (x: number, y: number): number => {
    const i = Math.min(grid.nu - 1, Math.max(0, Math.round((x - grid.u0) / grid.du)));
    const j = Math.min(grid.nv - 1, Math.max(0, Math.round((y - grid.v0) / grid.dv)));
    return grid.h[j * grid.nu + i] as number;
  };
  const idxOf = (I: number, J: number): number => I * ny + J;
  for (let I = 0; I <= nuD; I++) {
    const x = xMin + (I / nuD) * L;
    for (let J = 0; J <= nvD; J++) {
      const y = yMin + (J / nvD) * W;
      const top = Math.max(grid.base, Math.min(grid.initial, sample(x, y)));
      put(idxOf(I, J), x, y, top);
      put(topCount + idxOf(I, J), x, y, grid.base);
    }
  }
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  for (let I = 0; I < nuD; I++) {
    for (let J = 0; J < nvD; J++) {
      quad(idxOf(I, J), idxOf(I + 1, J), idxOf(I + 1, J + 1), idxOf(I, J + 1)); // top, +Z
      quad(topCount + idxOf(I, J), topCount + idxOf(I, J + 1), topCount + idxOf(I + 1, J + 1), topCount + idxOf(I + 1, J)); // bottom, −Z
    }
  }
  const side = (t0: number, t1: number, b0: number, b1: number): void => {
    idx.push(t0, t1, b0, t0, b0, b1);
  };
  for (let J = 0; J < nvD; J++) {
    side(idxOf(0, J), idxOf(0, J + 1), topCount + idxOf(0, J), topCount + idxOf(0, J + 1)); // −X
    side(idxOf(nuD, J + 1), idxOf(nuD, J), topCount + idxOf(nuD, J + 1), topCount + idxOf(nuD, J)); // +X
  }
  for (let I = 0; I < nuD; I++) {
    side(idxOf(I + 1, 0), idxOf(I, 0), topCount + idxOf(I + 1, 0), topCount + idxOf(I, 0)); // −Y
    side(idxOf(I, nvD), idxOf(I + 1, nvD), topCount + idxOf(I, nvD), topCount + idxOf(I + 1, nvD)); // +Y
  }
  const indices = Uint32Array.from(idx);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3] as number,
      y = positions[v * 3 + 1] as number,
      z = positions[v * 3 + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions,
    indices,
    triangleCount: indices.length / 3,
    vertexCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    componentCount: 1,
  };
}

/** Resolve the cutting moves of one checkpoint into `CutMove`s (flat: X and Y; Z is the tip). */
export function flatMovesOf(cp: Checkpoint, timeline: Timeline): CutMove[] {
  const out: CutMove[] = [];
  const n = cp.steps.length;
  for (let i = 0; i < n; i++) {
    const step = cp.steps[i] as number;
    const x0 = cp.xy[i * 4] as number;
    const y0 = cp.xy[i * 4 + 1] as number;
    const x1 = cp.xy[i * 4 + 2] as number;
    const y1 = cp.xy[i * 4 + 3] as number;
    const z0 = cp.zs[i * 2] as number;
    const z1 = cp.zs[i * 2 + 1] as number;
    out.push({
      step,
      line: timeline.events[step]?.line ?? -1,
      u0: x0,
      u1: x1,
      v0: y0,
      v1: y1,
      z: Math.min(z0, z1),
    });
  }
  return out;
}

/** Resolve the cutting moves of one checkpoint into `CutMove`s (rotary: X and A). */
export function rotaryMovesOf(cp: Checkpoint, timeline: Timeline): CutMove[] {
  const out: CutMove[] = [];
  const n = cp.steps.length;
  for (let i = 0; i < n; i++) {
    const step = cp.steps[i] as number;
    const x0 = cp.xy[i * 4] as number;
    const x1 = cp.xy[i * 4 + 2] as number;
    const z0 = cp.zs[i * 2] as number;
    const z1 = cp.zs[i * 2 + 1] as number;
    const aEnd = timeline.stateAt(step).a;
    const aStart = timeline.stateAt(step - 1).a;
    out.push({
      step,
      line: timeline.events[step]?.line ?? -1,
      u0: x0,
      u1: x1,
      v0: aStart ?? aEnd ?? 0,
      v1: aEnd ?? aStart ?? 0,
      z: Math.min(z0, z1),
    });
  }
  return out;
}

function zeroStats(): SweepStats {
  return {
    airMovesChecked: 0,
    airMovesRechecked: 0,
    airMovesClearedByConstruction: 0,
    stockVolume: 0,
    resultVolume: 0,
    removedVolume: 0,
    removedFromPart: 0,
    removedFromSacrificial: 0,
    checkpointsSwept: 0,
    checkpointsSkipped: 0,
    contours: 0,
    ms: { union2d: 0, extrude: 0, subtract: 0, airCheck: 0, total: 0 },
    engine: 'column',
    resolution: { ...COLUMN_SIM_RESOLUTION },
  };
}

/**
 * Sweep a timeline with the column engine. A ROTARY job (A moves) uses the rotary
 * parameterisation and refuses (`rotary-stock`) a non-cylinder stock; a non-rotary job uses the
 * FLAT parameterisation and refuses (`flat-stock`) a non-prism stock. Both refuse (`tool-refused`)
 * a tool neither parameterisation can hold: a ball or bull nose, or — since #405 — a V-bit, and
 * since #382 a drill or a thread mill, on a ROTARY job, which has no form in a single-valued radius
 * column. The rotary engine refuses
 * (`axis-crossing`) a genuine crossing and warns (`axis-clamped`) about shallow dips it clamped.
 * Diagnostic `code`s match the exact sweeper's vocabulary so the UI does not learn a second set.
 */
export function columnSweep(timeline: Timeline, tool: Tool, setup: Setup, opts?: ColumnSweepOpts): ColumnOutcome {
  const t0 = performance.now();
  const rotary = timeline.summary.rotary;
  // The cutter, in the parameterisation's terms. The FLAT engine takes a V-bit's cone (#405), a
  // drill's bounded point and a thread mill's envelope (#382); ROTARY takes a flat end mill only, and
  // refuses the rest by name rather than sweeping them as one — a V-bit on a turntable is #221's
  // chamfer-profile work, and a drill or a thread mill about the A axis has no model here.
  const resolved = columnCutterFor(tool, opts?.drillPointDefault);
  if (!resolved.ok) return { ok: false, diagnostics: [{ severity: 'error', code: 'tool-refused', message: resolved.reason }] };
  if (rotary && resolved.kind !== 'flat') {
    const what =
      resolved.kind === 'v'
        ? "a V-bit, whose cone about a turntable axis is a different body (#221's chamfer profiles)"
        : resolved.kind === 'drill'
          ? 'a drill, whose cone point about a turntable axis is not modelled'
          : 'a thread mill, whose envelope about a turntable axis is not modelled';
    return {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'tool-refused', message: `the rotary column engine sweeps a flat end mill only; tool "${tool.name}" is ${what}` }],
    };
  }
  const param: ColumnParameterisation = rotary ? ROTARY : FLAT;
  if (rotary && setup.part.kind !== 'cylinder') {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'rotary-stock', message: `the rotary column engine sweeps a cylinder stock; the setup's part is a ${setup.part.kind}` }] };
  }
  if (!rotary && setup.part.kind !== 'prism') {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'flat-stock', message: `the flat column engine sweeps a prism stock; the setup's part is a ${setup.part.kind}` }] };
  }
  // The grid's pitches are the shop's (#438, #451): the caller reads `sim.columnPitchXMm`,
  // `sim.rotaryPitchDeg` and `sim.columnFlatPitchYMm` from the location because the worker cannot,
  // and each falls back to its labelled constant when absent. A FLAT job's second axis is
  // millimetres, not the rotary's degrees, so it takes the flat Y pitch. An explicit `resolution`
  // still wins over all three. A pitch that is not a positive number (the location validates it; a
  // hand-built caller may not) falls back too, rather than building a grid of zero or infinite rows.
  const positive = (asked: number | null | undefined, fallback: number): number =>
    typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : fallback;
  const pitchX = positive(opts?.columnPitchXMm, COLUMN_PITCH_X_FALLBACK_MM);
  const rotaryPitch = positive(opts?.rotaryPitchDeg, COLUMN_ROTARY_PITCH_FALLBACK_DEG);
  const flatPitch = positive(opts?.flatPitchYMm, COLUMN_FLAT_PITCH_Y_FALLBACK_MM);
  const res: ColumnResolution =
    opts?.resolution ?? (rotary ? { dx: pitchX, dThetaDeg: rotaryPitch } : { dx: pitchX, dThetaDeg: flatPitch });
  // A thread mill's ENVELOPE is widened by half a cell diagonal (#382 review): a column is cut when
  // its CENTRE is within the radius, so at the 0.1 mm default a small radius can lose up to half a
  // cell around its edge. Widened, every column whose cell the true cylinder touches is cut — the
  // over-removal side, which is the side an envelope promises.
  let cutter = resolved.cutter;
  if (resolved.kind === 'thread-envelope') {
    const pad = Math.hypot(res.dx, res.dThetaDeg) / 2;
    cutter = { ...cutter, radius: cutter.radius + pad };
  }

  // Resolve every checkpoint's moves once. `stateAt` is snapshotted (O(512)), not recomputed.
  const perCheckpoint = timeline.checkpoints.map((cp) => (rotary ? rotaryMovesOf(cp, timeline) : flatMovesOf(cp, timeline)));
  const allMoves = perCheckpoint.flat();
  const tBuild = performance.now();
  let grid: ColumnGrid;
  try {
    grid = param.buildGrid(setup, cutter, allMoves, res);
  } catch (e) {
    return { ok: false, diagnostics: [{ severity: 'error', code: rotary ? 'rotary-stock' : 'flat-stock', message: e instanceof Error ? e.message : String(e) }] };
  }
  const stats = zeroStats();
  stats.resolution = { dx: grid.du, dThetaDeg: grid.dv };
  // The cutter's own notes first: the drill's point and where its angle came from, the thread mill's
  // envelope (#382) — said wherever the result is read, never only in a comment.
  const diagnostics: SweepDiagnostic[] = [...resolved.diagnostics];
  // The thread mill's NECK (#382 review): the envelope is its cutting diameter all the way up, which
  // is honest only as deep as the neck reaches. Past it the shank is wider and would rub, so the
  // exact sweeper's own holder gate is asked — `holder-collision` past a stated shoulder/flute
  // length, `holder-unproven` when the record states neither.
  if (resolved.kind === 'thread-envelope') {
    let deepest: number | null = null;
    for (const m of allMoves) if (m.z < grid.initial) deepest = Math.max(deepest ?? 0, grid.initial - m.z);
    const neck = holderGate(tool, deepest);
    if (neck) diagnostics.push(neck);
  }
  const tGrid = performance.now();

  const count = perCheckpoint.length;
  const deadline = opts?.budgetMs === undefined ? null : tGrid + opts.budgetMs;
  const anchorEvery = Math.max(COLUMN_MIN_ANCHOR_EVERY, Math.ceil(count / COLUMN_MAX_ANCHORS));
  // anchors[k] is a full grid copy after checkpoint k, for k ≡ anchorEvery−1 (mod anchorEvery),
  // plus the last checkpoint. Snapshotting is a `slice`, the only allocation in the hot loop.
  const anchors = new Map<number, Float32Array>();
  let ops = 0;
  let clampedMoves = 0;
  let clampedWorst = 0;

  for (let k = 0; k < count; k++) {
    for (const m of perCheckpoint[k] as CutMove[]) {
      const r = param.applyMove(grid, m, cutter);
      ops += r.written;
      if (r.crossed) {
        stats.ms.total = performance.now() - t0;
        stats.checkpointsSwept = k;
        return {
          ok: false,
          stats,
          diagnostics: [
            ...diagnostics,
            {
              severity: 'error',
              code: 'axis-crossing',
              message: `line ${m.line}: the cutter tip reaches radius Z ${r.crossed.z.toFixed(3)}, deeper than the tool radius ${cutter.radius.toFixed(4)} mm below the rotary axis, at step ${m.step}: a single-valued radius column cannot represent a cut that crosses the axis (/Rotary.md §4.3, decision R8)`,
            },
          ],
        };
      }
      if (r.clamped) {
        clampedMoves++;
        clampedWorst = Math.min(clampedWorst, r.clamped.z);
      }
    }
    if (k % anchorEvery === anchorEvery - 1 || k === count - 1) anchors.set(k, grid.h.slice());
    if (opts?.onProgress) opts.onProgress(k + 1, count);
    if (deadline !== null && performance.now() > deadline) {
      stats.ms.total = performance.now() - t0;
      stats.checkpointsSwept = k + 1;
      return { ok: false, diagnostics: [{ severity: 'error', code: 'sweep-budget-exceeded', message: `the column sweep passed its ${Math.round((opts?.budgetMs ?? 0) / 1000)} s budget after ${k + 1} of ${count} checkpoints; raise the limit or coarsen the grid (/Rotary.md §4.4)` }] };
    }
  }
  const tSweep = performance.now();
  if (clampedMoves > 0) diagnostics.push({ severity: 'warning', code: 'axis-clamped', message: `${clampedMoves} cutting move(s) took the cutter tip past the rotary axis by less than the tool radius ${cutter.radius.toFixed(4)} mm and were clamped to Z 0 (deepest Z ${clampedWorst.toFixed(3)}): the cut did not come out as deep as the program asked and its far-side hollow is not modelled (/Rotary.md §4.3, decision R8)` });

  // Gouges: a rapid whose cutter would cut material (§4.4). Detected, not subtracted; reported
  // with the count and the first step. Solids are a follow-up (see the file note). The check is
  // parameterisation-specific — the rotary model is angular, the flat one a swept disc over
  // (x, y) — so each has its own.
  //
  // The loop BOUND is the cutter's widest footprint over the blank — a flat end's radius, or a
  // cone's flank at the stock's bottom — but the per-column TEST is the cutter's own floor at that
  // column (#405): the tip plane for a flat, the cone's flank height above it for a V-bit, exactly
  // the floor `applyMove` writes. A fixed disc footprint is WRONG for a cone — it would call a V
  // trace's own retract a gouge, because columns just outside the groove (0.84 mm wide at 1 mm
  // deep) still stand at the top and the cone's widest reach is 3× that — and the honest test for
  // both shapes is one expression, since `surfaceAboveTip` is 0 inside a flat's radius.
  const gougeRadius = cutterReach(cutter, Math.max(0, grid.initial - grid.base));
  const gouges: { step: number; line: number }[] = [];
  {
    let checked = 0;
    for (const mv of timeline.airMoves) {
      if (checked >= MAX_AIR_CHECKS) {
        diagnostics.push({ severity: 'warning', code: 'air-moves-unchecked', message: `${timeline.airMoves.length - checked} air move(s) not checked: more than ${MAX_AIR_CHECKS} in the job` });
        break;
      }
      checked++;
      const tip = Math.min(mv.from[2], mv.to[2]);
      if (tip > grid.initial) continue; // wholly above the stock
      const gouged = rotary
        ? (() => {
            const aEnd = timeline.stateAt(mv.step).a;
            const aStart = timeline.stateAt(mv.step - 1).a;
            return gougeAlong(grid, mv, gougeRadius, aStart ?? aEnd ?? 0, aEnd ?? aStart ?? 0);
          })()
        : gougeAlongFlat(grid, mv, gougeRadius, cutter);
      if (gouged) {
        if (gouges.length < MAX_GOUGES) gouges.push({ step: mv.step, line: mv.line });
      }
    }
    stats.airMovesChecked = checked;
    if (gouges.length > 0) diagnostics.push({ severity: 'error', code: 'rapid-through-stock', message: `${gouges.length} rapid${gouges.length === 1 ? '' : 's'} pass through material still present at that point in the program (first at line ${gouges[0]?.line})` });
  }
  const tAir = performance.now();

  const stockGrid: ColumnGrid = { ...grid, h: new Float32Array(grid.h.length).fill(grid.initial) };
  const vol = param.volume(grid);
  stats.stockVolume = vol.stock;
  stats.removedVolume = vol.removed;
  stats.removedFromPart = vol.removed;
  stats.resultVolume = vol.stock - vol.removed;
  stats.checkpointsSwept = count;
  stats.columnOps = ops;

  const displayRes = opts?.resolution ? { dx: Math.max(res.dx, COLUMN_DISPLAY_RESOLUTION.dx), dThetaDeg: Math.max(res.dThetaDeg, COLUMN_DISPLAY_RESOLUTION.dThetaDeg) } : COLUMN_DISPLAY_RESOLUTION;
  const stock = param.mesh(stockGrid, displayRes);
  const result = param.mesh(grid, displayRes);
  stats.ms.union2d = 0;
  stats.ms.extrude = tSweep - tGrid;
  stats.ms.subtract = tAir - tSweep;
  stats.ms.airCheck = tAir - tSweep;
  stats.ms.total = performance.now() - t0;
  void tBuild;

  const meshAt = (k: number): NodeMeshOutput => {
    if (k < 0 || count === 0) return param.mesh(stockGrid, displayRes);
    const kk = Math.min(count - 1, Math.trunc(k));
    let a = -1;
    for (let i = kk; i >= 0; i--) {
      if (anchors.has(i)) {
        a = i;
        break;
      }
    }
    const scratch: ColumnGrid = { ...grid, h: (a >= 0 ? (anchors.get(a) as Float32Array) : grid.h).slice() };
    const from = a >= 0 ? a : 0;
    if (a < 0) scratch.h.fill(grid.initial);
    for (let i = from; i <= kk; i++) for (const m of perCheckpoint[i] as CutMove[]) param.applyMove(scratch, m, cutter);
    return param.mesh(scratch, displayRes);
  };

  return {
    ok: true,
    count,
    stockTopZ: grid.initial,
    radius: grid.initial,
    grid,
    stats,
    diagnostics,
    stock,
    result,
    gouges,
    meshAt,
    axisClamped: clampedMoves > 0 ? { count: clampedMoves, deepestZ: clampedWorst } : null,
  };
}

/**
 * Is the tool, swept along an air move, below any column's remaining ρ — a gouge? The tool tip
 * is at work radius `tipZ = min(z)`, and a column at angle θ is under the tool while |θ − A(t)|
 * is within `φ_max = atan(r_eff/tipZ)`; there the material surface is at ρ = h, and the tool is
 * inside it when `tipZ < h`. Sampled along the move at the grid's own X pitch.
 */
function gougeAlong(
  grid: ColumnGrid,
  mv: { from: readonly [number, number, number]; to: readonly [number, number, number] },
  toolRadius: number,
  a0: number,
  a1: number,
): boolean {
  const { nu, nv, u0, du, dv, h } = grid;
  const xLo = Math.min(mv.from[0], mv.to[0]);
  const xHi = Math.max(mv.from[0], mv.to[0]);
  const steps = Math.max(1, Math.min(64, Math.ceil((xHi - xLo) / du) + 1));
  const dA = a1 - a0;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = mv.from[0] + (mv.to[0] - mv.from[0]) * t;
    const tipZ = mv.from[2] + (mv.to[2] - mv.from[2]) * t;
    if (tipZ > grid.initial) continue;
    const a = a0 + dA * t;
    const iLo = Math.max(0, Math.floor((x - toolRadius - u0) / du));
    const iHi = Math.min(nu - 1, Math.ceil((x + toolRadius - u0) / du));
    const phiMax = tipZ > 0 ? Math.atan2(toolRadius, tipZ) / DEG : 90;
    let jLo = Math.floor((a - phiMax) / dv);
    let jHi = Math.ceil((a + phiMax) / dv);
    if (jHi - jLo >= nv) {
      jLo = 0;
      jHi = nv - 1;
    }
    for (let i = iLo; i <= iHi; i++) {
      const xc = u0 + i * du;
      const dx = xc < xLo ? xLo - xc : xc > xHi ? xc - xHi : 0;
      if (dx > toolRadius) continue;
      for (let jj = jLo; jj <= jHi; jj++) {
        const j = ((jj % nv) + nv) % nv;
        const phi = wrap180(j * dv - a);
        if (Math.abs(phi) > phiMax) continue;
        if (tipZ < (h[j * nu + i] as number)) return true;
      }
    }
  }
  return false;
}

/**
 * Sub-micron slack on the gouge comparison, mm. The cut pass and the gouge check compute the
 * distance from a column to the move's segment along two different code paths, and for a column
 * beside a segment's endpoint the two answers differ in the last bits (~1e-9 mm) — enough for a
 * `<` to call a retract out of its own groove a gouge. A real gouge removes material by a
 * fraction of a millimetre, so a micron of slack hides the noise and not a cut.
 */
const GOUGE_EPSILON = 1e-6;

/**
 * The flat-parameterisation gouge check (#222): a rapid whose cutter would cut material the program
 * has not removed. `toolRadius` bounds the columns the move can touch (the cutter's widest reach);
 * a column is gouged when the cutter's floor there — `tipZ + surfaceAboveTip` for the cutter's own
 * shape (#405) — is below its remaining `h`. Sampled at the grid pitch, capped so a long rapid
 * stays bounded.
 */
function gougeAlongFlat(
  grid: ColumnGrid,
  mv: { from: readonly [number, number, number]; to: readonly [number, number, number] },
  toolRadius: number,
  cutter: ColumnCutter,
): boolean {
  const { nu, nv, u0, du, v0, dv, h } = grid;
  const xLo = Math.min(mv.from[0], mv.to[0]);
  const xHi = Math.max(mv.from[0], mv.to[0]);
  const yLo = Math.min(mv.from[1], mv.to[1]);
  const yHi = Math.max(mv.from[1], mv.to[1]);
  const seg = Math.hypot(xHi - xLo, yHi - yLo);
  const steps = Math.max(1, Math.min(64, Math.ceil(seg / du) + 1));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = mv.from[0] + (mv.to[0] - mv.from[0]) * t;
    const y = mv.from[1] + (mv.to[1] - mv.from[1]) * t;
    const tipZ = mv.from[2] + (mv.to[2] - mv.from[2]) * t;
    if (tipZ > grid.initial) continue;
    const iLo = Math.max(0, Math.floor((x - toolRadius - u0) / du));
    const iHi = Math.min(nu - 1, Math.ceil((x + toolRadius - u0) / du));
    const jLo = Math.max(0, Math.floor((y - toolRadius - v0) / dv));
    const jHi = Math.min(nv - 1, Math.ceil((y + toolRadius - v0) / dv));
    for (let j = jLo; j <= jHi; j++) {
      const yc = v0 + j * dv;
      for (let i = iLo; i <= iHi; i++) {
        const xc = u0 + i * du;
        const rho = distToSegment(xc, yc, mv.from[0], mv.from[1], mv.to[0], mv.to[1]);
        if (rho > toolRadius) continue;
        // The floor the cutter leaves at this column is `applyMove`'s (`tipZ + surfaceAboveTip`):
        // 0 above the tip inside a flat end's radius, a rising flank outside a V-bit's tip. A
        // column standing above that floor is material the rapid cuts — a gouge. For a flat end
        // this is exactly `tipZ < h`.
        const floorHere = tipZ + surfaceAboveTip(cutter, rho);
        if (floorHere < (h[j * nu + i] as number) - GOUGE_EPSILON) return true;
      }
    }
  }
  return false;
}

