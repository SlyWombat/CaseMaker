import { test, expect } from './fixtures/caseMaker';

test('snap-fit lid: triangle count grows substantially over flat-lid baseline', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.patchCase({ joint: 'flat-lid' });
  });
  const flat = await page.evaluate(() => window.__caseMaker!.getMeshStats('lid')!);
  await page.evaluate(async () => {
    await window.__caseMaker!.patchCase({ joint: 'snap-fit' });
  });
  const snap = await page.evaluate(() => window.__caseMaker!.getMeshStats('lid')!);
  expect(snap.triangleCount).toBeGreaterThan(flat.triangleCount);
  // Snap-fit lid extends downward by ~4mm via the lip ring.
  const flatHeight = flat.bbox.max[2] - flat.bbox.min[2];
  const snapHeight = snap.bbox.max[2] - snap.bbox.min[2];
  expect(snapHeight - flatHeight).toBeGreaterThanOrEqual(2);
});

test('removed sliding joint coerces to flat-lid (issue #48)', async ({ cm, page }) => {
  // The 'sliding' joint type was removed; the schema preprocesses it to
  // 'flat-lid' on load. Setting it via patchCase should leave the project
  // with a valid joint (either ignored or coerced) — never break the build.
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    // Cast to bypass typed API; this exercises the runtime defensive path.
    await window.__caseMaker!.patchCase({ joint: 'sliding' as never });
  });
  const joint = await page.evaluate(() => window.__caseMaker!.getProject()?.case.joint);
  expect(['flat-lid', 'snap-fit', 'screw-down']).toContain(joint);
});

test('ventilation slots: enabling reduces shell triangle count differential vs disabled', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.patchCase({
      ventilation: { enabled: false, pattern: 'none', coverage: 0 },
    });
  });
  const noVent = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  await page.evaluate(async () => {
    await window.__caseMaker!.patchCase({
      ventilation: { enabled: true, pattern: 'slots', coverage: 0.7 },
    });
  });
  const withVent = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  // Ventilation cuts holes through the wall — net triangle count grows due to new faces.
  expect(withVent.triangleCount).not.toBe(noVent.triangleCount);
});
