import { test, expect } from './fixtures/caseMaker';

// Phase 8a regression: HAT stacking lifts the case top and adds wall cutouts.
test('adding CQRobot DMX shield to GIGA grows shell Z and increases triangle count', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('arduino-giga-r1-wifi');
  });
  const before = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  const placementId = await page.evaluate(async () => {
    return await window.__caseMaker!.addHat('cqrobot-dmx-shield-max485');
  });
  expect(placementId).toMatch(/^hat-/);
  const after = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(after.bbox.max[2]).toBeGreaterThan(before.bbox.max[2]);
  expect(after.triangleCount).toBeGreaterThan(before.triangleCount);
});

test('disabling a stacked HAT collapses zClearance back to baseline', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('arduino-giga-r1-wifi');
  });
  const baseline = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  const placementId = await page.evaluate(
    async () => await window.__caseMaker!.addHat('cqrobot-dmx-shield-max485'),
  );
  const enabledStats = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(enabledStats.bbox.max[2]).toBeGreaterThan(baseline.bbox.max[2]);
  await page.evaluate(
    async (id) => await window.__caseMaker!.patchHat(id, { enabled: false }),
    placementId,
  );
  const disabledStats = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(disabledStats.bbox.max[2]).toBeCloseTo(baseline.bbox.max[2], 1);
});

test('removeHat brings the project back to no-hats', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('arduino-giga-r1-wifi');
  });
  const placementId = await page.evaluate(
    async () => await window.__caseMaker!.addHat('cqrobot-dmx-shield-max485'),
  );
  expect(await page.evaluate(() => window.__caseMaker!.getHats().length)).toBe(1);
  await page.evaluate(async (id) => await window.__caseMaker!.removeHat(id), placementId);
  expect(await page.evaluate(() => window.__caseMaker!.getHats().length)).toBe(0);
});
