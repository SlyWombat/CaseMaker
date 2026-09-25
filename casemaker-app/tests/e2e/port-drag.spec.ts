import { test, expect } from './fixtures/caseMaker';

test('selecting a port via API updates viewportStore.selectedPortId', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const portId = await page.evaluate(() => window.__caseMaker!.getProject().ports[0]!.id);
  await page.evaluate((id) => window.__caseMaker!.selectPort(id), portId);
  const selected = await page.evaluate(() => window.__caseMaker!.getSelectedPortId());
  expect(selected).toBe(portId);
});

test('patchPort updates the port position and triggers a rebuild', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  // Issue #162 — this used to assert `shell.triangleCount` changed. That was
  // never a property of moving a port: translating a rectangular wall cutout
  // in Z does not alter the triangle count. It only passed because at the
  // default Z the cutout incidentally interacted with other shell geometry
  // (1236 -> 1228); once the boss seats changed shape the coincidence went
  // away and the counts matched at 1220. getGeneration() is the signal the
  // test name actually describes.
  const before = await page.evaluate(() => window.__caseMaker!.getGeneration());
  const portId = await page.evaluate(() => window.__caseMaker!.getProject().ports[0]!.id);
  await page.evaluate(async (id) => {
    await window.__caseMaker!.patchPort(id, { position: { z: 4 } });
  }, portId);
  const updated = await page.evaluate(
    (id) => window.__caseMaker!.getProject().ports.find((p) => p.id === id)?.position,
    portId,
  );
  expect(updated?.z).toBe(4);
  await page.evaluate(async () => { await window.__caseMaker!.waitForIdle(); });
  const after = await page.evaluate(() => window.__caseMaker!.getGeneration());
  expect(after).toBeGreaterThan(before);
  // and the shell still builds
  const stats = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(stats.triangleCount).toBeGreaterThan(0);
});
