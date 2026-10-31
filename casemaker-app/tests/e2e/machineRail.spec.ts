// #820 — THE LEFT RAIL'S MACHINE ROW IS AN ACTION. On k3's web build the maintainer pressed
// "Machine · No machine yet" wanting to connect the Z1 and nothing happened. It now opens
// Manage › Machines, and the web build says plainly that connecting needs the desktop app.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-machine-rail');

test('#820 — the rail machine row opens Manage › Machines, and the web build names the limit', async ({ cm, page }) => {
  await cm.ready();
  // The rail belongs to the workspace: open a project so the sidebar is on screen.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });

  const pin = page.getByTestId('machine-pin');
  await expect(pin).toBeVisible();
  // The row says what pressing it does, not only the state.
  await expect(page.getByTestId('machine-pin-status')).toContainText('No machine yet · Add');

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'machine-row.png') });

  await page.getByTestId('machine-pin-open').click();

  // Manage › Machines, on the card a person adds a machine from…
  await expect(page.getByTestId('manage-machine-none')).toBeVisible();
  // …and the web build's one sentence, in #821's words: this page has no machine relay.
  await expect(page.getByTestId('manage-machine-web-hint')).toContainText(
    'This page was served without the machine relay — open Case Maker from a Case Maker server or the desktop app to connect a machine.',
  );

  await page.screenshot({ path: path.join(OUT, 'machine-rail.png') });
});
