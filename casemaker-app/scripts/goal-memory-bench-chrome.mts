// #902 — MEASURE FIRST (Chrome). Launches the app's dev server page in real Chrome, drives the
// panther goal through the wizard exactly as the app's own UI does, and samples the page's and
// every worker's JS heap every ~2s via CDP.
//
// Uses Playwright's OWN CDP session API (`page.context().newCDPSession`, `browser.newBrowserCDPSession`)
// rather than #881's shared `scripts/cdpHeap.mts`: a second, raw CDP WebSocket opened to the same
// browser endpoint Playwright already controls fails its first `Target.getTargets` call with a
// bare "CDP error" (no message) in this setup. Flagged for 67 rather than patched into the frozen
// probe. Also: `performance.memory` is NOT exposed inside a dedicated Worker in Chrome (only on
// `window`) — a worker's heap is readable only through CDP's `Runtime.getHeapUsage`, which is the
// whole reason `cdpHeap.mts` exists. This script's relay (`Target.attachToTarget` +
// `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget`) is the same one the #889/#896
// crash profiling used successfully in the prior session (`CaseMaker-bench/bench-scripts/pantherProfile.mjs`).
//
// Usage: npx tsx --tsconfig tsconfig.scripts.json scripts/goal-memory-bench-chrome.mts --base http://127.0.0.1:5302
import { chromium } from '@playwright/test';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

const BASE = arg('--base', 'http://127.0.0.1:5302');
const MESH = arg('--mesh', 'samples/3d/nude_pantherv2-final.stl');

interface WorkerEntry {
  title: string;
  url: string;
  sessionId: string | null;
  enabled: boolean;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

  const pageCdp = await page.context().newCDPSession(page);
  await pageCdp.send('Runtime.enable');

  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });

  const workers = new Map<string, WorkerEntry>();
  let msgId = 1;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  browserCdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }: { sessionId: string; message: string }) => {
    let parsed: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const key = `${sessionId}:${parsed.id}`;
    const waiter = pending.get(key);
    if (parsed.id !== undefined && waiter !== undefined) {
      pending.delete(key);
      if (parsed.error !== undefined) waiter.reject(new Error(JSON.stringify(parsed.error)));
      else waiter.resolve(parsed.result);
    }
  });
  function sendToSession(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<{ usedSize?: number; totalSize?: number }> {
    const id = msgId++;
    const message = JSON.stringify({ id, method, params });
    const key = `${sessionId}:${id}`;
    const p = new Promise<unknown>((resolve, reject) => pending.set(key, { resolve, reject }));
    browserCdp.send('Target.sendMessageToTarget', { sessionId, message }).catch(() => undefined);
    return p as Promise<{ usedSize?: number; totalSize?: number }>;
  }

  async function attachWorker(targetInfo: { targetId: string; title: string; url: string; type: string }): Promise<void> {
    if (workers.has(targetInfo.targetId)) return;
    const entry: WorkerEntry = { title: targetInfo.title, url: targetInfo.url, sessionId: null, enabled: false };
    workers.set(targetInfo.targetId, entry);
    try {
      const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: false });
      entry.sessionId = sessionId;
      await sendToSession(sessionId, 'Runtime.enable');
      entry.enabled = true;
      console.error(`[info] attached worker target ${targetInfo.type} ${targetInfo.url}`);
    } catch (e) {
      console.error(`[info] worker attach failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  browserCdp.on('Target.targetCreated', ({ targetInfo }: { targetInfo: { targetId: string; title: string; url: string; type: string } }) => {
    if (targetInfo.type === 'worker' || targetInfo.type === 'shared_worker') void attachWorker(targetInfo);
  });
  browserCdp.on('Target.targetDestroyed', ({ targetId }: { targetId: string }) => {
    workers.delete(targetId);
  });
  browserCdp.on('Target.targetInfoChanged', ({ targetInfo }: { targetInfo: { targetId: string; url: string; title: string } }) => {
    const w = workers.get(targetInfo.targetId);
    if (w && targetInfo.url) w.url = targetInfo.url;
    if (w && targetInfo.title) w.title = targetInfo.title;
  });

  const { targetInfos } = await browserCdp.send('Target.getTargets', {});
  for (const ti of targetInfos as { targetId: string; title: string; url: string; type: string }[]) {
    if (ti.type === 'worker' || ti.type === 'shared_worker') await attachWorker(ti);
  }

  const startedAt = Date.now();
  const samples: { tMs: number; page: number | null; workers: Record<string, number | null> }[] = [];
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      let pageMb: number | null = null;
      try {
        const heap = (await pageCdp.send('Runtime.getHeapUsage')) as { usedSize: number };
        pageMb = heap.usedSize / (1024 * 1024);
      } catch {
        pageMb = null;
      }
      const workerMb: Record<string, number | null> = {};
      for (const [, w] of workers) {
        if (!w.sessionId || !w.enabled) continue;
        const label = w.url || w.title;
        try {
          const heap = await sendToSession(w.sessionId, 'Runtime.getHeapUsage');
          workerMb[label] = heap.usedSize === undefined ? null : heap.usedSize / (1024 * 1024);
        } catch {
          workerMb[label] = null;
        }
      }
      samples.push({ tMs: Date.now() - startedAt, page: pageMb, workers: workerMb });
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  await page.goto(`${BASE}/?BETA=yes`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard').waitFor({ timeout: 10000 });
  await page.getByTestId('start-wizard-next').click();

  await page.getByTestId('engrave-setup-what-surface').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByTestId('engrave-setup-what-surface').click({ timeout: 10000 });
  const chooseFileBtn = page.getByTestId('start-wizard-op-surface-picker-choose');
  await chooseFileBtn.waitFor({ state: 'visible', timeout: 10000 });
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  chooserPromise.catch(() => undefined);
  await chooseFileBtn.click({ timeout: 10000 });
  const chooser = await chooserPromise;
  await chooser.setFiles(MESH);
  await page.getByTestId('start-wizard-operation-next').click({ timeout: 10000 });

  await page.getByTestId('start-wizard-step-stock').waitFor({ timeout: 10000 });
  await page.getByTestId('start-wizard-stock-material').selectOption('hardwood');
  await page.getByTestId('start-wizard-form-block').click();
  await page.getByTestId('start-wizard-make-length').fill('150');
  await page.getByTestId('start-wizard-make-width').fill('75');
  await page.getByTestId('start-wizard-make-thickness').fill('51');
  await page.getByTestId('start-wizard-stock-next').click();

  const holding = page.getByTestId('engrave-setup-step-holding');
  await holding.waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined);
  await page.getByTestId('engrave-setup-next').click({ timeout: 15000 });
  await page.getByTestId('engrave-panel').waitFor({ timeout: 20000 });

  const layFlatBtn = page.getByTestId('engrave-target-layflat-0');
  await layFlatBtn.waitFor({ state: 'visible', timeout: 10000 });
  await layFlatBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1500);

  console.error('[info] clicking Generate');
  await page.getByTestId('engrave-generate').click({ timeout: 10000 });

  const deadline = Date.now() + 180_000;
  let retries = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const refused = await page.getByTestId('engrave-run-refused').isVisible().catch(() => false);
    if (refused) {
      const text = await page.getByTestId('engrave-run-refused').textContent().catch(() => null);
      console.error(`[info] refusal text: ${text?.slice(0, 300)}`);
    }
    if (refused && retries < 3) {
      retries++;
      const pitchRetry = page.getByTestId('engrave-generate-at-pitch');
      if (await pitchRetry.isVisible().catch(() => false)) {
        console.error(`[info] refused — clicking the coarser-pitch retry (attempt ${retries})`);
        await pitchRetry.click({ timeout: 10000 }).catch(() => undefined);
        continue;
      }
      console.error('[info] refused with no pitch retry available — stopping poll');
      break;
    }
    if (refused) {
      console.error('[info] still refused after retries — stopping poll');
      break;
    }
    const ready = await page.getByTestId('engrave-run-ready').isVisible().catch(() => false);
    if (ready) {
      console.error('[info] run ready — generate finished');
      break;
    }
  }
  await page.waitForTimeout(1000);

  polling = false;
  await pollLoop;
  await browser.close();

  console.log(`\n# ${samples.length} samples over ${((samples.at(-1)?.tMs ?? 0) / 1000).toFixed(1)}s`);
  const pageVals = samples.map((s) => s.page).filter((v): v is number => v !== null);
  if (pageVals.length > 0) console.log(`# page       peak=${Math.max(...pageVals).toFixed(1)} MB, last=${(pageVals.at(-1) as number).toFixed(1)} MB, n=${pageVals.length}`);
  const workerLabels = new Set(samples.flatMap((s) => Object.keys(s.workers)));
  for (const label of workerLabels) {
    const vals = samples.map((s) => s.workers[label]).filter((v): v is number => v !== null && v !== undefined);
    if (vals.length === 0) continue;
    const short = label.split('/').pop() ?? label;
    console.log(`# ${short.padEnd(40)} peak=${Math.max(...vals).toFixed(1)} MB, last=${(vals.at(-1) as number).toFixed(1)} MB, n=${vals.length}`);
  }
}

await main();
