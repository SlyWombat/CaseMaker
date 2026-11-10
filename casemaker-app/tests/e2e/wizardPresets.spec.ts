// #1100 — What are you making? The step opens on the eight illustrated preset cards, each with a
// visible blurb (touch has no hover), and a selected card shows its own questions.

import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

test('#1100 — the eight preset cards, and a sign asks for its text', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  // The cards, with their blurbs in the DOM — never a title attribute.
  await expect(page.getByTestId('start-wizard-presets')).toBeVisible();
  for (const id of ['sign', 'part-3d', 'cutout', 'pocket', 'design-file', 'pcb', 'something-else']) {
    await expect(page.getByTestId(`start-wizard-preset-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('start-wizard-preset-sign')).toContainText('Letters cut into a board');
  await expect(page.getByTestId('start-wizard-preset-sign')).not.toHaveAttribute('title');
  await page.screenshot({ path: 'test-results/1100-preset-cards.png' });

  // A sign's questions are in place, and Create waits for the text.
  await page.getByTestId('start-wizard-preset-sign').click();
  await page.getByTestId('start-wizard-preset-text').fill('Hello');
  await expect(page.getByTestId('start-wizard-preset-letter-medium')).toBeChecked();
  await page.screenshot({ path: 'test-results/1100-sign-card.png' });

  // Cut out a shape carries its own size numbers.
  await page.getByTestId('start-wizard-preset-cutout').click();
  await expect(page.getByTestId('start-wizard-preset-length')).toHaveValue('60');
  await expect(page.getByTestId('start-wizard-preset-width')).toHaveValue('40');
  await page.screenshot({ path: 'test-results/1100-cutout-card.png' });
});
