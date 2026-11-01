// #841 — both new thread cases, from the operation picker through Generate, in a real browser:
//
//   1. an M8×1.25 EXTERNAL thread on a ⌀8 mm rod standing 12 mm proud of the vise jaws — the
//      picker's "Thread a boss (external)", which finds the rod as its boss;
//   2. a 1/4-20 UNC INTERNAL thread — the picker's "Thread", the row switched to Imperial and the
//      size picked, the pitch shown in mm.
//
// Each run must tick the toolpath, the verifier and the simulation, and the oracle must agree.
// REAL screenshots are kept under `docs/bench/img/2026-10-31-threads/`.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(600_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-threads');
const WORK = path.join(process.cwd(), 'test-results', 'threads-841');

function mill(key: string, name: string, d: number): ToolLibraryEntry {
  return {
    key,
    provenance: 'typed here for the #841 thread e2e',
    tool: flatEndMill(d, { name, typeText: 'Thread Mill', shape: 'thread', tipDiameter: d, diameter: d, fluteLength: 20 }),
  };
}
const M8 = mill('user:841-m8', 'Thread mill M8x1.25 (d6mm)', 6);
const UNC = mill('user:841-unc', 'Thread mill 1/4-20 UNC (d4.0mm)', 4);

function emptyJob(name: string, tool: ToolLibraryEntry, stock: Partial<EngraveJob['stock']>, stockProud?: number): EngraveJob {
  const job = defaultEngraveJob();
  job.name = name;
  job.stock = { ...job.stock, ...stock };
  job.labels = [];
  job.shapes = [];
  job.toolKey = tool.key;
  job.tool = tool.tool;
  if (stockProud !== undefined && job.workholding.kind === 'vise') {
    job.workholding = { ...job.workholding, vise: { ...job.workholding.vise, stockProud } };
  }
  return job;
}

async function openJob(page: Page, job: EngraveJob, file: string): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const at = path.join(WORK, file);
  fs.writeFileSync(at, JSON.stringify(job));
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(at);
  await expect(page.getByTestId('engrave-job-file-name')).toContainText(job.name);
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name) });
}

async function generateAndCheck(page: Page): Promise<void> {
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect.poll(async () => (await page.evaluate(() => window.__caseMaker!.getEngraveRunState())).oracleOk, { timeout: 120_000 }).toBe(true);
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok, JSON.stringify(state)).toBe(true);
  expect(state.verifyErrors).toBe(0);
}

test.beforeEach(async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async (entries) => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.seedCutters(entries, []);
    window.__caseMaker!.engraveReset();
  }, [M8, UNC]);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
});

test('an M8×1.25 external thread on a ⌀8 mm rod, from "Thread a boss (external)" through Generate', async ({ page }) => {
  await openJob(page, emptyJob('M8 boss', M8, { length: 8, width: 8, thickness: 20, shape: 'cylinder', diameter: 8 }, 12), 'm8-boss.job.json');

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-thread-external').click();
  await expect(page.getByTestId('engrave-thread-row-0')).toBeVisible();
  if ((await page.getByTestId('engrave-thread-side-0').count()) === 0) await page.getByTestId('engrave-thread-expand-0').click();

  // The rod is the boss: the row says so, and the size starts at the metric size nearest it.
  await expect(page.getByTestId('engrave-thread-side-0')).toHaveValue('external');
  await expect(page.getByTestId('engrave-thread-size-0')).toHaveValue('M8');
  await expect(page.getByTestId('engrave-thread-boss-0')).toHaveText('Cut on the ⌀8 mm round stock.');
  await expect(page.getByTestId('engrave-thread-boss-note-0')).toContainText('⌀6.466 mm external minor');
  await page.getByTestId('engrave-thread-depth-0').fill('6');
  await shoot(page, 'm8-external-row.png');

  await generateAndCheck(page);
  const nc = (await page.evaluate(() => window.__caseMaker!.engraveProgramText())) ?? '';
  expect(nc).toContain('Thread M8×1.25 external');
  await shoot(page, 'm8-external-generated.png');
});

test('a 1/4-20 UNC internal thread, from "Thread" with Imperial picked, through Generate', async ({ page }) => {
  await openJob(page, emptyJob('UNC hole', UNC, { length: 60, width: 40, thickness: 12 }), 'unc-hole.job.json');

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-thread').click();
  await expect(page.getByTestId('engrave-thread-row-0')).toBeVisible();
  if ((await page.getByTestId('engrave-thread-standard-0').count()) === 0) await page.getByTestId('engrave-thread-expand-0').click();

  await page.getByTestId('engrave-thread-standard-0').selectOption('imperial');
  await page.getByTestId('engrave-thread-size-0').selectOption('1/4-20');
  await expect(page.getByTestId('engrave-thread-pitch-0')).toContainText('20 TPI = 1.27 mm pitch');
  await expect(page.getByText(/⌀4\.975 mm/)).toBeVisible();
  await page.getByTestId('engrave-thread-depth-0').fill('6');
  await shoot(page, 'unc-internal-row.png');

  await generateAndCheck(page);
  const nc = (await page.evaluate(() => window.__caseMaker!.engraveProgramText())) ?? '';
  expect(nc).toContain('Thread 1/4-20 UNC');
  await shoot(page, 'unc-internal-generated.png');
});
