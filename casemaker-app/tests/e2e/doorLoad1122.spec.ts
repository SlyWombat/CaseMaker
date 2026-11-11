// #1122 — THE DOOR'S LOAD OPENS A CUTTING JOB, in one press.
//
// The maintainer opened a `.cutjob.json` from the door and got a Zod dump, because Load only knew
// projects; the only way to a job was the wizard and the Job panel's File menu. This spec makes a
// real job document through the app's own Save, returns to the door, and opens it with Load — the
// shipped route, the real schema, the real store. A job opens on the Job panel with its name in
// the bar, and no schema text reaches the page.

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, enterCnc } from './fixtures/caseMaker';

/** #1123 item 10 — the one record that says the CNC workspace was open (`workspaceSession.ts`). */
const WORKSPACE_KEY = 'casemaker.workspace.v1';

/** #686 — every job-file command is the File menu's; open it if it is not already. */
async function fileMenu(page: Page, testid: string): Promise<void> {
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  await expect(menu).toBeVisible();
  await page.getByTestId(testid).click();
}

test('#1122 — Load opens a .cutjob.json from the door and lands on the Job panel', async ({
  cm,
  page,
}) => {
  await cm.ready();

  // A real job document, made by the app's own Save so the fixture cannot drift from the schema.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    fileMenu(page, 'engrave-job-save'),
  ]);
  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const doc = JSON.parse(readFileSync(savedPath!, 'utf8')) as { name: string; stock: unknown };
  expect(doc.stock).toBeDefined();

  // Back to the door, and open it with ONE press of Load. #1123 item 10 means a reload comes back
  // to the workspace that was open, so the session record is cleared for this navigation: a fresh
  // load — no record — is what opens the door.
  await page.addInitScript((key) => window.localStorage.removeItem(key), WORKSPACE_KEY);
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('load-project').click(),
  ]);
  await chooser.setFiles(savedPath!);

  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('engrave-job-file-name')).toContainText(doc.name);
  // The schema detail never reaches the page: no dump, and the door's slim bar is gone.
  await expect(page.getByTestId('toolbar-welcome')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('invalid_type');
  await expect(page.locator('body')).not.toContainText('ZodError');
});
