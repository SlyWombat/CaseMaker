/**
 * #966 — probes `cam/model/plan.ts`'s `USE_MODEL_CAM_ENGINE`, read fresh in a brand-new process,
 * exactly as `casemaker`'s own CLI entry point would read it at that module's first import.
 * `casemakerCliModelCam966.spec.ts` spawns this (never imports it in-process) so the read is a
 * genuine subprocess's module-load-time value — the same boundary a real `casemaker` invocation
 * crosses — not a value `vi.resetModules()` leaves behind for a later test in the same process.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/modelCamFlagProbe.ts
 *
 * Prints one JSON line: `{ "USE_MODEL_CAM_ENGINE": boolean }`.
 */
import { USE_MODEL_CAM_ENGINE } from '../../src/engine/cnc/cam/model/plan';

process.stdout.write(JSON.stringify({ USE_MODEL_CAM_ENGINE }));
