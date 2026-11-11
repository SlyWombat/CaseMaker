// #1100 — What are you making? The step opens on the illustrated preset cards, each with a
// visible blurb (touch has no hover), and a selected card shows its own questions — a file card
// hosts its file field in the card. The step empty and with each card selected is a baseline.
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

async function reachQuestion(cm: { ready(): Promise<void> }, page: import('@playwright/test').Page): Promise<void> {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you making?');
}

test('#1100 — the preset cards, and a sign asks for its text', async ({ cm, page }) => {
  await reachQuestion(cm, page);

  // The cards, with their blurbs in the DOM — never a title attribute.
  await expect(page.getByTestId('start-wizard-presets')).toBeVisible();
  for (const id of ['sign', 'part-3d', 'cutout', 'pocket', 'design-file', 'pcb', 'something-else']) {
    await expect(page.getByTestId(`start-wizard-preset-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('start-wizard-preset-sign')).toContainText('Letters cut into a board');
  await expect(page.getByTestId('start-wizard-preset-sign')).not.toHaveAttribute('title');

  // A sign's questions are in place, and Create waits for the text.
  await page.getByTestId('start-wizard-preset-sign').click();
  await page.getByTestId('start-wizard-preset-text').fill('Hello');
  // #1100 item 3, ruling b — the size starts UNCHOSEN: the house stick stands until one is picked.
  await expect(page.getByTestId('start-wizard-preset-letter-small')).not.toBeChecked();
  await expect(page.getByTestId('start-wizard-preset-letter-medium')).not.toBeChecked();
  await expect(page.getByTestId('start-wizard-preset-letter-large')).not.toBeChecked();
  await page.getByTestId('start-wizard-preset-letter-medium').click();
  await expect(page.getByTestId('start-wizard-preset-letter-medium')).toBeChecked();

  // Cut out a shape carries its own size numbers.
  await page.getByTestId('start-wizard-preset-cutout').click();
  await expect(page.getByTestId('start-wizard-preset-length')).toHaveValue('60');
  await expect(page.getByTestId('start-wizard-preset-width')).toHaveValue('40');

  // #1100 item 1 — a selected FILE card keeps its press and hosts its own field in the card.
  await page.getByTestId('start-wizard-preset-pcb').click();
  await expect(page.getByTestId('start-wizard-preset-pcb')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('start-wizard-preset-card-pcb')).toContainText('Gerber');
  await page.getByTestId('start-wizard-preset-part-3d').click();
  await expect(page.getByTestId('start-wizard-preset-card-part-3d').getByTestId('start-wizard-op-surface-file')).toBeAttached();
  await expect(page.getByTestId('start-wizard-op-surface-picker-choose')).toBeVisible();
});

test('#1100 item 6 — the step empty and with each card selected are baselines', async ({ cm, page }) => {
  await reachQuestion(cm, page);
  await expect(page).toHaveScreenshot('1100-step-empty.png');
  for (const id of ['sign', 'cutout', 'pocket', 'part-3d', 'design-file', 'pcb', 'something-else']) {
    await page.getByTestId(`start-wizard-preset-${id}`).click();
    await expect(page.getByTestId(`start-wizard-preset-${id}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveScreenshot(`1100-card-${id}.png`);
  }
});

// #1100 item 5 — TOUCH HAS NO HOVER: the blurb and the card's questions must be on the screen and
// reachable by a tap alone.
test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('#1100 — the blurbs show under touch', async ({ cm, page }) => {
    await reachQuestion(cm, page);
    const sign = page.getByTestId('start-wizard-preset-sign');
    await expect(sign).toContainText('Letters cut into a board');
    await sign.tap();
    await expect(page.getByTestId('start-wizard-preset-text')).toBeVisible();
    await page.getByTestId('start-wizard-preset-text').fill('Tap');
    await expect(page.getByTestId('start-wizard-preset-letter-medium')).toBeVisible();
  });
});
