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
import { MoveStore } from '@/engine/cnc/cam/moveStore';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import type { Polygons } from '@/engine/cnc/cam/pocket';

/**
 * #881 — ONE LEVEL'S PLANNER GRID, exactly as `planAdaptive` builds it: the region's bounding
 * box at the planner's measuring resolution (`h = min(engagement cap / 6, radius / 12)`). This is
 * the level's real memory driver — the planner allocates several arrays over this grid — so the
 * pool sizes on it, not on the goal's covered cells. A region with no room for the cutter (or a
 * non-flat tool) allocates nothing: `planAdaptive` refuses before building the grid.
 */
export function plannerGridCells(region: Polygons, shared: LevelPlanShared): number {
  const flat = cuttingRadiusForSweep(shared.tool);
  if (!flat.ok) return 0;
  const r = flat.radius;
  const cap = shared.settings.engagementFraction * 2 * r;
  const h = Math.min(cap / 6, r / 12);
  if (!(h > 0)) return 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const contour of region) {
    if (contour.length < 3) continue;
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0;
  return (Math.ceil((maxX - minX) / h) + 2) * (Math.ceil((maxY - minY) / h) + 2);
}

/**
 * #881 — the run's memory facts, posted before the batch's plans. `levelGridCells` is the largest
 * level's planner grid (see {@link plannerGridCells}); `memory` is absent when the CAM has no
 * budget to state.
 */
interface OutgoingBegin {
  kind: 'begin';
  levelGridCells: number;
  memory?: NonNullable<LevelPlanShared['memory']>;
}

interface OutgoingPlan {
  kind: 'plan';
  id: number;
  request: LevelPlanRequest;
  shared: LevelPlanShared;
}

/** #908 — the largest per-level typed-array peak this run's pool has reported, with its grid. */
let lastPeak: { peakArrayBytes: number; gridCells: number; usedHeapBytes: number | null } | null = null;

/** The pool's own measurement of the costliest level so far (null before any level). */
export function lastLevelPeak(): { peakArrayBytes: number; gridCells: number; usedHeapBytes: number | null } | null {
  return lastPeak;
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
      // A batch is a run: the previous program's peak must not be quoted for this one.
      lastPeak = null;
      let levelGridCells = 0;
      for (const request of requests) {
        levelGridCells = Math.max(levelGridCells, plannerGridCells(request.region, shared));
      }
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
          // #881 — the wire form is #889's MoveStore arrays (transferred); the CAM consumes the
          // same `CamMove[]` the in-process path produces, now built from the store's view.
          if (result.ok) {
            // #908 — the planner's own per-level measurement rides back with the plan; keep the
            // largest this run has seen so the run can state what a level really cost.
            if (result.peakArrayBytes > (lastPeak?.peakArrayBytes ?? 0)) {
              lastPeak = {
                peakArrayBytes: result.peakArrayBytes,
                gridCells: result.gridCells,
                usedHeapBytes: result.usedHeapBytes,
              };
            }
            results[slot] = {
              ok: true,
              moves: MoveStore.fromBuffers(result.moves).view(),
              maxEngagementMm: result.maxEngagementMm,
              peakArrayBytes: result.peakArrayBytes,
              gridCells: result.gridCells,
            };
          } else {
            results[slot] = result;
          }
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
          levelGridCells,
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
