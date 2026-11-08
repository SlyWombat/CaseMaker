// #1093 R2/R3 — SAVE ALL, ON THE REAL JOB, AGAINST SET B.
//
// The published app (7a7bac78) wrote ONE program of m1trayB-bottom's five and stranded the other
// four behind a machine connection. This walk generates the same document through the shipped
// route — File ▾ → Open job… — with the k3 shop served as the house (the catalogue snapshot at
// `fixtures/m1trayB/house.json`: the 129 Makera cutters, the 1 328 feed rows and the 35 owned
// cutters the published app read), acknowledges the Cut statement, and presses *Save all*.
//
// The zip's five `.nc` files must be BYTE-IDENTICAL to set B — the CLI's own output for this job
// (`fixtures/m1trayB/setB-md5.json`, the #1093 re-keyed table) — proving the app's Save, the CLI
// and the release store name and write the same files. All five are strict since #1111: the app
// and the CLI order the owned set canonically and decide a same-diameter tie by stated keys, so
// the ⌀3.175 finish is the 22 mm ball on both doors (this walk is #1111's gate). The run sheet must
// name five programs with five Save buttons, and the file bar must offer NO single-program Save
// for a run of five.
//
// WHY THE HOUSE IS A FIXTURE: no real house service runs in the e2e web build, and the tray's
// bytes depend on the shop's cutters and feed rows (a run without them posts the starting table —
// #1081's measured difference). Serving the snapshot is what makes the comparison meaningful.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'fflate';

import { test, expect } from './fixtures/caseMaker';
import { downloadToBuffer } from './fixtures/parsers';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(`${HERE}fixtures/m1trayB/${name}`, 'utf8');

const HOUSE = JSON.parse(read('house.json')) as {
  tools: unknown[];
  feeds: unknown[];
  inventory: unknown[];
};
const SETB = JSON.parse(read('setB-md5.json')) as {
  jobs: Record<
    string,
    {
      programs: number;
      files: {
        name: string;
        oldName: string;
        bytes: number;
        md5: string;
        /** #1111 — present on a file whose tool identity may legitimately differ (none today). */
        toolIdentityMayDiffer?: { issue: number; maskedMd5: number | string; maskedLines: number };
      }[];
    }
  >;
};
const JOB_NAME = 'm1trayB-bottom';
const SETB_BOTTOM = SETB.jobs[JOB_NAME]!;

/**
 * The generation of a 106 × 136 tray is minutes in the worker — the published-app walk measured
 * ~17 min from Generate to the green card on the Z1's host — and the whole walk gets 45.
 */
test.setTimeout(2_700_000);

async function menuItem(page: import('@playwright/test').Page, testid: string) {
  const item = page.getByTestId(testid);
  if (!(await item.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  await expect(item).toBeVisible();
  return item;
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

test('#1093 — Save all writes all five programs, byte-identical to set B, and the sheet offers each one', async ({
  cm,
  page,
}, testInfo) => {
  // The k3 shop as the published app read it: the same tools, feed rows and owned cutters.
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        schemaVersion: 1,
        hasCatalogue: true,
        feedRows: HOUSE.feeds.length,
        materialSpecRows: 0,
        catalogueSyncedAt: '2026-10-18T03:24:13.374Z',
        lastSync: null,
        problems: [],
        warnings: [],
      }),
    }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"tools-1093"' },
      body: JSON.stringify(HOUSE.tools),
    }),
  );
  await page.route('**/api/v1/feeds**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"feeds-1093"' },
      body: JSON.stringify(HOUSE.feeds),
    }),
  );
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"inventory-1093"' },
      body: JSON.stringify(HOUSE.inventory),
    }),
  );

  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const jobPath = testInfo.outputPath(`${JOB_NAME}.cutjob.json`);
  writeFileSync(jobPath, read(`${JOB_NAME}.cutjob.json`));
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText(`Opened ${JOB_NAME}.cutjob.json.`);

  // GENERATE — five programs, swept and checked in cut order.
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 1_500_000 });
  // The design check is the fourth tick the published walk saw on this job; Save sits behind it.
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 1_500_000 });
  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.programs).toBe(SETB_BOTTOM.programs);

  // The statement lives on Cut step 1 (#689/#688); Save waits on it.
  await page.getByTestId('cnc-mode-cut').click();
  await page.getByTestId('engrave-ack').check();
  await page.getByTestId('cnc-mode-design').click();

  // THE FILE BAR OFFERS SAVE ALL, AND NO SINGLE-PROGRAM SAVE.
  await expect(await menuItem(page, 'engrave-save-all')).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId('engrave-save')).toHaveCount(0);
  await expect(page.getByTestId('engrave-save-all')).toContainText(`Save all (${SETB_BOTTOM.programs} programs)`);

  // The e2e browser has no directory picker to complete, so Save all must download one zip.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByTestId('engrave-save-all').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${JOB_NAME}-programs.zip`);
  const zip = unzipSync(new Uint8Array(await downloadToBuffer(await download.createReadStream())));
  // Keep what the app wrote: when a byte comparison fails, the file itself is the evidence.
  for (const [name, bytes] of Object.entries(zip)) writeFileSync(testInfo.outputPath(name), bytes);

  // Every program of set B, by name and by byte, plus the run record — and nothing else.
  const expectedNames = [...SETB_BOTTOM.files.map((f) => f.name), `${JOB_NAME}-run.json`].sort();
  expect(Object.keys(zip).sort(), 'the zip holds exactly the run’s files').toEqual(expectedNames);

  // #1093 R4 — THE RECORD LISTS EVERY PROGRAM, and every hash is its own file's: the app's save
  // and the app's upload list are the same bytes, whatever the card's copy of a cutter is called.
  const record = JSON.parse(new TextDecoder().decode(zip[`${JOB_NAME}-run.json`]!)) as {
    programs: { index: number; ncFile: string; ncHash: string }[];
  };
  expect(record.programs.map((p) => p.ncFile)).toEqual(SETB_BOTTOM.files.map((f) => f.name));
  for (const program of record.programs) {
    const bytes = zip[program.ncFile]!;
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 8), `${program.ncFile} hash`).toBe(program.ncHash);
  }

  // THE SHEET — five programs, five Saves, each row naming its own file.
  await page.getByTestId('cnc-mode-design').click();
  await (await menuItem(page, 'engrave-run-sheet')).click();
  await expect(page.getByTestId('run-sheet')).toBeVisible();
  await expect(page.getByTestId('run-sheet-files')).toBeVisible();
  for (let i = 1; i <= SETB_BOTTOM.programs; i++) {
    await expect(page.getByTestId(`run-sheet-file-${i}`)).toContainText(`${JOB_NAME}-p${i}.nc`);
    await expect(page.getByTestId(`run-sheet-save-${i}`)).toBeVisible();
  }
  // One row's own Save writes that program, and only that program.
  const [one] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('run-sheet-save-4').click(),
  ]);
  expect(one.suggestedFilename()).toBe(`${JOB_NAME}-p4.nc`);
  await page.getByTestId('run-sheet-close').click();

  // THE CROSS-DOOR CHECK — the app's files against set B, the CLI's own output for this job, all
  // five strictly byte-identical (#1111's gate; the walk found the p5 divergence).
  for (const file of SETB_BOTTOM.files) {
    expect(md5(zip[file.name]!), `${file.name} equals set B’s ${file.oldName}`).toBe(file.md5);
  }
});
