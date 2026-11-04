/**
 * cam/model/ops/rough.ts — §3.3 of `docs/design/cam-model-engine.md`.
 *
 * Z-level roughing of stock minus the CL surface (#957) for a curved `RemainderRegion`, largest flat
 * cutter that fits, no cap carried forward from the old `rough3d.ts`/its budgets (§6: a stall guard
 * only). `rest` is the next cutter's own CL surface compared against the previous cutter's — same
 * method, smaller cutter, no separate rest code path (C's per-slice minimum groups the two).
 */

import type { Tool } from '@/engine/cnc/tool';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import type { OpOutcome, RegionRef } from '../linking';

export interface RoughOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  stepDownMm: number;
}

export function rough(_opts: RoughOpOptions): OpOutcome {
  throw new Error('cam/model/ops/rough: rough() not implemented (#959)');
}

export interface RestOpOptions {
  prev: OpOutcome;
  next: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
}

export function rest(_opts: RestOpOptions): OpOutcome {
  throw new Error('cam/model/ops/rough: rest() not implemented (#959)');
}
