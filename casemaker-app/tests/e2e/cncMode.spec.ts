// #419 §3, slice 1 — the Design/Cut switch, end to end in a real browser.
//
// The panel header is new UI, so this covers exactly the contract the slice promised: a fresh job
// opens in Design, pressing Cut runs the gate and shows the preflight page (an ungenerated job is
// `no-generate`), and Back to Design returns to the stack. The collector's and hub's own rows are
// unit-tested; this spec is about the switch being wired to them in the shipped bundle.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load a board (which shows the sidebar) and open Engrave on the deterministic, ungenerated job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

test('Design/Cut: Cut runs the gate and Back to Design returns to the stack', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  // A fresh job is in Design: today's controls, no preflight page.
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cnc-mode-cut')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('engrave-setup-open')).toBeVisible();
  await expect(page.getByTestId('engrave-preflight')).toBeHidden();

  // Pressing Cut always asks the gate. Nothing has been generated for this job, so the page is
  // blocked and the run gate's own `no-generate` row is on it.
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('cnc-mode-cut')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-preflight')).toBeVisible();
  await expect(page.getByTestId('engrave-preflight')).toHaveAttribute('data-state', 'blocked');
  await expect(page.getByTestId(/^engrave-preflight-row-\d+-no-generate$/)).toBeVisible();
  await expect(page.getByTestId('engrave-preflight-first-blocking')).toContainText('Generate first.');
  // The Design stack is replaced, not merely covered.
  await expect(page.getByTestId('engrave-setup-open')).toBeHidden();

  // Back to Design leaves Cut and shows the stack again.
  await page.getByTestId('engrave-back-to-design').click();
  await expect(page.getByTestId('cnc-mode-design')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-preflight')).toBeHidden();
  await expect(page.getByTestId('engrave-setup-open')).toBeVisible();
});
