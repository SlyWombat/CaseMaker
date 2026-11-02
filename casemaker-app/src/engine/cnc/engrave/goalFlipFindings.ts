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
import { GOAL_BAND_CLEARANCE_MM, knownReach, type ToolReach } from './goalReach';
import { dowelHold } from './goalFlipSetups';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/** The measure the finding is built from, kept as data so a caller can assert on it. */
export interface GoalSurfaceOffer {
  targetId: string;
  plan: FlipPlan;
  /** The first setup's own share of the goal's area, mm² — the split the sentence states. */
  first: { facingAwayMm2: number; shadowedMm2: number; visibleMm2: number; totalMm2: number };
  /** #914 — the chosen cutter's known reach, when it has one; null leaves every band unlimited. */
  reach: ToolReach | null;
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
export function goalSurfaceOffer(
  job: EngraveJob,
  goal: EngraveTargetObject,
  /** #914 — the chosen cutter; its known reach bounds each side's band. Null: the geometric plan. */
  chosen?: Tool | null,
  /** The registry the reach's catalogue fallback reads (`knownReach`). */
  entries?: readonly { key: string; tool: Tool }[],
): GoalSurfaceOffer | null {
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
  const reach = chosen == null ? null : knownReach(chosen, entries ?? []);
  const plan = goalFlipPlan({
    mesh,
    firstUp: 'top',
    mount: { kind: jobMount(job) },
    stockSize: { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
    pitchMm: RING_PITCH_MM,
    reachMm: reach?.mm ?? null,
    finishStepOverMm: goal.surface?.finishStepOverMm ?? null,
  });
  return { targetId: goal.id, plan, first: { facingAwayMm2, shadowedMm2, visibleMm2, totalMm2 }, reach };
}

/**
 * `the bottom, then the left edge` — the sides in the panel's order, naming the turn. #914 — a
 * side the cutter cannot reach all the way carries its BAND, so the plan says how deep each setup
 * cuts as well as which way it turns.
 */
export function sidesSentence(plan: FlipPlan): string {
  return plan.sides
    .map((s) => `${sideWords(s.faceUp)}${s.remainderMm > 1e-6 ? ` (${mm(s.bandMm)} mm band)` : ''}`)
    .join(', then ');
}

/** `31` — a millimetre figure at most two decimals, no trailing zeros. */
function mm(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/**
 * #914 — THE CUTTER'S REACH, as the bound every side's band reads. Every limited side cuts the
 * same usable reach (a side is limited only when its need is deeper than that), so one sentence
 * states the number for all of them; the per-side bands ride in the sides list. Sides that reach
 * their whole depth — or no stated reach at all — say nothing, and #872's sentence stands
 * unchanged.
 */
export function reachSentence(plan: FlipPlan, reach: ToolReach | null): string {
  const limited = plan.sides.filter((s) => s.remainderMm > 1e-6);
  if (reach === null || limited.length === 0) return '';
  const usable = limited[0]!.bandMm;
  return (
    ` The cutter reaches ${mm(reach.mm)} mm below each setup’s top face` +
    (reach.source === 'catalogue' ? ' (Makera’s catalogue)' : '') +
    `; with ${mm(GOAL_BAND_CLEARANCE_MM)} mm kept clear for the holder, a side cuts at most ${mm(usable)} mm.`
  );
}

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
  /** #914 — the chosen cutter, whose known reach bounds each side's band. */
  chosen?: Tool | null,
): JobFinding[] {
  const offer = goalSurfaceOffer(job, goal, chosen, tools);
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

  if (unreached <= COVERAGE_SMALL_FRACTION) {
    return [
      {
        severity: 'info',
        code: 'goal-unreached',
        targetId: goal.id,
        goalReachedFraction: plan.reachedFraction,
        message:
          `The top setup reproduces ${topWords} of the goal's surface. The rest is under the ` +
          `${coveragePercent(COVERAGE_SMALL_FRACTION)} a single setup is expected to leave (faces pointing away, ` +
          `and the shadow under an overhang), so no second setup is proposed.`,
      },
    ];
  }

  const split =
    `${facingWords} of its surface faces away from the tool — downward faces and undercuts — and ` +
    `${shadowWords} lies in an overhang's shadow, so it is not cut from this side.`;
  const hold =
    plan.sides.length > 1 ? dowelHold(job, goal, plan.sides[1]!.rotate?.about ?? 'x', tools) : null;
  const holdWords =
    plan.sides.length <= 1
      ? ''
      : hold !== null
        ? ` Setup 1 drills two ⌀${hold.diameterMm} mm locating holes ${hold.depthMm} mm deep in the margin, clear of the part, and setup 2 registers on them.`
        : ` Setup 2 needs two locating holes to register on; none of your cutters is a drill, so record one in Manage › Tools first.`;
  const proposal =
    plan.sides.length > 1
      ? ` A flip finishes it: ${sidesSentence(plan)} — ${plan.sides.length} setups reach ${planWords} of the surface. That is the geometry the sides expose: how much of it the CHOSEN CUTTER reproduces is the run's own simulation verdict.${holdWords}`
      : plan.stopped === 'only-flat-faces-remain'
        ? ` What remains is the stock's own flat face, so no second setup is proposed.`
        : plan.stopped === 'reach-limit'
          ? ` What remains is not reachable by this cutter from any side this mount can hold, so no further setup is proposed.`
          : ` No side this mount can hold reaches more of it, so no second setup is proposed.`;
  return [
    {
      severity: 'warning',
      code: 'goal-unreached',
      targetId: goal.id,
      goalReachedFraction: plan.reachedFraction,
      ...(plan.sides.length > 1
        ? {
            goalFlipSides: plan.sides.map((s) => s.faceUp),
            // #914 — each side's band, aligned with `goalFlipSides`; null where the cutter reaches
            // the whole depth, so the setups engine only floors the sides the plan says end short.
            goalFlipBands: plan.sides.map((s) => (s.remainderMm > 1e-6 ? s.bandMm : null)),
          }
        : {}),
      message: `The top setup reproduces ${topWords} of the goal's surface. ${split}${reachSentence(plan, offer.reach)}${proposal}`,
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
  tools?: readonly { key: string; tool: Tool }[],
  /** #914 — the chosen cutter, whose known reach bounds each side's band. */
  chosen?: Tool | null,
): JobFinding[] {
  if (rotaryMapOf(job) !== null) return [];
  const out: JobFinding[] = [];
  for (const goal of jobTargetObjects(job)) out.push(...cachedFlipFindings(job, goal, tools, chosen));
  return out;
}

/**
 * THE PANEL CALLS THIS ON EVERY RENDER, so the measure is CACHED on the facts it reads: the
 * goal's bytes, placement and scale, the stock, the mount, and — #914 — the chosen cutter's reach
 * and the registry the drill and the catalogue rows come from. A 4 000-triangle goal is six
 * rasters per measure; running that per render is the render-storm this codebase has already
 * been bitten by (#830). The cache is small and keyed by content, so an edit anywhere the measure
 * reads misses it and everything else hits.
 */
const flipCache = new Map<string, JobFinding[]>();
const FLIP_CACHE_MAX = 8;

/** The registry's own signature: the drill the hold names, and the rows `knownReach` reads. */
function toolsKey(tools: readonly { key: string; tool: Tool }[] | undefined): string {
  return (tools ?? [])
    .map((e) => `${e.key}:${e.tool.id ?? ''}:${e.tool.diameter ?? ''}:${e.tool.fluteLength ?? ''}:${e.tool.shoulderLength ?? ''}`)
    .join(',');
}

function cacheKey(
  job: EngraveJob,
  goal: EngraveTargetObject,
  tools: readonly { key: string; tool: Tool }[] | undefined,
  chosen: Tool | null | undefined,
): string {
  const s = goal.scale ?? { x: 1, y: 1, z: 1 };
  const reach = chosen == null ? null : knownReach(chosen, tools ?? []);
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
    goal.surface?.finishStepOverMm ?? '',
    reach === null ? 'reach-none' : `reach-${reach.mm}-${reach.source}`,
    toolsKey(tools),
  ].join('|');
}

function cachedFlipFindings(
  job: EngraveJob,
  goal: EngraveTargetObject,
  tools?: readonly { key: string; tool: Tool }[],
  chosen?: Tool | null,
): JobFinding[] {
  const key = cacheKey(job, goal, tools, chosen);
  const hit = flipCache.get(key);
  if (hit !== undefined) return hit;
  const computed = goalFlipFindings(job, goal, tools, chosen);
  flipCache.set(key, computed);
  if (flipCache.size > FLIP_CACHE_MAX) {
    const first = flipCache.keys().next().value;
    if (first !== undefined) flipCache.delete(first);
  }
  return computed;
}
