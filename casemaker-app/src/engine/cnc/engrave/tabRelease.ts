/**
 * #1073 line 4 — SIDE 2'S TAB RELEASE: the flipped setup's LAST shallow pass. The two sides cut
 * to `bandMm` and `bandMm + 2·tabs.thicknessMm`, leaving a continuous band of material around the
 * part; this pass cuts that band through so the part comes free — and, by Analyst's binding ruling
 * (2026-11-08), the part NEVER goes free under a running cutter: the band's last millimetre is
 * interrupted at `tabs.count` bridges and the operator cuts them with a flush-cut saw after the
 * machine is homed. The final lap is its own named operation so a later ruling can make it a
 * stop-and-hold without rewriting the plan.
 *
 * THE GEOMETRY is the existing machinery, not a second engine: the band's section comes from
 * `crossSectionPolylines` (the mesh slice the underside plan already measures), the centre path
 * from `profilePath` (offset one cutter radius OUTSIDE the part, so the kerf's inner wall is the
 * part's own widest surface), the tab spans from `placeTabs` and the moves from `contourMoves`
 * (the 2.5D cut-outs' own tab mechanism: lift over the span at the tab top, cross the span's path,
 * plunge back). What is new here is only the band's two passes, the tab placement RULES and the
 * refusal sentences.
 *
 * THE PLACEMENT RULES (Analyst's ruling): on the outline's long straight runs, each tab's whole
 * span ≥ {@link TAB_CORNER_CLEARANCE_MM} mm from the part's own corners and ≥
 * {@link TAB_PIN_CLEARANCE_MM} mm from a locating bore's centre. Each of the four tabs is placed
 * INDEPENDENTLY (equal-arc spacing can put a short side's bridge too near a corner): the module
 * computes the exact span-start intervals that satisfy both rules on every straight run, picks
 * the most spread-out set of non-overlapping spans, and hands those centres to `placeTabs`, whose
 * edge and overlap rules build the spans unchanged. If no such set exists, the release REFUSES BY
 * NAME (a job whose tabs cannot be placed must not cut the part free).
 *
 * The band's top is the side's own cut floor — `goal.position.z` less `goal.bandMm`, the depth the
 * side-2 program stops at; the band's half-thickness is the goal's own
 * `underside.tabs.thicknessMm` — the same record the plan that banded both sides wrote (F's seam,
 * 2026-11-08). `tabReleaseIr` wraps the plan as the flat-frame program the flipped setup posts
 * last.
 */

import type { CutParams } from '@/engine/cnc/feeds';
import type { CamMove, RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { estimateCycleSeconds, HOP_Z, SAFE_Z, toolNumberFor } from '@/engine/cnc/cam/ir';
import type { Tool } from '@/engine/cnc/tool';
import {
  contourMoves,
  enclosedPath,
  placeTabs,
  profilePath,
  signedArea,
  type TabPlacement,
} from '@/engine/cnc/cam/profile';
import { zPasses } from '@/engine/cnc/cam/engraveJob';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import { crossSectionPolylines, UNDERSIDE_TAB_THICKNESS_MM } from './goalUnderside';
import { goalWorkMesh } from './goalFlipFindings';
import type { EngraveTargetObject, JobSetupPins } from '@/types/engraveJob';

/** How far a tab's span must stand from the part's own corners, mm (Analyst's ruling). */
export const TAB_CORNER_CLEARANCE_MM = 15;

/** How far a tab's span must stand from a locating bore's centre, mm (Analyst's ruling). */
export const TAB_PIN_CLEARANCE_MM = 10;

/** The tab bridges the release leaves: the shop's tab defaults, handed in by the caller. */
export interface TabReleaseTabs {
  count: number;
  widthMm: number;
  heightMm: number;
}

/**
 * THE BAND'S HALF-THICKNESS a goal states, mm — `underside.tabs.thicknessMm`, the record F's flip
 * plan writes (plane ± this, so the band is twice it), else the labelled default the flip plan
 * itself uses. NOT a tab height: the goal's tabs block states the band, and the bridge's own
 * height is the shop's tab height capped at the band's full thickness.
 */
export function bandHalfThicknessMm(goal: EngraveTargetObject): number {
  return Math.max(0.2, goal.underside?.tabs?.thicknessMm ?? UNDERSIDE_TAB_THICKNESS_MM);
}

export interface TabReleaseInput {
  /** The flipped setup's goal copy: its `bandMm` (the cut floor) and the underside tab band. */
  goal: EngraveTargetObject;
  /** The setup's locating-pin centres in this setup's work XY; null when the method has none. */
  pins: JobSetupPins | null;
  /** The contour flat's cutting radius, mm. */
  toolRadiusMm: number;
  /** The tab bridges to leave (the shop's `tabs.*` defaults). */
  tabs: TabReleaseTabs;
  /** The feeds of the release's own cutter. */
  params: CutParams;
  /** The outward offset (the house kernel's), so the path is measured, not approximated. */
  offset: OffsetFn;
}

export interface TabReleasePlan {
  /** The band's top — the side's own cut floor, work Z (negative below the work top). */
  bandTopZ: number;
  /** The band's bottom: the other side's floor. */
  bandBottomZ: number;
  /** The tab top: `tabs.heightMm` above the band's bottom, where the crossings run. */
  tabTopZ: number;
  /** The offset centre path, one ring around the part. */
  path: Polygons;
  placement: TabPlacement;
  /** The tab bridges' centres in work XY, for the sheet and the graphic. */
  tabCentres: [number, number][];
  /** The band cut's earlier passes, down to one step above the final level. A pass that reaches
   *  below the tab top crosses the spans at the tab top like the final lap does. */
  bulkMoves: CamMove[];
  /** The NAMED final lap: the tabbed contour at the band's bottom, the only part-frees cut. */
  finalMoves: CamMove[];
}

/** A refusal, named: the caller states the sentence and does not post the release. */
export interface TabReleaseRefusal {
  ok: false;
  code: 'tab-release-no-band' | 'tab-release-no-mesh' | 'tab-release-no-path' | 'tab-release-no-tabs';
  reason: string;
}

/**
 * #1073 — WHAT THE SHEET PRINTS about the release program: the bridges it leaves, their size, and
 * where they are in the setup's work XY. The positions are the plan's own `tabCentres`, never a
 * second derivation the run sheet could disagree with.
 */
export interface TabReleaseProgramFacts {
  count: number;
  /** Tab width in material, mm. */
  widthMm: number;
  /** The material left at the bottom of the band, mm. */
  heightMm: number;
  /** The bridges' centres, in this setup's work frame. */
  at: { x: number; y: number }[];
}

export type TabReleaseResult = { ok: true; plan: TabReleasePlan } | TabReleaseRefusal;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The distance from `p` to the nearest point of the span `a`→`b` (its path, not its chord). */
function spanDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The four corners of the loop's bounding box, mm — the part's own corners the tabs stay off. */
function bboxCorners(loop: readonly (readonly [number, number])[]): [number, number][] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of loop) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/** Does the WHOLE span clear the corners and the bores by the ruled distances? */
function spanClears(
  span: TabPlacement['spans'][number],
  corners: readonly [number, number][],
  pins: readonly { x: number; y: number }[],
): boolean {
  // The span is the tab, not only its ends: every point of it must stand clear, so the distance is
  // measured to the segment itself (the ends were the earlier, weaker test).
  for (const [cx, cy] of corners) {
    if (spanDistance([cx, cy], span.start, span.end) < TAB_CORNER_CLEARANCE_MM - 1e-6) return false;
  }
  for (const pin of pins) {
    if (spanDistance([pin.x, pin.y], span.start, span.end) < TAB_PIN_CLEARANCE_MM - 1e-6) return false;
  }
  return true;
}

/**
 * THE EMPTY SPOTS a release tab must keep off: the part's own bbox corners (15 mm) and the
 * locating bores' centres (10 mm), each with the distance the ruling gives it.
 */
interface ClearancePoint {
  x: number;
  y: number;
  clearanceMm: number;
}

/** A maximal straight run of the offset ring, by arc length along the contour, mm. */
interface RingRun {
  startArc: number;
  length: number;
  p0: [number, number];
  /** Unit direction along the run. */
  dir: [number, number];
}

/** Directions within this of each other form one straight run — the SAME tolerance `edgesOf`
 *  (`cam/profile.ts`) uses for the edges `placeTabs` may place on. */
const RUN_COLLINEAR_COS = Math.cos((0.5 * Math.PI) / 180);

const sameDirection = (p: readonly [number, number], q: readonly [number, number]): boolean =>
  p[0] * q[0] + p[1] * q[1] > RUN_COLLINEAR_COS;

/** The ring's perimeter, mm. */
function ringPerimeter(ring: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}

/**
 * The ring's maximal straight runs. A run the seam splits in two (the contour's first vertex can
 * fall mid-side) is merged back into one; its arc range then continues past the perimeter, which
 * the targets and `placeTabs` both read modulo the perimeter.
 */
function ringRuns(ring: readonly (readonly [number, number])[]): RingRun[] {
  const segs: { a: [number, number]; len: number; dir: [number, number]; arc: number }[] = [];
  let arc = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    segs.push({ a: [a[0], a[1]], len, dir: len > 1e-12 ? [dx / len, dy / len] : [0, 0], arc });
    arc += len;
  }
  const runs: RingRun[] = [];
  let i = 0;
  while (i < segs.length) {
    const first = segs[i]!;
    if (first.len <= 1e-12) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < segs.length && segs[end + 1]!.len > 1e-12 && sameDirection(segs[end + 1]!.dir, first.dir)) end++;
    const last = segs[end]!;
    runs.push({ startArc: first.arc, length: last.arc + last.len - first.arc, p0: first.a, dir: first.dir });
    i = end + 1;
  }
  if (runs.length > 1) {
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    if (Math.abs(first.startArc) < 1e-12 && sameDirection(last.dir, first.dir)) {
      runs[0] = { startArc: last.startArc, length: last.length + first.length, p0: last.p0, dir: last.dir };
      runs.pop();
    }
  }
  return runs;
}

/**
 * THE SPAN-START INTERVALS along one run where the whole span keeps its distance from every
 * clearance point — exact, not sampled. For a point whose projection on the run is `along` and
 * whose perpendicular distance is `perp`, a span of length S starting at `s` comes within `d` of
 * it exactly when `along − S − δ < s < along + δ`, with `δ = √(d² − perp²)`; no point of the
 * line is closer than `d` when `perp ≥ d`.
 */
function clearStarts(run: RingRun, spanLength: number, voids: readonly ClearancePoint[]): [number, number][] {
  const maxStart = run.length - spanLength;
  if (maxStart < -1e-9) return [];
  const forbidden: [number, number][] = [];
  for (const v of voids) {
    const rx = v.x - run.p0[0];
    const ry = v.y - run.p0[1];
    const along = rx * run.dir[0] + ry * run.dir[1];
    const perp = Math.abs(rx * run.dir[1] - ry * run.dir[0]);
    if (perp >= v.clearanceMm) continue;
    const half = Math.sqrt(v.clearanceMm * v.clearanceMm - perp * perp);
    forbidden.push([along - spanLength - half, along + half]);
  }
  forbidden.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of forbidden) {
    const from = Math.max(0, lo);
    const to = Math.min(maxStart, hi);
    if (to <= from) continue;
    if (from > cursor) out.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor <= maxStart + 1e-9) out.push([cursor, maxStart]);
  return out.filter(([lo, hi]) => hi > lo + 1e-9);
}

/** The arc distance between two positions on the closed contour, mm. */
function circularDistance(a: number, b: number, perimeter: number): number {
  const d = ((a - b) % perimeter + perimeter) % perimeter;
  return Math.min(d, perimeter - d);
}

/** One candidate tab: where its span starts along the ring, and its centre in work XY. */
interface TabCandidate {
  startArc: number;
  mid: [number, number];
}

/** Samples per clear interval, inclusive of both ends — enough for the spread to reach a run's
 *  ends and still fit several tabs inside one long run. */
const CANDIDATES_PER_INTERVAL = 8;

function tabCandidates(
  runs: readonly RingRun[],
  spanLength: number,
  voids: readonly ClearancePoint[],
  perimeter: number,
): TabCandidate[] {
  const out: TabCandidate[] = [];
  // A candidate ON an interval's own boundary sits exactly the ruled distance from the corner or
  // bore — legal, but a tab placed exactly at the limit has no margin to dress. Keep 0.05 mm off
  // both ends; a shorter interval still samples its middle.
  const PAD_MM = 0.05;
  for (const run of runs) {
    for (const [lo, hi] of clearStarts(run, spanLength, voids)) {
      const pad = Math.min(PAD_MM, (hi - lo) / 2);
      const from = lo + pad;
      const to = hi - pad;
      for (let j = 0; j < CANDIDATES_PER_INTERVAL; j++) {
        const s = from + ((to - from) * j) / (CANDIDATES_PER_INTERVAL - 1);
        const startArc = (run.startArc + s) % perimeter;
        out.push({
          startArc,
          mid: [run.p0[0] + (s + spanLength / 2) * run.dir[0], run.p0[1] + (s + spanLength / 2) * run.dir[1]],
        });
      }
    }
  }
  return out;
}

/**
 * Pick `count` candidates that are spread around the part: seed at the first by arc, then take
 * the candidate farthest (in work XY) from every one already chosen. Two spans of equal length
 * overlap exactly when their start positions are closer than the span length along the contour,
 * so that is the separation rule.
 */
function spreadSelect(
  candidates: readonly TabCandidate[],
  count: number,
  spanLength: number,
  perimeter: number,
): TabCandidate[] | null {
  if (candidates.length < count) return null;
  const chosen: TabCandidate[] = [candidates[0]!];
  while (chosen.length < count) {
    let best: TabCandidate | null = null;
    let bestDistance = Infinity;
    for (const c of candidates) {
      if (chosen.some((o) => circularDistance(c.startArc, o.startArc, perimeter) < spanLength - 1e-9)) continue;
      let nearest = Infinity;
      for (const o of chosen) nearest = Math.min(nearest, Math.hypot(c.mid[0] - o.mid[0], c.mid[1] - o.mid[1]));
      if (best === null || nearest > bestDistance + 1e-9) {
        best = c;
        bestDistance = nearest;
      }
    }
    if (best === null) return null;
    chosen.push(best);
  }
  return chosen;
}

/**
 * The tabs, placed INDEPENDENTLY on the outline's long straight runs: each bridge's own centre
 * clears the part's corners by 15 mm and the locating bores by 10 mm, the bridges do not overlap,
 * and `placeTabs` builds the spans from those centres (its edge and overlap rules unchanged).
 * Null when no such set of `count` bridges exists — the release must then refuse, because the
 * part would come free under the cutter.
 */
function placeReleaseTabs(
  ring: readonly (readonly [number, number])[],
  tabs: TabReleaseTabs,
  toolRadiusMm: number,
  corners: readonly [number, number][],
  pins: readonly { x: number; y: number }[],
): TabPlacement | null {
  const spanLength = tabs.widthMm + 2 * toolRadiusMm;
  if (!(spanLength > 0) || tabs.count <= 0) return null;
  const perimeter = ringPerimeter(ring);
  if (!(perimeter > 0)) return null;
  const voids: ClearancePoint[] = [
    ...corners.map(([x, y]) => ({ x, y, clearanceMm: TAB_CORNER_CLEARANCE_MM })),
    ...pins.map((pin) => ({ x: pin.x, y: pin.y, clearanceMm: TAB_PIN_CLEARANCE_MM })),
  ];
  const candidates = tabCandidates(ringRuns(ring), spanLength, voids, perimeter);
  const chosen = spreadSelect(candidates, tabs.count, spanLength, perimeter);
  if (chosen === null) return null;
  const targets = chosen.map((c) => c.startArc + spanLength / 2);
  const placement = placeTabs(ring, tabs.count, tabs.widthMm, toolRadiusMm, { targets });
  if (placement.spans.length !== tabs.count) return null;
  if (!placement.spans.every((span) => spanClears(span, corners, pins))) return null;
  // The spans must be the ones asked for, not a distant edge's snap: each centre within half a
  // millimetre of its target (the clearance test above is the binding one).
  const midArc = (span: TabPlacement['spans'][number]): number => (span.startArc + spanLength / 2) % perimeter;
  if (!placement.spans.every((span) => targets.some((t) => circularDistance(midArc(span), t % perimeter, perimeter) < 0.5))) {
    return null;
  }
  return placement;
}

/**
 * #1073 — THE RELEASE AS A POSTABLE PROGRAM: one operation, the band's bulk passes and then its
 * named tabbed final lap, in that order. The IR is the ordinary flat frame the plan's own contour
 * posts in; the caller hands the contour flat, the feeds row it resolved for that flat, and the
 * machine's rapid model, so the file's numbers are the plan's numbers.
 */
export function tabReleaseIr(
  plan: TabReleasePlan,
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
  labelId: string,
): ToolpathIR {
  const bandThickness = plan.bandTopZ - plan.bandBottomZ;
  const moves: CamMove[] = [...plan.bulkMoves, ...plan.finalMoves];
  const last = moves[moves.length - 1];
  if (last !== undefined) moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
  const number = toolNumberFor(tool);
  return {
    frame: 'flat',
    tool,
    toolNumber: number,
    spindleRpm: params.rpm,
    air: params.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations: [
      {
        number: 1,
        name: `[T${number}]Tab release ${bandThickness.toFixed(1)}mm`,
        labelId,
        depth: bandThickness,
        depthPasses: zPasses(bandThickness, params.stepDown).length,
        passStepMm: params.stepDown,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, rapid),
        passKind: 'through',
      },
    ],
  };
}

/**
 * Plan the release from the side-2 goal's own records. Pure: no store, no machine.
 */
export function planTabRelease(input: TabReleaseInput): TabReleaseResult {
  const { goal, tabs } = input;
  const bandMm = goal.bandMm;
  if (bandMm === undefined || !(bandMm > 0)) {
    return {
      ok: false,
      code: 'tab-release-no-band',
      reason:
        'the flipped setup’s goal states no band, so neither side left material to release — band the goal copies first ' +
        '(the flip plan’s own job) and the release follows',
    };
  }
  const half = bandHalfThicknessMm(goal);
  const bandThickness = 2 * half;
  // The bridge is the material the release leaves across the band: its height may be the WHOLE
  // band (the ruling's "the bridge is the full band") or less, but never more than the band.
  if (!(tabs.heightMm > 0) || tabs.heightMm > bandThickness + 1e-9) {
    return {
      ok: false,
      code: 'tab-release-no-tabs',
      reason:
        `a ${r3(tabs.heightMm)} mm tab is thicker than the ${r3(bandThickness)} mm band: the tab is the material left across ` +
        'the band, so it cannot be thicker than the band itself',
    };
  }
  const mesh = goalWorkMesh(goal);
  if (mesh === null) {
    return { ok: false, code: 'tab-release-no-mesh', reason: 'the goal’s mesh could not be read, so the band’s section is unknown' };
  }
  const bandTopZ = goal.position.z - bandMm;
  const bandBottomZ = bandTopZ - bandThickness;
  const tabTopZ = bandBottomZ + tabs.heightMm;
  const loops = crossSectionPolylines(mesh, bandTopZ - half);
  if (loops.length === 0) {
    return {
      ok: false,
      code: 'tab-release-no-mesh',
      reason: 'the band’s own section has no closed loop — the mesh does not close there, so there is no outline to release',
    };
  }
  const outer = loops.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
  // The outline wound the way `profilePath` reads an OUTSIDE profile (CCW outers).
  const outline = enclosedPath([outer]);
  const rings = profilePath(outline, 'outside', input.toolRadiusMm, 0, input.offset);
  if (rings.length === 0) {
    return {
      ok: false,
      code: 'tab-release-no-path',
      reason:
        `the band’s outline is narrower than the ${r3(2 * input.toolRadiusMm)} mm cutter: the release has no centre path to ` +
        'follow — use a smaller flat for the release',
    };
  }
  const ring = rings.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
  const corners = bboxCorners(outer);
  const pins = input.pins === null ? [] : input.pins.at;
  const placement = placeReleaseTabs(ring, tabs, input.toolRadiusMm, corners, pins);
  if (placement === null) {
    return {
      ok: false,
      code: 'tab-release-no-tabs',
      reason:
        `could not place ${tabs.count} tabs on the band’s outline: each needs a straight run clear of the part’s corners by ` +
        `${TAB_CORNER_CLEARANCE_MM} mm and of the locating bores by ${TAB_PIN_CLEARANCE_MM} mm, and no placement satisfies all ` +
        `${tabs.count} — the part would come free under the cutter, so the release is refused`,
    };
  }
  // The band's Z levels, from its top down; the LAST one is the named final lap.
  const levels = zPasses(bandThickness, input.params.stepDown).map((d) => bandTopZ + d);
  const bulkMoves: CamMove[] = [];
  const finalMoves: CamMove[] = [];
  levels.forEach((z, i) => {
    const target = i === levels.length - 1 ? finalMoves : bulkMoves;
    for (const r of rings) {
      // The spans were placed on the largest ring; a second ring (an island) is cut untabbed.
      const on: TabPlacement = r === ring ? placement : { spans: [], unplaceable: 0, added: 0, tight: [] };
      target.push(...contourMoves(r, z, tabTopZ, on, input.params).moves);
    }
  });
  const tabCentres = placement.spans.map((span): [number, number] => [
    r3((span.start[0] + span.end[0]) / 2),
    r3((span.start[1] + span.end[1]) / 2),
  ]);
  return {
    ok: true,
    plan: {
      bandTopZ,
      bandBottomZ,
      tabTopZ,
      path: rings,
      placement,
      tabCentres,
      bulkMoves,
      finalMoves,
    },
  };
}
