/**
 * #1137 — ONE WORKER OF THE CLI's PICK POOL.
 *
 * The pool (`pickPool.ts`) hands this thread the pick's inputs once (`workerData`) and then one
 * plan at a time; the reply is the same `PlanEvaluation` the in-process evaluator produces, so the
 * search cannot tell the two paths apart. Everything the evaluator caches is MODULE-LEVEL
 * (`planCache`, `cutterCache`, `partCache`, `plugCache`, `floorsCache`), and every worker thread
 * has its own module instance, so the caches are per worker by construction — nothing is shared
 * with the parent or with a sibling.
 *
 * The Manifold toplevel and the sim session are per worker too: `getToplevel()` builds this
 * isolate's wasm instance (the same Node loader path the CLI uses), and `evaluatePlan` creates and
 * disposes its own sim session per full evaluation (`sweepPlan`).
 *
 * `runShop` is REQUIRED to reach here (the caller sends the run shop): the full evaluation plans
 * the program the cut would post (#1134), so the winning plan this worker returns is the cut's
 * plan, byte for byte.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { setRegistry } from '@/engine/cnc/toolRegistry';
import { seedBundledFontsFromDisk } from '@/platform/headless/bootstrap';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import { evaluatePlan } from '@/workers/sim/planEvaluate';
import { pickContext, type EngravePickInputs } from '@/workers/sim/smartPickRun';
import type { CandidatePlan } from '@/engine/cnc/engrave/smartPick';
import type { PlanEvaluation } from '@/workers/sim/planEvaluate';

/** What the pool sends once; `tl` is the worker's own. */
export type PickWorkerInputs = Omit<EngravePickInputs, 'tl'>;

/** One plan to evaluate. */
export interface PickWorkerRequest {
  id: number;
  plan: CandidatePlan;
}

/** The reply: the evaluation, or the error that stopped it. */
export type PickWorkerReply =
  | { ready: true }
  | { id: number; ok: true; evaluation: PlanEvaluation }
  | { id: number; ok: false; error: string };

const inputs = workerData as PickWorkerInputs;
const port = parentPort;
if (port === null) throw new Error('pickPoolWorker must run as a worker thread');

// The same font seed the CLI bootstraps: a full evaluation typesets the job's labels, and the
// registry's browser path `fetch`es asset URLs — a `file:` URL Node's fetch refuses.
seedBundledFontsFromDisk();
// AND THE TOOLS: the app resolves a program's tool key through the REGISTRY. Without it the key
// an evaluation posts falls back to the tool's numeric id (";@CM|TOOL|key=111011313825" instead of
// "key=inv:…"), so the pick's reused plan would carry a header byte the cut's own plan does not.
setRegistry([...inputs.tools]);
const ctx = pickContext({ ...inputs, tl: await getToplevel() });
port.postMessage({ ready: true } satisfies PickWorkerReply);
port.on('message', (msg: PickWorkerRequest) => {
  void (async () => {
    try {
      const evaluation = await evaluatePlan(inputs.job, msg.plan, ctx, { level: 'full' });
      port.postMessage({ id: msg.id, ok: true, evaluation } satisfies PickWorkerReply);
    } catch (error) {
      port.postMessage({ id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies PickWorkerReply);
    }
  })();
});
