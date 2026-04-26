import { test, expect } from './fixtures/caseMaker';
import { parseBinaryStl, downloadToBuffer } from './fixtures/parsers';

test('STL export round-trip: triangle count and bbox match in-app stats', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });

  const inAppStats = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.__caseMaker!.triggerExport('stl')),
  ]);
  const stream = await download.createReadStream();
  const buf = await downloadToBuffer(stream);
  const parsed = parseBinaryStl(buf);

  expect(parsed.triCount).toBe(inAppStats.triangleCount);
  expect(parsed.bbox.min[0]).toBeCloseTo(inAppStats.bbox.min[0], 2);
  expect(parsed.bbox.min[1]).toBeCloseTo(inAppStats.bbox.min[1], 2);
  expect(parsed.bbox.min[2]).toBeCloseTo(inAppStats.bbox.min[2], 2);
  expect(parsed.bbox.max[0]).toBeCloseTo(inAppStats.bbox.max[0], 2);
  expect(parsed.bbox.max[1]).toBeCloseTo(inAppStats.bbox.max[1], 2);
  expect(parsed.bbox.max[2]).toBeCloseTo(inAppStats.bbox.max[2], 2);
});
