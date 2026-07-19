import { test, expect } from './fixtures/caseMaker';

test('screw-down lid: triangle count grows over flat lid (lid holes), shell bosses extend full height', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    await window.__caseMaker!.patchCase({ joint: 'flat-lid' });
  });
  const flat = await page.evaluate(() => ({
    lid: window.__caseMaker!.getMeshStats('lid')!,
    shell: window.__caseMaker!.getMeshStats('shell')!,
  }));
  await page.evaluate(async () => {
    await window.__caseMaker!.patchCase({ joint: 'screw-down' });
  });
  const screw = await page.evaluate(() => ({
    lid: window.__caseMaker!.getMeshStats('lid')!,
    shell: window.__caseMaker!.getMeshStats('shell')!,
  }));
  expect(screw.lid.triangleCount).toBeGreaterThan(flat.lid.triangleCount);
  // Bosses are enabled by DEFAULT now, so the flat baseline already carries
  // them and switching joints doesn't add shell geometry (#133). The real
  // invariant: bosses themselves add shell triangles — compare against a
  // bosses-off shell.
  await page.evaluate(async () => {
    const bosses = window.__caseMaker!.getProject().case.bosses;
    await window.__caseMaker!.patchCase({ bosses: { ...bosses, enabled: false } });
  });
  const noBosses = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  expect(screw.shell.triangleCount).toBeGreaterThan(noBosses.triangleCount);
});
