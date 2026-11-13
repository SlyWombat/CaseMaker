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
import { readDefault } from '@/platform/defaultsClient';

import { orient } from '@/engine/cnc/setups/orient';
import type { Face, MountSpec } from '@/engine/cnc/setups/types';
import {
  coverageTriangles,
  rotateCoverageMesh,
  sampleCoverageField,
  type CoverageMesh,
  type CoverageOptions,
} from './goalCoverage';
import { faceDepthOffsetMm, type Box3 } from './goalFlipSetups';
import { GOAL_BAND_CLEARANCE_MM, longestKnownReach, type ToolReach } from './goalReach';
import type { Mat3 } from './targetScale';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

/** #872's decided default target; the caller may state its own. */
export const FLIP_TARGET_FRACTION = 0.95;
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
  /**
   * #914 — how deep below THIS side's own top the goal's farthest point sits, mm: `goalNeedMm`
   * restated for whatever face is up here, not only the first. Always present, whether or not a
   * `reach` pool was given — it is what the per-side sentence states.
   */
  neededMm: number;
  /**
   * #914 — how deep THIS SIDE'S OWN PROGRAM needs to cut, given what it is credited with: the
   * deepest CREDITED triangle (visible, and within `FlipPlan.reach`'s band when one is given) —
   * never more than that band. This is the `goalSideNeedMm`-equivalent the per-side sentence
   * states (`reachSidesSentence`), as distinct from `neededMm`'s "the goal's own farthest point,
   * reachable or not".
   */
  creditedMaxDepthMm: number;
  /**
   * #914 — visible area `FlipPlan.reach`'s tool CANNOT reach from this side, mm² (its own deepest
   * vertex sits below the usable band). Present only when `FlipPlanInput.reach` was given; the
   * greedy still ranks by what IS reachable, so a side can be offered with some of this standing.
   */
  beyondReachMm2?: number;
}

/**
 * #914 — the candidate tool pool (and the registry it is read against) a reach-aware plan picks
 * from. LOCATION-AWARE BY CONSTRUCTION: this module does not special-case a bench or a gate — the
 * CALLER decides what `tools` is (owned-only for a bench location, the full catalogue for a gate
 * location) and hands it here; `longestKnownReach` (`goalReach.ts`'s own pick, already used by
 * the reach FINDINGS) says which of THESE tools reaches furthest, falling back to a cutter's
 * catalogue row exactly as it does elsewhere. There is no second tool-pick machinery here.
 *
 * FILTERED TO BALL SHAPES FIRST. A goal's own finishing cutter is a ball or tapered-ball — every
 * real goal job this codebase has (the #945 elephant's `inv:lib-…` ball, `goalCorpus873`'s own
 * note that a flat end mill "never exercises `ballRise`") — so a pool that also hands in a long
 * FLAT end mill must not let that flat's irrelevant reach win: a 42 mm o-flute's "reach" says
 * nothing about whether a ball-finished goal can be cut, and picking it would make this plan
 * silently geometry-only on any shop that owns one. A pool with no ball/tapered-ball tool at all
 * scores no cap (same as no `reach` input) rather than falling back to a flat's number.
 */
export interface FlipPlanReachInput {
  tools: readonly Tool[];
  entries: readonly ToolLibraryEntry[];
}

/** What a reach-aware plan actually scored against — null when `reach` was not given, or none of
 *  its tools has a KNOWN reach (`goalReach.ts`'s own "unrecorded" rule: not a refusal, no cap). */
export interface FlipPlanReach {
  tool: Tool;
  mm: number;
  source: ToolReach['source'];
  catalogueName: string | null;
  /** The usable band below `mm`, `GOAL_BAND_CLEARANCE_MM` floored at 0. */
  bandMm: number;
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
  /** #914 — the tool/band every side was scored against, or null (no `reach` input, or none of
   *  its tools has a known reach — the plan is then geometry-only, exactly as before). */
  reach: FlipPlanReach | null;
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
   * #914 — make the plan REACH-AWARE: a side only gets credit for the area its best-reaching
   * candidate tool can actually cut (`goalSideNeedMm`/`knownReach`/`GOAL_BAND_CLEARANCE_MM`'s own
   * rule, generalised to every orientation, not only the first). Omitted keeps today's
   * GEOMETRY-ONLY behaviour byte-for-byte — a caller that does not ask for this sees no change at
   * all, including when none of its tools has a known reach.
   */
  reach?: FlipPlanReachInput;
  /**
   * #914 — restrict the candidates beyond `firstUp` to exactly these faces, with every OTHER
   * face `orient` could have tried written into `dropped` with `excludedReason` — the mechanism
   * a caller uses to say "these faces are not cuttable surfaces here" (a stick stock's vise-jaw
   * and length-overhang faces, for the elephant/panther jobs the approved design note named),
   * never a judgement this module makes on its own. Omitted keeps today's behaviour: every face
   * `orient` can hold competes.
   */
  candidateFaces?: { faces: readonly Face[]; excludedReason: string };
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
  // #1207 — the shop's `flip.minGainFraction`; a caller that states none reads the recommendation.
  const minGain = input.minGainFraction ?? readDefault(null, 'flip.minGainFraction').value;
  const flatShare = input.flatGainShare ?? FLIP_FLAT_GAIN_SHARE;
  const pitch = input.pitchMm ?? 0.3;
  const dropped: FlipPlan['dropped'] = [];

  // #914 — ONE TOOL PICK FOR THE WHOLE PLAN: every side is scored against the SAME cutter (the
  // one the operator would actually run), not re-picked per face. `longestKnownReach` is
  // `goalReach.ts`'s own location-aware pick — the caller's `tools` IS the location (owned-only
  // on a bench, the full catalogue on a gate); this module never special-cases either, beyond
  // narrowing the pool to the shapes a goal is actually finished with (see `FlipPlanReachInput`).
  const ballTools = input.reach === undefined ? [] : input.reach.tools.filter((t) => t.shape === 'ball' || t.shape === 'tapered-ball');
  const picked = input.reach === undefined ? null : longestKnownReach(ballTools, input.reach.entries);
  const reach: FlipPlanReach | null =
    picked === null
      ? null
      : {
          tool: picked.tool,
          mm: picked.reach.mm,
          source: picked.reach.source,
          catalogueName: picked.reach.catalogueName,
          bandMm: Math.max(0, picked.reach.mm - GOAL_BAND_CLEARANCE_MM),
        };
  const band = reach === null ? null : reach.bandMm;

  // Score one candidate: its visible triangles in the STOCK frame's index space. Each side is
  // scored ONCE (its visibility does not depend on which sides are already chosen — only the
  // marginal does), so a five-round greedy rasterises each orientation once, not five times.
  type Scored = {
    visible: Uint8Array;
    area: Float64Array;
    facts: ReturnType<typeof coverageTriangles>;
    /** #914 — this side's own `goalNeedMm`: how deep below ITS top the goal's farthest point
     *  sits, regardless of whether that point is visible OR reachable from here. The GOAL's own
     *  property, not this side's program — see `creditedMaxDepthMm` for that. */
    neededMm: number;
    /** #914 — how deep THIS SIDE'S OWN PROGRAM actually needs to cut, given what it is credited
     *  with (visible, and within `band` when one is given): the deepest CREDITED triangle, never
     *  more than `band`. This is what the per-side sentence states. */
    creditedMaxDepthMm: number;
    /** #914 — visible area beyond `band`, mm²; 0 when `band` is null (no reach input). */
    beyondReachMm2: number;
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
    const R = turned.matrix.flat() as unknown as Mat3;
    const mesh = rotateCoverageMesh(input.mesh, R);
    const field = sampleCoverageField(mesh, pitch);
    const facts = coverageTriangles(mesh, field, input.coverage ?? {});
    const visible = new Uint8Array(facts.length);
    const area = new Float64Array(facts.length);
    // #914 — the ONE constant that turns this pure rotation's z back into a depth below THIS
    // orientation's own stock top (`goalFlipSetups.ts`'s `faceDepthOffsetMm`; see its own doc for
    // why a single added scalar is enough, rather than re-transforming the whole mesh).
    const kz = faceDepthOffsetMm(R, input.stockSize as Box3);
    const positions = mesh.positions;
    const indices = mesh.indices;
    let neededMm = 0;
    let creditedMaxDepthMm = 0;
    let beyondReachMm2 = 0;
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      area[i] = f.areaMm2;
      const ia = indices[i * 3]! * 3;
      const ib = indices[i * 3 + 1]! * 3;
      const ic = indices[i * 3 + 2]! * 3;
      // The triangle's own deepest vertex (most negative z), restated as a depth below THIS
      // side's top — the point the cutter actually has to reach, not the triangle's average.
      const deepestZ = Math.min(positions[ia + 2]!, positions[ib + 2]!, positions[ic + 2]!);
      const depthMm = -(deepestZ + kz);
      if (f.areaMm2 > 0 && depthMm > neededMm) neededMm = depthMm;
      let ok = f.cls === 'visible';
      if (ok && band !== null && depthMm > band + 1e-6) {
        ok = false;
        beyondReachMm2 += f.areaMm2;
      }
      if (ok && f.areaMm2 > 0 && depthMm > creditedMaxDepthMm) creditedMaxDepthMm = depthMm;
      visible[i] = ok ? 1 : 0;
    }
    const out: Scored = { visible, area, facts, neededMm, creditedMaxDepthMm, beyondReachMm2 };
    scored.set(face, out);
    return out;
  };

  const firstScored = score(input.firstUp);
  if ('reason' in firstScored) {
    // The job's own orientation is not holdable — the jobs flow refuses that before a plan is
    // asked for, so this is the guard behind it, not a sentence the operator normally sees.
    return { sides: [], reachedFraction: 0, totalAreaMm2: 0, stopped: 'no-holdable-side-helps', dropped: [{ faceUp: input.firstUp, reason: firstScored.reason }], reach };
  }

  const total = firstScored.area.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { sides: [], reachedFraction: 0, totalAreaMm2: 0, stopped: 'no-holdable-side-helps', dropped, reach };

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
    {
      faceUp: input.firstUp,
      rotate: null,
      marginalMm2: coveredArea,
      visibleMm2: coveredArea,
      neededMm: firstScored.neededMm,
      creditedMaxDepthMm: firstScored.creditedMaxDepthMm,
      ...(reach !== null ? { beyondReachMm2: firstScored.beyondReachMm2 } : {}),
    },
  ];

  const allCandidates = CANDIDATE_ORDER.filter((f) => f !== input.firstUp);
  const restrict = input.candidateFaces;
  if (restrict !== undefined) {
    for (const f of allCandidates) {
      if (!restrict.faces.includes(f)) dropped.push({ faceUp: f, reason: restrict.excludedReason });
    }
  }
  const candidates = restrict === undefined ? allCandidates : allCandidates.filter((f) => restrict.faces.includes(f));
  let stopped: FlipPlan['stopped'] = 'only-flat-faces-remain';
  while (coveredArea / total < target) {
    let best: {
      face: Face;
      gain: number;
      visible: Uint8Array;
      area: Float64Array;
      flatShare: number;
      neededMm: number;
      creditedMaxDepthMm: number;
      beyondReachMm2: number;
    } | null = null;
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
      if (best === null || gain > best.gain) {
        best = {
          face,
          gain,
          visible: s.visible,
          area: s.area,
          flatShare: flat / gain,
          neededMm: s.neededMm,
          creditedMaxDepthMm: s.creditedMaxDepthMm,
          beyondReachMm2: s.beyondReachMm2,
        };
      }
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
      neededMm: best.neededMm,
      creditedMaxDepthMm: best.creditedMaxDepthMm,
      ...(reach !== null ? { beyondReachMm2: best.beyondReachMm2 } : {}),
    });
    candidates.splice(candidates.indexOf(best.face), 1);
  }
  if (coveredArea / total >= target) stopped = 'target-reached';

  return { sides, reachedFraction: coveredArea / total, totalAreaMm2: total, stopped, dropped, reach };
}

/**
 * #914 — each chosen side with the depth ITS OWN PROGRAM needs to cut, GIVEN its own band:
 * `creditedMaxDepthMm` (the `goalSideNeedMm`-equivalent this sentence promises — never more than
 * the stated band), not `neededMm` (the goal's farthest point whether or not this side can reach
 * it). A reach-aware plan's own band is stated once at the end (one tool informed every side's
 * score), the same voice `goalReachFindings`'s sentences already use for a cutter's reach.
 */
export function reachSidesSentence(plan: FlipPlan): string {
  const mm = (v: number): string => String(Number(v.toFixed(1)));
  let out = plan.sides.map((s) => `${sideWords(s.faceUp)} (${mm(s.creditedMaxDepthMm)} mm)`).join(', then ');
  if (plan.reach !== null) {
    const r = plan.reach;
    const named = r.source === 'catalogue' ? ` (${r.catalogueName ?? "Makera's catalogue"})` : '';
    out += ` — scored against ${mm(r.mm)} mm of reach${named}, a ${mm(r.bandMm)} mm usable band per side`;
  }
  // A face `dropped` for the SETUPS ENGINE'S own reason (not holdable) or a caller's own
  // `candidateFaces` restriction (a stick's vise-jaw and overhang faces, named by the design
  // note posted to #945) must be STATED here, not left silent in `dropped` alone — faces sharing
  // one reason are named together, so a four-face stick restriction reads as one clause.
  if (plan.dropped.length > 0) {
    const byReason = new Map<string, Face[]>();
    for (const d of plan.dropped) {
      const faces = byReason.get(d.reason) ?? [];
      faces.push(d.faceUp);
      byReason.set(d.reason, faces);
    }
    const clauses = [...byReason.entries()].map(
      ([reason, faces]) => `${faces.map(sideWords).join('/')} excluded: ${reason}`,
    );
    out += `; ${clauses.join('; ')}`;
  }
  return out;
}

/** The four faces a plan may turn the stock to, named for the panel. */
export function sideWords(face: Face): string {
  return (
    { top: 'top', bottom: 'bottom', left: 'left edge', right: 'right edge', front: 'front edge', back: 'back edge' } as const
  )[face];
}
