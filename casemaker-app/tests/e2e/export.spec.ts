import { test, expect } from './fixtures/caseMaker';
import { parseBinaryStl, downloadToBuffer } from './fixtures/parsers';

test('STL export round-trip (assembled mode): triangle count + bbox match in-app stats', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.setExportLayout('assembled'));
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });

  const inAppStats = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.__caseMaker!.triggerExport('stl-binary')),
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

  // Reset for downstream tests
  await page.evaluate(() => window.__caseMaker!.setExportLayout('print-ready'));
});

// Issue #153, step 6 — the whole point of the fit variants is printing two
// grades and keeping the one that fits, which only works if the files say which
// is which. Driven through the PANEL select, not the store, so the wiring from
// control to file name is covered end to end.
test('the export file name carries the snap fit grade (#153)', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    // The fit select only renders when a relieved snap interface is in play.
    await window.__caseMaker!.patchCase({ joint: 'snap-fit' });
  });

  // The notes sidecar is written after the mesh and also fires a download; take
  // the mesh one so a lagging sidecar cannot be mistaken for it.
  const exportOnce = async (): Promise<string> => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { predicate: (d) => d.suggestedFilename().endsWith('.stl') }),
      page.evaluate(() => window.__caseMaker!.triggerExport('stl-binary')),
    ]);
    return download.suggestedFilename();
  };

  // tight is the default and the as-designed number: it adds nothing, so a
  // project that never chose a grade keeps exactly the name it always had.
  const tight = await exportOnce();
  expect(tight).toMatch(/\.stl$/);
  expect(tight).not.toContain('-loose');

  // The context panel shows the section picked in the left rail.
  await page.getByTestId('sidebar-button-case').click();
  await expect(page.getByTestId('case-fit')).toBeVisible();
  await page.getByTestId('case-fit').selectOption('loose');

  const loose = await exportOnce();
  expect(loose).toBe(tight.replace(/\.stl$/, '-loose.stl'));
});
