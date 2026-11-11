/**
 * #1151 Phase 2 (#1134(c)'s ruling) — THE RANK'S OTHER CANDIDATES, ON WORKER THREADS.
 *
 * The ball rank measures each candidate with a full `planCurvedForTree` (42–65 s a candidate on
 * the set B bottom). The engine measures the FIRST candidate in-process and asks a seam for the
 * rest; this module is the CLI/service's seam: one short-lived worker per candidate, each running
 * the engine's own one-candidate entry, with the metrics consumed IN CANDIDATE ORDER by the
 * engine's unchanged loop. An early break calls `cancel`, which terminates the outstanding
 * workers: unused capacity, never a changed result.
 *
 * The workers are created per rank, not pooled across plans: the candidate count is small (2–8),
 * the inputs are a whole model, and a plan's rank is a single burst. `CASEMAKER_RANK_WORKERS`
 * caps the fan-out (the house service sets it like `CASEMAKER_PICK_WORKERS`: it can only lower
 * the core rule).
 */
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';

import { cutterKeyOf } from '@/engine/cnc/cam/model/sequence';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool } from '@/engine/cnc/tool';
import type { ShopDefaults } from '@/platform/defaultsClient';

import type {
  ModelPlanInput,
  RankMeasureHandle,
  RankMeasurement,
  RankMeasureRequest,
} from '@/engine/cnc/cam/model/plan';

/** What the worker receives once: the model input by clone, plus the one candidate's key. */
export interface RankWorkerInput {
  input: ModelPlanInput;
  setupIndex: number;
  /** `cutterKeyOf`: the worker resolves the Tool from ITS OWN cloned input by this key. */
  candidateKey: string;
  /**
   * #1237 — THE SHOP'S SETTINGS: `ModelPlanInput` carries no defaults map, and the planner reads
   * them through its realm's live source. The seam sends what the parent installed so a rank
   * worker plans with the shop's values, not the recommendations.
   */
  defaults?: ShopDefaults | null;
}

/** The worker's reply: the metric, or the error that stopped it. */
export type RankWorkerReply = { ok: true; metric: RankMeasurement } | { ok: false; error: string };

/** The `execArgv` a worker needs to load TypeScript exactly as this process did (minus `--eval`). */
function workerExecArgv(): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (arg === '--eval' || arg === '-e') {
      i += 1; // skip its value
      continue;
    }
    if (arg.startsWith('--eval=') || arg.startsWith('-e=')) continue;
    out.push(arg);
  }
  return out;
}

/** How many rank workers this process may start: the cores minus one, at most eight, lowered by env. */
export function rankWorkerCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CASEMAKER_RANK_WORKERS;
  const byEnv = raw === undefined ? undefined : Number(raw);
  const core = Math.max(1, Math.min(8, cpus().length - 1));
  return Number.isInteger(byEnv) && byEnv! > 0 ? Math.min(byEnv!, core) : core;
}

/**
 * #1151 Phase 2 follow-up (C's land16 check) — THE WORKER'S HOUSE AS REGISTRY ENTRIES. `setRegistry`
 * takes `ToolLibraryEntry[]`, not bare tools, and a registry built from the wrong shape is exactly
 * how a key lookup silently misses. The key is the identity a posted program stamps
 * (`cutterKeyOf` = the tool's id, else its name) — what the plan and the rank read back.
 */
export function rankHouseEntries(house: readonly Tool[]): ToolLibraryEntry[] {
  return house.map((tool) => ({
    key: cutterKeyOf(tool),
    tool,
    provenance: 'the rank worker’s own model input (the house the plan was given)',
  }));
}

/** What one candidate's promise carries; `unconsumed` lets `cancel` swallow an abandoned promise. */
interface Candidate {
  promise: Promise<RankMeasurement>;
  worker: Worker | null;
  consumed: boolean;
}

/**
 * The CLI/service seam: a handle over candidates 2..N, measured by short-lived workers. The
 * promises start IMMEDIATELY (up to the cap; the rest queue), so the engine's in-order consumption
 * finds them ready as soon as the search needs them.
 */
export function rankPoolSeam(
  options: { cap?: number; entry?: URL; defaults?: ShopDefaults | null } = {},
): (request: RankMeasureRequest) => RankMeasureHandle {
  const cap = Math.max(1, options.cap ?? rankWorkerCap());
  const entry = options.entry ?? new URL('./rankWorkerBoot.mjs', import.meta.url);
  return (request) => {
    const candidates: Candidate[] = [];
    let cancelled = false;
    let active = 0;
    const waiting: (() => void)[] = [];

    const spawn = (candidateKey: string): Candidate => {
      const worker = new Worker(entry, {
        workerData: { input: request.input, setupIndex: request.setupIndex, candidateKey, defaults: options.defaults ?? null } satisfies RankWorkerInput,
        execArgv: workerExecArgv(),
      });
      const raw = new Promise<RankMeasurement>((resolve, reject) => {
        worker.once('message', (msg: RankWorkerReply) => {
          if (msg.ok) resolve(msg.metric);
          else reject(new Error(msg.error));
        });
        worker.once('error', (error: Error) => reject(error));
        worker.once('exit', (code) => {
          if (code !== 0 && !cancelled) reject(new Error(`rank worker exited with code ${code}`));
        });
      });
      const promise = raw.finally(() => {
        active -= 1;
        waiting.shift()?.();
        void worker.terminate();
      });
      // #1151 Phase 2 — AN EAGER REJECTION MUST NOT GO UNHANDLED. Workers start up front, but the
      // engine consumes metrics IN ORDER and may be minutes away from this candidate; without this
      // handler a worker that refuses early surfaced as an unhandled rejection (k3, first run).
      // A separate catch on the chained promise does not hide the rejection from the consumer's
      // own await: the promise still rejects for whoever consumes it.
      promise.catch(() => undefined);
      return { promise, worker, consumed: false };
    };

    // Start up to the cap now; the rest follow as slots free (a candidate whose promise is never
    // consumed is still only started if a slot was free before the engine cancelled).
    const queued = (candidateKey: string): Candidate => {
      const slot: Candidate = { promise: Promise.resolve({ kind: 'noStamp' }), worker: null, consumed: false };
      const start = (): void => {
        active += 1;
        const started = spawn(candidateKey);
        slot.promise = started.promise;
        slot.worker = started.worker;
      };
      if (active < cap && !cancelled) start();
      else waiting.push(start);
      return slot;
    };
    for (const candidate of request.candidates) {
      const key = candidate.id ?? candidate.name;
      const slot = queued(key);
      // A promise the engine never awaits must not surface as an unhandled rejection: `cancel`
      // (the loop's finally) swallows the abandoned ones below.
      candidates.push(slot);
    }

    return {
      metric: (index) => {
        const slot = candidates[index];
        if (slot === undefined) return Promise.reject(new Error(`the rank seam was asked for candidate ${index} of ${candidates.length}`));
        slot.consumed = true;
        return slot.promise;
      },
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        for (const slot of candidates) {
          if (slot.consumed) continue;
          slot.promise.catch(() => undefined);
          slot.worker?.terminate();
        }
        waiting.length = 0;
      },
    };
  };
}
