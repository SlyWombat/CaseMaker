// #1123 item 47, in a real browser — THE LEFT RAIL COLLAPSES TO ITS ICONS, the canvas takes the
// width back, and the choice survives a reload. Below 640 px the rail is the phone drawer it has
// always been: its own handle, no collapse control, the same section index underneath.
//
// The fields are the analyst's (issue #1123): the rail narrows to ~48 px and the canvas widens by
// the difference; every section opens from its icon; the active state is kept; the choice is
// remembered per browser; the phone behaviour is unchanged.
import type { Page } from '@playwright/test';
import { test, expect, enterCnc } from './fixtures/caseMaker';
import { SIDEBAR_COLLAPSED_W, SIDEBAR_LS_KEY } from '../../src/components/layout/useSidebarCollapsed';

test.setTimeout(180_000);

/** The CNC workspace with a job open: a reload restores it (item 10), so the rail is measurable
 *  after the reload too. */
async function openWorkspace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  // #1123-59 — the CASE workspace's rail is where the full section list lives; entering CNC
  // reduces it to the project's own-part editor, Job, Simulate and Export. The collapse is the
  // same control in both, so the geometry is measured here.
  await expect(page.getByTestId('sidebar-button-board')).toBeVisible();
  await page.waitForTimeout(500);
}

async function railWidth(page: Page): Promise<number> {
  const box = await page.getByTestId('sidebar').boundingBox();
  return Math.round(box!.width);
}

test('#1123-47 — collapse narrows the rail to its icons and widens the canvas by the difference', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await openWorkspace(page);
  const sidebar = page.getByTestId('sidebar');
  const pane = page.locator('.viewport-pane');
  const collapse = page.getByTestId('sidebar-collapse');

  // Expanded first: 320 px, the width the rail has always had.
  expect(await railWidth(page)).toBe(320);
  const paneBefore = (await pane.boundingBox())!.width;
  // The control leads the rail — the first button in it, so it is also first in tab order.
  const firstButton = await sidebar.evaluate(
    (el) => [...el.querySelectorAll('button')][0]?.getAttribute('data-testid') ?? null,
  );
  expect(firstButton).toBe('sidebar-collapse');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  // The machine's dot colour, carried into the collapsed pin below.
  const dotBefore = await page
    .getByTestId('machine-unknown')
    .evaluate((el) => getComputedStyle(el).backgroundColor);

  await collapse.click();
  await expect(sidebar).toHaveClass(/sidebar--icons/);
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  expect(await railWidth(page)).toBe(SIDEBAR_COLLAPSED_W);
  // The canvas takes exactly what the rail gave up.
  const paneAfter = (await pane.boundingBox())!.width;
  expect(Math.round(paneAfter - paneBefore)).toBe(320 - SIDEBAR_COLLAPSED_W);

  // Collapsed, the machine pin is its state dot alone — the same colour it carried in the row.
  const pin = page.getByTestId('machine-pin-collapsed');
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('data-state', 'unknown');
  const dotAfter = await page
    .getByTestId('machine-unknown')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dotAfter).toBe(dotBefore);

  // Every section still opens from its icon, and the open one carries its pressed state.
  // (#1123-59: opening Job switches the rail to the CNC list; the CNC entries are each still
  // reachable, and the case sections themselves are what this loop proves open from an icon.)
  const ids = (
    await page
      .locator('[data-testid^="sidebar-button-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('sidebar-button-', '')))
  );
  expect(ids.length, 'a shell project has a full case rail').toBeGreaterThan(5);
  for (const id of ids) {
    await page.getByTestId(`sidebar-button-${id}`).click();
    await expect(page.getByTestId(`context-section-${id}`)).toBeVisible();
    await expect(page.getByTestId(`sidebar-button-${id}`)).toHaveAttribute('aria-pressed', 'true');
  }
  const activeTestId = await page
    .locator('[data-testid^="sidebar-button-"][aria-pressed="true"]')
    .getAttribute('data-testid');

  // The keyboard reaches the control and expands the rail; the open section keeps its state.
  await collapse.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).not.toHaveClass(/sidebar--icons/);
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(activeTestId!)).toHaveAttribute('aria-pressed', 'true');
});

test('#1123-47 — the collapsed rail is remembered across a reload', async ({ cm, page }) => {
  await cm.ready();
  await openWorkspace(page);
  // Item 10's reload restore is the CNC workspace's: enter the job before reloading.
  await enterCnc(page);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar')).toHaveClass(/sidebar--icons/);
  expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_LS_KEY)).toBe('true');

  await page.reload({ waitUntil: 'domcontentloaded' });
  // Item 10's restore: the job comes back, and the rail comes back collapsed.
  await expect(page.getByTestId('engrave-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sidebar')).toHaveClass(/sidebar--icons/);
  expect(await railWidth(page)).toBe(SIDEBAR_COLLAPSED_W);

  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar')).not.toHaveClass(/sidebar--icons/);
  expect(await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_LS_KEY)).toBe('false');
  expect(await railWidth(page)).toBe(320);
});

test('#1123-47 — below 640 px the rail is the phone drawer, with no collapse control', async ({ cm, page }) => {
  await cm.ready();
  await openWorkspace(page);
  // Collapse at a desktop width first: the preference must not turn the phone drawer into icons.
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar')).toHaveClass(/sidebar--icons/);
  // No section is open in this case workspace: on a phone an open section auto-opens the right
  // drawer over the left handle, which is a different (pre-existing) behaviour than this one.
  await expect(page.getByTestId('context-section-board')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('sidebar-collapse')).toHaveCount(0);
  const handle = page.getByTestId('sidebar-handle');
  await expect(handle).toBeVisible();
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveClass(/sidebar--drawer/);
  await expect(sidebar).toHaveClass(/sidebar--closed/);
  await expect(sidebar).not.toHaveClass(/sidebar--icons/);

  // The drawer is its own width (min(78vw, 300) at 390 px), opened by its own handle.
  await handle.click();
  await expect(sidebar).toHaveClass(/sidebar--open/);
  expect(await railWidth(page)).toBe(300);

  // Back at a desktop width the remembered choice is still collapsed.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toHaveClass(/sidebar--icons/);
  expect(await railWidth(page)).toBe(SIDEBAR_COLLAPSED_W);
});
