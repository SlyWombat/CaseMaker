// #848 — A BOSS THE JOB CUTS, THEN ITS THREAD, in a real browser, from the operation picker
// through Generate. A 40 × 40 × 20 mm block: a cutaway clears a ⌀30 mm field 8 mm deep around a
// ⌀8 mm reference circle, which stands as the boss. "Thread a boss (external)" adds the thread at
// the block's centre; the row tags it "Thread · external", names the cut that raises the boss, and a
// size that does not match the boss offers "Use M8" as one press. The plan splits the job — the
// flat for the boss (and any rest pass the measured pick adds), then the thread mill — and says so
// in one line; the run ticks
// the toolpath, the verifier and the simulation, and the oracle agrees.
//
// REAL screenshots are kept under `docs/bench/img/2026-11-01-boss-thread/`.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveCombinedShape, EngraveJob } from '@/types/engraveJob';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(600_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-11-01-boss-thread');
const WORK = path.join(process.cwd(), 'test-results', 'boss-thread-848');

const M8: ToolLibraryEntry = {
  key: 'user:848-m8',
  provenance: 'typed here for the #848 boss-thread e2e',
  tool: flatEndMill(6, { name: 'Thread mill M8x1.25 (d6mm)', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 6, diameter: 6, fluteLength: 20 }),
};
const FLAT: ToolLibraryEntry = {
  key: 'user:848-flat3',
  provenance: 'typed here for the #848 boss-thread e2e',
  tool: flatEndMill(3, { name: '3 mm flat end mill', fluteLength: 20 }),
};

function blockJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'M8 boss in a block';
  job.stock = { ...job.stock, length: 40, width: 40, thickness: 20 };
  job.labels = [];
  job.shapes = [
    { kind: 'circle', id: 'boss', name: 'boss', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, diameter: 8, construction: true },
    // A round field: its wall has no inside corner a rest pass would be asked to finish.
    { kind: 'circle', id: 'field', name: 'field', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, diameter: 30, construction: true },
  ] as EngraveJob['shapes'];
  job.combined = [
    { kind: 'cutaway', id: 'ring', name: 'ring', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, outer: 'field', islands: ['boss'] } as EngraveCombinedShape,
  ];
  job.toolKey = FLAT.key;
  job.tool = FLAT.tool;
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

test.beforeEach(async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async (entries) => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.seedCutters(entries, []);
    window.__caseMaker!.engraveReset();
  }, [M8, FLAT]);
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
});

test('an ⌀8 mm boss the job raises, threaded M8×1.25: the boss, then the thread, from the picker through Generate', async ({ page }) => {
  await openJob(page, blockJob(), 'm8-boss-block.job.json');

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-thread-external').click();
  await expect(page.getByTestId('engrave-thread-row-0')).toBeVisible();
  // The tag says which side.
  await expect(page.getByTestId('engrave-thread-type-0')).toHaveText('Thread · external');
  if ((await page.getByTestId('engrave-thread-side-0').count()) === 0) await page.getByTestId('engrave-thread-expand-0').click();

  // The boss is the circle the cutaway raises, and the row says so.
  await expect(page.getByTestId('engrave-thread-size-0')).toHaveValue('M8');
  await expect(page.getByTestId('engrave-thread-boss-0')).toHaveText(
    'Cut on circle "boss" (⌀8 mm), which the cutaway "ring" raises 8 mm tall before the thread.',
  );
  await page.getByTestId('engrave-thread-depth-0').fill('6');

  // A size that does not match the boss offers the nearest size as one press.
  await page.getByTestId('engrave-thread-size-0').selectOption('M10');
  await expect(page.getByTestId('engrave-thread-use-size-0')).toHaveText('Use M8 (⌀8 mm)');
  await shoot(page, 'use-m8-offer.png');
  await page.getByTestId('engrave-thread-use-size-0').click();
  await expect(page.getByTestId('engrave-thread-size-0')).toHaveValue('M8');
  await expect(page.getByTestId('engrave-thread-use-size-0')).toHaveCount(0);

  // The plan splits the job, boss first, and one line says so.
  const split = page.locator('[data-code="setup-programs-split"]');
  await expect(split).toHaveCount(1, { timeout: 180_000 });
  await expect(split).toHaveText(
    // The measured pick may add a rest pass after the boss's flat; the thread mill is always last.
    /^NoteSplit into \d programs: the ⌀ 3 mm flat end for ring, (.+, )?the thread mill for the thread on the boss the cutaway "ring" raises\.$/,
    { timeout: 180_000 },
  );
  await page.getByTestId('engrave-findings').locator('summary').click();
  await shoot(page, 'boss-thread-row-and-split.png');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect.poll(async () => (await page.evaluate(() => window.__caseMaker!.getEngraveRunState())).oracleOk, { timeout: 120_000 }).toBe(true);
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok, JSON.stringify(state)).toBe(true);
  expect(state.verifyErrors).toBe(0);
  expect(state.programs).toBeGreaterThanOrEqual(2);
  // Cut order: the boss's flat first, the thread mill last.
  const keys = await page.evaluate(async () => {
    const m = await import('/src/store/engraveRunStore.ts' as string);
    return (m.useEngraveRunStore.getState().generated?.programs ?? []).map((p: { toolKey: string }) => p.toolKey);
  });
  expect(keys[0]).toBe(FLAT.key);
  expect(keys[keys.length - 1]).toBe(M8.key);
  await shoot(page, 'boss-thread-generated.png');
});
