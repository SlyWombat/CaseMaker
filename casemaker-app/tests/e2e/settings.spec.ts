import { test, expect } from './fixtures/caseMaker';

// #372 — the "App port" field is gone from a build with no embedded server, and with it the last
// control in the app that looked like it changed a setting nothing on the Rust side ever read.
//
// WHAT A BROWSER RUN CAN PROVE HERE, AND WHAT IT CANNOT. The server controls are drawn only under
// `canRunLocalServer`, a build-time constant, and Playwright runs the web build — so the honest
// assertion is that this build offers none of them, which the two tests below make. Everything about
// what the controls DO is behind that same seam and is pinned in
// `tests/unit/serverSettings.spec.tsx`, where the capability can be turned on and the service faked.
// The old spec drove the field through `window.__caseMaker.setPortSetting` and asserted the store,
// which is why the defect survived three tests: it never rendered the control it was testing.

test('the settings dialog opens, and shows what a web build can actually set', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-menu')).toBeVisible();
  await expect(page.getByTestId('settings-export-format')).toBeVisible();
  await expect(page.getByTestId('settings-export-layout')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a build with no embedded server offers no server settings', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-menu')).toBeVisible();
  // The field that could not reach `config.json`, and its LAN checkbox beside it (#372).
  await expect(page.getByTestId('settings-port')).toHaveCount(0);
  await expect(page.getByTestId('settings-bind-all')).toHaveCount(0);
  // And nothing that depends on a server answering: no notice about a pending restart, no error from
  // a read this build has no service for.
  await expect(page.getByTestId('settings-port-pending')).toHaveCount(0);
  await expect(page.getByTestId('settings-server-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
});
