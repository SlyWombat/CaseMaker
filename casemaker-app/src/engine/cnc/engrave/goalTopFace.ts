/**
 * #888 — DOES THE PLAN LEAVE ANY OF THE STOCK'S ORIGINAL TOP?
 *
 * Facing skims the stock top so that surfaces left at the top height come out flat and true (and
 * so Z0 lands on a cut surface). When the programs remove the WHOLE top — a goal deeper than the
 * blank's top everywhere, or one cleared to its base plane — there is nothing left to skim: the
 * pass is wasted time and a tool change. The maintainer's rule (2026-11-01): facing is a default
 * only when some of the top survives, or when a later setup registers on it. It is judged from the
 * PLAN'S OWN CUT SURFACE — the heightfield the CAM will cut, sampled with the same clear band
 * `goalClearBand` gives the program — never from a rule of thumb about the mesh's bounding box.
 *
 * ONE MEASURE, TWO READERS. `engraveGenerate` reads it to decide whether a seeded facing choice is
 * acted on; the panel reads it (through {@link jobTopFaceCached}) to draw the same default before
 * any run. Both read the same facts, so the line and the program cannot disagree.
 */

import { goalClearBand } from '@/engine/cnc/cam/surface3d';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { placedSize } from './targetScale';
import { jobSetups, jobTargetObjects, jobTool } from './jobSetup';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/**
 * The grid the question is asked on, mm. Coarser than any cut grid the planner settles on
 * (`GOAL_BUDGET`'s own suggestions are ~0.24 mm and up): the answer is area, not a surface, and a
 * half-millimetre cell cannot mistake a surviving margin for a cut.
 */
const FACE_PITCH_MM = 0.5;

/**
 * A surface this close to the stock top IS the top face. 0.1 mm: the oracle band's 0.05 mm floor
 * with the finishing allowance's own rounding — a goal whose top sits a hair under the blank's top
 * still keeps it (that hair is what facing is for).
 */
const FACE_KEEP_TOL_MM = 0.1;

export interface TopFaceFacts {
  /** The goal the answer is about. */
  targetId: string;
  /** True when some part of the stock's top survives the plan. */
  keeps: boolean;
  /** The share of the blank's top rectangle still at the top height, 0..1. */
  keptFraction: number;
}

/**
 * #888 — the sentence a plan that cuts the whole top away states in place of a facing pass, and
 * the reason the run carries in `facingError`. One string each, shared by the panel, the run row
 * and the run sheet so they cannot word the same fact three ways.
 */
export const NO_FACING_TOP = 'No facing: every part of the top is cut away.';
export const NO_FACING_TOP_REASON = 'every part of the top is cut away, so there is nothing to skim';

/**
 * One goal against the stock's top rectangle, or null when the question is not about it (a
 * reference, a picture, a disabled mesh, or a mesh that cannot be sampled).
 *
 * The sample is taken with the goal's OWN clear band. `tool` is the cutter the plan will cut with,
 * when the caller knows it; without one the ring is the cutter's own diameter at most, which can
 * only make the measure keep the top a little more often — never less.
 */
export function goalTopFace(
  job: EngraveJob,
  goal: EngraveTargetObject,
  opts: { tool?: Tool | null } = {},
): TopFaceFacts | null {
  if ((goal.role ?? 'reference') !== 'goal' || !goal.enabled) return null;
  if (goal.format === 'png') return null; // a picture is cut INTO the top; the top is kept
  const L = job.stock.length;
  const W = job.stock.width;
  const rect = { xMin: 0, xMax: L, yMin: 0, yMax: W };
  const tool = opts.tool === undefined ? jobTool(job) : opts.tool;
  const diameter = tool === null ? 0 : cuttingDiameter(tool) ?? 0;
  const { clear } = goalClearBand(goal, { toolDiameterMm: diameter });

  let hf;
  try {
    hf = sampleGoalHeightfield(goal, {
      pitchMm: FACE_PITCH_MM,
      ...(clear === null
        ? {}
        : { clear, stockRect: rect, baseZ: goal.position.z - placedSize(goal).z }),
      clip: rect,
    });
  } catch {
    return null; // the mesh's own load refusal is the row's finding, not this one's
  }
  if (hf.nx === 0 || hf.ny === 0) return null;

  // The grid is clipped to the blank, but a goal smaller than the blank leaves the grid short of
  // the blank's edges: everything outside the grid is untouched stock top. One cell of slack (the
  // CAM's toolpath covers a cell, not a fraction of one) before that counts as "not covered".
  const x0 = hf.x0 - hf.pitch / 2;
  const y0 = hf.y0 - hf.pitch / 2;
  const x1 = hf.x0 + (hf.nx - 0.5) * hf.pitch;
  const y1 = hf.y0 + (hf.ny - 0.5) * hf.pitch;
  const slack = hf.pitch;
  const outside =
    x0 > slack || y0 > slack || x1 < L - slack || y1 < W - slack;

  let kept = 0;
  for (let k = 0; k < hf.covered.length; k++) {
    if (hf.covered[k] === 0 || (hf.z[k] as number) >= hf.topZ - FACE_KEEP_TOL_MM) kept++;
  }
  const total = hf.covered.length;
  if (outside) return { targetId: goal.id, keeps: true, keptFraction: Math.max(kept / total, 1e-6) };
  return { targetId: goal.id, keeps: kept > 0, keptFraction: kept / total };
}

/**
 * The job's answer: does ANY goal cut in the FIRST setup leave part of the original top? Goals on
 * later setups are in their own work frames — the second side's "top" is the stock's underside —
 * and the original top is setup 1's. A job with no goal keeps the top by definition (nothing cuts
 * it away), and null says so: no goal, no opinion, facing stays as it was.
 *
 * A ROTARY job is not judged in the flat frame (its goal's local Z is radial, the same rule the
 * reach and coverage checks state).
 */
export function jobTopFace(job: EngraveJob, opts: { tool?: Tool | null } = {}): TopFaceFacts | null {
  if (rotaryMapOf(job) !== null) return null;
  const first = jobSetups(job)[0]?.id;
  let best: TopFaceFacts | null = null;
  for (const goal of jobTargetObjects(job)) {
    if (goal.setupId !== undefined && goal.setupId !== first) continue;
    const facts = goalTopFace(job, goal, opts);
    if (facts === null) continue;
    if (facts.keeps) return facts;
    if (best === null || facts.keptFraction > best.keptFraction) best = facts;
  }
  return best;
}

/**
 * THE PANEL CALLS THIS ON EVERY RENDER, so the measure is cached on the facts it reads — the
 * same discipline `jobFlipFindings` states: an edit anywhere the measure reads misses the cache,
 * everything else hits. The cutter's diameter is part of the key because the clear ring's width
 * comes from it.
 */
const faceCache = new Map<string, TopFaceFacts | null>();
const FACE_CACHE_MAX = 8;

export function jobTopFaceCached(job: EngraveJob): TopFaceFacts | null {
  const tool = jobTool(job);
  const diameter = tool === null ? 0 : cuttingDiameter(tool) ?? 0;
  const key = [
    ...jobTargetObjects(job).map((goal) => {
      const s = goal.scale ?? { x: 1, y: 1, z: 1 };
      return [
        goal.id,
        goal.sha256,
        goal.data === undefined ? 'blob-absent' : 'blob-present',
        goal.enabled ? 1 : 0,
        goal.role ?? 'reference',
        goal.setupId ?? '',
        goal.position.x, goal.position.y, goal.position.z,
        goal.rotation, goal.rotationX ?? 0, goal.rotationY ?? 0,
        s.x, s.y, s.z,
      ].join(',');
    }),
    job.stock.length, job.stock.width, job.stock.thickness,
    diameter,
  ].join('|');
  if (faceCache.has(key)) return faceCache.get(key) as TopFaceFacts | null;
  const computed = jobTopFace(job, { tool });
  faceCache.set(key, computed);
  if (faceCache.size > FACE_CACHE_MAX) {
    const first = faceCache.keys().next().value;
    if (first !== undefined) faceCache.delete(first);
  }
  return computed;
}
