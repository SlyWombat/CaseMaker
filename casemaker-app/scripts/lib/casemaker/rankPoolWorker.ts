/**
 * #1151 Phase 2 — ONE WORKER OF THE CLI's RANK POOL.
 *
 * The parent hands this thread ONE rank candidate (its model input by structured clone, the setup
 * index and the candidate's key). The worker builds its own Manifold toplevel (planModelCam calls
 * `getToplevel()`), seeds the same font cache and tool registry the CLI bootstraps, and runs the
 * engine's one-candidate entry — `planModelCam` with `rankMeasure` — which prepares the setup
 * exactly as a real plan does and measures the candidate with the rank's own coarse options.
 *
 * The reply is the SAME `RankMeasurement` the in-process measurement produces, so the rank cannot
 * tell the two paths apart. The metric carries no ops: a winner measured here has no stage ops in
 * the parent's memo, and the chosen plan's reads MISS and recompute them (the memo is a
 * read-through cache) — the bytes are the same either way, which the seam's spec proves.
 */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '@/engine/fonts/registry';
import { setRegistry } from '@/engine/cnc/toolRegistry';
import { planModelCam, type RankMeasurement } from '@/engine/cnc/cam/model/plan';
import { installShopDefaults } from '@/platform/defaultsClient';
import { rankHouseEntries, type RankWorkerInput, type RankWorkerReply } from './rankPool';

const task = workerData as RankWorkerInput;
const port = parentPort;
if (port === null) throw new Error('rankPoolWorker must run as a worker thread');

// The same seeds the CLI's own boot does — the fonts from the bundled TTFs (branch bootstrap's own
// `seedFonts`, kept local because that export is #1137's), and the tool registry the plan reads.
for (const key of BUNDLED_FONT_KEYS) {
  const bytes = readFileSync(new URL(`../../../src/engine/fonts/files/${key}.ttf`, import.meta.url));
  registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
// The registry takes ENTRIES, keyed by the identity a posted program stamps (`cutterKeyOf`).
setRegistry(rankHouseEntries(task.input.cutters.house));
// #1237 — THE SHOP'S SETTINGS, IN THIS REALM: the seam sends the parent's installed defaults;
// the planner's own reads go through this realm's live source, which is otherwise empty.
installShopDefaults(() => task.defaults ?? null);

const reply = (msg: RankWorkerReply): void => port.postMessage(msg);

const captured: { metric: RankMeasurement | null } = { metric: null };
void planModelCam(task.input, {
  rankMeasure: { setupIndex: task.setupIndex, candidateKey: task.candidateKey },
  onRankMetric: (metric) => {
    captured.metric = metric;
  },
})
  .then(() => {
    reply(captured.metric === null ? { ok: false, error: 'the rank entry measured nothing' } : { ok: true, metric: captured.metric });
  })
  .catch((e: unknown) => {
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  });
