// Issue #134 — mobile audit against the CURRENT tree (not the deployed build).
// iPhone-13-class emulation (390x844), real Chromium, screenshots + geometry.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-134-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://localhost:5199/';
const W = Number(process.env.QA_W ?? 390);
const H = Number(process.env.QA_H ?? 844);
const TAG = process.env.QA_TAG ?? 'phone';

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  isMobile: W < 900,
  hasTouch: W < 900,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);

const box = async (sel) => {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  }, sel);
  return r;
};

const common = async () => page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  docScrollW: document.documentElement.scrollWidth,
  docScrollH: document.documentElement.scrollHeight,
  bodyScrollW: document.body.scrollWidth,
}));

// ---------- 1. Welcome screen ----------
await page.screenshot({ path: `${OUT}/${TAG}-01-welcome.png` });
await page.evaluate(() => window.scrollTo(0, 0));
const welcome = {
  doc: await common(),
  header: await box('.app-header'),
  headerScroll: await page.evaluate(() => {
    const h = document.querySelector('.app-header');
    const t = document.querySelector('.toolbar-buttons');
    return h && t ? { headerClientW: h.clientWidth, headerScrollW: h.scrollWidth, toolbarW: t.getBoundingClientRect().width } : null;
  }),
  grid: await page.evaluate(() => {
    const g = document.querySelector('.wb-grid');
    return g ? getComputedStyle(g).gridTemplateColumns : null;
  }),
  gridBox: await box('.wb-grid'),
  toolbarBox: await box('.wb-toolbar'),
  chipsBox: await box('.wb-chips'),
  searchBox: await box('.wb-search'),
  mfrBox: await box('.wb-mfr'),
  headerPBox: await box('.wb-header p'),
  railBox: await box('.wb-rail'),
  detailBox: await box('.wb-detail'),
};
console.log('WELCOME', JSON.stringify(welcome, null, 1));

// What is cut off in the header: enumerate toolbar buttons that are outside the visible header.
const headerCut = await page.evaluate(() => {
  const h = document.querySelector('.app-header');
  if (!h) return [];
  const hr = h.getBoundingClientRect();
  return [...h.querySelectorAll('button, select')].map((el) => {
    const r = el.getBoundingClientRect();
    return { label: (el.textContent || el.getAttribute('aria-label') || el.title || '?').trim().slice(0, 18), x: +r.x.toFixed(0), right: +r.right.toFixed(0), visible: r.right <= hr.right + 0.5 };
  });
});
console.log('HEADER CONTROLS', JSON.stringify(headerCut, null, 1));

// ---------- 2. Workspace ----------
// Other sessions edit this tree concurrently, so a Vite HMR reload can drop
// us back to the welcome screen mid-audit. Retry the entry until the
// workspace actually sticks, then measure fast.
async function enterWorkspace() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tpl = page.locator('[data-testid^="welcome-template-"]').first();
    const card = page.locator('[data-testid^="welcome-board-"]').first();
    if (await tpl.count()) {
      await tpl.click();
    } else if (await card.count()) {
      await card.dblclick();
    } else {
      return 'FAILED';
    }
    try {
      await page.waitForSelector('[data-testid="sidebar"]', { timeout: 25000 });
      await page.waitForTimeout(1200);
      if ((await page.locator('.welcome-overlay').count()) === 0) return `attempt ${attempt}`;
    } catch {
      /* fall through to a retry */
    }
    await page.waitForTimeout(1000);
  }
  return 'FAILED';
}
const entered = await enterWorkspace();
console.log('ENTERED', entered);
await page.screenshot({ path: `${OUT}/${TAG}-02-workspace.png` });

const workspace = {
  doc: await common(),
  header: await box('.app-header'),
  main: await box('.app-main'),
  sidebar: await box('.sidebar'),
  viewportPane: await box('.viewport-pane'),
  contextPanel: await box('[data-testid="context-panel"]'),
  contextHandle: await box('[data-testid="context-panel-handle"]'),
  statusBar: await box('.status-bar'),
  welcomeGone: (await page.locator('.welcome-overlay').count()) === 0,
};
console.log('WORKSPACE', JSON.stringify(workspace, null, 1));

// Open the section drawer, pick a section -> sidebar closes AND the right
// context drawer auto-opens; measure the viewport afterwards.
const sidebarHandle = page.locator('[data-testid="sidebar-handle"]');
if (await sidebarHandle.count()) {
  await sidebarHandle.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${TAG}-03-sidebar-open.png` });
  console.log('SIDEBAR OPEN', JSON.stringify({
    sidebar: await box('.sidebar'),
    viewportPane: await box('.viewport-pane'),
  }, null, 1));

  const firstSection = page.locator('[data-testid^="sidebar-button-"]').first();
  if (await firstSection.count()) {
    await firstSection.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${TAG}-04-section-drawer.png` });
    console.log('SECTION OPEN', JSON.stringify({
      sidebar: await box('.sidebar'),
      contextPanel: await box('[data-testid="context-panel"]'),
      viewportPane: await box('.viewport-pane'),
    }, null, 1));
  }
}

console.log('ERRORS', JSON.stringify(errs, null, 1));
await b.close();
