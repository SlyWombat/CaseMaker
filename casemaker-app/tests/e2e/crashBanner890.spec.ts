// #890 — THE CRASH BANNER IS NOT A WORKSPACE PANEL, AND IT GOES WHEN ITS JOB IS DONE.
//
// On k3 the banner rendered as the first child of `.app-main`, the three-column workspace grid:
// it took the first cell, so the sidebar landed in the canvas's column and the 3D view in the
// context rail. It is a row of the SHELL now (between the header and the workspace), and it leaves
// after its report is sent or saved, and when a new job starts.
//
// The proof is geometric: the three panels' boxes are measured with the banner on screen and again
// after it is dismissed, and they must be identical — a banner that pushes anything shows up here
// even if every testid is still present.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** The recorder's marker key: a leftover marker means the previous session died uncleanly. */
const MARKER_KEY = 'casemaker.flight.session.v1';
const MARKER = {
  id: 's-crashed',
  startedAt: new Date(2026, 9, 30, 16, 50).getTime(),
  appVersion: '1.0.0',
  commit: 'abc1234',
  work: 'generate',
  stage: 'rough',
  label: 'roughing level 41 of 112',
};

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

/**
 * Leave a crashed session's marker where the recorder reads it, before any app code runs.
 *
 * #1122 item 4 — a marker counts as THIS installation's last run only when it names the build that
 * wrote it (`appVersion` + `commit`). The fixture cannot know the build's identity before the app
 * has run, so the first load is asked: the recorder writes its own session marker at startup, and
 * that marker's identity is copied into the crash fixture. The reseed goes through an init script,
 * because the dying page's unload removes the marker on the way out — writing it now would be
 * erased by the very reload that should read it.
 */
async function seedCrash(page: Page, cm: { ready: () => Promise<void> }): Promise<void> {
  await cm.ready();
  await page.waitForFunction((key) => window.localStorage.getItem(key) !== null, MARKER_KEY, {
    timeout: 15_000,
  });
  const own = JSON.parse(
    (await page.evaluate((key) => window.localStorage.getItem(key), MARKER_KEY))!,
  ) as { appVersion?: string; commit?: string | null };
  if (typeof own.appVersion !== 'string') throw new Error('the recorder wrote no build identity');
  await page.addInitScript(
    ([key, marker]) => {
      window.localStorage.setItem(key!, marker!);
    },
    [MARKER_KEY, JSON.stringify({ ...MARKER, appVersion: own.appVersion, commit: own.commit ?? null })],
  );
}

async function openWorkspace(page: Page, cm: { ready: () => Promise<void> }): Promise<void> {
  await cm.ready();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('context-panel')).toBeVisible();
}

interface Boxes {
  sidebar: { x: number; y: number; width: number; height: number };
  viewport: { x: number; y: number; width: number; height: number };
  context: { x: number; y: number; width: number; height: number };
}

const round = (b: { x: number; y: number; width: number; height: number }): Boxes['sidebar'] => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.round(b.width),
  height: Math.round(b.height),
});

/** The part of each panel's box the bug moved: its column (x and width), not its row. */
function columns(b: Boxes): Record<'sidebar' | 'viewport' | 'context', { x: number; width: number }> {
  return {
    sidebar: { x: b.sidebar.x, width: b.sidebar.width },
    viewport: { x: b.viewport.x, width: b.viewport.width },
    context: { x: b.context.x, width: b.context.width },
  };
}

async function boxes(page: Page): Promise<Boxes> {
  const [sidebar, viewport, context] = await Promise.all([
    page.getByTestId('sidebar').boundingBox(),
    page.locator('.viewport-pane').boundingBox(),
    page.getByTestId('context-panel').boundingBox(),
  ]);
  if (sidebar === null || viewport === null || context === null) throw new Error('a panel has no box');
  return { sidebar: round(sidebar), viewport: round(viewport), context: round(context) };
}

test('#890 — the banner sits above the workspace, and the three panels keep their columns', async ({ cm, page }) => {
  await seedCrash(page, cm);
  await openWorkspace(page, cm);

  const banner = page.getByTestId('crash-banner');
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const shown = await boxes(page);
  if (bannerBox === null) throw new Error('the banner has no box');

  // The panels are one row, left to right, in the columns the shell defines: rail 320, canvas,
  // the operator's context rail (360 by default). The banner is above all three and spans the page.
  expect(shown.sidebar.x).toBe(0);
  expect(shown.sidebar.width).toBe(320);
  expect(shown.viewport.x).toBeGreaterThanOrEqual(320);
  expect(shown.context.x).toBeGreaterThanOrEqual(shown.viewport.x + shown.viewport.width);
  expect(shown.sidebar.y).toBe(shown.viewport.y);
  expect(shown.viewport.y).toBe(shown.context.y);
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(shown.sidebar.y);

  // THE PROOF, and it is about COLUMNS: with the banner gone each panel is exactly where it was
  // left to right (same x, same width). Its y and height do change — the banner's own shell row
  // gives the workspace its height back — and that is the fix working, not a defect: the whole
  // point is that the banner owns a row of its own instead of a cell of the workspace grid.
  await page.getByTestId('crash-dismiss').click();
  await expect(banner).toHaveCount(0);
  const hidden = await boxes(page);
  expect(columns(hidden)).toEqual(columns(shown));
  // The workspace is the same width and only GAINS height back when the banner's row collapses.
  expect(hidden.viewport.height).toBeGreaterThanOrEqual(shown.viewport.height);
});

test('#890 — a new job dismisses the previous session’s crash prompt', async ({ cm, page }) => {
  await seedCrash(page, cm);
  await cm.ready();
  await expect(page.getByTestId('crash-banner')).toBeVisible();

  // The toolbar's New belongs to a PRINT project (a CNC section, #686, hides it): open a board so
  // the button is the one a person returning to the picker would press.
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  // #1123 item 48 — NEW IS THE APP'S OWN DIALOG, NOT A window.confirm. The walk used to accept a
  // browser dialog the app no longer opens; the press now opens `new-project-confirm`, and its Yes
  // is what runs doNew() (and with it the session's crash-prompt dismissal).
  await page.getByTestId('new-project').click();
  await page.getByTestId('new-project-confirm-yes').click();

  await expect(page.getByTestId('crash-banner')).toHaveCount(0);
});

test('#890 — a sent report shows its confirmation, then the banner goes', async ({ cm, page }) => {
  // The house service, faked: the probe answers, so the Send half exists, and the report posts.
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/crash-reports**', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ path: 'crash-reports/crash-2-0.json' }) }),
  );
  await page.route('**/api/v1/tools**', (route) => route.fulfill({ status: 404, body: '' }));
  await seedCrash(page, cm);
  await cm.ready();

  const banner = page.getByTestId('crash-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('crash-send')).toBeVisible();
  await page.getByTestId('crash-send').click();
  await expect(page.getByTestId('crash-sent')).toContainText('crash-reports/crash-2-0.json');
  // The confirmation is shown, then the banner puts itself away.
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
});
