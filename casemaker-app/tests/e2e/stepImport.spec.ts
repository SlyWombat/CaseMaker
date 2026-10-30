// #774 — STEP import through the CAD kernel, in the real browser.
//
// The kernel is a 7.6 MB WebAssembly module behind dynamic imports: the unit spec proves the
// geometry, this proves the DOOR — that Vite serves the glue and the wasm, that picking a STEP
// tessellates it, and that the target row shows the mesh's own measured size.
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';

const STEP = path.resolve(process.cwd(), 'tests/fixtures/step/box-with-hole.step');

test('a STEP target object is tessellated by the CAD kernel at the import door', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // The panel's own reference-object door; the kernel is fetched lazily on this pick.
  await page.getByTestId('engrave-target-input').setInputFiles(STEP);
  await expect(page.getByTestId('engrave-target-name-0')).toHaveValue('box-with-hole.step', { timeout: 120_000 });

  const panel = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(panel).toContain('Imported STEP');
  // The size is the tessellated mesh's bounding box: 20 × 10 × 5 mm. Nothing but the kernel can
  // have measured it from these bytes.
  expect(panel).toContain('20×10×5 mm');
});
