import { test, expect } from './fixtures/caseMaker';
import { downloadToBuffer } from './fixtures/parsers';
import { unzipSync } from 'fflate';

test('3MF export round-trip: zip contains 3D/3dmodel.model XML with vertices and triangles', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const inAppStats = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.__caseMaker!.triggerExport('3mf')),
  ]);
  const stream = await download.createReadStream();
  const buf = await downloadToBuffer(stream);
  const zip = unzipSync(new Uint8Array(buf));
  expect(Object.keys(zip)).toContain('3D/3dmodel.model');
  const modelXml = new TextDecoder().decode(zip['3D/3dmodel.model']!);
  expect(modelXml).toContain('unit="millimeter"');
  const vertCount = (modelXml.match(/<vertex /g) ?? []).length;
  const triCount = (modelXml.match(/<triangle /g) ?? []).length;
  // The XML aggregates across all build objects (shell + lid). Total tri count must equal in-app.
  expect(triCount).toBe(inAppStats.triangleCount);
  expect(vertCount).toBeGreaterThanOrEqual(inAppStats.vertexCount); // 3MF doesn't dedupe vertices across objects
});
