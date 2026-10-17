/**
 * A program's identity: FNV-1a, 32-bit, lowercase hex padded to eight characters (#423 Q17,
 * #419 decision 3).
 *
 * It lives in its own import-free module because BOTH sides of the app key on it now:
 *
 *  - `platform/machineRun.ts` uses it as the run confirmation's key (#423), which is where it was
 *    written, and re-exports it from there so every existing import site is unchanged; and
 *  - the generator's per-program list (#419 J3) keys each posted program with it, and that code
 *    runs in the sim worker and in node scripts. Importing `machineRun.ts` for the hash alone would
 *    drag the run's console client, its defaults client and its Tauri seam into those places, which
 *    is exactly the coupling this split exists to avoid.
 *
 * The run sheet's `fileHash` and the run record's `ncHash` are SHA-256 and stay so: they are the
 * human/printed hash. This is the machine-facing KEY — the one `RunPlanInput.finishedHashes` is
 * compared against, so both writers must use this function or the match never fires.
 */
export function programHash(nc: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < nc.length; i++) {
    h ^= nc.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
