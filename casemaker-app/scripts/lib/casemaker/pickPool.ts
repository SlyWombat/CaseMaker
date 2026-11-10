/**
 * #1137 — THE CLI's PICK POOL: the search's capped finalists evaluated on worker threads.
 *
 * The search itself is pure and runs here; each full evaluation is one message to a worker that
 * owns its own Manifold instance and its own module caches (`pickPoolWorker.ts`). Replies are
 * positional — the search's `evaluateMany` contract — and every evaluation is independent, so the
 * winner is the serial winner (see `smartPick`'s `EvaluateMany`).
 *
 * SIZE IS THE CORE RULE: the pick's own finalist cap, bounded by the machine's cores. (The
 * browser's memory-budgeted sizing is gone with the maintainer's server-side ruling — house-side
 * generation will decide its own pool size where the RAM is known; the API here takes the same
 * `evaluateMany` either way.) A pool of one means the finalists run serially in-process.
 *
 * A worker that dies mid-pick is not allowed to lose the run: the batch rejects, the pool is
 * disposed, and the caller reruns the search serially (coarse included — rare, and cheaper than
 * a wrong answer).
 */
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';

import { pickForEngrave, type EngravePickInputs } from '@/workers/sim/smartPickRun';
import type { CandidatePlan, EvaluateMany, SmartPick, SmartPickOptions, SmartPickRefusal } from '@/engine/cnc/engrave/smartPick';
import type { PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { PickWorkerInputs, PickWorkerReply, PickWorkerRequest } from './pickPoolWorker';

/** The core rule: one fewer than the machine, never more than eight. */
export function pickCoreCap(): number {
  return Math.min(8, Math.max(1, cpus().length - 1));
}

/**
 * How many finalists this process evaluates at once: the pick's cap, bounded by the cores AND by
 * the caller's own bound (#1126 — the house service's queue concurrency, passed down; `undefined`
 * leaves the core rule alone).
 */
export function pickCapacity(finalists: number, slots?: number): number {
  const bound = slots === undefined || !Number.isFinite(slots) ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(slots));
  return Math.max(1, Math.min(finalists, pickCoreCap(), bound));
}

/**
 * #1126 — THE SERVICE'S BOUND, when it sets one. `CASEMAKER_PICK_WORKERS` is read by the CLI so a
 * house run does not out-subscribe the service's own queue (`CASEMAKER_RUNS_CONCURRENCY`); it
 * never raises the core rule, it only lowers the pool. A malformed value is ignored.
 */
export function servicePickSlots(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.CASEMAKER_PICK_WORKERS;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * #1137 — what a worker may be sent: the pick's inputs WITHOUT the Manifold toplevel. The toplevel
 * is this process's wasm instance, functions and all, and is not structured-cloneable; every worker
 * builds its own (`getToplevel()`). Sending it whole failed the pool with
 * "()=>wasmPath could not be cloned" and silently fell back to serial.
 */
export function workerInputsOf(inputs: EngravePickInputs): PickWorkerInputs {
  const { tl: _toplevel, ...rest } = inputs;
  void _toplevel;
  return rest;
}

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

interface Slot {
  worker: Worker;
  busy: boolean;
}

interface Request {
  id: number;
  plan: CandidatePlan;
  resolve: (evaluation: PlanEvaluation) => void;
  reject: (error: Error) => void;
}

export class NodePickPool {
  private readonly slots: Slot[] = [];
  /** Requests not yet handed to a worker, in dispatch order. */
  private readonly queue: Request[] = [];
  /** Requests a worker is evaluating, by id. */
  private readonly inFlight = new Map<number, Request>();
  private nextId = 1;
  private closed = false;

  private constructor() {}

  /**
   * Start `size` workers and wait until each has its own Manifold instance and is listening.
   * `entry`/`execArgv` are injectable so a test can drive the pool's plumbing with a stub worker
   * (the real entry needs a whole Manifold build per worker).
   */
  static async open(
    inputs: PickWorkerInputs,
    size: number,
    entry: URL = new URL('./pickWorkerBoot.mjs', import.meta.url),
    execArgv: string[] = workerExecArgv(),
  ): Promise<NodePickPool> {
    const pool = new NodePickPool();
    const url = entry;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(url, { workerData: inputs, execArgv });
      const slot: Slot = { worker, busy: false };
      pool.slots.push(slot);
      worker.on('message', (msg: PickWorkerReply) => {
        if ('ready' in msg) return;
        pool.settle(slot, msg);
      });
      worker.on('error', (error: Error) => pool.onDeath(error));
      worker.on('exit', (code) => {
        if (code !== 0 && !pool.closed) pool.onDeath(new Error(`pick worker exited with code ${code}`));
      });
      await new Promise<void>((resolve, reject) => {
        const onReady = (msg: PickWorkerReply): void => {
          if ('ready' in msg) {
            worker.off('message', onReady);
            worker.off('error', onError);
            resolve();
          }
        };
        const onError = (error: Error): void => {
          worker.off('message', onReady);
          reject(error);
        };
        worker.on('message', onReady);
        worker.once('error', onError);
      });
    }
    return pool;
  }

  private settle(slot: Slot, msg: Exclude<PickWorkerReply, { ready: true }>): void {
    const request = this.inFlight.get(msg.id);
    if (request === undefined) return;
    this.inFlight.delete(msg.id);
    slot.busy = false;
    if (msg.ok) request.resolve(msg.evaluation);
    else request.reject(new Error(msg.error));
    this.pump();
  }

  private onDeath(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.inFlight.values()) request.reject(error);
    for (const request of this.queue) request.reject(error);
    this.inFlight.clear();
    this.queue.length = 0;
    for (const slot of this.slots) void slot.worker.terminate();
  }

  /** Hand queued requests to idle workers until one of the two runs out. */
  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (next === undefined) return;
      slot.busy = true;
      this.inFlight.set(next.id, next);
      slot.worker.postMessage({ id: next.id, plan: next.plan } satisfies PickWorkerRequest);
    }
  }

  /**
   * The search's batch evaluator. Plans are queued in order; the returned array is in plan order,
   * whichever worker answered which.
   */
  readonly evaluateMany: EvaluateMany = (plans) => {
    return new Promise<readonly PlanEvaluation[]>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('the pick pool is closed'));
        return;
      }
      const results: PlanEvaluation[] = new Array(plans.length);
      let remaining = plans.length;
      plans.forEach((plan, index) => {
        this.queue.push({
          id: this.nextId++,
          plan,
          resolve: (evaluation) => {
            results[index] = evaluation;
            remaining -= 1;
            if (remaining === 0) resolve(results);
          },
          reject,
        });
      });
      this.pump();
    });
  };

  /** Kill every worker. Idempotent. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) void slot.worker.terminate();
  }
}

/**
 * The CLI's one door to the search: decide the pool's size, run the pick through it, state a
 * budgeted-serial run, and fall back to serial if a worker dies. Every pick call in the CLI goes
 * through here so the two doors cannot drift.
 */
export async function pickWithPool(
  inputs: EngravePickInputs,
  opts: SmartPickOptions = {},
): Promise<SmartPick | SmartPickRefusal> {
  // #1137's acceptance is "the identical winner": this diagnostic switch forces the serial path so
  // a run's pick line and plan key can be diffed against the pooled run's byte for byte. It is not
  // a setting and states no note — the comparison IS the serial run.
  if (process.env.CM_PICK_SERIAL === '1') return pickForEngrave(inputs, opts);
  const finalists = Math.max(1, Math.floor(opts.fullFinalists ?? 3));
  const workers = pickCapacity(finalists, servicePickSlots());
  if (workers <= 1) return pickForEngrave(inputs, opts);
  let pool: NodePickPool | null = null;
  try {
    pool = await NodePickPool.open(workerInputsOf(inputs), workers);
    return await pickForEngrave(inputs, opts, undefined, pool.evaluateMany);
  } catch (error) {
    // A worker died mid-pick: rerun the search serially rather than losing the run. The pick says
    // the pool failed — never the memory sentence, which it did not earn.
    const pick = await pickForEngrave(inputs, opts);
    if (pick.refused !== true) {
      pick.notes.push(
        `the parallel evaluation stopped (${error instanceof Error ? error.message : String(error)}); the finalists were evaluated one at a time`,
      );
    }
    return pick;
  } finally {
    pool?.dispose();
  }
}
