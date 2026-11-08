/**
 * #1073 line 4 — SIDE 2'S TAB RELEASE: the flipped setup's LAST shallow pass. The two sides cut
 * to `bandMm` and `bandMm + 2·tabs.thicknessMm`, leaving a continuous band of material around the
 * part; this pass cuts that band through so the part comes free — and, by Analyst's binding ruling
 * (2026-11-08), the part NEVER goes free under a running cutter: 4 tab bridges are left in the
 * band's last millimetre and the operator cuts them with a flush-cut saw after the machine is
 * homed. The final lap is its own named operation so a later ruling can make it a stop-and-hold
 * without rewriting the plan.
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
 * {@link TAB_PIN_CLEARANCE_MM} mm from a locating bore's centre. `placeTabs` places at equal arc
 * intervals from the contour's start, so the filter walks the start vertex around the loop and
 * takes the first placement that satisfies every rule; if none does, the release REFUSES BY NAME
 * (a job whose tabs cannot be placed must not cut the part free).
 *
 * The band's top is the side's own cut floor (`goal.bandMm`, the depth the side-2 program stops
 * at); the band's half-thickness is the goal's own `underside.tabs.thicknessMm` — the same record
 * the plan that banded both sides wrote (F's seam, 2026-11-08).
 */

import type { CutParams } from '@/engine/cnc/feeds';
import type { CamMove } from '@/engine/cnc/cam/ir';
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
  /** The band cut, down to one pass above the final level (no crossings — nothing to keep yet). */
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

/** Does every point of this span clear the corners and the bores by the ruled distances? */
function spanClears(
  span: TabPlacement['spans'][number],
  corners: readonly [number, number][],
  pins: readonly { x: number; y: number }[],
): boolean {
  for (const [x, y] of [span.start, span.end]) {
    for (const [cx, cy] of corners) {
      if (Math.hypot(x - cx, y - cy) < TAB_CORNER_CLEARANCE_MM - 1e-6) return false;
    }
    for (const pin of pins) {
      if (Math.hypot(x - pin.x, y - pin.y) < TAB_PIN_CLEARANCE_MM - 1e-6) return false;
    }
  }
  // The pin rule is about the HOLE, not only the span's ends: the whole span stands clear of it.
  for (const pin of pins) {
    if (spanDistance([pin.x, pin.y], span.start, span.end) < TAB_PIN_CLEARANCE_MM - 1e-6) return false;
  }
  return true;
}

/**
 * The tabs, placed by `placeTabs` at equal arc intervals from the contour's own start — walked
 * around the loop until every span satisfies the clearance rules. Null when no start does.
 */
function placeReleaseTabs(
  ring: readonly (readonly [number, number])[],
  tabs: TabReleaseTabs,
  toolRadiusMm: number,
  corners: readonly [number, number][],
  pins: readonly { x: number; y: number }[],
): TabPlacement | null {
  const step = Math.max(1, Math.floor(ring.length / 96));
  for (let k = 0; k < ring.length; k += step) {
    const rotated = [...ring.slice(k), ...ring.slice(0, k)];
    const placement = placeTabs(rotated, tabs.count, tabs.widthMm, toolRadiusMm);
    if (placement.spans.length !== tabs.count) continue;
    if (placement.spans.every((span) => spanClears(span, corners, pins))) return placement;
  }
  return null;
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
  const half = Math.max(0.2, goal.underside?.tabs?.thicknessMm ?? UNDERSIDE_TAB_THICKNESS_MM);
  const bandThickness = 2 * half;
  if (!(tabs.heightMm > 0) || tabs.heightMm >= bandThickness - 1e-9) {
    return {
      ok: false,
      code: 'tab-release-no-tabs',
      reason:
        `a ${r3(tabs.heightMm)} mm tab does not fit the ${r3(bandThickness)} mm band: the tab is the material left at the ` +
        'bottom of the release cut, so it must be thinner than the band itself',
    };
  }
  const mesh = goalWorkMesh(goal);
  if (mesh === null) {
    return { ok: false, code: 'tab-release-no-mesh', reason: 'the goal’s mesh could not be read, so the band’s section is unknown' };
  }
  const bandTopZ = -bandMm;
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
      const on: TabPlacement = r === ring ? placement : { spans: [], unplaceable: 0 };
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
