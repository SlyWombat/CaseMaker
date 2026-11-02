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
  | { ok: true; moves: MoveBuffers; maxEngagementMm: number }
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
    { id, result: { ok: true, moves: buffers, maxEngagementMm: plan.maxEngagementMm } },
    moveBufferTransfers(buffers),
  );
};
