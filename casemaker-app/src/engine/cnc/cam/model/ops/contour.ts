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

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { zPasses } from '@/engine/cnc/cam/engraveJob';
import { generateProfile, profilePath, type ProfileCut } from '@/engine/cnc/cam/profile';
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
  /** `{count: 0}` cuts the part free with no tabs. */
  tabs: { count: number; width: number; height: number };
  offset: OffsetFn;
  params: CutParams;
  rapid: RapidEstimate;
}

// E's measurement on fb9fdaae: over 3,083 contour feeds, the minimum clearance to the outline was
// 2.99704 mm against a stated 3 mm radius — 3 µm INSIDE it, at one segment, Clipper's own offset
// rounding. A profile path that ever sits closer to the true outline than the cutter's own radius
// cuts into whatever the outline is protecting there (the Manager's ruling on fb9fdaae: a gate
// boundary-cell artefact explained the 134 adjudicated cells this round, but this 3 µm gap is real
// and this op's own to fix). Guarding the OUTSIDE offset distance outward by a hair ensures the
// path never sits inside the radius, whatever a real offset function's own rounding does.
const PROFILE_OFFSET_GUARD_MM = 0.001;

export function contour(opts: ContourOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/contour: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const path: Polygons = profilePath(opts.contour.outline, 'outside', toolRadius, PROFILE_OFFSET_GUARD_MM, opts.offset);
  const cut: ProfileCut = {
    id: 'contour',
    name: 'Contour',
    path,
    depth: opts.depthMm,
    thickness: opts.thicknessMm ?? opts.depthMm,
    tabs: opts.tabs,
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
