// #1123-48 (analyst's ruling on the land18 walk, row 2b) — CONTINUE HAS CARD WEIGHT. One full-width
// card above the four cards, in their own style: the title "Continue", the line under it, and the
// primary button at its right (under the text at phone width). Only when there is work to return to.
import type { Page } from '@playwright/test';
import { test, expect, enterCnc } from './fixtures/caseMaker';

async function homeWithOpenJob(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByTestId('home').click();
  await expect(page.getByTestId('welcome-continue')).toBeVisible();
}

const box = async (page: Page, id: string) => {
  const b = await page.getByTestId(id).boundingBox();
  if (b === null) throw new Error(`${id} is not laid out`);
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width };
};

test('#1123-48 2b — Continue is a full-width card above the four cards, button at its right', async ({ cm, page }) => {
  await cm.ready();
  await homeWithOpenJob(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const card = await box(page, 'welcome-continue');
  const doors = await box(page, 'welcome-doors');
  const text = await box(page, 'welcome-continue-what');
  const button = await box(page, 'welcome-continue-open');
  await expect(page.getByTestId('welcome-continue').getByRole('heading', { name: 'Continue' })).toBeVisible();
  expect(Math.abs(card.left - doors.left), 'the card starts where the four cards start').toBeLessThanOrEqual(1);
  expect(Math.abs(card.right - doors.right), 'and ends where they end').toBeLessThanOrEqual(1);
  expect(card.bottom, 'above the four cards').toBeLessThanOrEqual(doors.top);
  expect(button.left, 'the button is to the right of the text').toBeGreaterThan(text.right);
  expect(card.right - button.right, 'at the card’s right edge').toBeLessThan(card.width / 4);
  await expect(page.getByTestId('welcome-continue-what')).toContainText(' · a CNC job · changed ');
});

test('#1123-48 2b — at phone width the button sits under the text', async ({ cm, page }) => {
  await cm.ready();
  await homeWithOpenJob(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const text = await box(page, 'welcome-continue-what');
  const button = await box(page, 'welcome-continue-open');
  expect(button.top, 'the button is under the text').toBeGreaterThanOrEqual(text.bottom);
  expect(button.right, 'on screen').toBeLessThanOrEqual(390);
});
