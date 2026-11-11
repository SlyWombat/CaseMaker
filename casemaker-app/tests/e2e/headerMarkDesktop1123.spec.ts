// #1123-48 regression (found walking the cut cards, 2026-11-11): the phone Home bar's brand MARK
// (815ac4d4d) was hidden by `.app-header__mark { display: none }`, but `.app-header__logo img`
// (display: block, more specific) won, so at every width the header drew the wordmark AND a second
// mark beside it. The mark belongs to the phone Home bar alone.
import { test, expect } from './fixtures/caseMaker';

test('#1123-48 — on a desktop the header draws one brand: the mark is hidden, on Home and in the workspace', async ({
  cm,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await cm.ready();
  const shown = () =>
    page.evaluate(() => {
      const el = document.querySelector('.app-header__mark') as HTMLElement | null;
      return el === null ? null : { display: getComputedStyle(el).display, width: el.getBoundingClientRect().width };
    });
  expect(await shown(), 'Home').toEqual({ display: 'none', width: 0 });
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await expect(page.getByTestId('sidebar-button-board')).toBeVisible();
  expect(await shown(), 'the workspace').toEqual({ display: 'none', width: 0 });
});
