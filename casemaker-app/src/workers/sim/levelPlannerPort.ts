/**
 * #881 — the sim worker's end of the level pool's channel.
 *
 * The workers themselves live on the main thread (`engine/jobs/adaptivePool.ts`): the sim worker
 * holds one end of a MessageChannel and only sends level requests down it. Each plan comes back
 * as the same `LevelPlanResult` the in-process path produces, so `roughingAdaptiveMoves` cannot
 * tell the two apart — the parallel plan is byte-identical to the serial one.
 *
 * Requests carry an id chosen here, and replies are laid back into request order; a pool that
 * answers with a refusal for one level is handled by the CAM exactly as an in-process refusal is.
 */

import type { LevelPlanRequest, LevelPlanResult, LevelPlanShared, LevelPlanner } from '@/engine/cnc/cam/rough3d';
import type { PoolPlanReply } from '@/workers/adaptivePool.worker';

interface OutgoingPlan {
  kind: 'plan';
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

/** Wrap the sim worker's port as the CAM's planner. */
export function portLevelPlanner(port: MessagePort): LevelPlanner {
  let nextId = 1;
  return {
    planLevels(requests, shared, onPlanned) {
      if (requests.length === 0) return Promise.resolve([]);
      return new Promise<readonly LevelPlanResult[]>((resolve) => {
        const results: (LevelPlanResult | undefined)[] = new Array(requests.length);
        let done = 0;
        const onMessage = (event: MessageEvent<PoolPlanReply>): void => {
          const { id, result } = event.data;
          // The id is the request's own position among this run's ids; map it back through the
          // ids the planner handed out when it posted them.
          const slot = idToSlot.get(id);
          if (slot === undefined || results[slot] !== undefined) return;
          results[slot] = result;
          done++;
          onPlanned?.(done, requests.length);
          if (done === requests.length) {
            port.removeEventListener('message', onMessage);
            for (const used of idsUsed) idToSlot.delete(used);
            resolve(results as LevelPlanResult[]);
          }
        };
        const idToSlot = new Map<number, number>();
        const idsUsed: number[] = [];
        port.addEventListener('message', onMessage);
        port.start();
        for (const [slot, request] of requests.entries()) {
          const id = nextId++;
          idToSlot.set(id, slot);
          idsUsed.push(id);
          const message: OutgoingPlan = { kind: 'plan', id, request, shared };
          port.postMessage(message);
        }
      });
    },
  };
}
