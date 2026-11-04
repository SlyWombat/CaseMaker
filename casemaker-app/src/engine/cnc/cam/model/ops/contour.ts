/**
 * cam/model/ops/contour.ts — §3.2 of `docs/design/cam-model-engine.md`.
 *
 * The outer contour, step-downs to full depth, tabs when `contour.frees` — uses the EXISTING
 * `generateProfile` (`cam/profile.ts:631`) unchanged; it already supports step-downs and tabs
 * (`TabPlacement`/`ProfileTabReport`, `placeTabs`, `tabBars`/`tabBridgeRectangles` — checked, not
 * assumed, in the design note). No new contour math.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { FeatureTree } from '../features';
import type { OpOutcome, RegionRef } from '../linking';

export interface ContourOpOptions {
  cutter: Tool;
  contour: FeatureTree['contour'];
  region: RegionRef;
}

export function contour(_opts: ContourOpOptions): OpOutcome {
  throw new Error('cam/model/ops/contour: contour() not implemented (#959)');
}
