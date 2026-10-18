// #425 §6 — Save / Open for the job document, end to end.
//
// In E2E the native pickers cannot complete, so Save downloads the same text and Open uses the
// `<input type="file">` fallback (the paths `persistence.ts` deliberately keeps). Everything else
// is the shipped path: the real schema, the real store, the real document.
//
// The point of the slice is visible here: Save writes the whole job, an edit marks it dirty, a file
// that does not parse changes nothing, and a good file replaces the open document.

import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load a board (which shows the sidebar) and open Engrave on the deterministic default job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

/** Open the first label's row, where its text field lives (rows start folded). */
async function revealFirstLabel(page: Page): Promise<void> {
  const expand = page.getByTestId('engrave-label-expand-0').first();
  if ((await expand.getAttribute('aria-expanded')) !== 'true') await expand.click();
  await expect(page.getByTestId('engrave-label-text-0')).toBeVisible();
}

test('the job file is the owner: Save, a refused Open, then an Open that replaces the job', async ({
  cm,
  page,
}, testInfo) => {
  await cm.ready();
  await openEngravePanel(page);

  const bar = page.getByTestId('engrave-job-file');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('Not saved to a file yet');
  await expect(page.getByTestId('engrave-job-dirty')).toBeVisible();
  await expect(page.getByTestId('engrave-job-owner-note')).toContainText('the job file is the owner');
  await revealFirstLabel(page);
  await expect(page.getByTestId('engrave-label-text-0')).toHaveValue('CASE');

  // #419's Cut page is not this surface: the bar is Design's.
  await page.getByTestId('cnc-mode-cut').click();
  await expect(bar).toBeHidden();
  await page.getByTestId('cnc-mode-design').click();
  await expect(bar).toBeVisible();
  await revealFirstLabel(page);

  // Save writes the document itself — no wrapper, v3 literal, package/run-log keys absent on an
  // unused job — and a download fallback binds no handle.
  const saved = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('engrave-job-save').click(),
  ]).then(([download]) => download);
  expect(saved.suggestedFilename()).toBe('Untitled_engrave_job.cutjob.json');
  const savedPath = await saved.path();
  expect(savedPath).not.toBeNull();
  const doc = JSON.parse(readFileSync(savedPath!, 'utf8')) as {
    schemaVersion: number;
    labels: { text: string }[];
    package?: unknown;
  };
  expect(doc.schemaVersion).toBe(3);
  expect(doc.labels[0]!.text).toBe('CASE');
  expect('package' in doc).toBe(false);
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('Untitled_engrave_job.cutjob.json');
  await expect(page.getByTestId('engrave-job-dirty')).toBeHidden();

  // A file that does not parse changes nothing at all.
  const refused = testInfo.outputPath('refused.cutjob.json');
  writeFileSync(refused, '{ not a job');
  const [refusedChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('engrave-job-open').click(),
  ]);
  await refusedChooser.setFiles(refused);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('refused.cutjob.json was not opened');
  await expect(page.getByTestId('engrave-job-notice')).toHaveAttribute('data-kind', 'error');
  await revealFirstLabel(page);
  await expect(page.getByTestId('engrave-label-text-0')).toHaveValue('CASE');
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('Untitled_engrave_job.cutjob.json');

  // A good file replaces the open document: the label row shows the file's text, the bar its name.
  const editedDoc = { ...doc, name: 'From disk', labels: [{ ...doc.labels[0]!, text: 'OPENED' }] };
  const edited = testInfo.outputPath('edited.cutjob.json');
  writeFileSync(edited, JSON.stringify(editedDoc, null, 2));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('engrave-job-open').click(),
  ]);
  await chooser.setFiles(edited);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened edited.cutjob.json.');
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('edited.cutjob.json');
  await expect(page.getByTestId('engrave-job-dirty')).toBeHidden();
  await revealFirstLabel(page);
  await expect(page.getByTestId('engrave-label-text-0')).toHaveValue('OPENED');

  // An edit marks it dirty; Ctrl-S writes the document again (a download, since E2E has no handle).
  await page.getByTestId('engrave-label-text-0').fill('EDITED');
  await expect(page.getByTestId('engrave-job-dirty')).toBeVisible();
  const ctrlS = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('engrave-label-text-0').press('Control+S'),
  ]).then(([download]) => download);
  const ctrlSPath = await ctrlS.path();
  expect(ctrlSPath).not.toBeNull();
  const resaved = JSON.parse(readFileSync(ctrlSPath!, 'utf8')) as { labels: { text: string }[] };
  expect(resaved.labels[0]!.text).toBe('EDITED');
  await expect(page.getByTestId('engrave-job-dirty')).toBeHidden();
});
