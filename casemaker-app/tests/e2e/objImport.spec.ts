// #825 — OBJ import through the browser door, like the STEP e2e beside it.
//
// The unit specs prove the parser (quads, n-gons, units, malformed sentences) and both doors; this
// proves the DOOR in the real app: picking an OBJ fills the target row with the mesh's own measured
// size, and the panel STATES the unit reading an OBJ has no way to declare for itself.
import path from 'node:path';
import { test, expect, enterCnc } from './fixtures/caseMaker';

const OBJ = path.resolve(process.cwd(), 'tests/fixtures/obj/box.obj');

test('an OBJ target object is read at the import door, with its unit stated', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  await page.getByTestId('engrave-target-input').setInputFiles(OBJ);
  await expect(page.getByTestId('engrave-target-name-0')).toHaveValue('box.obj', { timeout: 60_000 });

  const panel = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(panel).toContain('Imported OBJ');
  // The size is the OBJ's own bounding box: 40 × 30 × 6 mm.
  expect(panel).toContain('40×30×6 mm');
  // And the reading is stated: an OBJ has no unit of its own.
  expect(panel).toContain('read as millimetres');
});
