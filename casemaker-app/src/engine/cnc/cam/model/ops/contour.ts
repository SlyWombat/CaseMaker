/**
 * cam/model/ops/contour.ts — §3.2 of `docs/design/cam-model-engine.md`.
 *
 * The outer contour, step-downs to full depth, tabs when `contour.frees` — uses the EXISTING
 * `generateProfile` (`cam/profile.ts:631`) UNCHANGED for the moves themselves (it already builds
 * the full `ToolpathIR`, step-downs and tabs included — `zPasses`, `placeTabs`, `tabBars`/
 * `tabBridgeRectangles`, checked, not assumed, in the design note). `profilePath` (`profile.ts:115`)
 * gives the tool-centre path outside the recognised outline, exactly as a cut-out's own path is
 * built elsewhere. What this file adds is turning `FeatureTree.contour` into the `ProfileCut`
 * `generateProfile` expects, and the `OpOutcome` wrapper every op returns — no new contour math.
 *
 * `PassRef`s are built directly from the SAME Z levels and path this op hands to `generateProfile`
 * (via the shared `zPasses`), not by parsing its move list back apart: `generateProfile` does not
 * expose per-level structure, and re-deriving it from moves would be a second, fragile source of
 * truth for information this file already has going in.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { zPasses } from '@/engine/cnc/cam/engraveJob';
import { generateProfile, longestTabGap, placeTabs, profilePath, type ProfileCut, type TabPlacement } from '@/engine/cnc/cam/profile';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import { cutterKeyOf } from '../sequence';
import type { FeatureTree } from '../features';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';

export interface ContourOpOptions {
  cutter: Tool;
  contour: FeatureTree['contour'];
  region: RegionRef;
  /** Total cutting depth below the part top, positive mm — `partTop - contour.zTo`. */
  depthMm: number;
  /** The blank's own thickness, mm (for the tab top: `-(thickness - tabs.height)`); absent → `depthMm` (no separate skin). */
  thicknessMm?: number;
  /** `{count: 0}` cuts the part free with no tabs. `maxSpanMm` is the shop's `tabs.maxSpanMm` (#1206). */
  tabs: { count: number; width: number; height: number; maxSpanMm?: number };
  offset: OffsetFn;
  params: CutParams;
  rapid: RapidEstimate;
  /**
   * #965/#898 part 2: when this contour FREES a non-first setup, the max LOCAL depth (same units
   * and datum as `depthMm` — positive mm below THIS setup's own stock top) that is safe at a given
   * LOCAL (x, y) ON THE PATH, imposed by the OPPOSITE setup's already-finished surface — `null`
   * where that setup's surface places no limit (its own waste, or no geometry under that point at
   * all). The caller (`plan.ts`) is what resolves a setup/frame pair into this plain function;
   * this file stays frame-agnostic. Absent → no opposite setup (today's single-setup case, or the
   * first of two) — `contour()` behaves EXACTLY as before (#959/#960's regression safety).
   */
  oppositeSafeDepthMm?: (x: number, y: number) => number | null;
  /**
   * #943 (10) — this contour is a THROUGH cut (its depth reaches the stock bottom, so the board's
   * breakthrough applies): the returned `OpOutcome.throughKerf` states the kerf — path, tab spans,
   * radius, tab height — for the verifier's through mask. Absent/false: no kerf is stated, and a
   * contour that stops above the stock bottom grants no breakthrough.
   */
  through?: boolean;
}

// E's measurement on fb9fdaae: over 3,083 contour feeds, the minimum clearance to the outline was
// 2.99704 mm against a stated 3 mm radius — 3 µm INSIDE it, at one segment, Clipper's own ROUND
// join. `makeClipperOffset` approximates that join with `segmentsForRadius`'s own chord-tolerance
// bound (`arcResolution.ts`): a polygon with straight chords instead of a true arc sits INSIDE the
// true circle by the chord's own sagitta at its midpoint, bounded by exactly `ARC_CHORD_TOLERANCE_MM`
// by that function's own contract — advisor's review caught that an earlier, arbitrary 0.001 mm
// guard (less than the measured 3 µm deficit) did not actually cover it. This is not a tuned
// constant: it is the SAME bound the offset's own chord approximation is built to hold, so guarding
// the requested offset distance outward by it guarantees the result never sits inside the true
// radius, whatever a real offset function's own rounding does within that stated bound.
const PROFILE_OFFSET_GUARD_MM = ARC_CHORD_TOLERANCE_MM;

export function contour(opts: ContourOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/contour: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const path: Polygons = profilePath(opts.contour.outline, 'outside', toolRadius, PROFILE_OFFSET_GUARD_MM, opts.offset);

  // #965/#898 part 2: `ProfileCut.depth` is ONE scalar for the whole cut — `generateProfile`'s own
  // contract, not touched here (this file's header: no new contour math). A true per-point-along-
  // the-path follow of the opposite surface would need `generateProfile`/`profilePath` to accept a
  // depth that varies along the path, which they do not and this change does not add. What IS
  // correct within that constraint: sample `oppositeSafeDepthMm` at every vertex the offset path
  // ALREADY has (its own chord-tolerance-bound density from `profilePath`'s offset), and take the
  // MINIMUM safe depth found over the WHOLE path — the single flat depth that is guaranteed never
  // to cut past the opposite surface at ANY point the tool actually travels. This is not "the easy
  // choice taken over a better one": given the one-scalar-depth contract, it is the correct one —
  // never less safe than a true per-point follow (it only ever cuts LESS than that would, never
  // more, wherever the opposite surface varies along the path), stated here rather than silently
  // assumed.
  let depthMm = opts.depthMm;
  if (opts.oppositeSafeDepthMm !== undefined) {
    let minSafeMm = Infinity;
    for (const ring of path) {
      for (const [x, y] of ring) {
        const safe = opts.oppositeSafeDepthMm(x, y);
        if (safe !== null && safe < minSafeMm) minSafeMm = safe;
      }
    }
    if (minSafeMm < depthMm) depthMm = Math.max(0, minSafeMm);
  }

  const thicknessMm = opts.thicknessMm ?? depthMm;
  // #1160 — A TAB CANNOT BE TALLER THAN THE PART IT HOLDS. `generateProfile` puts the tab's top
  // at `-(cut.thickness - tabs.height)`; the default 1 mm release tab on a 0.81 mm part (the
  // badge blank) put that top at +0.19 mm — ABOVE the stock top — and every candidate plan was
  // refused by the post's own air-cut rule (a feed above the stock top, below hopZ). Clamped to
  // the cut's own thickness, the tallest honest tab IS the part's full height, and its crossing
  // runs exactly at the stock top. The through case states `thicknessMm` = the blank, so the
  // clamp there is the blank's thickness: still the most material a tab can leave.
  const tabHeightMm = Math.min(opts.tabs.height, thicknessMm);
  const cut: ProfileCut = {
    id: 'contour',
    name: 'Contour',
    path,
    depth: depthMm,
    thickness: thicknessMm,
    tabs: tabHeightMm === opts.tabs.height ? opts.tabs : { ...opts.tabs, height: tabHeightMm },
  };

  const result = generateProfile([cut], opts.cutter, opts.params, opts.rapid);
  // #1235 — the contour STATES its outward guard: `profilePath` placed the centre path at
  // `toolRadius + PROFILE_OFFSET_GUARD_MM`, so the verifier's footprint rule allows exactly that
  // much beyond its own radius and no more. Every operation from this cut carries it.
  const ir = {
    ...result.ir,
    operations: result.ir.operations.map((op) => ({ ...op, outsideAllowanceMm: PROFILE_OFFSET_GUARD_MM })),
  };

  const levels = zPasses(depthMm, opts.params.stepDown);
  const passes: PassRef[] = levels.flatMap((z) =>
    path.map((ring) => {
      const start = ring[0]!;
      const entry: [number, number, number] = [start[0], start[1], z];
      return { z, boundary: [ring as [number, number][]], cleared: { z, boundary: path }, entry, exit: entry };
    }),
  );
  const cleared: RegionAtZ[] = levels.map((z) => ({ z, boundary: path }));

  // #943 (10) — the kerf this through cut leaves for the verifier's own mask. The spans are the
  // SAME `placeTabs` call `generateProfile` makes one level down (same path, same count, width and
  // radius — a pure function), so the mask protects exactly the tabs the file keeps; nothing is
  // re-derived from moves.
  const placements: TabPlacement[] =
    cut.tabs.count > 0
      ? path.map((ring) =>
          placeTabs(ring, cut.tabs.count, cut.tabs.width, toolRadius, {
            ...(cut.tabs.maxSpanMm === undefined ? {} : { maxSpanMm: cut.tabs.maxSpanMm }),
          }),
        )
      : [];

  // #1206 (the analyst's condition 3) — THE SPAN LIMIT IS CHECKED ON THE TABS AS PLACED. A drop
  // that leaves a stretch of outline longer than the shop's limit is a REFUSAL with its reason,
  // never a quieter program. (The limit is what `placeTabs` tried to meet; it can fail when the
  // edges' corner margins leave no room for the tabs the gaps ask for.)
  if (cut.tabs.count > 0 && cut.tabs.maxSpanMm !== undefined && cut.tabs.maxSpanMm > 0) {
    path.forEach((ring, i) => {
      const spans = placements[i]!.spans;
      if (spans.length === 0) return;
      let perimeter = 0;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!;
        const b = ring[(k + 1) % ring.length]!;
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const gap = longestTabGap(spans, perimeter);
      if (gap > cut.tabs.maxSpanMm! + 1e-9) {
        throw new Error(
          `the freeing contour's tabs leave a ${gap.toFixed(1)} mm stretch of outline without one, ` +
            `past the shop's ${cut.tabs.maxSpanMm} mm span limit — the edges' corners leave no room ` +
            'for the tabs that stretch asks for',
        );
      }
    });
  }

  const throughKerf =
    opts.through === true
      ? {
          path,
          spans: placements.map((placement) => placement.spans),
          toolRadius,
          tabHeight: cut.tabs.height,
        }
      : undefined;

  // #1206 (the analyst's condition 2) — A JOB THAT PLACES FEWER TABS THAN ASKED SAYS SO. The note
  // travels with the plan's notes and the sheet prints every one; a count the operator asked for
  // and did not get is never silent.
  const asked = cut.tabs.count * path.length;
  const placed = placements.reduce((sum, placement) => sum + placement.spans.length, 0);
  const tabNotes =
    cut.tabs.count > 0 && placed < asked
      ? [
          `release tabs: ${asked} asked, ${placed} placed — the remaining edges are too short for another tab clear of the corners`,
        ]
      : [];

  const clampedTabHeightMm =
    tabHeightMm < opts.tabs.height ? { wanted: opts.tabs.height, cut: tabHeightMm } : undefined;

  return {
    ir,
    cutter: cutterKeyOf(opts.cutter),
    passes,
    cleared,
    ...(throughKerf === undefined ? {} : { throughKerf }),
    ...(clampedTabHeightMm === undefined ? {} : { clampedTabHeightMm }),
    ...(tabNotes.length === 0 ? {} : { notes: tabNotes }),
  };
}

export interface ThroughHoleOpOptions {
  cutter: Tool;
  /** The `PocketNode.id` this hole is (A's review 6622610124, finding 4). */
  id: string;
  /** The hole's own footprint — `PocketNode.region` for a `through` node. */
  outline: Polygons;
  region: RegionRef;
  /** Total cutting depth below the part top, positive mm — through the full thickness. */
  depthMm: number;
  offset: OffsetFn;
  params: CutParams;
  rapid: RapidEstimate;
}

/**
 * A through hole (`PocketNode.through`) — a SEPARATE op from `contour()`'s outer release, not
 * folded into it: #961's chain sizes the cutter per feature, and a hole narrower than the
 * release's own primary flat needs a smaller one of its own (A's review 6622610124, finding 4 —
 * "through nodes skipped silently"). `generateProfile` orders cuts innermost-first; the caller
 * (`plan.ts`) is what puts every through hole before the outer release in one cutter's program.
 * No tabs: a hole isolates no material of its own to hold down.
 */
export function throughHole(opts: ThroughHoleOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/contour: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const path: Polygons = profilePath(opts.outline, 'inside', toolRadius, 0, opts.offset);
  const cut: ProfileCut = {
    id: opts.id,
    name: `Through "${opts.id}"`,
    path,
    depth: opts.depthMm,
    thickness: opts.depthMm,
    tabs: { count: 0, width: 0, height: 0 },
  };

  const result = generateProfile([cut], opts.cutter, opts.params, opts.rapid);

  const levels = zPasses(opts.depthMm, opts.params.stepDown);
  const passes: PassRef[] = levels.flatMap((z) =>
    path.map((ring) => {
      const start = ring[0]!;
      const entry: [number, number, number] = [start[0], start[1], z];
      return { z, boundary: [ring as [number, number][]], cleared: { z, boundary: path }, entry, exit: entry };
    }),
  );
  const cleared: RegionAtZ[] = levels.map((z) => ({ z, boundary: path }));

  return { ir: result.ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
