import { test, expect } from './fixtures/caseMaker';

test('wall thickness sensitivity: outer X and Y grow by 2*delta', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const before = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);
  await page.evaluate(async () => {
    await window.__caseMaker!.patchCase({ wallThickness: 4 });
  });
  const after = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);

  const beforeXSpan = before.max[0] - before.min[0];
  const beforeYSpan = before.max[1] - before.min[1];
  const afterXSpan = after.max[0] - after.min[0];
  const afterYSpan = after.max[1] - after.min[1];
  expect(afterXSpan - beforeXSpan).toBeCloseTo(4, 1);
  expect(afterYSpan - beforeYSpan).toBeCloseTo(4, 1);
});

test('z-clearance: outer Z grows by exactly delta', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const before = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);
  await page.evaluate(async () => {
    await window.__caseMaker!.patchCase({ zClearance: 13 });
  });
  const after = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);
  const beforeZSpan = before.max[2] - before.min[2];
  const afterZSpan = after.max[2] - after.min[2];
  expect(afterZSpan - beforeZSpan).toBeCloseTo(8, 1);
});
