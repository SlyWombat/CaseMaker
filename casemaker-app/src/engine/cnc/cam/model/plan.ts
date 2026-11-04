/**
 * cam/model/plan.ts — the one entry point of the model-driven CAM engine (#956). §3.0 of
 * `docs/design/cam-model-engine.md` is this file's source of truth; read that before changing
 * anything here.
 *
 * `planModelCam` replaces both `generateSurface3dForGoal` and `generateSurface3dIR` at their
 * `generateGoalPrograms` call sites (`workers/sim/engraveGenerate.ts:5232`, `:6088`) — both already
 * `async`, so this is not a new calling convention for that caller. It is wired behind an opt-in
 * flag (`USE_MODEL_CAM_ENGINE`, set only by specs for now) so nothing changes for an operator until
 * #957/#959/#960 land for real; every stub below throws, so a run with the flag on fails loudly
 * instead of posting an empty program.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mount } from '@/engine/cnc/setups/types';
import type { FixtureEnvelope } from '@/engine/cnc/setup';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { FeatureSource, FeatureTree, SetupFrame } from './features';
import type { CutterCandidates, EdgeBreakSpec, ModelPlanProgress, ModelTolerances } from './types';
import type { PlannedOp } from './linking';
import type { SequencedCutter } from './sequence';

export interface SetupSpec {
  frame: SetupFrame;
  /** #898's three choices. */
  underside: 'flatOnStockBottom' | 'flippedTabs' | 'plinth';
}

export interface ModelPlanInput {
  geometry: FeatureSource;
  /**
   * Length 1 for the tray/organizer today; #898/#914's flip plan (`held/914-flip-plan`: the
   * reach-aware face decision, the stock-floor anchor, the band-floor trigger) and #965 fill this
   * to more than one entry. Reserved now so #965 does not reopen this interface.
   */
  setups: SetupSpec[];
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material'>;
  /**
   * The resolved fixture, by mount type — `viseEnvelope(job.stock, jobVise(job), job.sacrificial)`
   * for a vise (`engine/cnc/fixture.ts:371`, the same call `jobSetup.ts:1207`'s `defaultFixture`
   * makes), `bracketMount(...).fixture` for a bracket (already a `FixtureEnvelope`,
   * `mounts/bracket.ts:451`), `null` for tape. The SAME object the sweep checks the posted program
   * against — not rebuilt here, so this engine and the sweep cannot disagree about where the jaws
   * are (the #949 class).
   */
  fixture: { mount: Mount; envelope: FixtureEnvelope | null };
  cutters: CutterCandidates;
  tolerances: ModelTolerances;
  edgeBreak: EdgeBreakSpec;
}

export interface ModelPlanOutput {
  perSetup: SetupPlan[];
}

export interface SetupPlan {
  setupIndex: number;
  features: FeatureTree;
  /** Grid resolution per cutter/op — renamed from `clSurface` to avoid colliding with `clsurface.ts`'s exported function of that name. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  ops: PlannedOp[];
  sequence: SequencedCutter[];
  linking: { rapidsCount: number; hopsCount: number; airFractionPct: number };
  /** One program per `cutterKey` in `sequence`, in sequence order — the #419 answer ("one program per tool"). */
  programs: ToolpathIR[];
  totalCostSeconds: number;
}

/** Set only by specs for now (see this file's header). */
export const USE_MODEL_CAM_ENGINE = false;

export interface PlanModelCamOptions {
  signal?: AbortSignal;
  onProgress?: (p: ModelPlanProgress) => void;
}

export async function planModelCam(_input: ModelPlanInput, _opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  throw new Error('cam/model/plan: planModelCam() not implemented (#956 skeleton — #957/#959/#960 fill it in)');
}
