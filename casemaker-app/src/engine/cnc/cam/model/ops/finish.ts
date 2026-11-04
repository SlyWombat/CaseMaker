/**
 * cam/model/ops/finish.ts — §3.4 of `docs/design/cam-model-engine.md`.
 *
 * Finishing by slope: a flat-following raster where the local slope is under the flat cutter's
 * admissible angle (Studio's method on the tray's scoop), a ball at constant scallop elsewhere —
 * step-over from the ball's own radius and the leftover band, the already-landed fix on
 * `held/945-scallop`. The finish's own cusp on a wall is the step-over's sagitta and does not close
 * by pitch alone (Session C's finding) — carried in the step-over formula here, not patched after.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import type { OpOutcome, RegionRef } from '../linking';

export type FinishKind = 'flat-raster' | 'ball-scallop';

export interface FinishOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  /** The flat-vs-ball slope classification (C's per-slice minimum) — the admissible angle test that picks `kind`. */
  kind: FinishKind;
  scallopMm: number;
}

export function finish(_opts: FinishOpOptions): OpOutcome {
  throw new Error('cam/model/ops/finish: finish() not implemented (#960)');
}
