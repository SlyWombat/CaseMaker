import { test, expect } from './fixtures/caseMaker';

test('USB-C cutout reduces shell triangle count consistency: enabling vs disabling all ports changes the mesh', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const withCutouts = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);

  await page.evaluate(async () => {
    const project = window.__caseMaker!.getProject();
    const next = JSON.parse(JSON.stringify(project));
    for (const p of next.ports) p.enabled = false;
    await window.__caseMaker!.setProject(next);
  });
  const noCutouts = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);

  // With cutouts removed, shell should be a strictly simpler mesh (fewer triangles).
  expect(noCutouts.triangleCount).toBeLessThan(withCutouts.triangleCount);
});

test('disabling cutouts does not change outer bbox', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const before = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);
  await page.evaluate(async () => {
    const project = window.__caseMaker!.getProject();
    const next = JSON.parse(JSON.stringify(project));
    for (const p of next.ports) p.enabled = false;
    await window.__caseMaker!.setProject(next);
  });
  const after = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);
  expect(after.min[0]).toBeCloseTo(before.min[0], 1);
  expect(after.min[1]).toBeCloseTo(before.min[1], 1);
  expect(after.max[0]).toBeCloseTo(before.max[0], 1);
  expect(after.max[1]).toBeCloseTo(before.max[1], 1);
});
