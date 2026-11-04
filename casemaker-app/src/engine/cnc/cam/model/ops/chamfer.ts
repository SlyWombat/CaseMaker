/**
 * cam/model/ops/chamfer.ts — §3.5 of `docs/design/cam-model-engine.md`.
 *
 * Chamfer / edge-break as its own op, on each `Rim`. `generateChamfer` (`cam/chamfer.ts:65`) and
 * `generateChamfer3d` (`cam/chamfer3d.ts:56`) are already standalone op modules with their own
 * result types — this op calls them, it does not rework them. Sizing comes from
 * `ModelPlanInput.edgeBreak` (A's R3 on #956: the job's own field, read independently of the gate's
 * allowance, never from this engine's plan output).
 */

import type { Tool } from '@/engine/cnc/tool';
import type { Rim } from '../features';
import type { OpOutcome, RegionRef } from '../linking';
import type { EdgeBreakSpec } from '../types';

export interface ChamferOpOptions {
  cutter: Tool;
  rim: Rim;
  region: RegionRef;
  edgeBreak: EdgeBreakSpec;
}

export function chamfer(_opts: ChamferOpOptions): OpOutcome {
  throw new Error('cam/model/ops/chamfer: chamfer() not implemented (#960)');
}
