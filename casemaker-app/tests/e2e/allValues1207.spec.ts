// #1207 — Manage › Advanced › All values: the four accepted states, drawn and measured.
//
// The page is a view of the registry, so the states are about the SHOP'S RECORD, not about a
// hand-built row: a shop with a record (house `/defaults` served), a save the service accepts, a
// save it refuses in its own words, and a shop with no record at all (read-only, recommendations
// shown). The phone state draws the row opening in place instead of a detail pane.
//
// The pictures go beside the other visual QA (`/mnt/house/casemaker/qa/`); the assertions here are
// the layout and state facts, so a picture changing without a test failing is visible in review.
import { mkdirSync } from 'node:fs';
import { test, expect } from './fixtures/caseMaker';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';
import { openManage } from './fixtures/manageLayout';

const QA = '/mnt/house/casemaker/qa/2026-11-12/1207';

async function openAllValues(page: import('@playwright/test').Page): Promise<void> {
  await openManage(page);
  await page.getByTestId('manage-scope-advanced').click();
  await expect(page.getByTestId('manage-all-values')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test.describe('#1207 All values', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('empty search is a stated state, not a blank list', async ({ cm, page }) => {
    const doc = locationDocument();
    await serveHouse(page, { location: locationView(doc), defaults: doc.defaults, writes: 'applied' });
    await cm.ready();
    await openAllValues(page);

    await expect(page.getByTestId('all-values-row-plan.shortlistSize')).toBeVisible();
    await page.getByTestId('all-values-search').fill('no such value zzz');
    await expect(page.getByTestId('all-values-empty')).toContainText('No values match');
    await expect(page.getByTestId('all-values-row-plan.shortlistSize')).toHaveCount(0);

    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}/empty-search.png` });
  });

  test('a value just saved: the record takes it and says so', async ({ cm, page }) => {
    const doc = locationDocument();
    await serveHouse(page, { location: locationView(doc), defaults: doc.defaults, writes: 'applied' });
    await cm.ready();
    await openAllValues(page);

    await page.getByTestId('all-values-row-plan.shortlistSize').click();
    await page.getByTestId('all-values-input').fill('10');
    await page.getByTestId('all-values-save').click();
    await expect(page.getByTestId('all-values-saved')).toContainText('Saved');
    // The re-read is the record's: the row now differs from its recommendation and says changed.
    await expect(page.getByTestId('all-values-row-plan.shortlistSize')).toContainText('10');
    await expect(
      page.getByTestId('all-values-row-plan.shortlistSize').locator('[data-kind="changed"]'),
    ).toHaveCount(1);

    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}/just-saved.png` });
  });

  test('a save the house service refuses: its sentence, and nothing applied', async ({ cm, page }) => {
    const doc = locationDocument();
    await serveHouse(page, { location: locationView(doc), defaults: doc.defaults, writes: 'applied' });
    // The service's own refusal, as the Rust route answers one: 400 and the sentence under `error`.
    // Reads fall through to the house fixture; only the write is refused.
    await page.route('**/api/v1/defaults/*', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'the shop’s record refused 10: outside the bounds it may set' }),
      });
    });
    await cm.ready();
    await openAllValues(page);
    // The record is loaded: the fixture's six measured values are marked, and none is editable out
    // of its range.
    await expect(page.getByTestId('all-values-chip-measured')).toContainText('Measured 6');

    await page.getByTestId('all-values-row-plan.shortlistSize').click();
    await page.getByTestId('all-values-input').fill('10');
    await page.getByTestId('all-values-save').click();
    await expect(page.getByTestId('all-values-refusal')).toContainText('refused 10');
    await expect(page.getByTestId('all-values-saved')).toHaveCount(0);

    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}/house-refused.png` });
  });

  test('a shop with no record is read-only: the recommendations show', async ({ cm, page }) => {
    await serveHouse(page, {});
    await cm.ready();
    await openAllValues(page);

    await expect(page.getByTestId('all-values-readonly')).toContainText('recommendations');
    await page.getByTestId('all-values-row-plan.shortlistSize').click();
    await expect(page.getByTestId('all-values-save')).toBeDisabled();
    await expect(page.getByTestId('all-values-reset')).toBeDisabled();

    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}/read-only.png` });
  });

  test('on a phone the row opens in place', async ({ cm, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const doc = locationDocument();
    await serveHouse(page, { location: locationView(doc), defaults: doc.defaults, writes: 'applied' });
    await cm.ready();
    await openAllValues(page);

    await page.getByTestId('all-values-row-plan.shortlistSize').click();
    const detail = page.getByTestId('all-values-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('This value decides');
    // In place: the detail is inside the list, directly after the chosen row.
    await expect(page.locator('.manage .allvalues-list [data-testid="all-values-detail"]')).toHaveCount(1);
    // The row keeps the recommendation beside the value at phone width.
    await expect(page.getByTestId('all-values-row-plan.shortlistSize')).toContainText('rec.');

    mkdirSync(QA, { recursive: true });
    await page.screenshot({ path: `${QA}/phone-in-place.png` });
  });
});
