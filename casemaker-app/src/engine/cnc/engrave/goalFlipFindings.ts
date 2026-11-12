/**
 * #872 — WHAT THE TOP SETUP LEAVES UNREACHED, IN THE RUN'S OWN FINDINGS, and the flip plan that
 * finishes it — stated without being asked, refused when the remainder is noise.
 *
 * The maintainer's words are the contract: "I would have expected given a mesh that it would
 * require me to rotate the material in the vise to finish the job." A goal that is not finished
 * from the top must SAY so, in the share it reaches and the reasons the rest is out of reach, and
 * offer the sides that reach it. It must never refuse: the program posts, verifies and runs; the
 * finding is the truth about what it leaves standing.
 *
 * ONE MEASURE, TWO SENTENCES. The split is the first side's coverage (faces pointing away, the
 * shadow band, the visible remainder); the plan is `goalFlipPlan`'s greedy over the stock's
 * holdable faces. Below the small-amount threshold the finding is an INFO that is quiet about a
 * proposal; above it the finding names the split and — when a side earns its setup — carries the
 * sides so the panel can add them in one press.
 */

import { targetObjectMesh } from '@/engine/import/targetObject';
import type { Tool } from '@/engine/cnc/tool';
import { DEFAULT_BREAKTHROUGH } from '@/engine/cnc/sacrificial';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { placeTarget } from './targetPlace';
import { jobMount, jobTargetObjects, type JobFinding } from './jobSetup';
import {
  coveragePercent,
  coverageTriangles,
  sampleCoverageField,
  COVERAGE_SMALL_FRACTION,
  type CoverageMesh,
} from './goalCoverage';
import { goalFlipPlan, sideWords, type FlipPlan } from './goalFlipPlan';
import { dowelHold } from './goalFlipSetups';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';

/** The measure the finding is built from, kept as data so a caller can assert on it. */
export interface GoalSurfaceOffer {
  targetId: string;
  plan: FlipPlan;
  /** The first setup's own share of the goal's area, mm² — the split the sentence states. */
  first: { facingAwayMm2: number; shadowedMm2: number; visibleMm2: number; totalMm2: number };
}

const RING_PITCH_MM = 0.3;

/** The goal's triangles in the WORK frame — the placement the CAM cuts, shared with the sampler. */
export function goalWorkMesh(goal: EngraveTargetObject): CoverageMesh | null {
  let mesh;
  try {
    mesh = targetObjectMesh(goal);
  } catch {
    return null; // the mesh's own load refusal is the row's finding, not this one's
  }
  if (mesh.triangleCount === 0) return null;
  const { place } = placeTarget(goal, mesh);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = place(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  return { positions, indices: mesh.indices };
}

/** Whether this target is a goal this measure is about at all. */
function measuredGoal(goal: EngraveTargetObject): boolean {
  return (goal.role ?? 'reference') === 'goal' && goal.enabled && goal.format !== 'png';
}

/** The measure and the plan for one goal, or null when there is nothing to measure. */
export function goalSurfaceOffer(job: EngraveJob, goal: EngraveTargetObject): GoalSurfaceOffer | null {
  if (!measuredGoal(goal)) return null;
  const mesh = goalWorkMesh(goal);
  if (mesh === null) return null;
  const field = sampleCoverageField(mesh, RING_PITCH_MM);
  const facts = coverageTriangles(mesh, field, {});
  let facingAwayMm2 = 0;
  let shadowedMm2 = 0;
  let visibleMm2 = 0;
  for (const f of facts) {
    if (f.cls === 'facingAway') facingAwayMm2 += f.areaMm2;
    else if (f.cls === 'shadowed') shadowedMm2 += f.areaMm2;
    else visibleMm2 += f.areaMm2;
  }
  const totalMm2 = facingAwayMm2 + shadowedMm2 + visibleMm2;
  if (!(totalMm2 > 0)) return null;
  const plan = goalFlipPlan({
    mesh,
    firstUp: 'top',
    mount: { kind: jobMount(job) },
    stockSize: { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
    pitchMm: RING_PITCH_MM,
  });
  return { targetId: goal.id, plan, first: { facingAwayMm2, shadowedMm2, visibleMm2, totalMm2 } };
}

/** `the bottom, then the left edge` — the sides in the panel's order, naming the turn. */
export function sidesSentence(plan: FlipPlan): string {
  return plan.sides.map((s) => sideWords(s.faceUp)).join(', then ');
}

/**
 * #1068/#1073 — the flip's locating bore goes this far past the stock's underside, mm: the app's
 * default breakthrough (#218, 0.3 mm) and nothing more (0f's 2026-11-08 ruling — the earlier
 * chip-clearance 0.2 is retired, the bore's job is to let the probe's walls-touch in). A job that
 * states its own breakthrough uses that; this constant is the no-job default the offer's
 * arithmetic falls back on.
 */
export const FLIP_HOLE_BREAKTHROUGH_MM = DEFAULT_BREAKTHROUGH;

/** #1068 — the drawer's one action verb, when the plan can be accepted as the job stands. */
export const FLIP_ACTION_LABEL = 'Add the flipped setup';

/**
 * The finding for one goal: nothing when the target is not a goal; an INFO when the top setup
 * leaves less than the small amount; a WARNING with the split, and the plan when one is worth it.
 */
export function goalFlipFindings(
  job: EngraveJob,
  goal: EngraveTargetObject,
  /** #911 — the LOCATION's cutters, so the hold sentence names the shop's own drill (or says
   *  there is none among them), rather than the app's default registry. */
  tools?: readonly { key: string; tool: Tool }[],
  /**
   * #1068 — THE MATERIAL UNDER THE STOCK the locating holes would enter, mm: the job's own
   * sacrificial board, else the bed's wasteboard, else 0 (a bare bed). The offer is validated
   * against it before it is made — an offer that would refuse when accepted is the same false
   * statement as a refusal of the real setup. Absent: the job's own board only.
   */
  underMm: number = job.sacrificial.under?.thickness ?? 0,
): JobFinding[] {
  const offer = goalSurfaceOffer(job, goal);
  if (offer === null) return [];
  const { plan, first } = offer;
  // THE TOP SETUP IS THE QUESTION — not the plan's union. A sphere's top setup reaches about half
  // and the flip finishes it; that is a warning with an offer, not a "target reached" silence.
  const top = plan.totalAreaMm2 > 0 ? plan.sides[0]!.visibleMm2 / plan.totalAreaMm2 : 0;
  const unreached = 1 - top;
  const topWords = coveragePercent(top);
  const planWords = coveragePercent(plan.reachedFraction);
  const facingWords = coveragePercent(first.facingAwayMm2 / first.totalMm2);
  const shadowWords = coveragePercent(first.shadowedMm2 / first.totalMm2);
  const unreachedWords = coveragePercent(unreached);

  if (unreached <= COVERAGE_SMALL_FRACTION) {
    return [
      {
        severity: 'info',
        code: 'goal-unreached',
        targetId: goal.id,
        goalReachedFraction: plan.reachedFraction,
        goalTopFraction: top,
        message:
          `The top setup reproduces ${topWords} of the goal's surface. The rest is under the ` +
          `${coveragePercent(COVERAGE_SMALL_FRACTION)} a single setup is expected to leave (faces pointing away, ` +
          `and the shadow under an overhang), so no second setup is proposed.`,
      },
    ];
  }

  // #1068 — THE SENTENCE IS THE FACT AND NOTHING ELSE. A proposal is an ACTION, never a step: what
  // a flip would involve (the sides, the locating holes, the second setup's registration) lives in
  // `goalFlipDetail`, shown only inside the drawer's action's own expansion. A warning that reads
  // "Setup 1 drills…" is read at the machine as a step.
  const split =
    `${unreachedWords} of the goal faces away from this setup and is left as stock — ` +
    `${facingWords} of its surface is downward faces and undercuts, and ${shadowWords} lies in an ` +
    `overhang's shadow, so it is not cut from this side.`;
  const noFlip =
    plan.sides.length <= 1
      ? plan.stopped === 'only-flat-faces-remain'
        ? ` What remains is the stock's own flat face, so no second setup is proposed.`
        : ` No side this mount can hold reaches more of it, so no second setup is proposed.`
      : '';
  // THE OFFER, VALIDATED BEFORE IT IS MADE. The locating holes reach `thickness + 2`: they need
  // that much material under the stock, and a cutter among the shop's own that can drill them.
  const holdOffer =
    plan.sides.length > 1 ? dowelHold(job, goal, plan.sides[1]!.rotate?.about ?? 'x', tools) : null;
  const hold = holdOffer !== null && holdOffer.ok ? holdOffer.hold : null;
  const holdReason = holdOffer !== null && !holdOffer.ok ? holdOffer.reason : null;
  // #1073 — THE BORE'S DROP PAST THE UNDERSIDE: the job's own breakthrough alone (0f's
  // 2026-11-08 ruling retired the chip clearance); the board must be at least that thick.
  const boreDropMm = Math.round(job.breakthrough * 100) / 100;
  const canOffer = plan.sides.length > 1 && hold !== null && underMm >= boreDropMm;
  const need =
    plan.sides.length <= 1 || canOffer
      ? undefined
      : holdReason !== null
        ? holdReason
        : 'needs a sacrificial board under the blank';
  const detail =
    hold === null
      ? undefined
      : `${sidesSentence(plan)} — ${plan.sides.length} setups reach ${planWords} of the surface; ` +
        `how much of it the chosen cutter reproduces is the run's own simulation verdict. ` +
        `The first setup bores two ⌀${hold.diameterMm} mm locating holes ${hold.depthMm} mm deep — ` +
        `through the blank and ${boreDropMm} mm into the board — in the margin, clear of the part, ` +
        `and the flipped setup registers on them.`;
  return [
    {
      severity: 'warning',
      code: 'goal-unreached',
      targetId: goal.id,
      goalReachedFraction: plan.reachedFraction,
      goalTopFraction: top,
      ...(plan.sides.length > 1 ? { goalFlipSides: plan.sides.map((s) => s.faceUp) } : {}),
      ...(canOffer ? { goalFlipAction: FLIP_ACTION_LABEL, ...(detail === undefined ? {} : { goalFlipDetail: detail }) } : {}),
      ...(need === undefined ? {} : { goalFlipNeed: need }),
      message: `The top setup reproduces ${topWords} of the goal's surface. ${split}${noFlip}`,
    },
  ];
}

/**
 * Every coverage finding over the job's goals, in goal order — the PANEL's reading, beside
 * `jobReachFindings`. A ROTARY job is not judged by the flat frame (its goal's local Z is radial,
 * the same rule the reach check states): the rotary's own checks and the sweep judge it.
 */
export function jobFlipFindings(
  job: EngraveJob,
  // #1244 — the map from the caller's edge; null: no location, the recommendations.
  defaults: ShopDefaults | null,
  tools?: readonly { key: string; tool: Tool }[],
  /** #1068 — the material under the stock the flip's holes would enter, mm (see `goalFlipFindings`). */
  underMm?: number,
): JobFinding[] {
  if (rotaryMapOf(job, defaults) !== null) return [];
  const out: JobFinding[] = [];
  for (const goal of jobTargetObjects(job)) out.push(...cachedFlipFindings(job, goal, tools, underMm));
  return out;
}

/**
 * THE PANEL CALLS THIS ON EVERY RENDER, so the measure is CACHED on the facts it reads: the
 * goal's bytes, placement and scale, the stock, and the mount. A 4 000-triangle goal is six
 * rasters per measure; running that per render is the render-storm this codebase has already
 * been bitten by (#830). The cache is small and keyed by content, so an edit anywhere the measure
 * reads misses it and everything else hits.
 */
const flipCache = new Map<string, JobFinding[]>();
const FLIP_CACHE_MAX = 8;

function cacheKey(
  job: EngraveJob,
  goal: EngraveTargetObject,
  tools: readonly { key: string; tool: Tool }[] | undefined,
  underMm: number | undefined,
): string {
  const s = goal.scale ?? { x: 1, y: 1, z: 1 };
  return [
    goal.sha256,
    goal.format,
    // The bytes travel BESIDE the job: while they are loading there is no mesh to measure, and a
    // cached empty answer keyed on the sha alone would outlive their arrival.
    goal.data === undefined ? 'blob-absent' : 'blob-present',
    goal.enabled ? 1 : 0,
    goal.role ?? 'reference',
    goal.position.x, goal.position.y, goal.position.z,
    goal.rotation, goal.rotationX ?? 0, goal.rotationY ?? 0,
    s.x, s.y, s.z,
    job.stock.length, job.stock.width, job.stock.thickness,
    jobMount(job),
    // #1068 — THE OFFER DEPENDS ON THESE TOO: the material under the stock (a board added or
    // removed changes the need) and the cutters the shop owns (a drill recorded changes the hold
    // sentence). A cached offer that outlived either would be a false statement.
    underMm ?? job.sacrificial.under?.thickness ?? 0,
    (tools ?? []).map((t) => t.key).join(','),
  ].join('|');
}

function cachedFlipFindings(
  job: EngraveJob,
  goal: EngraveTargetObject,
  tools?: readonly { key: string; tool: Tool }[],
  underMm?: number,
): JobFinding[] {
  const key = cacheKey(job, goal, tools, underMm);
  const hit = flipCache.get(key);
  if (hit !== undefined) return hit;
  const computed = goalFlipFindings(job, goal, tools, underMm);
  flipCache.set(key, computed);
  if (flipCache.size > FLIP_CACHE_MAX) {
    const first = flipCache.keys().next().value;
    if (first !== undefined) flipCache.delete(first);
  }
  return computed;
}
