/**
 * A machine's finished programs (#419 §4.5): `POST /api/v1/finished-programs/:id` with the program's
 * FNV hash, appended to the machine record's `finishedPrograms` (`finished_programs.rs`).
 *
 * NOT GUARDED ON THE LOCATION'S `ETag`, unlike the other machine sections. This is an APPEND: the
 * caller does not need to have read the list it is adding to, and two windows that each finished a
 * run must both be recorded — a stale validator would silently lose the second. The service's write
 * lock makes the dedupe and the cap atomic.
 *
 * THE KEY IS FNV, NOT SHA-256 (decision 3): `programHash` in `machineRun.ts` — the same key the run
 * confirmation uses and the one `RunPlanInput.finishedHashes` is compared against (#277's record
 * keeps its SHA-256 `ncHash`, a different key for a different question).
 */

import { houseRequest, type HouseRequestOptions, type HouseWrite } from './houseClient';

/**
 * Record that a program finished cleanly on `machineId`. `hash` is `programHash(nc)`. A hash the
 * machine already has is accepted by the service as a no-op, so retrying a dropped response is safe.
 */
export async function houseAddFinishedProgram(
  machineId: string,
  hash: string,
  opts?: HouseRequestOptions,
): Promise<HouseWrite> {
  if (hash.trim().length === 0 || hash !== hash.trim()) {
    return { kind: 'refused', status: 400, message: 'a finished program needs a non-empty hash' };
  }
  const res = await houseRequest('POST', `/finished-programs/${encodeURIComponent(machineId)}`, { hash }, opts);
  return res.kind === 'ok' ? { kind: 'ok' } : res;
}
