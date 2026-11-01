// #880 — THE GUIDE'S PICTURES LOAD IN THE SERVED APP.
//
// The bug the maintainer hit: the CNC guide hot-linked its twelve pictures to
// raw.githubusercontent.com. The app's CSP allows images from `'self'`, `data:` and `blob:` only,
// so the guide showed twelve broken pictures in the served app — and a LAN install with no
// internet could not load them anyway. The pictures now ship in the bundle (`src/docs/img/`,
// resolved by `src/docs/images.ts`); this spec opens the guide on the DESKTOP bundle served
// headless — the same page a local install gives a LAN browser — and proves every one loads.
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });

test('#880 every picture in the CNC guide loads from the bundle', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('docs-open').click();
  await page.getByTestId('docs-nav-cnc-guide').click();
  const content = page.getByTestId('docs-content-cnc-guide');
  await expect(content).toContainText('CNC');

  // Every <img> the guide renders must be finished loading before it is read.
  await page.waitForFunction(
    () => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>('[data-testid="docs-content-cnc-guide"] img'),
      );
      return imgs.length >= 12 && imgs.every((img) => img.complete);
    },
    undefined,
    { timeout: 30_000 },
  );

  const report = await content.locator('img').evaluateAll((nodes) =>
    nodes.map((node) => {
      const img = node as HTMLImageElement;
      return { src: img.currentSrc || img.src, naturalWidth: img.naturalWidth, alt: img.alt };
    }),
  );
  expect(report.length, 'the guide carries its twelve figures').toBeGreaterThanOrEqual(12);
  for (const img of report) {
    expect(img.alt, `every figure has alt text (${img.src})`).not.toBe('');
    // Served by the app itself: the dev server's origin, a bundled data: URI, or a blob.
    expect(img.src, `figure ${img.src} must be served by the app, not the network`).toMatch(
      /^(http:\/\/127\.0\.0\.1:|data:|blob:)/,
    );
    expect(img.naturalWidth, `figure ${img.src} did not load`).toBeGreaterThan(0);
  }
});
