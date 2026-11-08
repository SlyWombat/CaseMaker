/**
 * #955/V2-2 — THE EDGE-BREAK ALLOWANCE'S PARAMETERS, from the JOB, never from the CAM (A's R3).
 *
 * `checkGoalCutInto` (measurement side) knows the geometry of the rule but not the job's cutter: it
 * takes a reach and a leg as plain numbers. This module produces those two numbers from
 *  - the goal's stated edge break (D's #963 `edgeBreak`, with #829's `chamfer` as the old name), and
 *  - the chamfer Tool record's own geometry — the cone's outer radius and its leg,
 *    `(outerRadius − tipRadius) / tan(halfAngle)`, the deepest the flank reaches at that radius.
 *
 * The CAM's plan is not read: the job says an edge break is wanted, the tool record says how big
 * the bit is, and the gate sizes its allowance from those two facts alone. The same two facts let
 * it refuse to excuse anything: no stated edge break, no allowance.
 *
 * `wallShadowRadiusMm` is a separate cell class — E's "wall shadow", the cells within the largest
 * cutting tool's radius of a wall that a heightfield stamp cannot adjudicate. The caller passes the
 * tool keys of the run's programs; this module returns the largest cutting radius.
 */

import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { coneHeight, vCone } from '@/engine/cnc/vProfile';
import type { GoalCutIntoOptions } from './designCheck';
import { pureGoalObject } from './jobSetup';

/** #963's edge-break block, read structurally until that field's type is on main. */
interface GoalEdgeBreakView {
  widthMm: number;
  toolKey?: string;
  /** #1064 — absent = `silhouette` (the part's own outline). */
  edges?: 'silhouette' | 'all';
}

/** What `checkGoalCutInto` takes: the allowance, or nothing when the job states none. */
export type GoalEdgeBreakOptions = Pick<
  GoalCutIntoOptions,
  'edgeBreak' | 'wallShadowRadiusMm' | 'stockThicknessMm' | 'breakthroughMm'
>;

function statedEdgeBreak(goal: EngraveTargetObject): GoalEdgeBreakView | undefined {
  const target = goal as EngraveTargetObject & {
    edgeBreak?: GoalEdgeBreakView;
    chamfer?: GoalEdgeBreakView;
  };
  return target.edgeBreak ?? target.chamfer;
}

/** A V tool's cutting radius and cone leg, or null when the record is not a V with a body+angle. */
export function vToolAllowance(tool: Tool): { reachMm: number; legMm: number } | null {
  const cone = vCone(tool);
  if (cone === null || cone.outerRadius === undefined) return null;
  const leg = coneHeight(cone);
  if (leg === null || !(leg > 0) || !(cone.outerRadius > 0)) return null;
  return { reachMm: cone.outerRadius, legMm: leg };
}

function cuttingRadius(tool: Tool): number | null {
  const cone = vCone(tool);
  if (cone?.outerRadius !== undefined) return cone.outerRadius;
  const d = cuttingDiameter(tool);
  return d !== null && d > 0 ? d / 2 : null;
}

/**
 * The gate parameters for one job: the allowance from the stated edge break (the widest usable V
 * bit among the pinned key and the run's programs), and the wall-shadow radius from the widest
 * cutting tool. Empty when the job states no edge break and no tool states a radius.
 */
export function goalEdgeBreakOptions(
  job: EngraveJob,
  toolFor: (key: string) => Tool | null,
  programToolKeys: readonly string[],
): GoalEdgeBreakOptions {
  const tools: Tool[] = [];
  for (const key of new Set(programToolKeys)) {
    const tool = toolFor(key);
    if (tool !== null) tools.push(tool);
  }
  let wallShadowRadiusMm: number | undefined;
  for (const tool of tools) {
    const r = cuttingRadius(tool);
    if (r !== null && (wallShadowRadiusMm === undefined || r > wallShadowRadiusMm)) wallShadowRadiusMm = r;
  }

  const goal = pureGoalObject(job);
  const stated = goal === null ? undefined : statedEdgeBreak(goal);
  if (stated === undefined) return wallShadowRadiusMm === undefined ? {} : { wallShadowRadiusMm };

  const pinned = stated.toolKey === undefined ? null : toolFor(stated.toolKey);
  let allowance: { reachMm: number; legMm: number; toolNumber?: number; edges: 'silhouette' | 'all' } | null = null;
  for (const tool of [pinned, ...tools]) {
    if (tool === null) continue;
    const candidate = vToolAllowance(tool);
    if (candidate !== null && (allowance === null || candidate.reachMm > allowance.reachMm)) {
      // #964 — the V's own tool number rides with the allowance: the check excuses a cell only
      // where this cutter made its deepest stamp (the page's `who` rule).
      // #1064 — the job's own edge scope rides with the numbers; absent means silhouette.
      allowance = {
        ...candidate,
        edges: stated.edges ?? 'silhouette',
        ...(tool.number === null || tool.number === undefined ? {} : { toolNumber: tool.number }),
      };
    }
  }
  return {
    // #1092 (gate v8) — the blank's own depth, for the silhouette proof: the legitimate floor
    // beside the part is −(thickness + breakthrough).
    ...(job.stock === undefined ? {} : { stockThicknessMm: job.stock.thickness }),
    ...(job.breakthrough === undefined ? {} : { breakthroughMm: job.breakthrough }),
    ...(allowance === null ? {} : { edgeBreak: allowance }),
    ...(wallShadowRadiusMm === undefined ? {} : { wallShadowRadiusMm }),
  };
}
