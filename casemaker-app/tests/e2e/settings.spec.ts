import { test, expect } from './fixtures/caseMaker';
import { lanServerPort } from '../../scripts/e2ePort';

// #372 — the "App port" field is gone from a build with no embedded server, and with it the last
// control in the app that looked like it changed a setting nothing on the Rust side ever read.
//
// WHAT A BROWSER RUN CAN PROVE HERE, AND WHAT IT CANNOT. The server controls are drawn only under
// `canRunLocalServer`, a runtime `isTauri` check (#867) — so the web build and a LAN browser on the
// desktop bundle both offer none of them, which the tests below make. Everything about
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

// #867 — THE SAME BUNDLE, SERVED TO A LAN BROWSER. This page carries the machine bridge (the
// machine-console specs run against it) and is not the Tauri window, so the window's own controls —
// the app server's port and LAN bind — must not be offered here. Its own describe, because the
// baseURL is state for the whole file.
test.describe('a LAN browser on the desktop bundle', () => {
  test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });

  test('gets the machine-carrying page but none of the window’s server controls', async ({ cm, page }) => {
    await cm.ready();
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('settings-menu')).toBeVisible();
    await expect(page.getByTestId('settings-port')).toHaveCount(0);
    await expect(page.getByTestId('settings-bind-all')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
