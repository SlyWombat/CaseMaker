/**
 * cam/model/ops/pocket.ts — §3.1 of `docs/design/cam-model-engine.md`.
 *
 * Z-level pocketing per recognised `PocketNode` (#958), largest flat that fits, rest with the next
 * flat — uses the EXISTING `pocketLoops` (`cam/pocket.ts:204`) unchanged. This op maps a recognised
 * node onto that function; there is no new pocketing math, which makes it the least novel op and the
 * first one worth filling in once #958 lands a real `FeatureTree`.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { PocketNode } from '../features';
import type { OpOutcome, RegionRef } from '../linking';

export interface PocketOpOptions {
  cutter: Tool;
  node: PocketNode;
  region: RegionRef;
}

export function pocket(_opts: PocketOpOptions): OpOutcome {
  throw new Error('cam/model/ops/pocket: pocket() not implemented (#959)');
}
