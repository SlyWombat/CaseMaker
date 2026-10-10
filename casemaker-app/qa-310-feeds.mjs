// Issue #310 — Makera's feed matrix as a tier BELOW measurement, in a real browser.
//
// The payload is NOT hand-written. It is byte-for-byte what the real house service answered on this
// machine — 129 cutters and 1 328 feed rows read from Studio's own `makera_library.db` — because the
// ignored Rust test writes its own answer out for this script to pick up:
//
//   cargo test --lib -- --ignored --nocapture          # in src-tauri/, prints "fixture: <path>"
//
// The four acceptance sentences from the issue, each turned into something this script can see:
//
//   1. a wood job's panel shows the catalogue's numbers WITH THEIR SOURCE — the badge reads
//      "Makera's catalogue — not measured" and the four fields it supplies are tagged `Makera`;
//   2. the tier is keyed on the CUTTER, not the diameter: the built-in `flat-3.175x12-metal` IS the
//      vendor's `112111313812` and inherits its Hardwood row, while `flat-1.0` (no vendor id) does
//      not, with the same material chosen;
//   3. nothing above the machine's ceiling gets through — a row patched to 15 000 rpm resolves to
//      the Z1's 13 000 in the field the operator reads;
//   4. with no feed endpoint answering, the panel is exactly what it was before #310 — the badge
//      says "starting values — unmeasured" and every field is `computed`.
//
//   node qa-310-feeds.mjs                  # dev server on :5199
//   QA_URL=... node qa-310-feeds.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const OUT = './qa-310-out';
mkdirSync(OUT, { recursive: true });

/** Where the Rust test leaves the real service's answer (Windows `%TEMP%`). */
const FIXTURE = process.env.QA_310_FIXTURE
  ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'casemaker-308-tools.json');

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const TOOLS = fx.tools;
const HEALTH = fx.health;
const FEEDS = fx.feeds;
if (!Array.isArray(FEEDS)) {
  console.error(`no feed rows in ${FIXTURE} — re-run the ignored Rust test to write them`);
  process.exit(2);
}

/** The built-in whose `id` IS the vendor's, and the anon 1 mm one that has none. */
const MAKERA_KEY = 'flat-3.175x12-metal';
const VENDOR_ID = '112111313812';
const ANON_KEY = 'flat-1.0';

const results = [];
let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

const rowFor = (cutterId, material) => FEEDS.find((r) => r.cutterId === cutterId && r.material === material);

// — the fixture itself, before any browser is involved ---------------------------------------------
console.log(`\n== 0. the payload the real service served (${FIXTURE}) ==`);
const WOOD = rowFor(VENDOR_ID, 'Hardwood');
{
  check('[0] the fixture is the real install\'s answer', fx.source.endsWith('makera_library.db'), fx.source);
  check('[0] it carries 1 328 feed rows', FEEDS.length === 1328, `${FEEDS.length}`);
  check('[0] the badge job\'s material has no row at all', FEEDS.every((r) => r.material !== 'PLA'), 'PLA present');
  check('[0] the TopClamp cutter has a Hardwood row to inherit', Boolean(WOOD), JSON.stringify(WOOD));
  check('[0] every row names a served cutter', FEEDS.every((r) => TOOLS.some((e) => e.tool.id === r.cutterId)));
}

/** One browser scenario. Returns the panel's rendered state after a material + cutter are chosen. */
async function scenario(name, { route } = {}) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  if (route) await page.route('**/api/v1/**', route);

  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(
    () => window.__caseMaker?.getToolRegistry && window.__caseMaker.getToolRegistry().status !== 'checking',
    { timeout: 15000 },
  );
  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());

  await page.evaluate(async () => { await window.__caseMaker.loadBuiltinBoard('rpi-4b'); });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await page.waitForSelector('[data-testid="engrave-panel"]', { timeout: 15000 });
  await page.waitForTimeout(500);

  /** Choose a material and a cutter, then read everything the Cutting section shows. */
  async function readPanel(material, toolKey) {
    await page.locator('[data-testid="engrave-stock-material"]').selectOption(material);
    await page.locator('[data-testid="engrave-tool"]').selectOption(toolKey);
    await page.waitForTimeout(250);
    const badge = page.getByTestId('engrave-feeds-status');
    const state = {
      badge: (await badge.count()) ? await badge.innerText() : null,
      badgeSource: (await badge.count()) ? await badge.getAttribute('data-source') : null,
      badgeTitle: (await badge.count()) ? await badge.getAttribute('title') : null,
      refused: (await page.getByTestId('engrave-feeds-refused').count())
        ? await page.getByTestId('engrave-feeds-refused').innerText()
        : null,
      params: {},
      sources: {},
    };
    for (const key of ['rpm', 'feed', 'plungeFeed', 'stepDown', 'stepOver']) {
      const input = page.getByTestId(`engrave-override-${key}`);
      state.params[key] = (await input.count()) ? Number(await input.inputValue()) : null;
      const tag = page.getByTestId(`engrave-override-${key}-source`);
      state.sources[key] = (await tag.count()) ? await tag.getAttribute('data-source') : null;
    }
    return state;
  }

  const makera = await readPanel('hardwood', MAKERA_KEY);
  // The claim is about what the operator SEES, so put the Cutting section in the frame before the
  // shot rather than photographing whatever happens to be scrolled to.
  await page.getByTestId('engrave-feeds-status').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${name}-makera.png` });
  const anon = await readPanel('hardwood', ANON_KEY);
  const mdf = await readPanel('mdf', MAKERA_KEY);
  await browser.close();
  return { name, hook, makera, anon, mdf, errors };
}

const open = (feeds) => (route) => {
  const url = route.request().url();
  const body = url.endsWith('/health') ? HEALTH : url.endsWith('/feeds') ? feeds : TOOLS;
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { etag: '"fnv1a-qa-310"' },
    body: JSON.stringify(body),
  });
};

// — 1 — the service's own matrix. -----------------------------------------------------------------
console.log('\n== 1. wood, with the real matrix loaded ==');
const present = await scenario('1-catalogue', { route: open(FEEDS) });
{
  check('[1] the service is PRESENT', present.hook.status === 'present', present.hook.error ?? '');
  check('[1] the panel says the numbers are Makera\'s, not a measurement',
    present.makera.badge === "Makera's catalogue — not measured" && present.makera.badgeSource === 'catalogue',
    `${present.makera.badge} / ${present.makera.badgeSource}`);
  // The four numbers the catalogue supplies are the vendor's, and the panel knows it.
  for (const key of ['rpm', 'feed', 'plungeFeed', 'stepDown']) {
    check(`[1] ${key} is tagged Makera`, present.makera.sources[key] === 'catalogue', String(present.makera.sources[key]));
    const expected = { rpm: WOOD.rpm, feed: WOOD.feed, plungeFeed: WOOD.plungeFeed, stepDown: WOOD.stepDown }[key];
    check(`[1] ${key} is the row's own number`, present.makera.params[key] === Math.min(expected, key === 'rpm' ? 13000 : 1200),
      `${present.makera.params[key]} vs ${expected}`);
  }
  // And the two this app keeps to itself: the vendor's 63 % step-over is not ours (#191).
  check('[1] step-over stays ours', present.makera.sources.stepOver === 'computed', String(present.makera.sources.stepOver));
  check('[1] the panel explains where the numbers came from',
    /Makera's catalogue for .* in hardwood/.test(present.makera.badgeTitle ?? '')
      && /nothing here has been cut on this machine/.test(present.makera.badgeTitle ?? ''),
    present.makera.badgeTitle);
  check('[1] no console or page errors', present.errors.length === 0, present.errors.join(' | ') || '(none)');
}

// — 2 — keyed on the cutter, not the diameter ------------------------------------------------------
console.log('\n== 2. the same geometry with no vendor id ==');
{
  check('[2] the anonymous 1 mm cutter gets no catalogue row',
    present.anon.badge === 'starting values — unmeasured' && present.anon.badgeSource === 'unmeasured',
    `${present.anon.badge} / ${present.anon.badgeSource}`);
  check('[2] and none of its fields claim Makera',
    ['rpm', 'feed', 'plungeFeed', 'stepDown'].every((k) => present.anon.sources[k] === 'computed'),
    JSON.stringify(present.anon.sources));
  // MDF has no row in the matrix either — the same cutter, a material the vendor does not file it
  // under in this app, so the tier does not answer.
  check('[2] a material with no vendor row keeps the starting values',
    present.mdf.badge === 'starting values — unmeasured', String(present.mdf.badge));
}

// — 3 — the machine's ceiling holds -----------------------------------------------------------------
console.log('\n== 3. a row above the ceiling ==');
{
  // The vendor's own matrix has 15 000 rpm rows; patch this cutter's wood rows to one so the clamp
  // is exercised on the real path rather than a hand-picked number.
  const hot = FEEDS.map((r) => (r.cutterId === VENDOR_ID ? { ...r, rpm: 15000 } : r));
  const clamped = await scenario('3-clamped', { route: open(hot) });
  check('[3] the row is still Makera\'s', clamped.makera.badgeSource === 'catalogue', String(clamped.makera.badgeSource));
  check('[3] the spindle speed the panel shows is the Z1\'s ceiling, not 15 000',
    clamped.makera.params.rpm === 13000, String(clamped.makera.params.rpm));
}

// — 4 — nothing answering. ------------------------------------------------------------------------
console.log('\n== 4. the tools answer but the feed endpoint does not ==');
const absent = await scenario('4-no-feeds', {
  route: (route) => {
    const url = route.request().url();
    if (url.endsWith('/health')) return open(FEEDS)(route);
    if (url.endsWith('/feeds')) {
      return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' });
    }
    return open(FEEDS)(route);
  },
});
{
  check('[4] the cutters still arrived', absent.hook.status === 'present' && absent.hook.houseKeys.length === 129,
    `${absent.hook.houseKeys.length} cutters`);
  check('[4] the panel is exactly what it was before #310',
    absent.makera.badge === 'starting values — unmeasured' && absent.makera.badgeSource === 'unmeasured',
    `${absent.makera.badge} / ${absent.makera.badgeSource}`);
  check('[4] every field is computed',
    ['rpm', 'feed', 'plungeFeed', 'stepDown', 'stepOver'].every((k) => absent.makera.sources[k] === 'computed'),
    JSON.stringify(absent.makera.sources));
  // The starting table's hardwood 1.6–3.2 row, not Makera's: proof the tier did not silently
  // fill in from somewhere else.
  check('[4] the numbers are the starting table\'s', absent.makera.params.feed === 400, String(absent.makera.params.feed));
}

writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ url: PAGE_URL, fixture: FIXTURE, wood: WOOD, results }, null, 2),
);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots and results.json in ${OUT}/`);
process.exit(failures === 0 ? 0 : 1);
