// Issue #306 — the house service, in a real browser. Two builds, four origins, one page each:
//
//   1. the WEB build on the dev server, nothing stubbed: the probe asks the page's own origin, vite
//      is not the house service, and the app concludes ABSENT with the built-ins intact.
//   2. the DESKTOP build on its dev server, nothing stubbed: the SAME conclusion from the SAME
//      question — the evidence for decision 31's rule that reaching is a runtime fact and not a
//      build target (`canRunLocalServer` gates hosting, never reaching).
//   3. the DESKTOP build against a stubbed house service: one cutter of the user's own must reach
//      `getTools()` AND the tool picker's DOM — the registry is what every picker reads.
//   4. the DESKTOP build against a static host answering 404 text/html.
//
// When nothing answers the health request, the browser may log its own console line for that 404 —
// it did in one run and not in the next, so the allowance below is by text and every OTHER console
// error or page error fails the run. That line is the observed cost of the rule in 2, reported on
// #306 rather than papered over. The picker's options are dumped as well, so "the built-ins are
// still there" is checked against the DOM and not only against the hook.
//
//   node qa-306-house.mjs            # web :5199, desktop :5198
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const WEB_URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const DESKTOP_URL = process.env.QA_URL_DESKTOP ?? 'http://127.0.0.1:5198/';
const OUT = './qa-306-out';
mkdirSync(OUT, { recursive: true });

/** The browser's own log for a 404 response: the origin's line, not the app's (see the header). */
const ORIGIN_404 = /status of 404/;

// The house service's own wire shape (#306): every field explicit, because the schema the client
// validates against is the built-in list's — a missing key is a refusal, not a default (#305).
const HOUSE_TOOL = {
  key: 'user:9f2a1c4b7d',
  provenance: 'typed in by hand — QA fixture (#306)',
  tool: {
    number: null,
    id: null,
    name: 'QA 3.175 flat end',
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: null,
    tipDiameter: 3.175,
    diameter: 3.175,
    cornerRadius: 0,
    angle: null,
    halfAngle: null,
    fluteLength: null,
    shoulderLength: 12,
    stickout: null,
    centreCutting: null,
  },
};

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  catalogueSyncedAt: null,
  problems: [],
};

const results = [];
let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

/**
 * One scenario: a fresh context, its own error collectors, and (optionally) its own service. Returns
 * the hook's report, the tool picker's options, and every request the page made to `/api/v1/`.
 */
async function scenario(name, { url = WEB_URL, route, after } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) {
      requests.push({ url: r.url(), ifNoneMatch: r.headers()['if-none-match'] ?? null });
    }
  });
  if (route) await page.route('**/api/v1/**', route);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // The probe is fire-and-forget at mount: wait for it to stop saying "checking".
  await page.waitForFunction(
    () => window.__caseMaker?.getToolRegistry && window.__caseMaker.getToolRegistry().status !== 'checking',
    { timeout: 15000 },
  );
  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());

  // The DOM half: a template, the Simulate section, and the tool `<select>` every engrave/sim job
  // is authored against.
  const tpl = page.locator('[data-testid^="welcome-template-"]').first();
  if (await tpl.count()) {
    await tpl.click();
    await page.waitForTimeout(9000);
  }
  await page.locator('[data-testid="sidebar-button-cnc-sim"]').click();
  await page.waitForTimeout(1500);
  const options = await page.$$eval('[data-testid="sim-tool"] option', (os) =>
    os.map((o) => ({ value: o.value, label: o.textContent })).filter((o) => o.value !== ''),
  );
  // An optional scenario-specific interaction, run while the page is still open (scenario 3 uses it
  // to actually SELECT the house cutter, so the picker's own state is evidence and not just a list).
  const extra = after ? await after(page) : undefined;
  await page.screenshot({ path: `${OUT}/${name}.png` });

  await browser.close();
  return { name, hook, options, extra, requests, errors };
}

/** Each scenario's shared bar: the built-ins are all still offered, and no unexpected error. */
function commonChecks(s, { allowErrors = [] } = {}) {
  check(
    `[${s.name}] the picker lists the built-ins`,
    s.builtins.every((k) => s.options.some((o) => o.value === k)),
    `${s.options.length} options`,
  );
  const unexpected = s.errors.filter((e) => !allowErrors.some((a) => a.test(e)));
  check(`[${s.name}] no unexpected console or page errors`, unexpected.length === 0, unexpected.join(' | ') || '(none)');
}

// — 1 — the web build, and 2 — the desktop build: the same question, the same answer. ------------
const absentChecks = (s, label) => {
  check(`${label} the app concludes the service is ABSENT`, s.hook.status === 'absent', s.hook.error ?? '');
  check(`${label} the reason describes what answered`, /answered with/.test(s.hook.error ?? ''), s.hook.error);
  check(`${label} the probe DID ask the page's own origin`, s.requests.length >= 1, s.requests.map((r) => r.url).join(', ') || 'none');
  check(`${label} the registry holds no house tiers`, s.hook.houseKeys.length === 0, JSON.stringify(s.hook.houseKeys));
  check(`${label} the picker is back to the built-ins alone`, s.options.length === s.builtins.length, `${s.options.length} options`);
  commonChecks(s, { allowErrors: [ORIGIN_404] });
};

console.log('\n== 1. web build, dev server, nothing stubbed ==');
const web = await scenario('1-web-build');
web.builtins = web.hook.registryKeys;
{
  check('[1] the registry holds the built-ins', web.builtins.length > 0, `${web.builtins.length} keys`);
  absentChecks(web, '[1]');
}
const builtins = web.builtins;
console.log(`   built-in keys: ${builtins.join(', ')}`);
console.log(`   origin said: ${web.hook.error}`);

console.log('\n== 2. desktop build, dev server, nothing stubbed ==');
const desktop = await scenario('2-desktop-build', { url: DESKTOP_URL });
desktop.builtins = builtins;
{
  absentChecks(desktop, '[2]');
  check(
    '[2] the two builds reached the same conclusion by the same route',
    desktop.hook.status === web.hook.status && desktop.requests.length === web.requests.length,
    `${web.hook.status}/${web.requests.length} vs ${desktop.hook.status}/${desktop.requests.length}`,
  );
}

// — 3 — the desktop build against a house service. -----------------------------------------------
console.log('\n== 3. desktop build, a house service answering ==');
const present = await scenario('3-service-present', {
  url: DESKTOP_URL,
  route: (route) =>
    route.request().url().endsWith('/health')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { etag: '"fnv1a-qa-1"' },
          body: JSON.stringify([HOUSE_TOOL]),
        }),
  // Choose the house cutter in the picker and photograph the panel holding it: a list that contains
  // the option is weaker evidence than the picker's own value.
  after: async (page) => {
    await page.locator('[data-testid="sim-tool"]').selectOption(HOUSE_TOOL.key);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/3b-tool-selected.png` });
    return { selected: await page.inputValue('[data-testid="sim-tool"]') };
  },
});
{
  present.builtins = builtins;
  check('[3] the app concludes the service is PRESENT', present.hook.status === 'present', present.hook.error ?? '');
  check('[3] the service’s validator is kept', present.hook.etag === '"fnv1a-qa-1"', String(present.hook.etag));
  check(
    '[3] the house tier is the service’s list',
    JSON.stringify(present.hook.houseKeys) === JSON.stringify([HOUSE_TOOL.key]),
    JSON.stringify(present.hook.houseKeys),
  );
  check(
    '[3] the registry is the built-ins PLUS the house tier',
    present.hook.registryKeys.length === builtins.length + 1 && present.hook.registryKeys.includes(HOUSE_TOOL.key),
    `${present.hook.registryKeys.length} keys`,
  );
  const opt = present.options.find((o) => o.value === HOUSE_TOOL.key);
  check('[3] the cutter is offered in the tool picker', Boolean(opt), opt ? `label "${opt.label}"` : 'absent from the picker');
  check('[3] the picker holds the house cutter once chosen', present.extra?.selected === HOUSE_TOOL.key, String(present.extra?.selected));
  check(
    '[3] both calls went to this page’s own origin',
    present.requests.length >= 2 && present.requests.every((r) => r.url.startsWith(DESKTOP_URL.replace(/\/$/, ''))),
    present.requests.map((r) => r.url).join(', '),
  );
  check('[3] the first read sent no validator', present.requests.every((r) => r.ifNoneMatch === null));
  commonChecks(present);
}

// — 4 — the desktop build against a static host. -------------------------------------------------
console.log('\n== 4. desktop build, a static host answering 404 ==');
const staticHost = await scenario('4-static-404', {
  url: DESKTOP_URL,
  route: (route) =>
    route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' }),
});
{
  staticHost.builtins = builtins;
  check('[4] the app concludes the service is ABSENT', staticHost.hook.status === 'absent', staticHost.hook.error ?? '');
  check('[4] the reason names what answered', /text\/html/.test(staticHost.hook.error ?? ''), staticHost.hook.error);
  check('[4] the picker is back to the built-ins alone', staticHost.options.length === builtins.length, `${staticHost.options.length} options`);
  commonChecks(staticHost, { allowErrors: [ORIGIN_404] });
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ web: WEB_URL, desktop: DESKTOP_URL, builtins, results }, null, 2));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots and results.json in ${OUT}/`);
process.exit(failures === 0 ? 0 : 1);
