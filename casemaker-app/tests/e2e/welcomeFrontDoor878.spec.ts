// #878 — the welcome page's front door, in a real browser.
//
// Four capability cards: Cases, Racks, Toolboxes, CNC cutting. Each opens its flow — the board
// catalog, the rack designer, the toolbox designer, the cutting wizard — and the cards lay out as
// one row on a wide desktop, two by two at tablet width, and a single column on a phone.

import { test, expect } from './fixtures/caseMaker';
import type { Page } from '@playwright/test';

test.setTimeout(120_000);

const DOORS = ['welcome-door-print', 'welcome-door-racks', 'welcome-door-toolboxes', 'welcome-door-cnc'] as const;

async function cardBoxes(page: Page): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const boxes = [];
  for (const id of DOORS) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} is laid out`).not.toBeNull();
    boxes.push(box!);
  }
  return boxes;
}

test('the four cards are there, each with a picture, a headline and one action', async ({ cm, page }) => {
  await cm.ready();
  for (const id of DOORS) {
    const card = page.getByTestId(id);
    await expect(card).toBeVisible();
    await expect(card.locator('svg[role="img"]')).toHaveCount(1);
    await expect(card.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(1);
  }
  await expect(page.getByTestId('welcome-hero')).toContainText('Design it. Print it. Cut it.');
  // The quiet row keeps the starters; the catalog is still below.
  await expect(page.getByTestId('welcome-starters')).toContainText('Name badge');
  await expect(page.getByTestId('welcome-search')).toBeVisible();
});

test('Cases leads to the board catalog with the search focused', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-case').click();
  await expect(page.getByTestId('welcome-search')).toBeFocused();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
});

test('Racks opens the rack designer', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-rack').click();
  await page.getByTestId('welcome-overlay').waitFor({ state: 'detached', timeout: 30_000 });
  await expect(page.getByTestId('rack-panel')).toBeVisible({ timeout: 30_000 });
});

test('Toolboxes opens the toolbox designer', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-toolbox').click();
  await page.getByTestId('welcome-overlay').waitFor({ state: 'detached', timeout: 30_000 });
  await expect(page.getByTestId('toolbox-panel')).toBeVisible({ timeout: 30_000 });
});

test('CNC cutting opens the wizard over the page', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
});

test('one row on a wide desktop, two by two at tablet width, a column on a phone', async ({ cm, page }) => {
  await cm.ready();

  await page.setViewportSize({ width: 1440, height: 900 });
  let boxes = await cardBoxes(page);
  const rowY = boxes[0]!.y;
  for (const b of boxes) expect(Math.abs(b.y - rowY)).toBeLessThan(2);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
  // All four above the fold, action included.
  for (const id of DOORS) await expect(page.getByTestId(id).getByRole('button')).toBeInViewport();

  await page.setViewportSize({ width: 1024, height: 768 });
  boxes = await cardBoxes(page);
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
  expect(Math.abs(boxes[2]!.y - boxes[3]!.y)).toBeLessThan(2);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
  expect(Math.abs(boxes[0]!.x - boxes[2]!.x)).toBeLessThan(2);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);

  await page.setViewportSize({ width: 400, height: 900 });
  boxes = await cardBoxes(page);
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(2);
    expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height - 1);
  }
  // Nothing wider than the phone.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(400);
});
