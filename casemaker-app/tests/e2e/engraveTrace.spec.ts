// Tracing a bitmap (#252) end to end, in a real browser.
//
// The unit specs stub the DECODER — there is no `createImageBitmap` in jsdom — so this is the only
// place the real one runs: a real bitmap file, decoded by Chromium, thresholded, traced and added
// to the job. The bitmap is built here rather than checked in, so the picture and the number
// asserted against it are visible in the same file.
//
// Assertions read the panel's own words and the traced geometry, never pixels.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load a board (which shows the sidebar) and open the Engrave panel on the deterministic job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

/** A 24-bit BMP, row-padded and bottom-up as the format requires. No dependencies, no fixtures. */
function bmp24(width: number, height: number, ink: (x: number, y: number) => boolean): Buffer {
  const stride = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const size = stride * height;
  const b = Buffer.alloc(54 + size);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(54 + size, 2); // file size
  b.writeUInt32LE(54, 10); // pixel data offset
  b.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22); // positive height = rows stored bottom-up
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(size, 34);
  b.writeInt32LE(2835, 38); // ~72 dpi, which the tracer ignores: it assumes 96 px/inch
  b.writeInt32LE(2835, 42);
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let x = 0; x < width; x++) {
      const v = ink(x, y) ? 0 : 255;
      const p = 54 + row * stride + x * 3;
      b[p] = v;
      b[p + 1] = v;
      b[p + 2] = v;
    }
  }
  return b;
}

/** A 32 px black square in a 64 px white field, whatever the file format's own dpi says. */
const SQUARE = bmp24(64, 64, (x, y) => x >= 16 && x < 48 && y >= 16 && y < 48);

test('a bitmap becomes a cut region, and the trace controls re-trace it', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);
  await page.getByTestId('engrave-add-summary').click();

  // The picker: the e2e build uses the file-input fallback, so Playwright can answer it.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-trace-image').click();
  await (await chooser).setFiles({ name: 'square.bmp', mimeType: 'image/bmp', buffer: SQUARE });

  const dialog = page.getByTestId('engrave-import-dialog');
  await expect(dialog).toBeVisible();

  // The traced size is the picture's own pixel count at the assumed 96 px/inch: 32 px is 8.47 mm.
  // (The file's 72 dpi header is a decoy — a bitmap's physical size is what the dialog says it is.)
  await expect(page.getByTestId('engrave-import-source-size')).toHaveText('8.47 × 8.47 mm');
  await expect(page.getByTestId('engrave-import-unit-warning')).toContainText('96 px/inch');

  // The preview drew real rings, not an empty path.
  const d = await page.getByTestId('engrave-import-preview').locator('path').getAttribute('d');
  expect(d).toBeTruthy();
  expect((d ?? '').length).toBeGreaterThan(20);

  // A control re-traces: no pixel is darker than 0, so there is nothing left to cut and the
  // dialog says so rather than offering an empty region.
  await page.getByTestId('engrave-trace-threshold').fill('0');
  await expect(page.getByTestId('engrave-import-empty')).toBeVisible();
  await expect(page.getByTestId('engrave-import-accept')).toBeDisabled();

  await page.getByTestId('engrave-trace-threshold').fill('128');
  await expect(page.getByTestId('engrave-import-empty')).toBeHidden();
  await expect(page.getByTestId('engrave-import-accept')).toBeEnabled();

  // Look at it once, for the record: a screenshot is the only evidence that the preview is the
  // picture rather than a blank frame.
  await page.screenshot({ path: test.info().outputPath('trace-dialog.png') });

  await page.getByTestId('engrave-import-accept').click();
  await expect(dialog).toBeHidden();

  // And it landed as an ordinary vector item, named after the file it came from.
  await expect(page.getByTestId('engrave-vector-row-0')).toBeVisible();
  await expect(page.getByTestId('engrave-vector-source-0')).toContainText('square.bmp');
});
