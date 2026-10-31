// #792 — the right panel's Design footer: ONE primary button. Generate is full width on the app's
// primary container, the "Generate" subheading is gone, and Save .nc… / Run sheet… / Open run
// record… live in File ▾. The screenshots are the hand-in's record of the changed state.
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

test('#792 — the Design footer has one primary button and the run’s files are in File ▾', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const footer = page.getByTestId('engrave-footer');
  await expect(page.getByTestId('engrave-generate')).toBeVisible();
  // No "Generate" subheading in the footer.
  await expect(footer.locator('h3', { hasText: 'Generate' })).toHaveCount(0);
  // The footer holds no file button; they are all in the menu.
  for (const id of ['engrave-save', 'engrave-run-sheet', 'engrave-open-record']) {
    await expect(footer.getByTestId(id)).toHaveCount(0);
  }
  await footer.screenshot({ path: testInfo.outputPath('design-footer-one-primary.png') });

  await page.getByTestId('engrave-file-menu-toggle').click();
  const menu = page.getByTestId('engrave-file-menu');
  for (const id of ['engrave-save', 'engrave-run-sheet', 'engrave-open-record']) {
    await expect(menu.getByTestId(id)).toBeVisible();
  }
  await menu.screenshot({ path: testInfo.outputPath('design-file-menu-run-files.png') });
});

// #793/#794 — a passing run collapses to ONE Ready line (the four ticks folded behind its ›), and
// the footer's primary becomes the next step: Cut…, which switches the surface to Cut.
test('#793/#794 — the Ready card is one line and the primary becomes Cut…', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // #793 — before any press the footer says nothing about a run.
  await expect(page.getByTestId('engrave-run-rows')).toHaveCount(0);
  await expect(page.getByTestId('engrave-run-ready')).toHaveCount(0);
  await expect(page.getByTestId('engrave-generate')).toHaveText('Generate');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // One line: ✓ Program ready · about … ·, with the ticks behind the closed ›.
  const ready = page.getByTestId('engrave-run-ready');
  await expect(ready).toBeVisible();
  await expect(page.getByTestId('engrave-run-ready-summary')).toContainText('Program ready');
  await expect(page.getByTestId('engrave-run-ready-chevron')).toBeVisible();
  await expect(page.getByTestId('engrave-run-rows')).toBeHidden();
  await expect(page.getByTestId('engrave-generate')).toHaveText('Cut…');
  await page.getByTestId('engrave-footer').screenshot({ path: testInfo.outputPath('design-footer-ready-card.png') });
  // The › really is a disclosure: the four ticks are one click away.
  await page.getByTestId('engrave-run-ready-summary').click();
  await expect(page.getByTestId('engrave-run-rows')).toBeVisible();
  await expect(page.getByTestId('engrave-run-rows')).toContainText('matches the design');
  await page.getByTestId('engrave-footer').screenshot({ path: testInfo.outputPath('design-footer-ready-expanded.png') });

  // #794 — pressing the primary is the next step: Cut, where the gate is approved.
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('cnc-mode-cut')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
});
