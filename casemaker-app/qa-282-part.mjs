// Issue #282 — the Part section, driven in a real browser.
//
// The panel's own spec proves it writes through `patchCase`. What a jsdom test cannot settle is
// whether the numbers reach the GEOMETRY — so this walks both archetypes from the front door (the
// wizard), edits the part through the new panel, and reads the compiled mesh's bounding box before
// and after. A control that changed the project but not the part would pass the unit test and fail
// here.
//
// It also exercises the field #282 called unreachable by any route at all: the blank's corner
// radius, which nothing downstream models, so the check there is the vertex count (rounded corners
// add facets) rather than the box.
//
// Run from Windows:  node qa-282-part.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = './qa-282-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const errs = [];
const shots = [];
const report = {};

const b = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

/** A fresh page per archetype: the wizard's front door only exists on an empty welcome screen. */
async function freshPage(tag, viewport = { width: 1600, height: 950 }) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`[${tag}] console: ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(600);
  return page;
}

const shot = async (page, name) => {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
};

const idle = (page) => page.evaluate(() => window.__caseMaker.waitForIdle());
const ids = (page) => page.evaluate(() => window.__caseMaker.getSceneGraph().map((n) => n.id));
const stats = (page) => page.evaluate(() => window.__caseMaker.getMeshStats('all'));

/** welcome → machine check → Next → the named job card, with the engrave flow dismissed if the
 *  card opened one (the blank card does, and the badge's twin may). */
async function wizardTo(page, templateId) {
  await page.getByTestId('welcome-start-cnc').click();
  await page.waitForSelector('[data-testid="start-wizard"]');
  await page.getByTestId('start-wizard-check').click();
  await page.waitForSelector('[data-testid="start-wizard-machine-state"]');
  await page.getByTestId('start-wizard-next').click();
  await page.waitForSelector('[data-testid="start-wizard-step-job"]');
  await page.getByTestId(`start-wizard-job-${templateId}`).click();
  await page.waitForTimeout(400);
  if ((await page.locator('[data-testid="engrave-setup-close"]').count()) > 0) {
    await page.getByTestId('engrave-setup-close').click();
    await page.waitForTimeout(200);
  }
}

// ---- the name badge -------------------------------------------------------------------------
{
  const page = await freshPage('badge');
  await shot(page, '00-welcome');
  await wizardTo(page, 'badge-blank');

  report.badgeRail = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="sidebar-button-"]')).map((el) =>
      el.getAttribute('data-testid').replace('sidebar-button-', ''),
    ),
  );
  report.badgePartHiddenBeforeClick = (await page.locator('[data-testid="part-panel"]').count()) === 0;

  await page.getByTestId('sidebar-button-part').click();
  await page.waitForSelector('[data-testid="part-panel"]');
  report.badgeSummary = await page.getByTestId('part-summary').innerText();
  report.badgeProblem = (await page.locator('[data-testid="part-problem"]').count()) > 0;
  await shot(page, '01-badge-part');

  await idle(page);
  const wide = await stats(page);
  report.badgeGraph = await ids(page);
  report.badgeRails = { before: wide };

  await page.getByTestId('badge-width').fill('60');
  await page.waitForTimeout(250);
  await idle(page);
  const narrow = await stats(page);
  report.badgeBoxBefore = wide.bbox;
  report.badgeBoxAfter = narrow.bbox;
  await shot(page, '02-badge-narrow');

  // The magnet pocket was the issue's first complaint: it had to be the template's magnet, or none.
  await page.getByTestId('badge-pocket-on').uncheck();
  await page.waitForTimeout(250);
  await idle(page);
  const noPocket = await stats(page);
  report.badgeVerticesPocket = wide.vertexCount;
  report.badgeVerticesNoPocket = noPocket.vertexCount;
  report.badgePocketNoneNote = (await page.locator('[data-testid="badge-pocket-none"]').count()) > 0;
  await shot(page, '03-badge-no-pocket');

  await page.getByTestId('badge-pocket-on').check();
  await page.getByTestId('badge-pocket-depth').fill('3.5');
  await page.waitForTimeout(250);
  await idle(page);
  report.badgeProblemAfter = await page.getByTestId('part-problem').innerText();
  report.badgeSummaryGone = (await page.locator('[data-testid="part-summary"]').count()) === 0;
  await shot(page, '04-badge-bad-pocket');
  await page.context().close();
}

// ---- the bare blank -------------------------------------------------------------------------
{
  const page = await freshPage('blank');
  await wizardTo(page, 'blank');
  await page.getByTestId('sidebar-button-part').click();
  await page.waitForSelector('[data-testid="part-panel"]');
  report.blankSummary = await page.getByTestId('part-summary').innerText();
  await shot(page, '05-blank-part');

  await idle(page);
  const square = await stats(page);
  await page.getByTestId('blank-corner-radius').fill('12');
  await page.waitForTimeout(250);
  await idle(page);
  const round = await stats(page);
  report.blankBox = square.bbox;
  report.blankVerticesSquare = square.vertexCount;
  report.blankVerticesRound = round.vertexCount;
  report.blankSummaryRound = await page.getByTestId('part-summary').innerText();
  await shot(page, '06-blank-rounded');

  await page.getByTestId('blank-corner-radius').fill('40');
  await page.waitForTimeout(250);
  await idle(page);
  report.blankProblem = await page.getByTestId('part-problem').innerText();
  await shot(page, '07-blank-bad-radius');
  await page.context().close();
}

// ---- the phone: the new panel is a panel, and #134's class of bug is a panel that clips -------
{
  const page = await freshPage('phone', { width: 390, height: 844 });
  await wizardTo(page, 'badge-blank');
  // At this width BOTH rails are drawers (the Sidebar's ≤640px rule, and #280's same idea on the
  // right). The wizard can leave the right one already open, and then it overlays the left one —
  // so close it before reaching for the rail.
  const drawerOpen = () =>
    page.evaluate(() =>
      !!document.querySelector('[data-testid="context-panel"]')?.className.includes('--open'),
    );
  // The × inside the panel, not the edge handle: the open drawer is drawn over its own handle.
  if (await drawerOpen()) {
    await page.locator('.context-panel__close').click();
    await page.waitForTimeout(300);
  }
  await page.getByTestId('sidebar-handle').click();
  await page.getByTestId('sidebar-button-part').click();
  await page.waitForSelector('[data-testid="part-panel"]');

  const over = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="part-panel"]');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const wide = Array.from(panel.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().right > rect.right + 0.5)
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}]`);
    return { scrollOver: panel.scrollWidth - panel.clientWidth, outside: wide, width: rect.width };
  });
  report.phonePanel = over;
  await shot(page, '08-phone-badge-part');

  await page.getByTestId('badge-width').fill('60');
  await page.waitForTimeout(250);
  await idle(page);
  report.phoneBox = (await stats(page)).bbox;
  await page.context().close();
}

report.errors = errs;
report.shots = shots;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await b.close();
