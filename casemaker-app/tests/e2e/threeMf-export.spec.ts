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

/**
 * Issue #168 — the whole point of the exported 3MF for a two-colour badge is
 * that the slicer reads it as ONE object whose two parts are already on their
 * own tools. That spans the compiler, the geometry worker, the job store, the
 * export layout and the writer, so it is checked here through the real app
 * rather than only at the writer's unit boundary.
 */
test('#168 — the badge exports as one object with a part per extruder', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-template-badge-blank').click();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.__caseMaker!.triggerExport('3mf')),
  ]);
  const buf = await downloadToBuffer(await download.createReadStream());
  const zip = unzipSync(new Uint8Array(buf));

  const model = new TextDecoder().decode(zip['3D/3dmodel.model']!);
  expect(model.match(/<object /g)?.length, 'one object, not two').toBe(1);
  expect(model).toContain('slic3rpe:Version3mf');

  const config = new TextDecoder().decode(zip['Metadata/Slic3r_PE_model.config']!);
  expect(config.match(/<volume /g)?.length, 'one volume per colour').toBe(2);
  expect(config).toContain('key="name" value="badge-bottom"');
  expect(config).toContain('key="name" value="badge-top"');
  expect(config).toContain('<metadata type="volume" key="extruder" value="2"/>');
  expect(config).toContain('<metadata type="volume" key="extruder" value="3"/>');
  // The ranges must tile the mesh with no gap and no overlap — this is the
  // number that would silently mis-slice the boundary between the colours.
  const ranges = [...config.matchAll(/<volume firstid="(\d+)" lastid="(\d+)">/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as const,
  );
  expect(ranges.length).toBe(2);
  const [[bottomFirst, bottomLast], [topFirst, topLast]] = ranges as [
    readonly [number, number],
    readonly [number, number],
  ];
  const facets = (model.match(/<triangle /g) ?? []).length;
  expect(bottomFirst).toBe(0);
  expect(topFirst).toBe(bottomLast + 1);
  expect(topLast).toBe(facets - 1);
});
