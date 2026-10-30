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
// Type-only (erased): the CAM module is not pulled into the worker graph (§4's plain-data rule).
import type { SimThreadSpec } from '@/engine/cnc/cam/threadMill';

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
   * whose `radius` already is its outer edge. For a THREAD MILL (#445) it is the padded footprint
   * bound: the tooth's tip radius plus the engine's half-cell widening.
   */
  outerRadius?: number;
  /**
   * A THREAD MILL's tooth root radius, mm (#445): the radius where the 60° tooth meets the reduced
   * neck. At or inside it the cutter is its neck — a level floor at the tip plane; between it and
   * `radius` the tooth's flank rises INWARD, away from the wall, which is the opposite slope to a
   * V-bit. Absent for every other cutter.
   */
  toothRootRadius?: number;
  /**
   * A ROUNDED tip's corner-arc radius, mm (#532): a BALL nose or a BULL nose. Inside `radius` the
   * floor is flat at the tip plane; from `radius` out to `radius + cornerRadius` (= `outerRadius`)
   * it follows a quarter-round of this radius — the torus/sphere surface — and past `outerRadius`
   * the cutter is its cylindrical body, so nothing beyond is cut. A BALL is the special case
   * `radius = 0`, `cornerRadius = outerRadius = R` (a hemisphere of the tool radius); a BULL has
   * `radius = R − cornerRadius`. Absent for every other cutter, and never set together with
   * `toothRootRadius` or a non-null `tanHalf`.
   */
  cornerRadius?: number;
}

/**
 * A metric ISO thread's flank: 60° included, so each flank makes 30° with the axis' normal. In
 * `ColumnCutter` terms the tooth's axial rise per mm of inward radial travel is `1/tanHalf`, the
 * same reading a 60° V-bit uses.
 */
export const THREAD_FLANK_TAN = Math.tan(Math.PI / 6);

/**
 * The cutter a THREAD MILL presents in a column model (#445): a NECK column of `rRoot` plus a 60°
 * tooth cone from the tip radius `rTip` inward to the root. Swept along the program's helix it
 * leaves the thread's pitch and flank in the floor: the tooth's outer edge traces the major
 * diameter, the root traces the basic minor (the pilot), and the flank rises back from the wall
 * as a column moves inward.
 *
 * `cuttingDiameter` is the tool's `d`; `major`/`minor` are the item's ISO basic sizes. `pad` is the
 * engine's half-cell widening, applied only to the FOOTPRINT bound (`outerRadius`), never to the
 * flank's own geometry: widening the flank would raise the floor, which is the under-removal
 * direction.
 *
 * A cutter so small that `rTip − (D − D1)/2` is not positive has no neck left in the model; the
 * tooth then runs to the axis at `rRoot = 0` and the profile stays finite.
 */
export function threadCutter(cuttingDiameter: number, major: number, minor: number, pad = 0): ColumnCutter {
  const rTip = cuttingDiameter / 2;
  const radialDepth = (major - minor) / 2;
  const rRoot = Math.max(0, rTip - radialDepth);
  return { radius: rTip, tanHalf: THREAD_FLANK_TAN, outerRadius: rTip + pad, toothRootRadius: rRoot };
}

/** The surface a column at radial distance `rho` from the tool axis is left at: tip Z + this. */
export function surfaceAboveTip(cutter: ColumnCutter, rho: number): number {
  if (cutter.toothRootRadius !== undefined) {
    // #445 — a thread mill's tooth: the neck is the tip plane, the flank rises INWARD from the
    // tooth tip, and past the (padded) footprint nothing is cut.
    if (rho > (cutter.outerRadius ?? cutter.radius)) return Infinity;
    if (rho <= cutter.toothRootRadius) return 0;
    const h = (cutter.radius - rho) / (cutter.tanHalf as number);
    return h > 0 ? h : 0;
  }
  if (cutter.cornerRadius !== undefined) {
    // #532 — a ball (radius 0) or a bull nose: flat out to `radius`, then a quarter-round of
    // `cornerRadius` whose arc centre is at (radius, cornerRadius) in the (ρ, z) plane. The floor
    // at radial distance ρ is `rc − sqrt(rc² − (ρ − radius)²)`: 0 at ρ = radius (meets the flat),
    // rc at ρ = radius + cornerRadius (meets the cylindrical body). Past the body nothing is cut.
    const outer = cutter.outerRadius ?? cutter.radius + cutter.cornerRadius;
    if (rho > outer) return Infinity;
    if (rho <= cutter.radius) return 0;
    const dr = rho - cutter.radius;
    const rc = cutter.cornerRadius;
    const under = rc * rc - dr * dr;
    return under > 0 ? rc - Math.sqrt(under) : rc;
  }
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
  // #445 — a thread tooth's flank rises INWARD, so its furthest reach is the tooth tip (plus the
  // engine's padding) at every depth; unlike a V-bit it does not widen as the tip goes down.
  if (cutter.toothRootRadius !== undefined) return cutter.outerRadius ?? cutter.radius;
  // #532 — a ball/bull is a cylindrical body of `outerRadius` above the rounded corner, so its XY
  // reach is that body radius at every depth (never more), exactly like a thread tooth's.
  if (cutter.cornerRadius !== undefined) return cutter.outerRadius ?? cutter.radius + cutter.cornerRadius;
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
/**
 * #763 — THE FLOOR a cutter leaves on one column of the rotary grid, given the tool's tip height
 * `zt` (radius above the axis), the column's angular offset φ from the tool (radians) and its
 * axial offset `dx`. The column is the ray `(dx, u·sinφ, u·cosφ)` for u ≥ 0; the cutter's body
 * occupies a set of those points and the smallest u inside it is the floor. The flat's disc
 * reproduces the model the engine has always used exactly (its plane lies at the tip's height, so
 * the ray meets it at `zt/cosφ` and the disc's reach there is `dx² + (zt·tanφ)²`), which is why
 * adding a body here cannot move a flat job.
 */
export function cutterFloorOnColumn(cutter: ColumnCutter, zt: number, phiRad: number, dx: number): number | null {
  const cos = Math.cos(phiRad);
  const sin = Math.sin(phiRad);
  if (!(cos > 1e-9) || !(zt > 0)) return null;
  // BALL (#532/#763): the sphere of R centred on the tool axis at zt + R.
  if (cutter.cornerRadius !== undefined) {
    const R = cutter.cornerRadius;
    if (!(R > 0)) return null;
    const c = zt + R;
    const disc = c * c * cos * cos - (dx * dx + zt * zt + 2 * zt * R);
    if (disc < 0) return null;
    const u = c * cos - Math.sqrt(disc);
    if (!(u > 0)) return null;
    // Past the ball's own radius there is the shank, not the cap.
    if (Math.hypot(dx, u * sin) > (cutter.outerRadius ?? R) + 1e-9) return null;
    return u;
  }
  // FLAT: the disc at the tip's plane, exactly as before.
  if (cutter.tanHalf === null) {
    const dy = zt * Math.tan(phiRad);
    if (dx * dx + dy * dy > cutter.radius * cutter.radius) return null;
    return zt / cos;
  }
  // V (#405/#763): the flat tip first — under it the floor is the tip's plane.
  const tipFloor = zt / cos;
  if (Math.hypot(dx, tipFloor * sin) <= cutter.radius + 1e-12) return tipFloor;
  const k = cutter.tanHalf;
  const b = cutter.radius - zt * k;
  const A = sin * sin - cos * cos * k * k;
  const B = -2 * cos * k * b;
  const C = dx * dx - b * b;
  const roots: number[] = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      roots.push((-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A));
    }
  }
  roots.sort((p, q) => p - q);
  for (const u of roots) {
    if (!(u > tipFloor - 1e-9)) continue;
    const S = k * (u * cos - zt) + cutter.radius;
    if (S < -1e-9) continue;
    if (cutter.outerRadius !== undefined && Math.hypot(dx, u * sin) > cutter.outerRadius + 1e-9) continue;
    return u;
  }
  return null;
}

/**
 * #763 — the ROTARY facet term for any cutter: the rise of the floor at the footprint's angular
 * EDGE above the tip, in the arc-plane model `ROTARY.applyMove` uses. The edge is where the
 * cutter's profile meets the stock's surface (`cutterReach(cutter, depth)`), the profile's own
 * rise there is `surfaceAboveTip` (0 for a flat, R for a ball, the depth for an unbounded V), and
 * the wedge's `1/cos φ` lifts it at that angle. For a flat this is exactly `facetTerm`:
 * `√(Z_t² + r_t²) − Z_t`. The column oracle's band grows by it, and a level's reach.
 */
export function rotaryFacetTerm(cutter: ColumnCutter, tipAboveAxis: number, depth: number): number {
  if (!(tipAboveAxis > 0)) return 0;
  const reach = cutterReach(cutter, depth);
  const edgeRise = surfaceAboveTip(cutter, reach);
  const rise = Number.isFinite(edgeRise) ? edgeRise : depth;
  const cos = tipAboveAxis / Math.hypot(tipAboveAxis, reach);
  return (tipAboveAxis + rise) / cos - tipAboveAxis;
}

export interface DrillPointDefault {
  /** `drill.pointAngleDeg`, included, degrees. */
  deg: number;
  /** That reading's source (`chosen`, `measured`, `seeded`, or `fallback` with no location). */
  source: string;
}

export type ColumnCutterResult =
  | { ok: true; cutter: ColumnCutter; kind: 'flat' | 'v' | 'drill' | 'thread-envelope' | 'ball' | 'bull'; diagnostics: SweepDiagnostic[] }
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
 *   - THREAD MILL: its cutting diameter as a flat cylinder at the tip, which is the FALLBACK for a
 *     file with no thread dimensions. It is a conservative over-removal and a `warning` says so.
 *     When the load brings the thread's own dimensions (#445), `columnSweep` replaces this cylinder
 *     with the real column/cone profile — a reduced neck plus the item's 60° tooth — so the helix
 *     the program emits is left in the floor. Never sized from the thread spec (an M5 mill does not
 *     cut a 5 mm hole: it orbits). A thread mill that states no cutting diameter is refused by name.
 *
 *   - BALL nose (#532): a hemisphere of the tool radius — `radius 0`, `cornerRadius = R`. At radial
 *     distance ρ its floor rises `R − sqrt(R² − ρ²)`, so a move leaves a round-bottomed groove.
 *   - BULL nose (#532): a flat floor out to `R − cornerRadius`, then a quarter-round of the stated
 *     corner radius up to `R`, so a move leaves a filleted corner. Refused if it states no corner.
 *
 * A tapered ball, an unknown shape: refused, as before (#222).
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
  if (tool.shape === 'ball') {
    // A ball nose (#532): the hemisphere's radius is the cutting radius — a 1 mm ball's
    // `cuttingDiameter` is 1, so R = 0.5 — flat part zero, the whole tip a quarter-round of R.
    const d = cuttingDiameter(tool);
    if (d === null || !(d > 0)) {
      return { ok: false, reason: `ball nose "${tool.name}" states no cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})` };
    }
    const r = d / 2;
    return { ok: true, kind: 'ball', cutter: { radius: 0, tanHalf: null, cornerRadius: r, outerRadius: r }, diagnostics: [] };
  }
  if (tool.shape === 'bull') {
    // A bull nose (#532): a flat floor of `R − cornerRadius`, the corner a quarter-round of the
    // stated corner radius out to `R`. A bull that states no corner is a flat end's refusal, not a
    // silent flat sweep — the rounded corner is the whole point of the shape.
    const d = cuttingDiameter(tool);
    if (d === null || !(d > 0)) {
      return { ok: false, reason: `bull nose "${tool.name}" states no cutting diameter (tipdiameter=${tool.tipDiameter}, diameter=${tool.diameter})` };
    }
    const rc = tool.cornerRadius;
    if (rc === null || !(rc > 0)) {
      return { ok: false, reason: `bull nose "${tool.name}" states no corner radius (cornerradius=${tool.cornerRadius}); without it the rounded corner that distinguishes a bull nose cannot be modelled` };
    }
    const r = d / 2;
    // A corner wider than the tool radius is a ball; clamp so the flat part cannot go negative.
    const corner = Math.min(rc, r);
    return { ok: true, kind: 'bull', cutter: { radius: r - corner, tanHalf: null, cornerRadius: corner, outerRadius: r }, diagnostics: [] };
  }
  const trace = cuttingForTrace(tool);
  if (!trace.ok) return trace;
  return trace.tool.shape === 'v'
    ? {
        ok: true,
        kind: 'v',
        cutter: {
          radius: trace.tool.cone.tipRadius,
          tanHalf: trace.tool.cone.tanHalf,
          // #741 — THE CONE ENDS AT THE BIT'S BODY. `outerRadius` is the stated diameter's radius;
          // past it `surfaceAboveTip` says `Infinity` (no cutter reaches that column) and
          // `cutterReach` stops the sweep's footprint there. Without it the engine went on
          // widening the flank past the shank: a 5.1 mm-deep cut on a 3.175 mm bit removed a
          // 10.3 mm-wide V, 1431 mm³ where the physical cone takes 971.
          ...(trace.tool.cone.outerRadius === undefined
            ? {}
            : { outerRadius: trace.tool.cone.outerRadius }),
        },
        diagnostics: [],
      }
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
   * the flat parameterisation cuts towards it; a cut is clamped to {@link floor}.
   */
  readonly base: number;
  /**
   * The lowest value a column may take (#218). Absent, it is `base` and nothing can be removed
   * below the blank — every caller before a through-cut. A FLAT job that cuts through passes
   * `base − breakthrough`, the board's depth below the blank, so the kerf reaches through the
   * bottom face. Rotary never sets it: a radius column cannot go below the axis either way.
   */
  readonly floor?: number;
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
  /**
   * #758 — the tip at each END of the move, when the program ramps Z along the segment. `applyMove`
   * then follows Z along the move (a sloped footprint) instead of sweeping the whole move at `z`;
   * a constant-Z move, and every pre-#758 caller, leaves them absent.
   */
  z0?: number;
  z1?: number;
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
  /**
   * #716 slice 2 — the same columns UNROLLED onto the map (x, arc at the stock radius, radius lost
   * below the surface). Rotary only: a flat grid has no second cylindrical axis to unroll.
   */
  meshMap?(grid: ColumnGrid, res: ColumnResolution): NodeMeshOutput;
  /** Removed and (uncut) stock volume, mm³, from the grid. */
  volume(grid: ColumnGrid): { removed: number; stock: number; sacrificialRemoved?: number };
}

export interface ColumnSweepOpts {
  budgetMs?: number;
  onProgress?: (done: number, total: number) => void;
  /** Override the §4.4 sim-resolution estimate (a spec and the probe set this). */
  resolution?: ColumnResolution;
  /**
   * #776 TEST SEAM. True drives every move through the per-column path the pure-A span sweep
   * replaced, so a spec can compare the two grids cell for cell — the removed volume must be
   * identical, not merely close. Never set by the app.
   */
  noSpanSweep?: boolean;
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
   * How far below the blank's bottom face the program may cut, mm (#218) — the job's breakthrough,
   * read by the caller because the worker holds no job. Absent or zero: the flat grid's floor is
   * the blank's bottom, exactly as before. Present: the floor is `base − breakthroughMm`, so a
   * through cut's kerf is swept through the bottom face and its removal below the blank is
   * reported as `removedFromSacrificial`. The verifier's depth limit is the authority on how deep
   * a cut may go; this only lets the sweep draw the cut the program actually makes.
   */
  breakthroughMm?: number | null;
  /**
   * The ROTARY grid's θ pitch, degrees: the shop's `sim.rotaryPitchDeg`, read by the caller (#451).
   * Absent: {@link COLUMN_ROTARY_PITCH_FALLBACK_DEG}. Ignored by a flat job (its second axis is
   * millimetres) and when `resolution` overrides the whole grid.
   */
  rotaryPitchDeg?: number | null;
  /**
   * The threads the program mills (#445 §4), as the CAM planned them: plain numbers, type-only so
   * this worker does not import the CAM module. With these present the thread mill is swept as its
   * NECK plus the item's 60° TOOTH (a column/cone profile, `threadCutter`) instead of the fallback
   * cylinder, the generic envelope warning is replaced by one line per thread, and each thread is
   * checked against the cutting diameter. A ROTARY job with them is refused by name
   * (`thread-flat-only`): a thread is cut on a flat face, and a single-valued radius column has no
   * form for it.
   */
  threads?: readonly SimThreadSpec[] | null;
  /**
   * The Z ramp, mm, past which a swept XY move is reported as `ramp-over-removed` (#629). ONLY a
   * plain V-bit is swept at its deep end (`min(z0, z1)`) now that #758 follows Z along the move for
   * every other cutter — the V keeps the old rule because its oracle is a per-segment groove at one
   * depth (#408/#674). For a V, the caller passes half the job's smallest level step, so a ramp
   * that can over-remove at a lower level is named. Absent, zero, or any non-V cutter: the check is
   * off and no finding is raised.
   */
  rampThresholdMm?: number | null;
}

export interface ColumnSweepOk {
  ok: true;
  /** Checkpoints; valid `meshAt` indices are -1 … count-1. */
  count: number;
  /** Work-frame Z of the stock's top: for a rotary job, the stock RADIUS (R6). */
  stockTopZ: number;
  radius: number;
  /** #763 — the cutter profile the sweep resolved and used (the oracle's facet term reads it). */
  cutter: ColumnCutter;
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
  /**
   * #716 slice 2 — the same checkpoint UNROLLED onto the map (Unroll in the simulation), or null
   * for a flat grid: a flat job has no second cylindrical axis to unroll.
   */
  meshAtMap: ((k: number) => NodeMeshOutput) | null;
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
    // #758 — a ramp's tip is not one height: follow it along the segment. Every candidate point is
    // judged at the tip height the tool has when it is there, so the foot's floor is the move's
    // own Z at that point, not the whole move's lower end. A constant-Z move reads `z` twice.
    const za0 = m.z0 ?? m.z;
    const za1 = m.z1 ?? m.z;
    const zAt = (t: number): number => za0 + (za1 - za0) * t;
    // A move with no X/A travel is a plunge: the tip is at one point and passes through every Z
    // on the segment, so the deepest end is the floor, not the end a foot parameter would pick.
    const planar = m.u0 !== m.u1 || m.v0 !== m.v1;
    // #763/#723 — A BALL'S OR A V'S BODY IS NOT `radius` WIDE. `radius` is the FLAT part of the
    // tip — 0 for a ball and for a V — and the body's widest radius is `outerRadius` (a ball's
    // hemisphere radius, a V's shank). The footprint windows below must use that BODY REACH: with
    // `radius` alone a ball cut only the columns exactly under its tip, so the scallops between
    // passes stood at the previous pass's floor (found by #723 R-2: a ⌀2 ball at a 0.4 mm
    // step-over left the rough's allowance standing between every pair of passes). A flat is
    // unchanged — its `outerRadius` is absent, so `reach` is its own radius.
    const reach = cutter.outerRadius ?? cutter.radius;
    const { nu, nv, u0, du, dv, h } = grid;
    const xLo = Math.min(m.u0, m.u1);
    const xHi = Math.max(m.u0, m.u1);
    const aLo = Math.min(m.v0, m.v1);
    const aHi = Math.max(m.v0, m.v1);
    let written = 0;
    const iLo = Math.max(0, Math.floor((xLo - reach - u0) / du));
    const iHi = Math.min(nu - 1, Math.ceil((xHi + reach - u0) / du));
    // #240 slice 2 — THE FOOTPRINT IS SWEPT ALONG THE MOVE'S OWN SEGMENT. §4.2's half-strip
    // `|y| ≤ r_t, z ≥ Z_t` is, on the near side at angle φ, the WEDGE `|dx| ≤ r_t` by
    // `|Z_t·tan φ| ≤ r_eff` (the cross-section plane's `y` is `Z_t·tan φ`), and the material it
    // leaves there is `ρ = Z_t/cos φ` up to the facet at `φ_max = atan(r_t/Z_t)`. A move advances
    // X and A together, so a column is cut when it lies within `r_t` of the move's own segment IN
    // THE (x, Z_t·tan φ) PLANE — the tool's work plane at the tip's height. Reading the two axes
    // separately (X against the move's X range, φ against its A range) cuts the corner of every
    // diagonal move — up to `(√2 − 1)·r_t` past where the tool ever goes — and the column-space
    // oracle reports exactly that as an over-cut outside the opened region. This is FLAT's #405
    // rule read in the rotary frame: the cut must use the segment the gouge check reads.
    const perDeg = zt * DEG; // mm of arc at Z_t per degree of A — the linearised foot search only
    const phiMax = (Math.atan2(reach, zt) * 180) / Math.PI; // §4.2's atan(body reach/Z_t)
    const dxs = m.u1 - m.u0;
    const das = (m.v1 - m.v0) * perDeg;
    const len2 = dxs * dxs + das * das;
    // A clamped dip (Z_t = 0) has no floor radius to scale A into, and its footprint no longer
    // couples X with A: every column in the X band and within a quarter turn of the swept A is
    // removed outright. The interval reading is exact there, so it keeps that branch.
    const clampedDip = !(zt > 0);
    if (clampedDip) {
      for (let i = iLo; i <= iHi; i++) {
        const x = u0 + i * du;
        const dx = x < xLo ? xLo - x : x > xHi ? x - xHi : 0;
        if (dx > reach) continue;
        let jLo = Math.floor((aLo - 90) / dv);
        let jHi = Math.ceil((aHi + 90) / dv);
        if (jHi - jLo >= nv) {
          jLo = 0;
          jHi = nv - 1;
        }
        for (let jj = jLo; jj <= jHi; jj++) {
          const j = ((jj % nv) + nv) % nv;
          if (Math.abs(closestAngularOffset(j * dv, aLo, aHi)) > 90) continue;
          const idx = j * nu + i;
          if (0 < (h[idx] as number)) {
            h[idx] = 0;
            written++;
          }
        }
      }
      return { written, crossed: null, clamped };
    }
    // #763 — the footprint is the CUTTER's, not a flat disc's: its profile above the tip
    // (`surfaceAboveTip`) is read at the arc-plane distance, and the footprint's edge is where the
    // profile meets the stock's surface at this tip height — `cutterReach`. A flat reads exactly
    // as before (rise 0, footprint r_t); a ball is a sphere cap (rise R − √(R² − s²)); a V is the
    // cone (rise (s − r_tip)/tan). The tip height follows the move (#758's candidates).
    // θ window: the nearest point can be anywhere on the segment, so θ is within φ_max of the
    // swept A interval. A span of a full turn or more covers every column.
    const fullTurn = aHi - aLo >= 360;
    let jLo = 0;
    let jHi = nv - 1;
    if (!fullTurn) {
      jLo = Math.floor((aLo - phiMax) / dv);
      jHi = Math.ceil((aHi + phiMax) / dv);
      if (jHi - jLo >= nv) {
        jLo = 0;
        jHi = nv - 1;
      }
    }
    for (let jj = jLo; jj <= jHi; jj++) {
      const j = ((jj % nv) + nv) % nv;
      const theta = j * dv;
      // The segment is not repeated on the unrolled cylinder, so the copies a turn either side
      // of the column are what a closeness test near the seam must see — and a move that spans
      // more than a turn passes each column once per turn, so its copies are all of them.
      const kLo = Math.floor((aLo - theta - phiMax) / 360);
      const kHi = Math.ceil((aHi - theta + phiMax) / 360);
      for (let i = iLo; i <= iHi; i++) {
        const x = u0 + i * du;
        let floorHere = Infinity;
        for (let k = kLo; k <= kHi; k++) {
          const th = theta + k * 360;
          // The candidate points: the foot of the perpendicular in the arc-at-Z_t plane (exact
          // for a purely axial or a purely angular move, and the CAM's diagonal moves are short),
          // plus the segment's two ends. The footprint test itself is the WEDGE the arc plane is
          // an approximation of, `dx² + (Z_t·tan φ)² ≤ r_t²`, and the floor is `Z_t/cos φ`.
          let t = 0;
          if (len2 > 0) {
            t = ((x - m.u0) * dxs + (th - m.v0) * perDeg * das) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
          }
          for (let c = 0; c < 3; c++) {
            const tc = c === 0 ? t : c === 1 ? 0 : 1;
            const phi = th - (m.v0 + tc * (m.v1 - m.v0));
            const phiRad = phi * DEG;
            if (phiRad <= -Math.PI / 2 || phiRad >= Math.PI / 2) continue;
            const dx = x - (m.u0 + tc * dxs);
            const ztc = planar ? (zAt(tc) > 0 ? zAt(tc) : 0) : zt;
            // #763 — the floor THIS candidate leaves on THIS column for the cutter's own body:
            // the material the body occupies along the column is removed, and the lowest such
            // point is the floor. The body is the flat's disc, the ball's sphere or the V's cone.
            const f = cutterFloorOnColumn(cutter, ztc, phiRad, dx);
            if (f !== null && f < floorHere) floorHere = f;
          }
        }
        if (!(floorHere < Infinity)) continue;
        const idx = j * nu + i;
        if (floorHere < (h[idx] as number)) {
          h[idx] = floorHere < 0 ? 0 : floorHere;
          written++;
        }
      }
    }
    return { written, crossed: null, clamped };
  },

  mesh(grid, res) {
    return meshRotary(grid, res);
  },

  meshMap(grid, res) {
    return meshRotaryMap(grid, res);
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

/**
 * #776 — THE PURE-A SPAN SWEEP. A move with `u0 === u1` does not change the cutter's axial offset
 * `dx`, so on the rotary grid its floor and its reach depend only on the COLUMN'S ANGLE, never on
 * its X index: every candidate is one floor value over a contiguous i-span. `applyMove` evaluates
 * that same floor per column, three candidates deep, with a `cos`/`tan` each — which is the hours
 * a cut-resolution relief took.
 *
 * EXACT, NOT APPROXIMATE. Every floor is computed by the same expressions `cutterFloorOnColumn`'s
 * flat branch uses (`zt / Math.cos(phiRad)`), the candidate set is the same three points, and the
 * span boundaries are confirmed against the same inequality the per-column path tests
 * (`dx² + dy² ≤ r²`) so a rounding edge cannot add or drop a column. Writing each candidate's
 * span in turn takes the same `min` the per-column loop folds by hand, so the resulting grid is
 * bit-identical — the `noSpanSweep` seam in the specs proves it against the path it replaced.
 *
 * ONLY A FLAT END MILL takes this path. A ball or a V's floor varies with `dx` inside the
 * footprint, so their footprint is not a constant-floor span; `columnSweep` falls back to
 * `applyMove` for those. A clamped dip (Z at or below the axis) also falls back: that branch has
 * its own interval reading and no floor to span.
 *
 * Returns null when the caller must use `applyMove` instead.
 */
export function applyRotaryPureAFlat(grid: ColumnGrid, m: CutMove, cutter: ColumnCutter): MoveResult | null {
  const zt = m.z > 0 ? m.z : 0;
  // The clamped-dip branch and the crossing refusal stay with `applyMove`.
  if (!(zt > 0)) return null;
  const dxs = m.u1 - m.u0;
  if (dxs !== 0 || m.v0 === m.v1) return null;
  if (cutter.tanHalf !== null || cutter.cornerRadius !== undefined || cutter.toothRootRadius !== undefined) return null;

  const { nu, nv, u0, du, dv, h } = grid;
  const x0 = m.u0;
  const r = cutter.radius;
  const r2 = r * r;
  const reach = cutter.outerRadius ?? cutter.radius;
  const perDeg = zt * DEG;
  const phiMax = (Math.atan2(reach, zt) * 180) / Math.PI;
  const aLo = Math.min(m.v0, m.v1);
  const aHi = Math.max(m.v0, m.v1);
  const das = (m.v1 - m.v0) * perDeg;
  const len2 = dxs * dxs + das * das;
  const za0 = m.z0 ?? m.z;
  const za1 = m.z1 ?? m.z;
  const zAt = (t: number): number => za0 + (za1 - za0) * t;

  const iLo = Math.max(0, Math.floor((x0 - reach - u0) / du));
  const iHi = Math.min(nu - 1, Math.ceil((x0 + reach - u0) / du));
  const fullTurn = aHi - aLo >= 360;
  let jLo = 0;
  let jHi = nv - 1;
  if (!fullTurn) {
    jLo = Math.floor((aLo - phiMax) / dv);
    jHi = Math.ceil((aHi + phiMax) / dv);
    if (jHi - jLo >= nv) {
      jLo = 0;
      jHi = nv - 1;
    }
  }

  let written = 0;
  for (let jj = jLo; jj <= jHi; jj++) {
    const j = ((jj % nv) + nv) % nv;
    const theta = j * dv;
    const kLo = Math.floor((aLo - theta - phiMax) / 360);
    const kHi = Math.ceil((aHi - theta + phiMax) / 360);
    for (let k = kLo; k <= kHi; k++) {
      const th = theta + k * 360;
      // The same parameter `applyMove` computes; dxs = 0, so it is the column's angle alone.
      const tRaw = ((th - m.v0) * perDeg * das) / len2;
      const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
      for (let c = 0; c < 3; c++) {
        const tc = c === 0 ? t : c === 1 ? 0 : 1;
        // A foot clamped to an end duplicates that end candidate exactly (same φ, z, dx).
        if (c === 0 && (tRaw <= 0 || tRaw >= 1)) continue;
        const phi = th - (m.v0 + tc * (m.v1 - m.v0));
        if (phi <= -90 || phi >= 90) continue;
        const ztc = zAt(tc) > 0 ? zAt(tc) : 0;
        if (!(ztc > 0)) continue;
        const phiRad = phi * DEG;
        const cos = Math.cos(phiRad);
        if (!(cos > 1e-9)) continue;
        const dy = ztc * Math.tan(phiRad);
        const w2 = r2 - dy * dy;
        if (w2 < 0) continue;
        const floor = ztc / cos;
        const w = Math.sqrt(w2);

        // The span, then its edges confirmed with the per-column test (rounding may move an edge
        // by one column either way; the grid must match the per-column path exactly).
        let iA = Math.max(iLo, Math.ceil((x0 - w - u0) / du));
        let iB = Math.min(iHi, Math.floor((x0 + w - u0) / du));
        const cut = (i: number): boolean => {
          const dxi = u0 + i * du - x0;
          return dxi * dxi + dy * dy <= r2;
        };
        while (iA <= iB && !cut(iA)) iA++;
        while (iA <= iB && !cut(iB)) iB--;
        while (iA > iLo && cut(iA - 1)) iA--;
        while (iB < iHi && cut(iB + 1)) iB++;
        if (iA > iB) continue;
        const base = j * nu;
        for (let i = iA; i <= iB; i++) {
          const idx = base + i;
          if (floor < (h[idx] as number)) {
            h[idx] = floor;
            written++;
          }
        }
      }
    }
  }
  return { written, crossed: null, clamped: null };
}

/** Euclidean distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
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
 * cut is clamped to the grid's `floor` — `base`, or `base − breakthrough` for a job that cuts
 * through into the board (#218), so nothing can be removed deeper than the blank allows.
 *
 * A NON-FLAT footprint is a height profile over that disc, and this is where it is modelled
 * (#405, the hook #221 reserved here): a V-bit's floor at a column is `tipZ + (ρ − r_t)/tan`, ρ
 * being the column's distance from the move's segment, so the groove it leaves is a V and not a
 * slot of the tip's width. A DRILL is the same cone with a sharp tip, BOUNDED at the drill's radius
 * (`ColumnCutter.outerRadius`, #382), and a THREAD MILL is its neck plus the item's 60° tooth, swept
 * as an inverted cone with a level neck (`ColumnCutter.toothRootRadius`, #445; the fallback for a
 * file with no thread dimensions is its cutting-diameter cylinder — `columnCutterFor`). A BALL is a
 * hemisphere of the tool radius and a BULL nose a flat floor with a quarter-round corner (#532,
 * `ColumnCutter.cornerRadius`): both are a height profile over the disc, so `applyMove` leaves a
 * round-bottomed groove and a filleted corner respectively.
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
    // The lowest floor a cut may leave (#218): the blank's bottom, or — when the caller passed a
    // breakthrough — that far into the board, which is where a through cut's kerf shows.
    const bottom = grid.floor ?? base;
    if (m.z >= initial) return { written: 0, crossed: null, clamped: null }; // wholly above the blank
    const xLo = Math.min(m.u0, m.u1);
    const xHi = Math.max(m.u0, m.u1);
    const yLo = Math.min(m.v0, m.v1);
    const yHi = Math.max(m.v0, m.v1);
    // The cutter's XY reach at THIS tip Z: a flat end's radius, or the radius at which a cone's
    // flank is at the top face. Columns past it cannot be touched by the move.
    const reach = cutterReach(cutter, Math.max(0, initial - m.z));
    // #758 — a ramp's floor follows the tip along the segment: each column takes the Z the tool has
    // at its own foot, so a 3D finish is no longer swept at the move's lower end. Constant Z reads
    // the same number at every foot.
    //
    // A PLAIN V-BIT keeps the low-end rule for now: its oracle model is a per-SEGMENT groove at one
    // depth (#408/#674), and following a ramped V's Z would make the two models disagree — the
    // flute's own acceptance fails on exactly that. A ramp-aware V-groove prediction is its own
    // change; the cutters #758 names (a flat or ball 3D finish, and the thread whose prediction
    // already follows the move) take the sloped rule.
    const followsZ = cutter.tanHalf === null || cutter.toothRootRadius !== undefined;
    const za0 = followsZ ? (m.z0 ?? m.z) : m.z;
    const za1 = followsZ ? (m.z1 ?? m.z) : m.z;
    const dxs = m.u1 - m.u0;
    const dys = m.v1 - m.v0;
    const len2 = dxs * dxs + dys * dys;
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
        // #758 — the tip the cutter has when it is over THIS column. The tool passes the column
        // over an interval of the move, and with Z ramping along it the DEEPEST tip in that
        // interval is the floor. The interval's candidates are the perpendicular foot and the
        // segment's two ends: a column beside the move's start is still under the disc at the END,
        // where the tip is deeper (a 0.04 mm clip the retract found before this rule). Each
        // candidate is tested at its own tip height, so the reach of a cone shrinks as it rises.
        let floor = Infinity;
        let covered = false;
        for (let c = 0; c < 3; c++) {
          let tc = 0;
          if (c === 0) {
            if (len2 > 0) {
              tc = ((x - m.u0) * dxs + (y - m.v0) * dys) / len2;
              tc = tc < 0 ? 0 : tc > 1 ? 1 : tc;
            }
          } else {
            tc = c === 1 ? 0 : 1;
          }
          const rhoC = distToSegment(x, y, m.u0 + tc * dxs, m.v0 + tc * dys, m.u0 + tc * dxs, m.v0 + tc * dys);
          // A pure plunge has no foot to interpolate: the tip is at one (x, y) and passes through
          // every Z on the segment, so the deepest end is the floor it leaves.
          const zt = len2 > 0 ? za0 + (za1 - za0) * tc : m.z;
          if (rhoC > cutterReach(cutter, Math.max(0, initial - zt))) continue;
          covered = true;
          // The floor this candidate leaves: the tip plane for a flat end, the cone's flank
          // height above it otherwise (#405). Clamped to `bottom` — the blank's bottom, or the
          // board's breakthrough floor when the job cuts through (#218).
          const f = zt + surfaceAboveTip(cutter, rhoC);
          const cand = f < bottom ? bottom : f;
          if (cand < floor) floor = cand;
        }
        if (!covered) continue;
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
    let sacrificialRemoved = 0;
    for (let k = 0; k < grid.h.length; k++) {
      const top = Math.min(initial, grid.h[k] as number);
      if (top < base) {
        // Through the blank's bottom (#218): the part's own volume is gone to `base`, and the
        // rest is board material the breakthrough took. The exact sweeper splits these the same
        // way (`removedFromPart` / `removedFromSacrificial`).
        removed += (initial - base) * cellArea;
        sacrificialRemoved += (base - top) * cellArea;
      } else {
        removed += (initial - top) * cellArea;
      }
    }
    const stock = (initial - base) * du * grid.nu * dv * grid.nv;
    return { removed, stock, sacrificialRemoved };
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
    // OUTWARD, not inward: at xMin the face looks -X and at xMax +X. The first R-4 e2e drew both
    // ends as triangular gaps because these two lines were wound the other way and the viewport
    // culls back faces — the caps were there, facing the axis.
    idx.push(cap0, J, Jn);
    idx.push(cap1, nuD * nvD + Jn, nuD * nvD + J);
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
 * #716 slice 2 — mesh a rotary grid UNROLLED onto the map (§3.9's **Unroll**; design §5.1d).
 *
 * The same columns as `meshRotary`, read in the map's frame instead of around the rod: x along,
 * y the arc at the stock's own radius (R·θ, so the map is as wide as the circumference), and
 * z the radius LOST below the surface (ρ − R; the uncut map is flat at 0, a cut is negative like
 * the engrave preview's depths). The solid is closed down to the axis (−R) like the flat column
 * mesh closes to the blank's bottom, with four side skirts; a clamped cut that reaches the axis
 * becomes a degenerate column, handled by the same `through` rule the flat mesh uses.
 */
export function meshRotaryMap(grid: ColumnGrid, res: ColumnResolution): NodeMeshOutput {
  const R = grid.initial;
  const xMin = grid.u0 - grid.du / 2;
  const xMax = grid.u0 + (grid.nu - 0.5) * grid.du;
  const L = Math.max(1e-6, xMax - xMin);
  const nuD = Math.max(1, Math.round(L / res.dx));
  const nvD = Math.max(3, Math.round(360 / res.dThetaDeg));
  const nx = nuD + 1;
  const ny = nvD + 1;
  const topCount = nx * ny;
  const vertexCount = topCount * 2; // a top grid and a bottom grid
  const base = -R;
  const positions = new Float32Array(vertexCount * 3);
  /** Each display column's top Z on the map (radius lost, so ≤ 0). */
  const tops = new Float32Array(topCount);
  const put = (v: number, x: number, y: number, z: number): void => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
  };
  // θ is periodic: the map's two edges are the same seam, so a display node at 360° samples the
  // grid's 0° column and the map closes on itself without a seam gap.
  const sample = (x: number, theta: number): number => {
    const i = Math.min(grid.nu - 1, Math.max(0, Math.round((x - grid.u0) / grid.du)));
    const j = ((Math.round(theta / grid.dv) % grid.nv) + grid.nv) % grid.nv;
    return grid.h[j * grid.nu + i] as number;
  };
  const idxOf = (I: number, J: number): number => I * ny + J;
  for (let I = 0; I <= nuD; I++) {
    const x = xMin + (I / nuD) * L;
    for (let J = 0; J <= nvD; J++) {
      const theta = (J / nvD) * 360;
      const y = R * theta * DEG;
      // The map's surface is the radius lost: the uncut stock sits at z = 0 and a cut goes down.
      const top = Math.min(R, sample(x, theta)) - R;
      tops[idxOf(I, J)] = top;
      put(idxOf(I, J), x, y, top);
      put(topCount + idxOf(I, J), x, y, top < base ? top : base);
    }
  }
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  const through = (I: number, J: number): boolean => (tops[idxOf(I, J)] as number) < base;
  for (let I = 0; I < nuD; I++) {
    for (let J = 0; J < nvD; J++) {
      quad(idxOf(I, J), idxOf(I + 1, J), idxOf(I + 1, J + 1), idxOf(I, J + 1)); // top, +Z
      if (!through(I, J) && !through(I + 1, J) && !through(I + 1, J + 1) && !through(I, J + 1)) {
        quad(topCount + idxOf(I, J), topCount + idxOf(I, J + 1), topCount + idxOf(I + 1, J + 1), topCount + idxOf(I + 1, J)); // bottom, −Z
      }
    }
  }
  // A skirt QUAD is (t0, t1, b1, b0) round its outside; the two triangles must cut the same
  // diagonal. The old second triangle (t0, b0, b1) cut the other one and faced INWARD, so every
  // skirt quad was a triangle plus a hole — the R-4 e2e's stock read as open-sided.
  const side = (t0: number, t1: number, b0: number, b1: number): void => {
    idx.push(t0, t1, b0, t1, b1, b0);
  };
  for (let J = 0; J < nvD; J++) {
    side(idxOf(0, J), idxOf(0, J + 1), topCount + idxOf(0, J), topCount + idxOf(0, J + 1)); // axial −X
    side(idxOf(nuD, J + 1), idxOf(nuD, J), topCount + idxOf(nuD, J + 1), topCount + idxOf(nuD, J)); // axial +X
  }
  for (let I = 0; I < nuD; I++) {
    side(idxOf(I + 1, 0), idxOf(I, 0), topCount + idxOf(I + 1, 0), topCount + idxOf(I, 0)); // seam 0°
    side(idxOf(I, nvD), idxOf(I + 1, nvD), topCount + idxOf(I, nvD), topCount + idxOf(I + 1, nvD)); // seam 360°
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
 *
 * A THROUGH cut (#218) makes a column's top sit BELOW `base`, and the mesh must not pretend the
 * bottom face is intact there: the bottom vertex for such a column is degenerate with the top
 * and every bottom quad touching it is omitted, so the kerf is open through the underside. The
 * top heightfield is drawn at the real floor (`base − breakthrough`), which is the hole the
 * viewport shows; the blank's bottom face is kept everywhere the material remains.
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
  /** Each display column's top Z; below `base` is a through column (#218). */
  const tops = new Float32Array(topCount);
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
      // The real floor, not a clamp to the blank's bottom: a through cut's top is below `base`
      // and the kerf is exactly that hole (#218).
      const top = Math.min(grid.initial, sample(x, y));
      tops[idxOf(I, J)] = top;
      put(idxOf(I, J), x, y, top);
      // Where material remains the bottom is the blank's bottom; where it is through there is no
      // material, so the bottom vertex falls on the top and the quads around it are omitted below.
      put(topCount + idxOf(I, J), x, y, top < grid.base ? top : grid.base);
    }
  }
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  const through = (I: number, J: number): boolean => (tops[idxOf(I, J)] as number) < grid.base;
  for (let I = 0; I < nuD; I++) {
    for (let J = 0; J < nvD; J++) {
      quad(idxOf(I, J), idxOf(I + 1, J), idxOf(I + 1, J + 1), idxOf(I, J + 1)); // top, +Z
      // The underside of the blank, except where the cut is through: there the kerf is open.
      if (!through(I, J) && !through(I + 1, J) && !through(I + 1, J + 1) && !through(I, J + 1)) {
        quad(topCount + idxOf(I, J), topCount + idxOf(I, J + 1), topCount + idxOf(I + 1, J + 1), topCount + idxOf(I + 1, J)); // bottom, −Z
      }
    }
  }
  // A skirt QUAD is (t0, t1, b1, b0) round its outside; the two triangles must cut the same
  // diagonal. The old second triangle (t0, b0, b1) cut the other one and faced INWARD, so every
  // skirt quad was a triangle plus a hole — the R-4 e2e's stock read as open-sided.
  const side = (t0: number, t1: number, b0: number, b1: number): void => {
    idx.push(t0, t1, b0, t1, b1, b0);
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
      z0,
      z1,
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
      z0,
      z1,
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
 * FLAT parameterisation and refuses (`flat-stock`) a non-prism stock. The ROTARY engine refuses
 * (`tool-refused`) every tool but a flat end mill — a V-bit (#405), a drill or a thread mill
 * (#382), and a ball or bull nose (#532) — because a single-valued radius column holds none of
 * their profiles about a turntable axis; the FLAT engine admits them all. The rotary engine refuses
 * (`axis-crossing`) a genuine crossing and warns (`axis-clamped`) about shallow dips it clamped.
 * Diagnostic `code`s match the exact sweeper's vocabulary so the UI does not learn a second set.
 */
export function columnSweep(timeline: Timeline, tool: Tool, setup: Setup, opts?: ColumnSweepOpts): ColumnOutcome {
  const t0 = performance.now();
  const rotary = timeline.summary.rotary;
  // A thread job is a FLAT job, and says so by name (#445 §4): the rotary grid is one radius per
  // (θ, X) column, and the thread's crest/groove is multi-valued in the radius it would need. The
  // refusal comes before the cutter check so the message names the thread, not the tool.
  if (rotary && (opts?.threads?.length ?? 0) > 0) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'thread-flat-only',
          message: `this program cuts ${opts?.threads?.length} milled thread(s), and a thread is simulated on a flat face only: the rotary column grid is a single-valued radius per (θ, X) column, which has no form for a thread, so nothing is claimed about this job`,
        },
      ],
    };
  }
  // The cutter, in the parameterisation's terms. The FLAT engine takes a V-bit's cone (#405), a
  // drill's bounded point and a thread mill's envelope (#382); ROTARY takes a flat end mill only, and
  // refuses the rest by name rather than sweeping them as one — a V-bit on a turntable is #221's
  // chamfer-profile work, and a drill or a thread mill about the A axis has no model here.
  const resolved = columnCutterFor(tool, opts?.drillPointDefault);
  if (!resolved.ok) return { ok: false, diagnostics: [{ severity: 'error', code: 'tool-refused', message: resolved.reason }] };
  // #763 — the rotary engine sweeps a FLAT, a BALL and a V now: each is a profile above the tip
  // over the same arc-plane columns (R-UI-12). Drills, bull noses and thread mills stay refused —
  // their bodies about a turntable axis are not modelled.
  if (rotary && resolved.kind !== 'flat' && resolved.kind !== 'ball' && resolved.kind !== 'v') {
    const what =
      resolved.kind === 'drill'
        ? 'a drill, whose cone point about a turntable axis is not modelled'
        : resolved.kind === 'bull'
          ? 'a bull nose, whose rounded corner about a turntable axis is not modelled'
          : 'a thread mill, whose envelope about a turntable axis is not modelled';
    return {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'tool-refused', message: `the rotary column engine sweeps a flat end mill, a ball nose or a V-bit only; tool "${tool.name}" is ${what}` }],
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
  // A thread mill's cutter (#445): when the load brings the thread's own dimensions, the tool is
  // modelled as its NECK plus a 60° TOOTH — a column/cone profile — so the helix the program
  // already emits leaves the thread's pitch and flank in the floor. Without dimensions (a foreign
  // file, the QA harness) the old cutting-diameter cylinder stays, and so does its warning.
  //
  // The footprint is widened by half a cell diagonal either way (#382 review): a column is cut when
  // its CENTRE is within the shape, so at the 0.1 mm default a small tooth can lose up to half a
  // cell around its edge. Widened, every column whose cell the true cutter touches is cut — the
  // over-removal side, which is the side an envelope promises.
  let cutter = resolved.cutter;
  if (resolved.kind === 'thread-envelope') {
    const pad = Math.hypot(res.dx, res.dThetaDeg) / 2;
    const specs = opts?.threads ?? [];
    if (specs.length > 0) {
      // The ITEM states the thread and the TOOL supplies its cutting diameter (#445 D2). More than
      // one thread size can share this program's one tool; the WIDEST radial depth gives the
      // smallest neck and the widest tooth — the conservative side. The oracle checks each thread
      // against its own size, so a mismatched pairing is still caught there.
      let widest = specs[0]!;
      for (const s of specs) {
        if (s.majorMm - s.minorMm > widest.majorMm - widest.minorMm) widest = s;
      }
      cutter = threadCutter(cutter.radius * 2, widest.majorMm, widest.minorMm, pad);
    } else {
      cutter = { ...cutter, radius: cutter.radius + pad };
    }
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
  // A through job lets the flat grid's columns reach the breakthrough into the board (#218). The
  // breakthrough is the caller's reading of the job; absent or zero keeps the floor at the blank's
  // bottom, which is every job that does not cut through and every pre-#218 caller.
  const breakthrough = typeof opts?.breakthroughMm === 'number' && Number.isFinite(opts.breakthroughMm) && opts.breakthroughMm > 0 ? opts.breakthroughMm : 0;
  if (!rotary && breakthrough > 0) grid = { ...grid, floor: grid.base - breakthrough };
  const stats = zeroStats();
  stats.resolution = { dx: grid.du, dThetaDeg: grid.dv };
  // The cutter's own notes first: the drill's point and where its angle came from, the thread mill's
  // envelope (#382) — said wherever the result is read, never only in a comment. A thread job that
  // brought its dimensions (#445 §4) replaces the generic envelope warning below with one line per
  // thread, so the reader learns which thread the envelope stands for and how much it over-removes.
  const threadSpecs = resolved.kind === 'thread-envelope' ? (opts?.threads ?? []) : [];
  const diagnostics: SweepDiagnostic[] =
    threadSpecs.length > 0 ? resolved.diagnostics.filter((d) => d.code !== 'thread-envelope') : [...resolved.diagnostics];
  // #629 — a feed whose Z ramps along its XY segment is swept at its deep end (`min(z0, z1)`), so
  // the sim removes more than the machine would. #758 changed that for every cutter EXCEPT a plain
  // V-bit: the flat and ball/bull finishes and the thread mill follow the tip along the move, so
  // their picture no longer over-removes and this info would be false. A V's oracle is a
  // per-segment groove at one depth, so its cut still takes the low end; this is the one cutter the
  // warning still speaks for. One line per qualifying checkpoint, like the exact path.
  const rampThreshold = opts?.rampThresholdMm ?? null;
  if (!rotary && resolved.kind === 'v' && rampThreshold !== null && rampThreshold > 0) {
    for (let k = 0; k < timeline.checkpoints.length; k++) {
      const cp = timeline.checkpoints[k] as Checkpoint;
      let worst = 0;
      let worstLine = -1;
      let worstStroke = 0;
      for (let i = 0; i < cp.steps.length; i++) {
        // Only an XY move ramps: a plunge is swept at its deep end and over-removes nothing across
        // XY, so it never raises this. The timeline's own `nonConstantZ` draws the same line.
        const x0 = cp.xy[i * 4] as number;
        const y0 = cp.xy[i * 4 + 1] as number;
        const x1 = cp.xy[i * 4 + 2] as number;
        const y1 = cp.xy[i * 4 + 3] as number;
        if (x0 === x1 && y0 === y1) continue;
        const dz = Math.abs((cp.zs[i * 2 + 1] as number) - (cp.zs[i * 2] as number));
        if (dz > worst) {
          worst = dz;
          worstLine = timeline.events[cp.steps[i] as number]?.line ?? -1;
          worstStroke = Math.hypot(x1 - x0, y1 - y0);
        }
      }
      if (worst > rampThreshold) {
        diagnostics.push({
          severity: 'info',
          code: 'ramp-over-removed',
          checkpoint: k,
          message: `a cut that ramps ${worst.toFixed(1)} mm along a ${worstStroke.toFixed(1)} mm stroke at line ${worstLine} was swept at its lowest Z — the picture removes more than the machine would`,
        });
      }
    }
  }
  if (threadSpecs.length > 0) {
    // The fit checks: the same two the CAM refuses on (#445 D2), restated here because this is the
    // simulation of a FILE — a program loaded from elsewhere never met the CAM's own gate. An
    // `error` does not stop the sweep: the moves are still swept as the envelope says, and the
    // removal picture is what this program would make, but the thread it is meant to cut is not
    // the thread it leaves.
    const d = resolved.cutter.radius * 2;
    for (const s of threadSpecs) {
      const radialDepth = (s.majorMm - s.minorMm) / 2;
      if (d >= s.minorMm) {
        diagnostics.push({
          severity: 'error',
          code: 'thread-cutter-fit',
          message: `thread at (${s.x}, ${s.y}): the ${d} mm cutting diameter cannot enter the ⌀${s.minorMm} mm pilot (a thread mill must be smaller than the thread's minor diameter), so this program cannot cut the ⌀${s.majorMm} × ${s.pitchMm} thread`,
        });
      } else if (d < radialDepth) {
        diagnostics.push({
          severity: 'error',
          code: 'thread-cutter-fit',
          message: `thread at (${s.x}, ${s.y}): the ${d} mm cutting diameter spans only ${d.toFixed(3)} mm, less than the ${radialDepth.toFixed(3)} mm radial depth of the ⌀${s.majorMm} over ⌀${s.minorMm} thread, so the cutter cannot reach the major diameter`,
        });
      }
      // The profile still cannot leave the crests, so the over-removal remains an UPPER bound: the
      // annular band between the basic minor and the major, `π/4 (D² − D1²) L`. It needs no
      // thread-profile coefficient, so it cannot be optimistic. The pilot is not an initial
      // condition — the sweep starts from the solid blank — but the modelled neck now traces a
      // ⌀D1 bore, where the shop drills the pilot before this file runs.
      const band = (Math.PI / 4) * (s.majorMm ** 2 - s.minorMm ** 2) * s.threadDepthMm;
      diagnostics.push({
        severity: 'warning',
        code: 'thread-envelope',
        message: `thread at (${s.x}, ${s.y}): ⌀${s.majorMm} × ${s.pitchMm}, ⌀${s.minorMm} pilot, ${s.threadDepthMm} mm; the cutter is simulated as its neck plus a tooth on the item's 60° form, swept along the helix, so the floor follows the thread's pitch and flank; a column holds one height, so the crests between the grooves are not left — the picture over-removes by at most the annular band from ⌀${s.minorMm} to ⌀${s.majorMm} (${band.toFixed(2)} mm³). The neck traces the ⌀${s.minorMm} pilot in the solid blank; the shop drills it first`,
      });
    }
  }
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

  // #776 — the span sweep is exact for a rotary flat end mill's pure-A moves (see
  // `applyRotaryPureAFlat`); every other move, and the test seam that disables it, takes the
  // per-column path. The seam exists so a spec can prove the two grids are identical.
  const spanSweep = rotary && resolved.kind === 'flat' && opts?.noSpanSweep !== true;

  for (let k = 0; k < count; k++) {
    for (const m of perCheckpoint[k] as CutMove[]) {
      const r = (spanSweep ? applyRotaryPureAFlat(grid, m, cutter) : null) ?? param.applyMove(grid, m, cutter);
      ops += r.written;
      if (r.crossed) {
        stats.ms.total = performance.now() - t0;
        stats.checkpointsSwept = k;
        // #716 slice 2 — the simulation's own words (design §3.9): the MOVE number, what the tip
        // does, and that the picture stops at that move. The panel's line link comes from `line`;
        // the move number is 1-based, the way the operator counts the program.
        const past = -r.crossed.z;
        return {
          ok: false,
          stats,
          diagnostics: [
            ...diagnostics,
            {
              severity: 'error',
              code: 'axis-crossing',
              line: m.line,
              step: m.step,
              message: `Move ${m.step + 1} cuts through the centre: the cutter tip reaches ${Number(past.toFixed(3))} mm past the axis. The simulation stops there; the moves after it are drawn, not simulated.`,
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
      return { ok: false, diagnostics: [{ severity: 'error', code: 'sweep-budget-exceeded', message: `the column sweep passed its ${Math.round((opts?.budgetMs ?? 0) / 1000)} s budget after ${k + 1} of ${count} checkpoints; raise the limit or coarsen the grid` }] };
    }
  }
  const tSweep = performance.now();
  if (clampedMoves > 0) diagnostics.push({ severity: 'warning', code: 'axis-clamped', message: `${clampedMoves} cutting move(s) took the cutter tip past the rotary axis by less than the tool radius ${cutter.radius.toFixed(4)} mm and were clamped to Z 0 (deepest Z ${clampedWorst.toFixed(3)}): the cut did not come out as deep as the program asked and its far-side hollow is not modelled` });

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
            return gougeAlong(grid, mv, gougeRadius, aStart ?? aEnd ?? 0, aEnd ?? aStart ?? 0, cutter);
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
  // Material the breakthrough took out of the board UNDER the blank (#218); 0 for every job that
  // does not cut through. The exact sweeper's own split, so a reader sees one pair of numbers.
  stats.removedFromSacrificial = vol.sacrificialRemoved ?? 0;
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

  const gridAt = (k: number): ColumnGrid => {
    if (k < 0 || count === 0) return stockGrid;
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
    return scratch;
  };
  const meshAt = (k: number): NodeMeshOutput => param.mesh(gridAt(k), displayRes);
  const meshMap = param.meshMap;
  const meshAtMap = meshMap === undefined ? null : (k: number): NodeMeshOutput => meshMap(gridAt(k), displayRes);

  return {
    ok: true,
    count,
    stockTopZ: grid.initial,
    radius: grid.initial,
    cutter,
    grid,
    stats,
    diagnostics,
    stock,
    result,
    gouges,
    meshAt,
    meshAtMap,
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
  cutter: ColumnCutter,
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
        // THE FOOTPRINT IS THE TOOL'S DISC, read in the plane the CUT reads (#240): a column is
        // under the tool when `dx² + (Z_t·tanφ)² ≤ r_t²`, the same wedge `applyMove` tests. The
        // rectangle this check used before (X within r_t AND |φ| ≤ atan(r_t/Z_t)) has corners
        // √2·r_t away, so it called the corner of every stroke's own end disc material the cutter
        // never reaches — each stroke's retract then read as a rapid through stock.
        const arc = tipZ * Math.tan((phi * Math.PI) / 180);
        if (dx * dx + arc * arc > toolRadius * toolRadius + 1e-9) continue;
        // THE FLOOR AT THAT COLUMN IS THE CUT'S OWN, face and facet together: along the ray at φ
        // the tool's body crosses at the same surface `applyMove` writes (#763 — the flat's disc,
        // the ball's sphere, the V's cone; a tip at or below the axis keeps the flat reading).
        // Comparing the CENTRELINE height `Z_t` instead calls the facet the same pass just cut —
        // a few thousandths of a millimetre beside the stroke — material the tool is inside, so
        // every stroke's own retract read as a rapid through stock.
        const floorHere = tipZ > 0 ? cutterFloorOnColumn(cutter, tipZ, (phi * Math.PI) / 180, dx) : 0;
        if (floorHere === null) continue;
        // GOUGE_EPSILON, for the reason the flat check gives: the two paths' last bits differed
        // enough for a `<` to call a retract out of its own groove a gouge.
        if (floorHere < (h[j * nu + i] as number) - GOUGE_EPSILON) return true;
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

