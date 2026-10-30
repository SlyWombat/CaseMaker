// #780 — the Holding step's pictures: everything inside the picture column stays inside it.
//
// Three defects in one small area: the top view's Y axis was drawn at the edge with its label past
// the viewBox (only a bare line showed), the side view's proud height had no number on it, and the
// picture SVG measured 2 px wider than its slot (the border on a content-box width). This walk
// reaches Holding through the same door → stock path every first job takes, measures the SVGs
// against the slot, reads the two labels, and keeps a screenshot for the eye.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

/** Door → a typed plate → Holding (the start wizard's own path). */
async function reachHolding(page: Page): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill('6');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

test('#780 — the Holding pictures fit their column, and both axes are labelled inside it', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await reachHolding(page);

  const slot = page.getByTestId('engrave-setup-holding-picture-slot');
  await expect(slot).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-picture')).toBeVisible();

  // NO HORIZONTAL OVERFLOW: every picture SVG fits the slot's own width (the border included —
  // the old content-box width made this 232 in a 230 slot).
  const measured = await slot.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const svgs = [...el.querySelectorAll('svg')].map((s) => s.getBoundingClientRect().width);
    return { slot: box.width, svgs };
  });
  expect(measured.svgs.length).toBeGreaterThan(0);
  for (const width of measured.svgs) expect(width).toBeLessThanOrEqual(measured.slot + 0.5);

  // The Y axis is INSIDE the top view: its letter's box sits within the SVG's own box.
  const yInside = await page.getByTestId('engrave-setup-holding-y-label').evaluate((el) => {
    const svg = el.closest('svg');
    if (svg === null) return false;
    const label = el.getBoundingClientRect();
    const box = svg.getBoundingClientRect();
    return label.left >= box.left && label.right <= box.right && label.top >= box.top && label.bottom <= box.bottom;
  });
  expect(yInside).toBe(true);

  // The side view's proud height carries its number, not a bare tick.
  await expect(page.getByTestId('engrave-setup-holding-side')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-side-proud')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-side-proud-label')).toContainText('mm');

  await slot.screenshot({ path: testInfo.outputPath('holding-picture.png') });
});
