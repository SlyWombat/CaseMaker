// #1276 — THE PAGE'S GENERATE WAITS FOR THE SHOP'S SETTINGS, on the real page.
//
// The settings route is held open, a sign job is taken to Generate and pressed, and the run says it is
// reading the shop's settings and starts no plan; the route is released and the run's shop signature
// shows the settings' state AND the map's ETag. The location is faked as the other wizard walks fake it.
import { test, expect, openSignCard, stockNext } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

test.setTimeout(240_000);

test('#1276 Generate pressed while the settings route is held: it says so, plans nothing, then plans on the map', async ({ cm, page }) => {
  const doc = locationDocument();
  await serveHouse(page, { location: locationView(doc), fromSharedDocument: true });
  await installFakeConsole(page, { steps: 4 });
  // Hold /defaults until the test releases it (a route registered later wins over serveHouse's).
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/defaults', async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"held-etag-1"' },
      body: JSON.stringify(doc.defaults ?? {}),
    });
  });

  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await openSignCard(page);
  await page.getByTestId('start-wizard-preset-text').fill('Hello');
  await page.getByTestId('start-wizard-operation-next').click();
  await stockNext(page, { typeSize: [100, 40, 12] });
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  const state = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __caseMaker: { getEngraveRunState(): { phase: string; progressLabel: string | null; shopSignature: string | null } } }).__caseMaker.getEngraveRunState();
      return { phase: s.phase, label: s.progressLabel, signature: s.shopSignature };
    });

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-generate-progress')).toContainText("reading the shop's settings");
  expect(await state()).toMatchObject({ phase: 'generating', label: "reading the shop's settings", signature: null });

  release();
  await expect.poll(async () => (await state()).signature, { timeout: 60_000 }).toContain('settings:present:"held-etag-1"');
  // The run left the waiting words: it is planning on the map it was given.
  expect((await state()).label).not.toBe("reading the shop's settings");
});
