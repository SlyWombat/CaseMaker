/**
 * #881 — THE ROUGHING LEVEL POOL (main thread).
 *
 * `roughingAdaptiveMoves` plans each level independently; on a real goal that is the whole cost of
 * Generate. This pool runs those plans on `hardwareConcurrency - 1` dedicated workers (capped, and
 * one on a phone), fed over a MessagePort the sim worker holds. The sim worker never spawns
 * anything itself — nested workers are unreliable in WebKitGTK and Safari — and the main thread
 * only relays messages, so a blocked planner cannot freeze the UI.
 *
 * A run is one MessageChannel: `beginRun()` returns the sim worker's end, the pool keeps the
 * other, and every request that arrives on it is handed to a free worker. `dispose()` (the app's
 * cancel path, `terminateSim`) kills the workers, so a cancelled Generate leaves nothing running.
 */

import type { LevelPlanRequest, LevelPlanShared } from '@/engine/cnc/cam/rough3d';
import type { PoolPlanReply } from '@/workers/adaptivePool.worker';

/** One level's work, as it arrives from the sim worker. */
export interface PoolPlanRequest {
  kind: 'plan';
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

/**
 * How many planners to run: one fewer than the machine's cores (the sim worker keeps one busy
 * assembling), never more than eight, and one on a phone — a coarse pointer is the app's own
 * signal that the device is a handset whose cores and battery are not ours to spend.
 */
export function adaptivePoolSize(
  nav: { hardwareConcurrency?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  coarsePointer: boolean = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
): number {
  if (coarsePointer) return 1;
  const cores = Math.max(1, Math.floor(nav?.hardwareConcurrency ?? 2));
  return Math.min(8, Math.max(1, cores - 1));
}

interface WorkerSlot {
  worker: Worker;
  /** The request it is planning, or null while idle. */
  busyWith: number | null;
}

export class AdaptivePool {
  private slots: WorkerSlot[] = [];
  private readonly idle: number[] = [];
  private readonly queue: PoolPlanRequest[] = [];
  /** Every request the sim worker is still waiting for, by id. */
  private readonly pending = new Map<number, PoolPlanRequest>();
  private out: MessagePort | null = null;

  private readonly size: number;

  constructor(size: number = adaptivePoolSize()) {
    this.size = size;
  }

  /** Start a run: the returned port goes to the sim worker, transferred. */
  beginRun(): MessagePort {
    this.dispose();
    const channel = new MessageChannel();
    this.out = channel.port1;
    this.out.onmessage = (event: MessageEvent<PoolPlanRequest>) => this.enqueue(event.data);
    this.out.start();
    this.ensureWorkers();
    return channel.port2;
  }

  /** Stop everything — the cancel path. The channel and every worker go. */
  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    this.idle.length = 0;
    this.queue.length = 0;
    this.pending.clear();
    this.out?.close();
    this.out = null;
  }

  private ensureWorkers(): void {
    if (this.slots.length > 0 || this.size <= 0) return;
    for (let i = 0; i < this.size; i++) this.slots.push(this.newSlot(i));
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
    this.queue.push(message);
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
    this.out?.postMessage(reply);
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
