// #799/#798 — the Job group's quiet first screen: the Stock fact line is the voids' disclosure,
// the Cutter verdict is one line above the fold, and the reference object is an entry of the one
// Add operation menu. The screenshots are the hand-in's record of the changed states.
import { writeFileSync } from 'node:fs';

import { test, expect } from './fixtures/caseMaker';
import { routeHouse, twoSideJob } from './fixtures/twoSideMouseShell';

test.setTimeout(120_000);

test('#799 — the Job group: Stock disclosure, Cutter line, and the Add menu’s reference entry', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // 1. The closed Stock line: one fact, with the voids behind it, not a top-level row.
  await expect(page.getByTestId('engrave-stock-detail')).not.toHaveAttribute('open');
  await expect(page.getByTestId('engrave-voids-line')).toBeHidden();
  await page.getByTestId('engrave-cutter-line').screenshot({ path: testInfo.outputPath('job-cutter-line.png') });
  await page.getByTestId('engrave-group-job').screenshot({ path: testInfo.outputPath('job-group-closed.png') });

  // 2. The opened Stock detail: the voids line and its add controls inside it.
  await page.getByTestId('engrave-stock-line').click();
  await expect(page.getByTestId('engrave-stock-detail')).toHaveAttribute('open');
  await expect(page.getByTestId('engrave-add-keepout-circle')).toBeVisible();
  await page.getByTestId('engrave-stock-detail').screenshot({ path: testInfo.outputPath('job-stock-detail.png') });

  // 3. The one Add operation menu, with the reference object as an entry.
  await page.getByTestId('engrave-add-summary').click();
  await expect(page.getByTestId('engrave-target-import')).toBeVisible();
  await page.getByTestId('engrave-add-menu').screenshot({ path: testInfo.outputPath('job-add-menu.png') });
});

// #1123 item 44 — BEFORE A GENERATE THE CUTTER LINE IS THE PLANNED SET. The 11-09 bench read the
// file's one tool as a lost plan and cancelled a good run. A multi-setup job is not measurable as
// one plan (`canMeasure`), so the line is settled; with no operator pick, it names the set the
// planner will choose at Generate, not the file's single tool.
test('#1123 item 44 — the settled pre-plan Cutter line says the set is planned at Generate', async ({ cm, page }, testInfo) => {
  // The web build has no house service; serve the demo long ball so the loaded job's tool resolves.
  await routeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The two-sided shell without the operator's pick: the document carries a tool, sources do not
  // say it was chosen, and the planner owns the set.
  const jobPath = testInfo.outputPath('two-sides-computed.cutjob.json');
  writeFileSync(jobPath, JSON.stringify({ ...twoSideJob(), sources: {} }));
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened');

  const line = page.getByTestId('engrave-cutter-line');
  await expect(line).toContainText('planned at Generate from your owned bits');
  await expect(line).not.toContainText('chosen by you');
  await line.screenshot({ path: testInfo.outputPath('cutter-line-planned.png') });
});

// #1171 — THE DESIGN PANEL AS FIVE ONE-LINE GROUPS OVER ONE FIXED PROGRESS ROW. Each group states
// its fact while closed; the progress row is the one place Generate and its words live.
test('#1171 — five fact-bearing group lines and one fixed progress row', async ({ cm, page }, testInfo) => {
  await routeHouse(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const jobPath = testInfo.outputPath('two-sides-1171.cutjob.json');
  writeFileSync(jobPath, JSON.stringify({ ...twoSideJob(), sources: {} }));
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(jobPath);
  await expect(page.getByTestId('engrave-job-notice')).toContainText('Opened');

  // The five groups, in order, each with its one-line fact while closed.
  await expect(page.getByTestId('engrave-group-job-summary')).toContainText('two sides');
  await expect(page.getByTestId('engrave-group-cutter-summary')).toContainText('chosen at Generate from your bits');
  await expect(page.getByTestId('engrave-group-hold-summary')).not.toBeEmpty();
  await expect(page.getByTestId('engrave-group-setups-summary')).toContainText('2 sides');
  await expect(page.getByTestId('engrave-findings-summary')).toContainText('to confirm');
  // ONE progress row: the press lives inside it, and the Cut tab's surface renders the same
  // RunProgressLine for a generate started there (#1123 item 45; unit-pinned in cutSurface.spec).
  const row = page.getByTestId('engrave-progress-row');
  await expect(row).toBeVisible();
  expect(await row.locator('[data-testid="engrave-generate"]').count()).toBe(1);
  await page.getByTestId('engrave-panel').screenshot({ path: testInfo.outputPath('design-panel-1171.png') });
  await row.screenshot({ path: testInfo.outputPath('progress-row-1171.png') });
});
