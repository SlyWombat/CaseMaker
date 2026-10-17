// #471 §5.4 — the Setups section, end to end in a real browser (fresh server, 127.0.0.1 only).
//
// The section's critical path, exactly as the slice promises it: a job with no saved list reads as
// the implicit top-up setup and writes NOTHING until "Use this plan"; a saved list that has gone
// stale reports `setup-item-missing` and clears it only when the person presses "Remove from
// setup"; Add setup is disabled with the engine's own reason; and the remount page shows the
// engine's steps in order, refuses the mirror answer, and only then approves.
//
// Harness pattern from #419's `cncMode.spec.ts`: `cm.ready()`, then load a builtin board and reset
// the deterministic default job, then open Engrave from the sidebar.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

test('Setups: implicit draft, stale list, disabled Add, and the remount refusal', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  const section = page.getByTestId('engrave-setups');
  await expect(section).toBeVisible();

  // ── 1. The implicit reading is shown as a plan, not a document write ─────────────────────────
  await expect(page.getByTestId('engrave-setups-badge')).toHaveText('planned');
  await expect(page.getByTestId('engrave-setups-implicit')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-1')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-face-words-1')).toContainText('top up');

  // The one write the section performs: the person's plan.
  await page.getByTestId('engrave-setups-use-plan').click();
  await expect(page.getByTestId('engrave-setups-badge')).toHaveText('saved');
  await expect(page.getByTestId('engrave-setups-implicit')).toBeHidden();

  // ── 2. A removed item is `setup-item-missing` until "Remove from setup" ─────────────────────
  await page.getByTestId('engrave-label-remove-0').click();
  await expect(page.getByTestId('engrave-setups-badge')).toHaveText('stale');
  await expect(page.getByTestId('engrave-setup-finding-1-setup-item-missing')).toBeVisible();

  await page.getByTestId('engrave-setup-expand-1').click();
  const missing = page.locator('[data-testid^="engrave-setup-missing-1-"]');
  await expect(missing).toBeVisible();
  const missingId = (await missing.getAttribute('data-testid'))!.replace('engrave-setup-missing-1-', '');
  await page.getByTestId(`engrave-setup-remove-item-1-${missingId}`).click();
  await expect(page.getByTestId('engrave-setup-finding-1-setup-item-missing')).toBeHidden();
  await expect(page.getByTestId('engrave-setups-badge')).toHaveText('saved');

  // ── 3. Add setup is disabled with the engine's reason ───────────────────────────────────────
  // Every remaining cut opens to the top face, and the top face is already setup 1.
  await expect(page.getByTestId('engrave-setups-add')).toBeDisabled();
  await expect(page.getByTestId('engrave-setups-add-reason')).toContainText(
    'every cut opens to the top face, which is already a setup',
  );

  // ── 4. A through hole opens the bottom, so Add setup becomes available ──────────────────────
  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-drill').click();
  await page.getByTestId('engrave-drill-through-0').check();

  await page.getByTestId('engrave-add-drill').click();
  await page.getByTestId('engrave-drill-through-1').check();
  // Off-centre: the remount page can only ask a landmark question about a feature that is not
  // centred. Drill 1 is the one setup 1 keeps (see below), so it is the one made lopsided.
  await page.getByTestId('engrave-drill-x-1').fill('20');
  await page.getByTestId('engrave-drill-y-1').fill('20');

  // Move both through holes into setup 1 first: they are what setup 2 will see through.
  const addItem1 = page.getByTestId('engrave-setup-add-item-1');
  const drillIds = await addItem1
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''));
  expect(drillIds).toHaveLength(2);
  await addItem1.selectOption(drillIds[0]!);
  await addItem1.selectOption(drillIds[1]!);

  await expect(page.getByTestId('engrave-setups-add')).toBeEnabled();
  await page.getByTestId('engrave-setups-add').click();
  await expect(page.getByTestId('engrave-setup-2')).toBeVisible();

  // ── 5. The remount page: steps in order, the mirror answer refused, then approval ───────────
  await page.getByTestId('engrave-setup-expand-2').click();
  // Give setup 2 the first hole; setup 1 keeps the off-centre one, visible through setup 2.
  await page.getByTestId('engrave-setup-add-item-2').selectOption(drillIds[0]!);
  await expect(page.getByTestId('engrave-setup-remount-times-2')).toContainText('Remount ≈');
  await page.getByTestId('engrave-setup-remount-preview-2').click();

  await expect(page.getByTestId('engrave-remount-page')).toBeVisible();
  await expect(page.getByTestId('engrave-remount-title')).toHaveText('Remount for setup 2 of 2');
  // Order: the holder first (this is a remount, not the first mount), the last line the check.
  await expect(page.getByTestId('engrave-remount-step-1')).toContainText('Open the vise.');
  const steps = page.locator('[data-testid^="engrave-remount-step-"]');
  await expect(steps.last()).toContainText('Check it does not rock.');
  await expect(page.getByTestId('engrave-remount-question')).toContainText('which side is it nearer?');

  // Setup 2 is even-numbered, so the engine puts the right answer first: option 1 is the mirror.
  await page.getByTestId('engrave-remount-option-1').click();
  await page.getByTestId('engrave-remount-done').click();
  await expect(page.getByTestId('engrave-remount-refusal')).toContainText('that is the mirror-image mount');
  await expect(page.getByTestId('engrave-remount-page')).toBeVisible();

  await page.getByTestId('engrave-remount-option-0').click();
  await page.getByTestId('engrave-remount-done').click();
  await expect(page.getByTestId('engrave-remount-page')).toBeHidden();
  await expect(page.getByTestId('engrave-setup-remount-approved-2')).toBeVisible();
});
