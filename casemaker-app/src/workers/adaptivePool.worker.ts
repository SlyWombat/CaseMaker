/**
 * #881 — ONE ADAPTIVE ROUGHING LEVEL, planned off the sim worker's thread.
 *
 * A pool of these sits behind the main thread's `AdaptivePool`; the sim worker sends each level's
 * request down a MessagePort and gets the same plan `planLevel` produces in-process — the one
 * `planAdaptive` call, with the same settings — so a pooled plan cannot differ from a serial one.
 * The moves go back as #889's `MoveStore` arrays, TRANSFERRED (see `moveWire.ts`), not as cloned
 * objects: a level is tens of thousands of moves, and a copy per level is the sim worker's memory.
 */

import { planLevel, type LevelPlanRequest, type LevelPlanShared } from '@/engine/cnc/cam/rough3d';
import type { MoveBuffers } from '@/engine/cnc/cam/moveStore';
import { moveBuffersOf, moveBufferTransfers } from '@/engine/cnc/cam/moveWire';
import type { PoolSizing } from '@/engine/jobs/poolSizing';

export interface PoolPlanMessage {
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

export type PackedLevelPlanResult =
  | {
      ok: true;
      moves: MoveBuffers;
      maxEngagementMm: number;
      /** #908 — the planner's own typed-array high-water mark for this level, bytes. */
      peakArrayBytes: number;
      /** #908 — the level's grid cells, so the peak can be judged per cell. */
      gridCells: number;
      /**
       * #908 — this worker's used JS heap right after the level finished, bytes, where the
       * browser reports it (Chromium). It is an END-of-level reading, not the peak: a dedicated
       * worker answers nothing while its JS thread is inside the synchronous plan.
       */
      usedHeapBytes: number | null;
    }
  | { ok: false; reason: string };

export interface PoolPlanReply {
  id: number;
  result: PackedLevelPlanResult;
}

/** #881 — the pool's answer to a `begin`: how many planners the budget allowed. */
export interface PoolSizedReply {
  kind: 'sized';
  sizing: PoolSizing;
}

/** Everything the pool sends back up the channel. */
export type PoolReply = PoolPlanReply | PoolSizedReply;

/** #908 — the worker's own heap, where the browser exposes it (the sim worker's #896 pattern). */
function usedHeapBytes(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const used = mem?.usedJSHeapSize;
  return used === undefined ? null : used;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoolPlanMessage>) => void) | null;
  postMessage: (message: PoolPlanReply, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event) => {
  const { id, request, shared } = event.data;
  const plan = planLevel(shared, request);
  if (!plan.ok) {
    scope.postMessage({ id, result: { ok: false, reason: plan.reason } });
    return;
  }
  const buffers = moveBuffersOf(plan.moves);
  scope.postMessage(
    {
      id,
      result: {
        ok: true,
        moves: buffers,
        maxEngagementMm: plan.maxEngagementMm,
        peakArrayBytes: plan.peakArrayBytes,
        gridCells: plan.gridCells,
        usedHeapBytes: usedHeapBytes(),
      },
    },
    moveBufferTransfers(buffers),
  );
};
