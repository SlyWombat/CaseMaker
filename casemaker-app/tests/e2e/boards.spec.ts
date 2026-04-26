import { test, expect } from './fixtures/caseMaker';

test('Pi 4B default load: bbox, triangle count, and scene graph', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const result = await page.evaluate(() => {
    const stats = window.__caseMaker!.getMeshStats('shell')!;
    const graph = window.__caseMaker!.getSceneGraph();
    return { stats, graph };
  });
  expect(result.stats.triangleCount).toBeGreaterThan(200);
  expect(result.stats.bbox.min[0]).toBeCloseTo(0, 4);
  expect(result.stats.bbox.min[1]).toBeCloseTo(0, 4);
  expect(result.stats.bbox.max[0]).toBeCloseTo(90, 1);
  expect(result.stats.bbox.max[1]).toBeCloseTo(61, 1);
  expect(result.stats.bbox.max[2]).toBeGreaterThanOrEqual(8);
  const ids = result.graph.map((g) => g.id).sort();
  expect(ids).toContain('shell');
  expect(ids).toContain('lid');
});
