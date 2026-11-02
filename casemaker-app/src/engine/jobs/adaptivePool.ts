/**
 * #881 — THE ROUGHING LEVEL POOL (main thread).
 *
 * `roughingAdaptiveMoves` plans each level independently; on a real goal that is the whole cost of
 * Generate. This pool runs those plans on dedicated workers, fed over a MessagePort the sim worker
 * holds. The sim worker never spawns anything itself — nested workers are unreliable in WebKitGTK
 * and Safari — and the main thread only relays messages, so a blocked planner cannot freeze the UI.
 *
 * A run is one MessageChannel: `beginRun()` returns the sim worker's end, the pool keeps the
 * other, and every request that arrives on it is handed to a free worker. `dispose()` (the app's
 * cancel path, `terminateSim`) kills the workers, so a cancelled Generate leaves nothing running.
 *
 * #881 — THE SIZE IS BUDGETED, NOT JUST COUNTED. Before its first plan the sim worker sends a
 * `begin` message naming the largest level's cell count and, when #889 has stated one, the
 * program's memory budget and the parent's own estimate. The pool then spawns exactly the number
 * `memoryBoundPoolSize` allows — cores, the page's budget and `navigator.deviceMemory`, whichever
 * is tightest — and waits to spawn at all until it knows: a `begin` with no budget keeps the core
 * rule, and a pool spawned without one (an old caller) starts at the core cap on its first plan.
 */

import type { LevelPlanRequest, LevelPlanMemory, LevelPlanShared } from '@/engine/cnc/cam/rough3d';
import type { PoolPlanReply, PoolSizedReply } from '@/workers/adaptivePool.worker';
import { packTransfers } from '@/engine/cnc/cam/movePack';
import {
  adaptivePoolSize,
  estimateLevelPlannerBytes,
  reportedDeviceMemory,
  sizePool,
  type PoolSizing,
} from '@/engine/jobs/poolSizing';

/** The run's memory facts, sent before its first plan (see the module comment). */
export interface PoolBeginRequest {
  kind: 'begin';
  /** The largest level's covered cells: the per-planner peak's cost estimate. */
  maxLevelCells: number;
  /** #889's budget for this program; absent → the core rule alone. */
  memory?: LevelPlanMemory;
}

/** One level's work, as it arrives from the sim worker. */
export interface PoolPlanRequest {
  kind: 'plan';
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

/** Everything the sim worker sends down the channel. */
export type PoolMessage = PoolBeginRequest | PoolPlanRequest;

interface WorkerSlot {
  worker: Worker;
  /** The request it is planning, or null while idle. */
  busyWith: number | null;
}

/** The last decision a run stated, for the Technical line; null until a budgeted run begins. */
let lastSizing: PoolSizing | null = null;

/** What the last budgeted run allowed (the panel's Technical line reads this). */
export function lastPoolSizing(): PoolSizing | null {
  return lastSizing;
}

/** A test's reset — the panel's line must not outlive the run it describes. */
export function forgetPoolSizing(): void {
  lastSizing = null;
}

export class AdaptivePool {
  private slots: WorkerSlot[] = [];
  private readonly idle: number[] = [];
  private readonly queue: PoolPlanRequest[] = [];
  /** Every request the sim worker is still waiting for, by id. */
  private readonly pending = new Map<number, PoolPlanRequest>();
  private out: MessagePort | null = null;

  /** The core rule's answer: the most workers this machine may have. */
  private readonly coreCap: number;
  /** What the last `begin` said this run may spend; null → no budget stated. */
  private sizing: PoolSizing | null = null;

  constructor(coreCap: number = adaptivePoolSize()) {
    this.coreCap = Math.max(1, Math.floor(coreCap));
  }

  /** Start a run: the returned port goes to the sim worker, transferred. */
  beginRun(): MessagePort {
    this.dispose();
    const channel = new MessageChannel();
    this.out = channel.port1;
    this.out.onmessage = (event: MessageEvent<PoolMessage>) => {
      const message = event.data;
      if (message.kind === 'begin') this.onBegin(message);
      else this.enqueue(message);
    };
    this.out.start();
    return channel.port2;
  }

  /** Stop everything — the cancel path. The channel and every worker go. */
  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    this.idle.length = 0;
    this.queue.length = 0;
    this.pending.clear();
    this.sizing = null;
    this.out?.close();
    this.out = null;
  }

  /** The number of planners this run settled on (after `begin`; the core cap before). */
  get planners(): number {
    return this.sizing?.planners ?? this.coreCap;
  }

  /** The run's decision — null until a `begin` with a budget arrives. */
  get decision(): PoolSizing | null {
    return this.sizing;
  }

  /**
   * A run's memory facts: size the pool from them and spawn it. Every `planLevels` batch begins
   * with one, so a later program in the same worker may re-size the pool — the CAM awaits each
   * batch, so no level is ever in flight when this runs.
   */
  private onBegin(message: PoolBeginRequest): void {
    const levelBytes = estimateLevelPlannerBytes(message.maxLevelCells);
    if (message.memory === undefined) {
      this.sizing = null;
      this.resizeWorkers(this.coreCap);
      return;
    }
    const decision = sizePool({
      budgetBytes: message.memory.budgetBytes,
      parentBytes: message.memory.parentBytes,
      levelBytes,
      coreCap: this.coreCap,
      ...(reportedDeviceMemory() === undefined ? {} : { deviceMemoryGb: reportedDeviceMemory() }),
    });
    this.sizing = decision;
    lastSizing = decision;
    // The sim worker cannot apply the core rule itself (a worker has no `matchMedia`), so the
    // pool states the answer back: it is the one authority on how many planners were allowed.
    this.out?.postMessage({ kind: 'sized', sizing: decision } satisfies PoolSizedReply);
    this.resizeWorkers(decision.planners);
  }

  /**
   * Spawn exactly `size` workers (idle and waiting), replacing any others. A resize with a level
   * in flight keeps the pool it has: the size takes effect when the pool is next idle, and a
   * running level is never terminated to satisfy a budget it has already spent.
   */
  private resizeWorkers(size: number): void {
    const wanted = Math.max(1, Math.floor(size));
    if (this.slots.length === wanted) return;
    if (this.slots.some((slot) => slot.busyWith !== null)) return;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    this.idle.length = 0;
    for (let i = 0; i < wanted; i++) {
      this.slots.push(this.newSlot(i));
      // A fresh worker is idle: without this the queue never reaches one.
      this.idle.push(i);
    }
    this.pump();
  }

  private newSlot(index: number): WorkerSlot {
    const worker = new Worker(new URL('../../workers/adaptivePool.worker.ts', import.meta.url), {
      type: 'module',
      name: `rough-pool-${index}`,
    });
    const slot: WorkerSlot = { worker, busyWith: null };
    worker.onmessage = (event: MessageEvent<PoolPlanReply>) => this.onReply(index, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.onWorkerFailure(index, 'a level planner stopped');
    };
    worker.onmessageerror = () => this.onWorkerFailure(index, 'a level planner could not be read');
    return slot;
  }

  private enqueue(message: PoolPlanRequest): void {
    if (this.out === null) return;
    // The id is the SIM WORKER's, so its replies can be matched back to its own request array.
    this.pending.set(message.id, message);
    // A caller that never sent a `begin` (an older sim worker) still gets its core-sized pool.
    if (this.slots.length === 0) this.resizeWorkers(this.coreCap);
    // #881 — LONGEST FIRST. Every level is independent and the pool assembles by index, so the
    // order jobs leave this queue has no effect on the result — only on the makespan's tail. The
    // level's cell count is the cost estimate, and the biggest levels start first.
    let at = this.queue.length;
    while (at > 0 && (this.queue[at - 1]!.request.cells ?? 0) < (message.request.cells ?? 0)) at--;
    this.queue.splice(at, 0, message);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const index = this.idle.pop();
      if (index === undefined) return;
      const slot = this.slots[index];
      if (slot === undefined) continue;
      const message = this.queue.shift()!;
      slot.busyWith = message.id;
      slot.worker.postMessage({ id: message.id, request: message.request, shared: message.shared });
    }
  }

  private onReply(index: number, reply: PoolPlanReply): void {
    const slot = this.slots[index];
    if (slot === undefined) return;
    slot.busyWith = null;
    this.idle.push(index);
    this.pending.delete(reply.id);
    // #881 — forward packed moves as TRANSFERRED buffers: the pool never copies a level's moves.
    if (reply.result.ok) this.out?.postMessage(reply, packTransfers(reply.result.moves));
    else this.out?.postMessage(reply);
    this.pump();
  }

  /**
   * A planner died. Its level is answered with a refusal (so the CAM refuses honestly instead of
   * waiting forever), and a fresh worker takes its place for the rest of the run.
   */
  private onWorkerFailure(index: number, reason: string): void {
    const slot = this.slots[index];
    if (slot === undefined) return;
    const id = slot.busyWith;
    slot.worker.terminate();
    if (id !== null) {
      this.pending.delete(id);
      this.out?.postMessage({ id, result: { ok: false, reason } } satisfies PoolPlanReply);
    }
    this.slots[index] = this.newSlot(index);
    this.idle.push(index);
    this.pump();
  }
}

// Keep the core rule importable from here as before (the spec and any caller that predates it).
export { adaptivePoolSize };
