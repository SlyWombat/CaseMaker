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
 *   - the axis-crossing refusal (§4.3, decision R8): a single-valued radius column cannot hold
 *     the interval a sub-axis cut leaves on the far side, so a move that takes the tip to
 *     Z ≤ 0 is refused by name, with the step;
 *   - gouge detection in column space (§4.4): a rapid whose tip is below a column's remaining ρ;
 *   - a DISPLAY-resolution heightfield mesh, rebuilt from a snapshot without a boolean;
 *   - snapshot anchors on the pattern `playback.ts` uses: a full grid copy every N checkpoints,
 *     with the moves between replayed to reach any frame.
 *
 * THE INTERFACE #222 EXTENDS. `columnSweep` is parameterisation-generic: it owns the grid walk,
 * the budget, the anchors, the mesh cadence and the refusal vocabulary, and delegates everything
 * axial to a `ColumnParameterisation` (build the grid, apply one move, mesh). Only
 * `ROTARY` exists today; the flat one adds `buildGrid`/`applyMove`/`mesh` and nothing else.
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
import type { Setup } from '@/engine/cnc/setup';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import type { NodeMeshOutput } from './meshOutput';
import type { SweepDiagnostic, SweepStats } from './sweep';
import { MAX_AIR_CHECKS, MAX_GOUGES } from './sweep';

/** A column grid. Rotary: `u` is work X, `v` is the stock angle θ in degrees, `h` is radius ρ. */
export interface ColumnGrid {
  readonly kind: ColumnParameterisation['kind'];
  /** Columns along `u` (rotary: X). */
  readonly nu: number;
  /** Columns along `v` (rotary: θ). */
  readonly nv: number;
  /** Work coordinate of column (0,0)'s centre on the first axis (rotary: X, mm). */
  readonly u0: number;
  /** First-axis pitch (mm). */
  readonly du: number;
  /** Second-axis pitch (rotary: degrees). */
  readonly dv: number;
  /** The untouched column value (rotary: the stock radius R). */
  readonly initial: number;
  /** Remaining value: `h[j*nu + i]`. Rotary: remaining radius from the axis. */
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
}

export interface ColumnResolution {
  /** Spacing along the stock axis, mm. */
  dx: number;
  /** Spacing around the stock, degrees. */
  dThetaDeg: number;
}

/** The §4.4 estimate for the ENVELOPE, to be measured against a real load. */
export const COLUMN_SIM_RESOLUTION: ColumnResolution = { dx: 0.1, dThetaDeg: 0.25 };
/** The §4.4 estimate for the display mesh — coarser on purpose; the mesh is not the answer. */
export const COLUMN_DISPLAY_RESOLUTION: ColumnResolution = { dx: 0.5, dThetaDeg: 1 };
/** Full grid snapshots kept per job; the cadence grows with the checkpoint count to bound memory. */
export const COLUMN_MIN_ANCHOR_EVERY = 16;
export const COLUMN_MAX_ANCHORS = 32;
/**
 * How far the tip may go below the axis before the cut is refused instead of clamped, mm
 * (decision R8). ZERO is the design's rule: **any** move whose tip reaches Z ≤ 0 is refused.
 * A non-zero value clamps such a move to the axis and warns (`axis-clamped`) instead — the knob
 * the maintainer needs if a job that grazes the axis should still simulate. See the probe:
 * both Nefertiti files reach Z ≤ 0, the rough only to −0.70 (4 moves) and the finish to −5.0
 * (3 847 moves), so no non-zero tolerance can refuse the finish at its FIRST Z ≤ 0 step while
 * admitting the rough (the finish's first dip, −0.05, is the SHALLOWER of the two).
 */
export const AXIS_CROSSING_TOLERANCE_MM = 0;

export interface ColumnParameterisation {
  readonly kind: 'rotary' | 'flat';
  /** Build the initial grid from the setup, the tool and the program's own extent. */
  buildGrid(setup: Setup, toolRadius: number, moves: readonly CutMove[], res: ColumnResolution): ColumnGrid;
  /** Subtract one move; report a crossing when the model cannot hold it. */
  applyMove(grid: ColumnGrid, m: CutMove, toolRadius: number, axisToleranceMm: number): MoveResult;
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
  /** Override `AXIS_CROSSING_TOLERANCE_MM` (the probe demonstrates the relaxed reading). */
  axisToleranceMm?: number;
}

export interface ColumnSweepOk {
  ok: true;
  /** Checkpoints; valid `meshAt` indices are -1 … count-1. */
  count: number;
  /** Work-frame Z of the stock's top: for a rotary job, the stock RADIUS (R6). */
  stockTopZ: number;
  radius: number;
  stats: SweepStats;
  diagnostics: SweepDiagnostic[];
  /** Uncut stock, display resolution. */
  stock: NodeMeshOutput;
  /** Final stock, display resolution. */
  result: NodeMeshOutput;
  /** Gouges found in column space. No solids yet — see the file note on `gouges`. */
  gouges: { step: number; line: number }[];
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

  buildGrid(setup, toolRadius, moves, res) {
    const part = setup.part;
    if (part.kind !== 'cylinder') {
      throw new Error(`the rotary column engine sweeps a cylinder stock; the setup's part is a ${part.kind}`);
    }
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
    return { kind: 'rotary', nu, nv, u0: xMin + res.dx / 2, du: (xMax - xMin) / nu, dv: 360 / nv, initial: R, h };
  },

  applyMove(grid, m, toolRadius, tol) {
    // R8: the single-valued model cannot hold a cut that crosses the axis.
    if (m.z <= -tol) return { written: 0, crossed: { z: m.z } };
    const zt = m.z <= 0 ? 0 : m.z; // clamped only when tol > 0 admits it
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
    return { written, crossed: null };
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
 * Sweep a rotary timeline with the column engine. Refuses (`rotary-stock`) a non-cylinder stock,
 * (`tool-refused`) a non-flat tool, and (`axis-crossing`) the first move whose tip reaches the
 * axis. Diagnostic `code`s match the exact sweeper's vocabulary so the UI does not learn a
 * second set.
 */
export function columnSweep(timeline: Timeline, tool: Tool, setup: Setup, opts?: ColumnSweepOpts): ColumnOutcome {
  const t0 = performance.now();
  const rr = cuttingRadiusForSweep(tool);
  if (!rr.ok) return { ok: false, diagnostics: [{ severity: 'error', code: 'tool-refused', message: rr.reason }] };
  const toolRadius = rr.radius;
  if (setup.part.kind !== 'cylinder') {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'rotary-stock', message: `the rotary column engine sweeps a cylinder stock; the setup's part is a ${setup.part.kind}` }] };
  }
  const res = opts?.resolution ?? COLUMN_SIM_RESOLUTION;
  const tol = opts?.axisToleranceMm ?? AXIS_CROSSING_TOLERANCE_MM;
  const param = ROTARY;

  // Resolve every checkpoint's moves once. `stateAt` is snapshotted (O(512)), not recomputed.
  const perCheckpoint = timeline.checkpoints.map((cp) => rotaryMovesOf(cp, timeline));
  const allMoves = perCheckpoint.flat();
  const tBuild = performance.now();
  let grid: ColumnGrid;
  try {
    grid = param.buildGrid(setup, toolRadius, allMoves, res);
  } catch (e) {
    return { ok: false, diagnostics: [{ severity: 'error', code: 'rotary-stock', message: e instanceof Error ? e.message : String(e) }] };
  }
  const stats = zeroStats();
  stats.resolution = { dx: grid.du, dThetaDeg: grid.dv };
  const diagnostics: SweepDiagnostic[] = [];
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
      const r = param.applyMove(grid, m, toolRadius, tol);
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
              message: `line ${m.line}: the cutter tip reaches radius Z ${r.crossed.z.toFixed(3)} ≤ 0 at step ${m.step}: a single-valued radius column cannot represent a cut that crosses the rotary axis (/Rotary.md §4.3, decision R8)`,
            },
          ],
        };
      }
      if (m.z <= 0) {
        clampedMoves++;
        clampedWorst = Math.min(clampedWorst, m.z);
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
  if (clampedMoves > 0) diagnostics.push({ severity: 'warning', code: 'axis-clamped', message: `${clampedMoves} cutting move(s) took the tip below the axis by at most ${AXIS_CROSSING_TOLERANCE_MM} mm and were clamped to it (deepest Z ${clampedWorst.toFixed(3)}): their far-side hollow is not modelled (/Rotary.md §4.3)` });

  // Gouges: a rapid whose tip is below a column's remaining ρ (§4.4). Detected, not subtracted;
  // reported with the count and the first step. Solids are a follow-up (see the file note).
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
      const aEnd = timeline.stateAt(mv.step).a;
      const aStart = timeline.stateAt(mv.step - 1).a;
      if (gougeAlong(grid, mv, toolRadius, aStart ?? aEnd ?? 0, aEnd ?? aStart ?? 0)) {
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
    for (let i = from; i <= kk; i++) for (const m of perCheckpoint[i] as CutMove[]) param.applyMove(scratch, m, toolRadius, tol);
    return param.mesh(scratch, displayRes);
  };

  return {
    ok: true,
    count,
    stockTopZ: grid.initial,
    radius: grid.initial,
    stats,
    diagnostics,
    stock,
    result,
    gouges,
    meshAt,
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

