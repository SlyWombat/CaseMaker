// #807/#800 — the first screen's one disclosure affordance and the file bar's clean line, and the
// run rows' words after a run ("generated · checked · simulated · matches the design").
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(240_000);

test('#807 — the first screen: one › per disclosure, and the file bar is a line', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // Each row ends with the one affordance; the stock's edit is in its opened body.
  await expect(page.getByTestId('engrave-stock-line')).toContainText('›');
  await expect(page.getByTestId('engrave-facing-line')).toContainText('›');
  await expect(page.getByTestId('engrave-stock-line')).not.toContainText('▸ edit');
  await page.getByTestId('engrave-job-file').screenshot({ path: testInfo.outputPath('file-bar-line.png') });
  await page.getByTestId('engrave-group-job').screenshot({ path: testInfo.outputPath('job-first-screen.png') });
});

test('#800 — after a run the rows say generated · checked · simulated · matches the design', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-verified')).toContainText('checked');
  await page.getByTestId('engrave-run-ready-summary').click();
  await expect(page.getByTestId('engrave-run-rows')).toContainText('checked');
  await page.getByTestId('engrave-footer').screenshot({ path: testInfo.outputPath('footer-run-words.png') });
});
