/**
 * #872 — WHICH SIDES FINISH A GOAL, and the plan that says so without being asked.
 *
 * The top setup cuts the top surface at every XY; the rest of a figure — its underside, its
 * undercuts, the band in an overhang's shadow — is left as stock while the job looks finished.
 * This module turns the coverage measure into a PLAN: the fewest stock orientations that reach the
 * goal, each one a setup the operator can actually hold, and the reason a side was refused.
 *
 * THE GREEDY, ONE NUMBER PER SIDE. Setup 1 is the face the job already has up (the "Lay it flat"
 * choice). Every other stock face `orient` can hold is a candidate; each is scored by the goal
 * area it reaches that the chosen sides do not — the MARGINAL gain — and the best is added until
 * the goal is reached or no side earns its setup. That is why the usual answer is two setups (the
 * top and the flip) and why a side is never added for a few square millimetres.
 *
 * THE NOISE RULE. A candidate whose whole gain is ONE FLAT FACE is not offered: the back of a
 * relief, the bottom of a cube, the flat end of a bar are faces the stock already has, and turning
 * the part over to skim them is a facing pass, not a reason to plan a flip. A gain only counts
 * when `flatGainShare` or more of it is NOT a face square to the tool.
 *
 * HOLDABILITY IS THE SETUPS ENGINE'S. `orient(faceUp, mount, size)` decides whether the stock can
 * stand that way at all (a side up on tape is refused; a vise states its opening) — the same
 * function #809/#814's vise rules and the saved-setup remounts read, so a side this plan offers is
 * one the setups engine will also accept.
 *
 * GEOMETRY ONLY, ON PURPOSE. The plan ranks sides by what is VISIBLE to each (the `resultTop`-less
 * pass); confirming a plan's number requires the simulation, which the run does per setup. A
 * ranking that ran the CAM for all six candidates would cost six runs to choose one.
 */

import { orient } from '@/engine/cnc/setups/orient';
import type { Face, MountSpec } from '@/engine/cnc/setups/types';
import {
  coverageTriangles,
  rotateCoverageMesh,
  sampleCoverageField,
  type CoverageMesh,
  type CoverageOptions,
} from './goalCoverage';

/** #872's decided default target; the caller may state its own. */
export const FLIP_TARGET_FRACTION = 0.95;
/** A candidate must reach at least this share of the GOAL's area beyond the chosen sides. */
export const FLIP_MIN_GAIN_FRACTION = 0.01;
/** A gain this flat (a share of it square to the tool) is the stock's own face, not a feature. */
export const FLIP_FLAT_GAIN_SHARE = 0.95;
/** How far from square-to-the-tool a face may tilt and still count as flat, degrees. */
const FLAT_DEG = 3;

export interface FlipSide {
  /** The stock face this setup puts up. */
  faceUp: Face;
  /** The turn into this setup, as `orient` states it; null for the first side (already up). */
  rotate: { about: 'x' | 'y'; degrees: 90 | -90 | 180 } | null;
  /** Goal area this side reaches that the sides before it did not, mm². */
  marginalMm2: number;
  /** Everything visible from this side, mm². */
  visibleMm2: number;
}

export interface FlipPlan {
  /** The chosen sides in order; the first is the job's current orientation. */
  sides: FlipSide[];
  /** The union of the chosen sides' visible area over the goal's whole surface. */
  reachedFraction: number;
  totalAreaMm2: number;
  /**
   * Why the plan stopped: the goal is reached, the only gains left are flat faces (the noise
   * rule), or no side the mount can hold adds anything.
   */
  stopped: 'target-reached' | 'only-flat-faces-remain' | 'no-holdable-side-helps';
  /** Every face a plan would have offered and did not, with the setups engine's own reason. */
  dropped: { faceUp: Face; reason: string }[];
}

export interface FlipPlanInput {
  /** The goal mesh, in setup 1's work frame (the stock frame). */
  mesh: CoverageMesh;
  /** The stock face the job has up today; the plan keeps it as setup 1. */
  firstUp: Face;
  mount: MountSpec;
  /** The stock's size, for the vise's opening rule. */
  stockSize: { x: number; y: number; z: number };
  /** The shadow raster's pitch, mm — finer than a finish step-over, or a slope reads as an edge. */
  pitchMm?: number;
  targetFraction?: number;
  minGainFraction?: number;
  flatGainShare?: number;
  coverage?: CoverageOptions;
}

/** Where each face sits in the candidate order once the first side is fixed. */
const CANDIDATE_ORDER: readonly Face[] = ['bottom', 'left', 'right', 'front', 'back', 'top'];

/**
 * The plan. `sides` always has at least the first side; a returned plan with ONE side and a
 * `stopped` reason is the "no flip is worth it" answer — the panel shows the reason, never a
 * proposal.
 */
export function goalFlipPlan(input: FlipPlanInput): FlipPlan {
  const target = input.targetFraction ?? FLIP_TARGET_FRACTION;
  const minGain = input.minGainFraction ?? FLIP_MIN_GAIN_FRACTION;
  const flatShare = input.flatGainShare ?? FLIP_FLAT_GAIN_SHARE;
  const pitch = input.pitchMm ?? 0.3;
  const dropped: FlipPlan['dropped'] = [];

  // Score one candidate: its visible triangles in the STOCK frame's index space. Each side is
  // scored ONCE (its visibility does not depend on which sides are already chosen — only the
  // marginal does), so a five-round greedy rasterises each orientation once, not five times.
  type Scored = { visible: Uint8Array; area: Float64Array; facts: ReturnType<typeof coverageTriangles> };
  const scored = new Map<Face, Scored | { reason: string }>();
  const score = (face: Face): Scored | { reason: string } => {
    const cached = scored.get(face);
    if (cached !== undefined) return cached;
    const turned = orient(face, input.mount, input.stockSize);
    if (!turned.ok) {
      const out = { reason: turned.reason };
      scored.set(face, out);
      return out;
    }
    const mesh = rotateCoverageMesh(input.mesh, turned.matrix.flat());
    const field = sampleCoverageField(mesh, pitch);
    const facts = coverageTriangles(mesh, field, input.coverage ?? {});
    const visible = new Uint8Array(facts.length);
    const area = new Float64Array(facts.length);
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      area[i] = f.areaMm2;
      visible[i] = f.cls === 'visible' ? 1 : 0;
    }
    const out: Scored = { visible, area, facts };
    scored.set(face, out);
    return out;
  };

  const firstScored = score(input.firstUp);
  if ('reason' in firstScored) {
    // The job's own orientation is not holdable — the jobs flow refuses that before a plan is
    // asked for, so this is the guard behind it, not a sentence the operator normally sees.
    return { sides: [], reachedFraction: 0, totalAreaMm2: 0, stopped: 'no-holdable-side-helps', dropped: [{ faceUp: input.firstUp, reason: firstScored.reason }] };
  }

  const total = firstScored.area.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { sides: [], reachedFraction: 0, totalAreaMm2: 0, stopped: 'no-holdable-side-helps', dropped };

  const covered = new Uint8Array(firstScored.visible.length);
  let coveredArea = 0;
  for (let i = 0; i < covered.length; i++) {
    if (firstScored.visible[i] === 1) {
      covered[i] = 1;
      coveredArea += firstScored.area[i]!;
    }
  }
  // Setup 1 is the stock as the job has it: there is no turn INTO it.
  const sides: FlipSide[] = [
    { faceUp: input.firstUp, rotate: null, marginalMm2: coveredArea, visibleMm2: coveredArea },
  ];

  const candidates = CANDIDATE_ORDER.filter((f) => f !== input.firstUp);
  let stopped: FlipPlan['stopped'] = 'only-flat-faces-remain';
  while (coveredArea / total < target) {
    let best: { face: Face; gain: number; visible: Uint8Array; area: Float64Array; flatShare: number } | null = null;
    for (const face of candidates) {
      const s = score(face);
      if ('reason' in s) {
        if (!dropped.some((d) => d.faceUp === face)) dropped.push({ faceUp: face, reason: s.reason });
        continue;
      }
      // THE GAIN'S SHAPE, in the STOCK frame's own orientation: a gain that is one PLANE — a
      // face of the model seen from any side (the back of a relief seen edge-on is still a flat
      // back) — is the stock's own face, not a surface a setup exists to make.
      let gain = 0;
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < s.visible.length; i++) {
        if (s.visible[i] === 1 && covered[i] === 0) {
          gain += s.area[i]!;
          const n = s.facts[i]!.normal;
          mx += n[0] * s.area[i]!;
          my += n[1] * s.area[i]!;
          mz += n[2] * s.area[i]!;
        }
      }
      let flat = 0;
      if (gain > 0) {
        const ml = Math.hypot(mx, my, mz);
        if (ml > 0) {
          const flatThreshold = Math.cos((FLAT_DEG * Math.PI) / 180);
          for (let i = 0; i < s.visible.length; i++) {
            if (s.visible[i] === 1 && covered[i] === 0) {
              const n = s.facts[i]!.normal;
              const dot = (n[0] * mx + n[1] * my + n[2] * mz) / ml;
              if (dot >= flatThreshold) flat += s.area[i]!;
            }
          }
        }
      }
      if (gain <= 0) continue;
      if (best === null || gain > best.gain) best = { face, gain, visible: s.visible, area: s.area, flatShare: flat / gain };
    }
    if (best === null || best.gain / total < minGain) {
      stopped = 'no-holdable-side-helps';
      break;
    }
    if (best.flatShare >= flatShare) {
      // Its only gain is a face square to the tool: the stock's own face, not a surface to make.
      stopped = 'only-flat-faces-remain';
      break;
    }
    for (let i = 0; i < best.visible.length; i++) {
      if (best.visible[i] === 1 && covered[i] === 0) {
        covered[i] = 1;
        coveredArea += best.area[i]!;
      }
    }
    const turn = orient(best.face, input.mount, input.stockSize);
    sides.push({
      faceUp: best.face,
      rotate: turn.ok ? (turn.rotate ?? null) : null,
      marginalMm2: best.gain,
      visibleMm2: best.visible.reduce((a, v, i) => a + (v === 1 ? best.area[i]! : 0), 0),
    });
    candidates.splice(candidates.indexOf(best.face), 1);
  }
  if (coveredArea / total >= target) stopped = 'target-reached';

  return { sides, reachedFraction: coveredArea / total, totalAreaMm2: total, stopped, dropped };
}

/** The four faces a plan may turn the stock to, named for the panel. */
export function sideWords(face: Face): string {
  return (
    { top: 'top', bottom: 'bottom', left: 'left edge', right: 'right edge', front: 'front edge', back: 'back edge' } as const
  )[face];
}
