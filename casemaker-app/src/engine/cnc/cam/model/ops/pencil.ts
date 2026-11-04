/**
 * cam/model/ops/pencil.ts — §3.4 of `docs/design/cam-model-engine.md`.
 *
 * Pencil for creases: concave edges under the finish cutter's own reach. OpenCamLib's method,
 * re-implemented from its description — scope open item (`docs/design/cam-model-engine.md` §8):
 * creases only, not a general rest-machining pass, until a real part needs more.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { RemainderRegion } from '../features';
import type { OpOutcome, RegionRef } from '../linking';

export interface PencilOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
}

export function pencil(_opts: PencilOpOptions): OpOutcome {
  throw new Error('cam/model/ops/pencil: pencil() not implemented (#960)');
}
