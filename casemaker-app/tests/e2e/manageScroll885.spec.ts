// #885 — MANAGE › MACHINES SCROLLS. On k3 the machine card's "Files on the card" console sits
// below Console and could not be reached at all: `.mmain` is `overflow: hidden` and the Machines
// page never wrapped its body in `.mscroll` (Tools and Accessories already did). The wrapper is
// the fix; this walk is the proof a person can get to the bottom of the card at 1280×800.
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';

// The machine card's Files console exists only where the app can open a socket to a machine, so
// this spec runs against the LAN server Playwright starts beside the web one — the same
// door `runStates.spec.ts` uses.
test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });

test('#885 — the Machines page scrolls, so the files on the card can be reached', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await cm.ready();
  // The rail belongs to the workspace: open a project so the sidebar (and its machine row) is on
  // screen, then plant a machine as a check would leave it.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.evaluate(() => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: '<Idle|MPos:-1,-1,-1|WPos:0,0,0>',
        profileId: 'Z1',
        observedAt: new Date().toISOString(),
        notes: [],
      },
      '<Idle|MPos:-1,-1,-1|WPos:0,0,0>',
    );
  });

  await page.getByTestId('machine-pin-open').click();
  await expect(page.getByTestId('manage-machine-card')).toBeVisible();

  // THE PROOF: the files console is below the fold, and the page can bring it into view. Without
  // the scroll container `scrollIntoViewIfNeeded` has nowhere to scroll and this stays out.
  const summary = page.getByTestId('manage-files-summary');
  await expect(summary).not.toBeInViewport();
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toBeInViewport();
});

test('#885 — the shelf and the accessory list can scroll too', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('machine-pin-open').click();
  // Manage's rail switches scopes; the stock shelf and the accessory list are their own pages and
  // each needs the same scroll container as the machine card.
  await page.getByTestId('manage-scope-materials').click();
  const shelf = page.getByTestId('manage-stock-table');
  if ((await shelf.count()) > 0) {
    await shelf.scrollIntoViewIfNeeded();
    await expect(shelf).toBeInViewport();
  }
  await page.getByTestId('manage-scope-accessories').click();
  const table = page.getByTestId('manage-accessories-table');
  if ((await table.count()) > 0) {
    await table.scrollIntoViewIfNeeded();
    await expect(table).toBeInViewport();
  }
});
