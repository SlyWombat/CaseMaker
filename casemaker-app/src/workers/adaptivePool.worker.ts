/**
 * #881 — ONE ADAPTIVE ROUGHING LEVEL, planned off the sim worker's thread.
 *
 * A pool of these sits behind the main thread's `AdaptivePool`; the sim worker sends each level's
 * request down a MessagePort and gets the same plan `planLevel` produces in-process — the one
 * `planAdaptive` call, with the same settings — so a pooled plan cannot differ from a serial one.
 * Nothing wasm or stateful lives here: a request in, a plan out.
 */

import { planLevel, type LevelPlanRequest, type LevelPlanShared, type LevelPlanResult } from '@/engine/cnc/cam/rough3d';

export interface PoolPlanMessage {
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

export interface PoolPlanReply {
  id: number;
  result: LevelPlanResult;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoolPlanMessage>) => void) | null;
  postMessage: (message: PoolPlanReply) => void;
};

scope.onmessage = (event) => {
  const { id, request, shared } = event.data;
  scope.postMessage({ id, result: planLevel(shared, request) });
};
