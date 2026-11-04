/**
 * cam/model/types.ts — the `ModelPlanInput`/`ModelPlanOutput` fields with no existing codebase
 * equivalent (§3.0 of `docs/design/cam-model-engine.md`). Everything here is genuinely new; a type
 * that already exists elsewhere (`Tool`, `ObstacleBox`, `FixtureEnvelope`, `CycleTerms`, `Mount`,
 * `ToolpathIR`, …) is imported from its own module in `plan.ts`, not redefined here.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { PlannedOp } from './linking';

export interface CutterCandidates {
  house: Tool[];
  catalogue: Tool[];
  pinned?: Partial<Record<PlannedOp['kind'], string>>;
}

export interface ModelTolerances {
  /** The finish tolerance — §2's `ARC_CHORD_TOLERANCE_MM`-derived adaptive-spacing basis. Per A's R3, this does NOT carry an edge-break leg; see `EdgeBreakSpec`. */
  finishMm: number;
}

/**
 * The job's own stated edge break (or a shop constant) — read by the chamfer op (§3.5) to size its
 * cut. Per A's R3: the gate's allowance reads the SAME job field independently, through its own
 * path, capped by the chamfer Tool record's own geometry; neither side derives its number from the
 * other's plan output.
 */
export interface EdgeBreakSpec {
  legMm: number;
}

export interface ModelPlanProgress {
  setupIndex: number;
  op: PlannedOp['kind'] | 'features' | 'clSurface' | 'sequence' | 'linking';
  fraction: number;
}
