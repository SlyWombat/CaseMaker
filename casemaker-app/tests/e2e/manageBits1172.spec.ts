// #1172A — Manage > Tools: the bits list, from the fake house (fixtures/fakeHouse.ts).
//
// The web e2e build has no house service, so this walk serves the four read endpoints from a
// fixture and takes the picture of the list the maintainer asked for. It also pins the two facts
// the slice changed: the header counts the five OWNED bits, and the list opens on them (the
// catalogue switch is off by default).
import { mkdirSync } from 'node:fs';
import { test, expect } from './fixtures/caseMaker';
import { installFakeHouse } from './fixtures/fakeHouse';

test('#1172A — Manage > Tools opens on your bits, counted', async ({ cm, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installFakeHouse(page);
  await cm.ready();

  await page.getByTestId('manage-open').click();
  await expect(page.getByTestId('manage-mode')).toBeVisible();
  await expect(page.getByTestId('manage-bits-counts')).toContainText('5 kinds');
  await expect(page.getByTestId('manage-bits-counts')).toContainText('8 pieces');
  await expect(page.getByTestId('manage-tools-row-inv:bits-corn-06')).toBeVisible();
  await expect(page.getByTestId('manage-tools-row-inv:bits-flat-3175-long')).toBeVisible();
  // The Have column says what the pieces are, including the lost one.
  await expect(page.getByTestId('manage-tools-have-inv:bits-flat-3175-long')).toContainText('0 · lost');
  // The catalogue is behind the switch; the switch is off.
  await expect(page.getByTestId('manage-show-catalogue')).not.toBeChecked();

  mkdirSync('/mnt/house/casemaker/qa/2026-11-10/1172', { recursive: true });
  await page.screenshot({ path: '/mnt/house/casemaker/qa/2026-11-10/1172/manage-bits.png' });
});
