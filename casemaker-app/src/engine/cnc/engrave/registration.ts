/**
 * The registration plan for an engrave job, and the words a person at the machine reads it in
 * (#272, the caller slice of #188 / decision 26, `/Fabrication.md` §7.3).
 *
 * `probePlan.ts` derives the plan given a part outline, a `Workholding` and a probe; this module
 * is the one place an `EngraveJob` becomes those three arguments, and the one place a touch point
 * becomes something an operator can act on. Both halves are pure — no wasm, no store, no machine.
 *
 * THE OUTLINE IS THE STOCK'S RECTANGLE, and that is a real limitation rather than an oversight:
 * `EngraveJob` has no outline field (its stock is `length × width × thickness`), so a blank whose
 * printed corners are R3.175 reaches the planner as a plain rectangle and its datum edges read as
 * full sides — ~38.1 mm where §7.3 derives ~31.75 mm. The consequence is bounded: a longer edge
 * is a *better* datum, so the plan does not claim a precision the part does not have, it merely
 * does not shorten the datum the corners would. Conversely nothing here needs the geometry worker:
 * `rectProfile` is point maths, so `profilePolygons` resolves it and the plan never refuses with
 * `no-outline`.
 *
 * THE TOUCH POINTS ARE PHYSICAL. The part frame IS the work frame (`setup.ts`): the front-left
 * corner is the origin, +X runs right along the jaws' clamping direction and +Y runs away from the
 * operator. So the four sides name themselves — and they name the jaws too, because x = 0 is the
 * fixed jaw and x = length the moving one (#191). `describeTouch` puts a touch point into that
 * language, and the run sheet prints it, because an operator standing at the Z1 can find "the
 * back edge, a quarter of the way along from the left end" and cannot find "(19.05, 38.1)".
 */

import { rectProfile, type Profile } from '@/engine/compiler/profile';
import {
  planProbing,
  type ProbePart,
  type ProbeResult,
  type ProbeSpec,
  type ProbeTouch,
} from '@/engine/cnc/probePlan';
import { workholdingFor } from './jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import type { Mm, Vec2 } from '@/types/units';

/**
 * The probe in use. §1: of the three that fit the Z1, only the **Makera 3D Probe** is rated for
 * non-conductive material, so it is the only one that can touch off a PLA blank — the wired probe
 * is Z-only and the 3D Probe Rod that ships in the box requires a conductive workpiece.
 *
 * ITS TIP DIAMETER IS PROVISIONAL (#208). Makera publishes no figure and nobody has put calipers
 * on it; 3 mm is the common ball for a probe of this class and is what `cncProbePlan.spec.ts`
 * used. The tip sets how far a touch stands off a corner and how short an edge may be, so where
 * that matters the plan is nominal — the *edges and axes* it chooses are the finding, the
 * millimetre along them is not.
 *
 * `toleranceMm` is deliberately ABSENT, which the planner documents as "probe every axis the
 * fixture leaves open". `EngraveJob` states no XY tolerance — `edgeMargin` is the slack the
 * *content* keeps from the stock edge, a property of where the text sits, not of how well the
 * blank is located — so the honest default is to resolve everything and let the plan say so,
 * rather than to invent a number that would quietly skip a touch. For the vise that means three
 * touches where §7.3's V1 table calls for one: the jaws hold X and rotation to ±0.05 mm, and the
 * plan re-resolves both because it was not told that 0.05 mm is good enough.
 */
export const PROBE_SPEC: ProbeSpec = { tipDiameter: 3 };

/** The blank as the probe sees it. The outline is always a `Profile` here — never polygons. */
export interface JobProbePart extends ProbePart {
  outline: Profile;
}

/** The blank as the probe sees it — its stock rectangle, in the part's own frame. */
export function probePartFor(job: EngraveJob): JobProbePart {
  return { outline: rectProfile(job.stock.length, job.stock.width) };
}

/**
 * The registration the job's blank and workholding imply: what the fixture already references,
 * which blank edges are left to touch and where on them, what is still uncertain afterwards — or
 * a refusal when no reachable edge can resolve an open axis.
 */
export function registrationFor(job: EngraveJob, probe: ProbeSpec = PROBE_SPEC): ProbeResult {
  return planProbing(probePartFor(job), workholdingFor(job), probe);
}

/** A touch, in the words someone standing at the machine can act on. */
export interface TouchWords {
  /** Which side of the blank, and which jaw it faces: `the left edge — the one against the fixed jaw`. */
  edge: string;
  /** How far along that edge, from a named end: `about 19 mm along it from the left end`. */
  where: string;
}

/**
 * Name one side of the blank.
 *
 * A side is told from the other three by its midpoint, which is safe because the sides do not
 * overlap: an X-parallel edge has its midpoint at y = 0 or y = width, a Y-parallel one at x = 0 or
 * x = length. The jaws are what makes the name useful — the left side is the one the fixed jaw
 * bears on, and the operator has that in front of them.
 */
function edgeName(edge: readonly [Vec2, Vec2], length: Mm, width: Mm): string {
  const [a, b] = edge;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) {
    return my > width / 2 ? 'the back edge — the one furthest from you' : 'the front edge — the one nearest you';
  }
  return mx > length / 2 ? 'the right edge — the one against the moving jaw' : 'the left edge — the one against the fixed jaw';
}

/**
 * How far along an edge a touch sits, measured from its LEFT end (an X-parallel edge) or its FRONT
 * end (a Y-parallel edge) — the ends a person names without a coordinate system. `edge` from the
 * planner may run either way around, so the fraction is flipped when it does.
 */
function alongEdge(t: ProbeTouch): { end: string; mm: number } {
  const [a, b] = t.edge;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const len2 = dx * dx + dy * dy;
  const raw = len2 > 0 ? ((t.at[0] - a[0]) * dx + (t.at[1] - a[1]) * dy) / len2 : 0;
  const forward = alongX ? dx > 0 : dy > 0;
  const frac = forward ? raw : 1 - raw;
  return { end: alongX ? 'left' : 'front', mm: frac * t.edgeLength };
}

/** A touch's edge and position, as the run sheet states them. */
export function describeTouch(t: ProbeTouch, length: Mm, width: Mm): TouchWords {
  const { end, mm } = alongEdge(t);
  const along = Number(mm.toFixed(1));
  return {
    edge: edgeName(t.edge, length, width),
    where:
      Math.abs(mm / t.edgeLength - 0.5) < 0.02
        ? `at about its middle, ${along} mm from the ${end} end`
        : `about ${along} mm along it from the ${end} end`,
  };
}

/** What a touch is for, in the sheet's words: which axis it resolves. */
export function readsWord(t: ProbeTouch): string {
  if (t.fixes.includes('rotation')) return t.fixes.length > 1 ? 'position and rotation' : 'rotation';
  return t.reads === 'y' ? 'Y' : 'X';
}

/** `['x','rotation']` → `X and rotation`, for the datum sentence. */
export function axesWord(axes: readonly string[]): string {
  const named = axes.map((a) => (a === 'rotation' ? 'rotation' : a.toUpperCase()));
  if (named.length <= 1) return named[0] ?? 'nothing';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** `vise` → `vise`, `top-clamps` → `top clamps` — the kind as prose. */
export function kindWord(kind: string): string {
  return kind.replace(/-/g, ' ');
}
