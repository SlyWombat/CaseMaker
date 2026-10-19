/**
 * A PrusaSlicer project (.3mf) as a job patch, from the picked file to the engine (#410 item 4's
 * second entry point — `scripts/engrave-job.ts --from-3mf` is the first).
 *
 * Two halves, and this module owns the join between them:
 *
 *   - the FILE side: the bytes and the name, from the panel's picker;
 *   - the READING side: `readDesign` + `designJobFor`, which need a ManifoldToplevel and therefore
 *     run in the sim worker — the same one the engrave preview slices its stock in.
 *
 * The client is reached by a dynamic `import()` behind `featureSim` (#343), exactly as
 * `engravePreviewStore.ts` does, so a build with the flag off contains neither the sim client nor
 * its worker. `setDesignImportClient` is the test seam, marked the way that store's is.
 *
 * Nothing here decides anything about the job: `designJobFor` is pure and the STORE owns the write
 * (`takeDesign`), which is the same division the badge route has (#271, #352).
 */

import { featureSim } from '@/platform/features';
import type { DesignJobPatch, DesignReadingDirection } from '@/engine/cnc/engrave/fromDesign';

/**
 * The largest project we will read, bytes. See `./designLimits`, where the constant lives so
 * `meshStock.ts` can share it without importing this module's browser-only client graph (#544).
 */
import { MAX_DESIGN_FILE_BYTES } from './designLimits';
export { MAX_DESIGN_FILE_BYTES };

/** The one thing this module needs of the sim worker. A fake in tests. */
export interface DesignImportClient {
  readDesign3mf: (bytes: ArrayBuffer, direction: DesignReadingDirection) => Promise<DesignJobPatch>;
}

const loadClient = async (): Promise<DesignImportClient> => {
  if (!featureSim) throw new Error('reading a design is not enabled in this build');
  const client = await import('@/engine/jobs/simClient');
  return { readDesign3mf: client.readDesign3mf };
};
let clientLoader: () => Promise<DesignImportClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setDesignImportClient(fn: (() => Promise<DesignImportClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

/** What a picked file produced: the patch to apply, or the reason it could not be read. */
export type DesignReadResult =
  | { ok: true; filename: string; patch: DesignJobPatch }
  | { ok: false; error: string };

/**
 * Read one picked `.3mf` as this job's blank and items.
 *
 * Every failure is a message, never a throw and never a silent no-op: the caller is a button in the
 * panel, and "the file could not be read" and "there is no design in it" are things the person who
 * picked it has to be told. `parsePrusaThreeMf` and `readDesign` both throw their own sentences
 * (`PrusaThreeMfError` names the entry or the volume at fault), and those are passed through as
 * they are rather than re-worded here.
 *
 * The direction is not a parameter: the panel offers no control for it, and the shipped default —
 * the same one `scripts/engrave-job.ts` uses when `--turn` is omitted — is what a job built here
 * gets. `designJobFor` writes which way it turned into the notes, so the job states it either way.
 */
export async function readDesignFile(file: File): Promise<DesignReadResult> {
  if (file.size > MAX_DESIGN_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `${file.name} is ${mb} MB — larger than the ${MAX_DESIGN_FILE_BYTES / (1024 * 1024)} MB limit for a project file.` };
  }
  try {
    const bytes = await file.arrayBuffer();
    const client = await clientLoader();
    // `ccw` — the default quarter turn. See the doc above.
    const patch = await client.readDesign3mf(bytes, 'ccw');
    return { ok: true, filename: file.name, patch };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
