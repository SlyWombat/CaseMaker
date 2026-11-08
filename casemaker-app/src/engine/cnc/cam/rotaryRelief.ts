/**
 * #723 R-1 — THE RADIAL HEIGHTFIELD: a goal mesh sampled as a radius per (x, θ) on a rod.
 *
 * A rotary relief is Makera's Rotation Relief (`Rotary.md` class R): the mesh is oriented along
 * the rod's X, the stock is a cylinder, and the cut follows the part's RADIUS around the axis —
 * the rotary analogue of the flat goal's top-Z (`sampleGoalHeightfield`, #534). This module owns
 * the sampling rule and nothing else, so the CAM, the findings and the preview cannot disagree
 * about what the mesh says:
 *
 *     map cell (x, s)  →  angle φ = s / R
 *     r(x, φ) = the OUTERMOST hit of the ray from the axis at X = x, direction (0, sin φ, cos φ)
 *     z       = r − R      (the stock's surface is z = 0; below it is negative — the map height
 *                           the flat goal pipeline and `toRotaryIR` already speak)
 *
 * THE MESH'S PLACEMENT. Its local X is the rod's axis; its local Y/Z section is measured about the
 * axis (a vertex at local (y, z) sits at radius `hypot(y, z)` and angle `atan2(y, z)`), so a mesh
 * modelled as a turned part is correct as authored. `position.x` is the mesh's centre along the
 * rod, `position.y` is the seam offset in map millimetres (it turns the mesh about the rod),
 * `position.z` is ignored on a rod — the radius IS the height — and `scale` applies per axis
 * about the axis (design `docs/design/rotary-relief.md` §Part 1). `rotation` is not read here:
 * turning a mesh about X/Y/Z is part 2's design.
 *
 * THE GRID is the map's: X along the rod, Y the arc at the design radius, zero at the seam; the
 * around extent is the full circumference. A cell no triangle's ray hits keeps the STOCK's surface
 * (`z = 0`, `covered = 0`) — the goal says nothing there, and the CAM leaves the stock standing,
 * exactly as the flat field's sentinel does. The grid is capped like the flat one: above
 * {@link DEFAULT_MAX_CELLS} the pitch is COARSENED and the coarser value is stated, never refused.
 *
 * SINGLE-VALUED, HONESTLY SO. One radius per (x, φ) cannot express an undercut, a re-entrant
 * groove hidden behind the outer surface, or an internal void. The sampler takes the outermost
 * surface, and material the ray re-enters behind it is left standing — the single-axis answer the
 * flat field gives too (#222).
 */

import { ROTARY_JAW_KEEP_OUT_MM } from '@/engine/cnc/rotary/wrap';
import { type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
// #1083 — the sampler itself is the neutral rotary module (the goal check reads it too); this
// module keeps its own API by re-exporting it.
export { sampleGoalRadialField } from '@/engine/cnc/rotary/radialField';
export type { GoalRadialField } from '@/engine/cnc/rotary/radialField';
import type { GoalRadialField } from '@/engine/cnc/rotary/radialField';


// ── R-2: the CAM over the field ────────────────────────────────────────────────────────────────

import type { Tool } from '@/engine/cnc/tool';
import { cuttingDiameter } from '@/engine/cnc/tool';
import {
  DEFAULT_MAX_FINISH_TIP_OPS,
  DEFAULT_STOCK_TO_LEAVE_MM,
  finishTipField,
  finishingMoves,
  type SurfaceFeeds,
  type SurfaceTool,
} from './surfaceFinishTipField';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from './ir';
import { sectionRadiusAt, throughCentreSentence, toRotaryIR, type RotarySection } from '@/engine/cnc/rotary/wrap';

/**
 * The radial field as the flat goal pipeline's heightfield: same grid, same sentinel (0 = the
 * stock's surface), same height convention (negative into the stock). The finish reuses the flat
 * pass's gouge-safe tip drop through this view — one model, not a second one.
 */
export function radialFieldAsHeightfield(field: GoalRadialField): GoalHeightfield {
  return {
    nx: field.nx,
    ny: field.ny,
    x0: field.x0,
    y0: field.y0,
    pitch: field.pitch,
    topZ: 0,
    minZ: field.minRadius - field.radius,
    z: field.z,
    covered: field.covered,
    coveredCount: field.coveredCount,
    resolutionNote: field.resolutionNote,
  };
}

/**
 * #1061 — THE LINE THE RELIEF CAM KEEPS EVERY PLANNED MOVE TO THE RIGHT OF, mm: the jaws' keep-out
 * band plus the cutter's radius, so the cutter's EDGE (not only its tip) stays clear — the same
 * wall `wrap-into-clamp` judges. Exported so the job path states the same clip line the CAM uses.
 */
export function reliefKeepOutX(tool: Tool): number {
  return ROTARY_JAW_KEEP_OUT_MM + (cuttingDiameter(tool) ?? 0) / 2;
}

/**
 * #1061 — CLIP A RADIAL FIELD TO THE CHUCK/JAWS KEEP-OUT: columns whose map X lies left of
 * `keepOutX` are dropped before any move is planned, so nothing the CAM writes can reach into the
 * band. Returns the field unchanged when it already clears the line.
 */
function clipFieldX(field: GoalRadialField, keepOutX: number): { field: GoalRadialField; clippedFromX: number | null } {
  if (field.x0 >= keepOutX - 1e-9) return { field, clippedFromX: null };
  const drop = Math.min(field.nx, Math.ceil((keepOutX - field.x0) / field.pitch - 1e-9));
  const nx = field.nx - drop;
  if (nx <= 0) {
    throw new Error(
      `a rotary relief entirely inside the chuck's keep-out band cannot be cut: the goal lies left of X ${Number(keepOutX.toFixed(3))} mm, where the jaws are`,
    );
  }
  const z = new Float32Array(nx * field.ny);
  const covered = new Uint8Array(nx * field.ny);
  let coveredCount = 0;
  for (let j = 0; j < field.ny; j++) {
    for (let i = 0; i < nx; i++) {
      const from = j * field.nx + (i + drop);
      z[j * nx + i] = field.z[from]!;
      covered[j * nx + i] = field.covered[from]!;
      if (covered[j * nx + i] === 1) coveredCount++;
    }
  }
  return { field: { ...field, nx, x0: field.x0 + drop * field.pitch, z, covered, coveredCount }, clippedFromX: field.x0 };
}

export interface RotaryReliefArgs {
  field: GoalRadialField;
  /**
   * #777 — the stock's section, when it is a block. The field's heights are relative to the
   * turned ENVELOPE; the stock's own surface at a row's angle is `sectionRadiusAt − envelope
   * radius`, and the roughing starts from IT: a layer above the flat has nothing to remove and
   * the sweep retracts instead of cutting air at the envelope radius.
   */
  section?: RotarySection;
  tool: Tool;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  feeds: SurfaceFeeds;
  rapid: RapidEstimate;
  /** Roughing allowance, mm; absent → {@link DEFAULT_STOCK_TO_LEAVE_MM}. */
  stockToLeaveMm?: number;
  /** The finishing tip field's budget; absent → {@link DEFAULT_MAX_FINISH_TIP_OPS}. */
  maxFinishTipOps?: number;
}

export interface RotaryReliefResult {
  /** The rotary-frame IR (through `toRotaryIR`). */
  ir: ToolpathIR;
  roughing: CamOperation;
  finishing: CamOperation;
  roughingLayers: number;
  /** The design radius the program was wrapped at, mm. */
  radius: number;
  /**
   * #1061 — the goal's own left edge when the field was clipped to the chuck/jaws keep-out (null
   * when nothing was clipped). The job path states the clip; the moves are all right of the line.
   */
  clippedFromX: number | null;
}

/**
 * #723 R-2 — THE ROTARY RELIEF CAM: A-sweep roughing at stepped radii, then the ball finish over
 * the radial field, wrapped into the rotary frame.
 *
 * ROUGHING. For each radial layer from the stock's surface down to `minRadius + allowance`, the
 * stock turns through a full A sweep at each map X, the tip riding at the layer but clamped UP to
 * the goal's own radius plus the allowance there — the flat roughing's clamp rule with the scan
 * around the stock instead of across it. A sweep stops and retracts where the clamp reaches the
 * stock's surface (nothing to remove) and resumes in the next run. This first implementation
 * STEPS X between full turns (a raster of A sweeps); the design's X-advances-per-turn spiral is a
 * later option, and both are the same "A sweeps at stepped radii".
 *
 * FINISHING. The flat goal's parallel finish, verbatim, over the radial field's map view: one tip
 * field (the gouge-safe ball drop) and raster passes along X at the finishing step-over. The map's
 * Y is the arc around the rod, so a raster row IS one A angle and the pass along X is a feed at a
 * held A.
 *
 * R8. A tip at or below the axis has no floor: the field's `minRadius <= 0` is refused with the
 * design's own "cuts through the centre" words before any move is written, and the sweep's axis
 * rule is the second check.
 */
export function generateRotaryReliefIR(args: RotaryReliefArgs): RotaryReliefResult {
  const { field, tool, feeds, rapid } = args;
  if (!(field.minRadius > 0)) {
    throw new Error(
      `a rotary relief whose surface reaches the axis cannot be cut: ${throughCentreSentence(field.minRadius)}`,
    );
  }
  const allowance = args.stockToLeaveMm ?? DEFAULT_STOCK_TO_LEAVE_MM;
  const diameter = cuttingDiameter(tool) ?? 0;
  if (!(diameter > 0)) throw new Error(`the rotary relief's cutter ${tool.name} states no cutting diameter`);
  const toolRadius = diameter / 2;
  const surfaceTool: SurfaceTool = { radius: toolRadius, ball: tool.shape === 'ball' || tool.shape === 'bull' };
  // #1061 — the field is CLIPPED to the chuck/jaws keep-out before any move is planned: nothing
  // in the program may reach into the band, at any Z.
  const { field: cutField, clippedFromX } = clipFieldX(field, reliefKeepOutX(tool));
  const hf = radialFieldAsHeightfield(cutField);

  // #1094 — THE ROUGH'S DROP-CUTTER TIP FIELD, COMPUTED ONCE. The A-sweep's per-cell clamp sees
  // only the cell's own angle, so the ball's flank cuts the wall beside a near-axis cell (a
  // narrow gap the cutter cannot enter): a 0.3 mm cell beside an 11.5 mm body is roughed to 0.5 mm
  // and the ball's flank removes the body. The finish's own tip field is the gouge-safe rule — the
  // tip lifted to clear every cell of the ball's disc — so the rough uses the same stencil on the
  // goal-plus-allowance surface: `z' = min(0, z + allowance)`. One pass, shared by every layer.
  const roughHf: GoalHeightfield = {
    ...hf,
    z: Float32Array.from(hf.z, (v) => Math.min(0, v + allowance)),
  };
  const roughTip = finishTipField(roughHf, surfaceTool, args.maxFinishTipOps ?? DEFAULT_MAX_FINISH_TIP_OPS, {
    wrapRows: true,
  });

  // Roughing: the A sweeps at stepped radii, from the stock's own section surface. Each layer's
  // floor stays; the tip never goes below the drop-cutter field's own value.
  const rough = aSweepRoughing(cutField, feeds, allowance, args.section, roughTip);
  const roughing: CamOperation = {
    number: 1,
    name: `[T${args.toolNumber}] rotary 3D rough — ${allowance} mm to leave`,
    labelId: '',
    depth: Math.max(0, 0 - hf.minZ),
    passKind: 'rough',
    moves: rough.moves,
    estimatedSeconds: estimateCycleSeconds(rough.moves, rapid, field.radius),
  };

  // Finishing: the flat goal's parallel finish over the map view.
  // The map's around axis is a circle: the tip field's rows WRAP, or the pass on the seam rides
  // on the stock's surface and leaves the allowance standing in one hairline column.
  const tip = finishTipField(hf, surfaceTool, args.maxFinishTipOps ?? DEFAULT_MAX_FINISH_TIP_OPS, {
    wrapRows: true,
  });
  const finish = finishingMoves(hf, tip, feeds, hf.pitch, SAFE_Z, HOP_Z);
  const finishing: CamOperation = {
    number: 2,
    name: `[T${args.toolNumber}] rotary 3D finish`,
    labelId: '',
    depth: Math.max(0, 0 - hf.minZ),
    passKind: 'finish',
    moves: finish,
    estimatedSeconds: estimateCycleSeconds(finish, rapid, field.radius),
  };

  const mapIr: ToolpathIR = {
    frame: 'flat',
    tool,
    toolNumber: args.toolNumber,
    spindleRpm: args.spindleRpm,
    air: args.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations: [roughing, finishing],
  };
  const ir = toRotaryIR(mapIr, field.radius, rapid);
  // The result carries the WRAPPED operations (A on every move), not the map-space ones they were
  // made from: a caller reading `roughing`/`finishing` is reading the program that will post.
  return {
    ir,
    roughing: ir.operations[0]!,
    finishing: ir.operations[1]!,
    roughingLayers: rough.layers,
    radius: field.radius,
    clippedFromX,
  };
}

/**
 * The A-sweep roughing. Each layer is a set of full turns, one per map X (stepped by the roughing
 * step-over); at each cell the tip is `max(layer, goal + allowance)`, and a sweep retracts where
 * that clamp reaches the stock's surface — there is nothing there to remove.
 */
function aSweepRoughing(
  field: GoalRadialField,
  feeds: SurfaceFeeds,
  allowance: number,
  section: RotarySection | undefined,
  /** #1094 — the drop-cutter tip of the goal-plus-allowance, computed once by the caller. */
  roughTip: Float32Array,
): { moves: CamMove[]; layers: number } {
  const moves: CamMove[] = [];
  const { nx, ny, pitch, x0, covered } = field;
  const minZ = field.minRadius - field.radius;
  if (!(feeds.stepDown > 0)) {
    throw new Error(`a rotary relief's roughing needs a positive step-down; the feeds gave ${feeds.stepDown} mm`);
  }
  const levels: number[] = [];
  const deepest = minZ + allowance;
  for (let L = -feeds.stepDown; L > deepest + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(Math.min(deepest, -1e-6));
  // The map X columns this layer sweeps: a raster of full turns.
  const stride = Math.max(1, Math.round(feeds.roughStepOver / pitch));
  const cols: number[] = [];
  for (let i = 0; i < nx; i += stride) cols.push(i);
  if (cols.length === 0 || cols[cols.length - 1] !== nx - 1) cols.push(nx - 1);

  const retract = (x: number, y: number): void => {
    moves.push({ kind: 'rapid', x, y, z: HOP_Z });
  };
  /**
   * #777 — the stock's surface at a map row's angle, relative to the envelope (0 for a rod; a
   * block's flat is NEGATIVE). A tip at or above it has no material to remove, so the roughing
   * retracts there rather than sweeping the envelope in air.
   */
  const stockSurface = (jj: number): number =>
    section === undefined ? 0 : sectionRadiusAt(section, (jj * pitch) / field.radius) - field.radius;

  for (const L of levels) {
    for (const i of cols) {
      const x = x0 + i * pitch;
      let open = false;
      let prevY = 0;
      for (let j = 0; j <= ny; j++) {
        // One full turn: after ny cells the seam cell closes the loop.
        const jj = j % ny;
        const idx = jj * nx + i;
        const y = j * pitch;
        // #1094 — the precomputed drop-cutter tip of the goal+allowance. It is the max over the
        // ball's whole disc, so it includes the cell's own `z + allowance`; the layer floor below
        // is unchanged.
        const clamp = covered[idx] === 1 ? (roughTip[idx] as number) : 0;
        const tip = Math.max(L, clamp);
        // A cut needs the goal's coverage AND a tip below the stock's own surface at this angle.
        const cut = covered[idx] === 1 && tip < stockSurface(jj) - 1e-9;
        if (cut) {
          if (!open) {
            moves.push({ kind: 'rapid', x, y, z: HOP_Z });
            moves.push({ kind: 'feed', x, y, z: tip, f: feeds.plungeFeed });
            open = true;
          } else {
            moves.push({ kind: 'feed', x, y, z: tip, f: feeds.feed });
          }
          prevY = y;
        } else if (open) {
          retract(x, prevY);
          open = false;
        }
      }
      if (open) retract(x, prevY);
    }
  }
  if (moves.length > 0) {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
  }
  return { moves, layers: levels.length };
}
