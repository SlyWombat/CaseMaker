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
 *
 * #914 — THE BAND IS THE CUTTER'S REACH. When the caller states the chosen cutter's reach, each
 * side is scored by the goal area its BAND reaches from that side's own top face: the visible
 * triangles whose depth lies within the reach less the holder clearance (`reachBand`; the
 * triangle's centroid is the band test, its lowest point the side's need). A side that cannot
 * reach the whole depth still earns its setup for what it can cut, and its remainder is stated on
 * the side — never silently credited, never a refusal. With no stated reach the band is the need,
 * and the plan is exactly the geometric one (#872).
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
import { reachBand, reachSeamMm } from './reachBand';

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
  /** Everything this side's BAND reaches that is visible to it, mm² (#914: visible ∩ within reach). */
  visibleMm2: number;
  /** #914 — how deep the goal's visible surface goes below this side's top face: its lowest point. */
  needMm: number;
  /** #914 — how deep this side cuts, mm: min(need, the cutter's usable reach). */
  bandMm: number;
  /** #914 — what this side cannot reach: need − band, mm; 0 when it reaches all of it. */
  remainderMm: number;
  /** #914 — the visible area whose depth is beyond this side's band, mm². */
  beyondReachMm2: number;
}

export interface FlipPlan {
  /** The chosen sides in order; the first is the job's current orientation. */
  sides: FlipSide[];
  /** The union of the chosen sides' REACHED area over the goal's whole surface (#914). */
  reachedFraction: number;
  totalAreaMm2: number;
  /** #914 — the seam adjacent sides overlap by, mm: max(one finishing step-over, 0.5). */
  seamMm: number;
  /**
   * Why the plan stopped: the goal is reached, the only gains left are flat faces (the noise
   * rule), no side the mount can hold adds anything, or what remains lies beyond the cutter's
   * reach from every side that can hold it (#914).
   */
  stopped: 'target-reached' | 'only-flat-faces-remain' | 'no-holdable-side-helps' | 'reach-limit';
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
  /**
   * #914 — the chosen cutter's KNOWN reach (its stated shoulder, else flute, else Makera's
   * catalogue row for the same cutter), mm. Each side's band is bounded by the reach from ITS OWN
   * top face; null/absent leaves the plan geometric (the caller states the assumption).
   */
  reachMm?: number | null;
  /** #914 — the finishing raster's step-over, mm, for the seam; absent → the seam's floor. */
  finishStepOverMm?: number | null;
}

/** Where each face sits in the candidate order once the first side is fixed. */
const CANDIDATE_ORDER: readonly Face[] = ['bottom', 'left', 'right', 'front', 'back', 'top'];

/**
 * The stock's TOP face in a side's own frame, mm: the setups engine's box (`[0,L]×[0,W]×[0,T]`,
 * the box `orient(faceUp, mount, size)` holds) turned by `m`, its highest corner. Every depth in
 * this module is measured from it (#914).
 */
function sideTopZ(m: readonly number[], stockSize: { x: number; y: number; z: number }): number {
  let top = -Infinity;
  for (const x of [0, stockSize.x]) {
    for (const y of [0, stockSize.y]) {
      for (const z of [0, stockSize.z]) {
        top = Math.max(top, m[6]! * x + m[7]! * y + m[8]! * z);
      }
    }
  }
  return top;
}

/**
 * The goal mesh moved into the setups engine's stock box frame: setup 1's work frame puts the work
 * origin on the stock's top face (z = 0, the stock's underside at −T), while `orient`'s box runs
 * 0…T in Z. A translation only, so every classification reads the same relative heights.
 */
function boxFrameMesh(mesh: CoverageMesh, thicknessMm: number): CoverageMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i]!;
    positions[i + 1] = mesh.positions[i + 1]!;
    positions[i + 2] = mesh.positions[i + 2]! + thicknessMm;
  }
  return { positions, indices: mesh.indices };
}

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
  const seamMm = reachSeamMm(input.finishStepOverMm);
  const dropped: FlipPlan['dropped'] = [];

  // Score one candidate: its visible triangles in the STOCK frame's index space, and — #914 — the
  // part of that visibility within the cutter's reach from THIS face's top. Each side is scored
  // ONCE (its visibility does not depend on which sides are already chosen — only the marginal
  // does), so a five-round greedy rasterises each orientation once, not five times.
  const boxMesh = boxFrameMesh(input.mesh, input.stockSize.z);
  type Scored = {
    visible: Uint8Array;
    reachable: Uint8Array;
    area: Float64Array;
    facts: ReturnType<typeof coverageTriangles>;
    /** How deep the visible goal lies below this face, mm — its NEED (#914). */
    needMm: number;
    /** How deep this side cuts, mm: min(need, the cutter's usable reach) (#914). */
    bandMm: number;
    /** What this side cannot reach: need − band, mm; 0 when it reaches all of it (#914). */
    remainderMm: number;
    /** The visible area beyond the band, mm² (#914). */
    beyondReachMm2: number;
    /** The visible area the band reaches, mm². */
    reachableMm2: number;
  };
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
    const m = turned.matrix.flat();
    const mesh = rotateCoverageMesh(boxMesh, m);
    const field = sampleCoverageField(mesh, pitch);
    const facts = coverageTriangles(mesh, field, input.coverage ?? {});
    const top = sideTopZ(m, input.stockSize);
    const visible = new Uint8Array(facts.length);
    const area = new Float64Array(facts.length);
    /**
     * Each visible triangle's depth below the face, mm, for the band test. The CENTROID, not the
     * triangle's lowest corner: a mesh's wall is often ONE long triangle, and a corner test would
     * put the whole wall beyond the band even where the side's band clearly cuts its upper part.
     * The plan is an estimate the run's simulation confirms; the centroid is the estimate that
     * does not flip on a mesh's tessellation.
     */
    const depth = new Float64Array(facts.length);
    let needMm = 0;
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      area[i] = f.areaMm2;
      visible[i] = f.cls === 'visible' ? 1 : 0;
      if (visible[i] === 1) {
        depth[i] = Math.max(0, top - f.centre[2]);
        // The NEED is how deep the goal's visible surface really goes: its lowest point, not the
        // centroid — the band statement must name the deepest surface the side has to reach.
        const deep = Math.max(0, top - f.lowZ);
        if (deep > needMm) needMm = deep;
      }
    }
    const band = reachBand({ needMm, reachMm: input.reachMm, finishStepOverMm: input.finishStepOverMm });
    const reachable = new Uint8Array(facts.length);
    let reachableMm2 = 0;
    let beyondReachMm2 = 0;
    for (let i = 0; i < facts.length; i++) {
      if (visible[i] !== 1) continue;
      if (depth[i]! <= band.bandMm + 1e-9) {
        reachable[i] = 1;
        reachableMm2 += area[i]!;
      } else {
        beyondReachMm2 += area[i]!;
      }
    }
    const out: Scored = {
      visible,
      reachable,
      area,
      facts,
      needMm,
      bandMm: band.bandMm,
      remainderMm: band.remainderMm,
      beyondReachMm2,
      reachableMm2,
    };
    scored.set(face, out);
    return out;
  };

  const firstScored = score(input.firstUp);
  if ('reason' in firstScored) {
    // The job's own orientation is not holdable — the jobs flow refuses that before a plan is
    // asked for, so this is the guard behind it, not a sentence the operator normally sees.
    return { sides: [], reachedFraction: 0, totalAreaMm2: 0, seamMm, stopped: 'no-holdable-side-helps', dropped: [{ faceUp: input.firstUp, reason: firstScored.reason }] };
  }

  const total = firstScored.area.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { sides: [], reachedFraction: 0, totalAreaMm2: 0, seamMm, stopped: 'no-holdable-side-helps', dropped };

  const covered = new Uint8Array(firstScored.visible.length);
  let coveredArea = 0;
  for (let i = 0; i < covered.length; i++) {
    if (firstScored.reachable[i] === 1) {
      covered[i] = 1;
      coveredArea += firstScored.area[i]!;
    }
  }
  // Setup 1 is the stock as the job has it: there is no turn INTO it.
  const sides: FlipSide[] = [
    {
      faceUp: input.firstUp,
      rotate: null,
      marginalMm2: coveredArea,
      visibleMm2: firstScored.reachableMm2,
      needMm: firstScored.needMm,
      bandMm: firstScored.bandMm,
      remainderMm: firstScored.remainderMm,
      beyondReachMm2: firstScored.beyondReachMm2,
    },
  ];

  const candidates = CANDIDATE_ORDER.filter((f) => f !== input.firstUp);
  let stopped: FlipPlan['stopped'] = 'only-flat-faces-remain';
  while (coveredArea / total < target) {
    let best: { face: Face; gain: number; scored: Scored; flatShare: number } | null = null;
    // #914 — the largest visible gain any holdable side can see but its band cannot cut. When no
    // side earns a setup for what it CAN cut, this is what tells "nothing helps" from "the
    // remainder lies beyond the cutter's reach".
    let beyondBest = 0;
    for (const face of candidates) {
      const s = score(face);
      if ('reason' in s) {
        if (!dropped.some((d) => d.faceUp === face)) dropped.push({ faceUp: face, reason: s.reason });
        continue;
      }
      // THE GAIN'S SHAPE, in the STOCK frame's own orientation: a gain that is one PLANE — a
      // face of the model seen from any side (the back of a relief seen edge-on is still a flat
      // back) — is the stock's own face, not a surface a setup exists to make. Only the area the
      // side's BAND reaches counts as gain; what lies beyond its reach is counted apart (#914).
      let gain = 0;
      let beyond = 0;
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < s.visible.length; i++) {
        if (covered[i] === 1) continue;
        if (s.reachable[i] !== 1) {
          if (s.visible[i] === 1) beyond += s.area[i]!;
          continue;
        }
        gain += s.area[i]!;
        const n = s.facts[i]!.normal;
        mx += n[0] * s.area[i]!;
        my += n[1] * s.area[i]!;
        mz += n[2] * s.area[i]!;
      }
      if (beyond > beyondBest) beyondBest = beyond;
      let flat = 0;
      if (gain > 0) {
        const ml = Math.hypot(mx, my, mz);
        if (ml > 0) {
          const flatThreshold = Math.cos((FLAT_DEG * Math.PI) / 180);
          for (let i = 0; i < s.visible.length; i++) {
            if (s.reachable[i] === 1 && covered[i] === 0) {
              const n = s.facts[i]!.normal;
              const dot = (n[0] * mx + n[1] * my + n[2] * mz) / ml;
              if (dot >= flatThreshold) flat += s.area[i]!;
            }
          }
        }
      }
      if (gain <= 0) continue;
      if (best === null || gain > best.gain) best = { face, gain, scored: s, flatShare: flat / gain };
    }
    if (best === null || best.gain / total < minGain) {
      // Nothing left earns a setup. When what the chosen sides' bands DO see but cannot cut is
      // itself more than the noise, the remainder is a REACH limit; otherwise no side helps.
      const beyondSeen = Math.max(beyondBest, ...sides.map((s) => s.beyondReachMm2), 0);
      stopped = beyondSeen / total >= minGain ? 'reach-limit' : 'no-holdable-side-helps';
      break;
    }
    if (best.flatShare >= flatShare) {
      // Its only REACHABLE gain is a face square to the tool: the stock's own face, not a surface
      // to make. What lies beyond the band does not change what the gain IS: nothing to cut here.
      stopped = 'only-flat-faces-remain';
      break;
    }
    for (let i = 0; i < best.scored.visible.length; i++) {
      if (best.scored.reachable[i] === 1 && covered[i] === 0) {
        covered[i] = 1;
        coveredArea += best.scored.area[i]!;
      }
    }
    const s = best.scored;
    const turn = orient(best.face, input.mount, input.stockSize);
    sides.push({
      faceUp: best.face,
      rotate: turn.ok ? (turn.rotate ?? null) : null,
      marginalMm2: best.gain,
      visibleMm2: s.reachableMm2,
      needMm: s.needMm,
      bandMm: s.bandMm,
      remainderMm: s.remainderMm,
      beyondReachMm2: s.beyondReachMm2,
    });
    candidates.splice(candidates.indexOf(best.face), 1);
  }
  if (coveredArea / total >= target) stopped = 'target-reached';

  return { sides, reachedFraction: coveredArea / total, totalAreaMm2: total, seamMm, stopped, dropped };
}

/** The four faces a plan may turn the stock to, named for the panel. */
export function sideWords(face: Face): string {
  return (
    { top: 'top', bottom: 'bottom', left: 'left edge', right: 'right edge', front: 'front edge', back: 'back edge' } as const
  )[face];
}
