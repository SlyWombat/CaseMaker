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
import type { PoolPlanReply, PoolReply } from '@/workers/adaptivePool.worker';
import type { PoolSizing } from '@/engine/jobs/poolSizing';
import { unpackMoves } from '@/engine/cnc/cam/movePack';

/**
 * #881 — the run's memory facts, posted before the batch's plans. `maxLevelCells` is the largest
 * level's covered cells; `memory` is absent when the CAM has no budget to state.
 */
interface OutgoingBegin {
  kind: 'begin';
  maxLevelCells: number;
  memory?: NonNullable<LevelPlanShared['memory']>;
}

interface OutgoingPlan {
  kind: 'plan';
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

/**
 * Wrap the sim worker's port as the CAM's planner. `onSized` hears the pool's answer to the
 * `begin` — the number of planners the budget allowed — whenever a budgeted batch is planned;
 * the run's Technical line states it.
 */
export function portLevelPlanner(port: MessagePort, onSized?: (sizing: PoolSizing) => void): LevelPlanner {
  let nextId = 1;
  return {
    planLevels(requests, shared, onPlanned) {
      if (requests.length === 0) return Promise.resolve([]);
      let maxLevelCells = 0;
      for (const request of requests) maxLevelCells = Math.max(maxLevelCells, request.cells ?? 0);
      return new Promise<readonly LevelPlanResult[]>((resolve) => {
        const results: (LevelPlanResult | undefined)[] = new Array(requests.length);
        let done = 0;
        const onMessage = (event: MessageEvent<PoolReply>): void => {
          const data = event.data;
          if ('kind' in data && data.kind === 'sized') {
            onSized?.(data.sizing);
            return;
          }
          const { id, result } = data as PoolPlanReply;
          // The id is the request's own position among this run's ids; map it back through the
          // ids the planner handed out when it posted them.
          const slot = idToSlot.get(id);
          if (slot === undefined || results[slot] !== undefined) return;
          // #881 — the wire form is packed buffers (transferred); the CAM consumes moves until
          // #889 moves its storage to the packed arrays themselves.
          results[slot] = result.ok
            ? { ok: true, moves: unpackMoves(result.moves), maxEngagementMm: result.maxEngagementMm }
            : result;
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
        const begin: OutgoingBegin = {
          kind: 'begin',
          maxLevelCells,
          ...(shared.memory === undefined ? {} : { memory: shared.memory }),
        };
        port.postMessage(begin);
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
