// Issue #163 — X-ray / Solid toggle. Asserts the toggle actually changes
// what is drawn: #162 was invisible for a whole deploy cycle because the
// viewport rendered identically with and without the geometry, so a render
// test that only checks state would not be worth much.
import { test, expect } from './fixtures/caseMaker';

test('X-ray / Solid toggle changes state, persists, and changes the render', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('esp32-devkit-v1');
    await window.__caseMaker!.waitForIdle();
  });

  // Defaults to x-ray so interior geometry is visible without opting in.
  expect(await page.evaluate(() => window.__caseMaker!.getShellRender())).toBe('xray');

  await page.getByTestId('viewport-camera-side').click();
  await page.waitForTimeout(600);
  const xrayShot = await page.locator('canvas').first().screenshot();

  await page.getByTestId('viewport-render-toggle').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__caseMaker!.getShellRender())).toBe('solid');
  const solidShot = await page.locator('canvas').first().screenshot();

  // The two modes must not render identically.
  expect(Buffer.compare(xrayShot, solidShot)).not.toBe(0);

  // Toggle back via the same button.
  await page.getByTestId('viewport-render-toggle').click();
  expect(await page.evaluate(() => window.__caseMaker!.getShellRender())).toBe('xray');

  // Choice survives a reload. Done last: reloading drops the app back to the
  // Welcome screen, which unmounts the viewport toolbar, so no clicking after.
  await page.getByTestId('viewport-render-toggle').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__caseMaker?.apiVersion === 1), undefined, {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => window.__caseMaker!.getShellRender())).toBe('solid');
});
