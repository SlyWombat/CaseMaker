// Issue #308 — Makera's catalogue, imported and served, in a real browser.
//
// The payload here is NOT hand-written. It is byte-for-byte what the real house service answered on
// this machine — 129 rows read from Studio's own `makera_library.db` — because the ignored Rust
// test writes its own answer out for this script to pick up:
//
//   cargo test --lib -- --ignored --nocapture          # in src-tauri/, prints "fixture: <path>"
//
// So the client's Zod schema, the registry and the picker are exercised against Makera's own
// numbers rather than a stand-in, which is the one thing `qa-306-house.mjs`'s hand-written cutter
// could not do. Override the path with `QA_308_FIXTURE`.
//
// What this adds over the Rust test: that the served bytes survive the CLIENT (a refused entry
// fails the whole array — `ToolLibrarySchema` is parsed as one document, so a single row its schema
// dislikes would leave the app with no catalogue at all and an `error` status), that they reach the
// picker's DOM, and that a catalogue cutter is a cutter the CAM path can actually resolve and sweep
// — a `cat:` row whose shape and `type=` text disagree with what it is would be imported and then
// refused for a reason that has nothing to do with the cutter.
//
// Two builds, one page each (decision 31: reaching the service is a runtime fact, not a build
// target — the WEB build asks its own origin exactly as the desktop build does, so the catalogue
// arrives in both when a service answers, and neither has one when it does not):
//
//   1. the web build against the service's own answer  -> present, 129 `cat:` cutters, picker lists them
//   2. the web build against a 404 text/html           -> absent, built-ins only
//
//   node qa-308-catalogue.mjs                  # dev server on :5199
//   QA_URL=... node qa-308-catalogue.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const OUT = './qa-308-out';
mkdirSync(OUT, { recursive: true });

/** Where the Rust test leaves the real service's answer (Windows `%TEMP%`). */
const FIXTURE = process.env.QA_308_FIXTURE
  ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'casemaker-308-tools.json');

const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const TOOLS = fx.tools;
const HEALTH = fx.health;
const ORIGIN_404 = /status of 404/;

const GCODE = readFileSync(new URL('./tests/e2e/fixtures/three-strokes.nc', import.meta.url), 'utf8');

const results = [];
let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

// — the fixture itself, before any browser is involved ---------------------------------------------
// Cheap checks, but they are the ones that would catch a regression in the READER that the Rust
// test's own assertions happen not to cover.
console.log(`\n== 0. the payload the real service served (${FIXTURE}) ==`);
{
  check('[0] the fixture is the real install\'s answer', fx.source.endsWith('makera_library.db'), fx.source);
  check('[0] it carries 129 cutters', TOOLS.length === 129, `${TOOLS.length}`);
  check('[0] every key is a `cat:` key', TOOLS.every((e) => e.key.startsWith('cat:')), TOOLS[0]?.key);
  check('[0] the keys are distinct', new Set(TOOLS.map((e) => e.key)).size === TOOLS.length);
  check(
    '[0] the sync\'s bookkeeping stays off the wire',
    TOOLS.every((e) => e.extras === undefined && e.contentHash === undefined),
  );
  // `unknown` would mean a category the reader has no name for; the sync reports those by name
  // instead, and none of the real 129 are one.
  check('[0] no cutter is served with an unknown shape', TOOLS.every((e) => e.tool.shape !== 'unknown'));
  check('[0] the health body says where the list came from', HEALTH.hasCatalogue === true && Boolean(HEALTH.catalogueSyncedAt), JSON.stringify(HEALTH));

  // The one cutter with an independent source — `TOOL_LIBRARY`'s flat-3.175x12-metal is verbatim
  // from Makera's own TopClamp.nc — read out of the SERVED payload rather than the database.
  const top = TOOLS.find((e) => e.tool.id === '112111313812');
  check('[0] the TopClamp cutter is served as the header describes it', Boolean(top)
    && top.tool.name === '3.175*12mm Flat End(Metal)' && top.tool.shape === 'flat'
    && top.tool.handleDiameter === 3.175 && top.tool.tipDiameter === 3.175
    && top.tool.fluteLength === 12 && top.tool.shoulderLength === 12,
    top ? `${top.tool.name} / ${top.tool.shape}` : 'absent');
}

// A flat cutter (the TopClamp clone) and a ball one, by the ids the fixture itself carries.
const FLAT = TOOLS.find((e) => e.tool.id === '112111313812');
const BALL = TOOLS.find((e) => e.tool.name === '3.175*1*3mm Ball Nose(Metal)');
check('[0] the fixture has the flat cutter to run with', Boolean(FLAT), FLAT?.key);
check('[0] the fixture has the ball cutter to be refused with', Boolean(BALL), BALL?.key);

/** One browser scenario. Returns the hook's report, the picker's options, and everything logged. */
async function scenario(name, { route, sim } = {}) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) requests.push(r.url());
  });
  if (route) await page.route('**/api/v1/**', route);

  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(
    () => window.__caseMaker?.getToolRegistry && window.__caseMaker.getToolRegistry().status !== 'checking',
    { timeout: 15000 },
  );
  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());

  // The picker every job is authored against, in the DOM.
  await page.evaluate(async () => { await window.__caseMaker.loadBuiltinBoard('rpi-4b'); });
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await page.waitForTimeout(800);
  const options = await page.$$eval('[data-testid="sim-tool"] option', (os) =>
    os.map((o) => ({ value: o.value, label: o.textContent })).filter((o) => o.value !== ''));

  const runs = [];
  for (const key of sim ?? []) {
    // Open FIRST, then choose: `openFile` replaces the tool with the one it matched in the file's
    // own TOOL record (`src/store/simSetupStore.ts`), so a selection made before it is discarded —
    // which is the panel's own flow anyway (open a program, then say which cutter wrote it).
    await page.evaluate((t) => window.__caseMaker.simOpenText('qa-308.nc', t), GCODE);
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sim-tool"]').selectOption(key);
    await page.waitForTimeout(300);
    const selected = await page.inputValue('[data-testid="sim-tool"]');
    const t0 = Date.now();
    await page.evaluate(() => window.__caseMaker.simRun());
    const state = await page.evaluate(() => window.__caseMaker.getSimState());
    const refusal = await page.locator('[data-testid="sim-refusal"]').first().innerText().catch(() => '');
    runs.push({ key, selected, seconds: Math.round((Date.now() - t0) / 1000), state, refusal: refusal.slice(0, 400) });
    await page.screenshot({ path: `${OUT}/${name}-sim-${runs.length}.png` });
  }

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  await browser.close();
  return { name, hook, options, runs, requests, errors };
}

const open = (route) => (route.request().url().endsWith('/health')
  ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) })
  : route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"fnv1a-qa-308"' },
      body: JSON.stringify(TOOLS),
    }));

// — 1 — the service's own answer. -----------------------------------------------------------------
console.log('\n== 1. the web build, the service answering with the real catalogue ==');
const present = await scenario('1-service-present', { route: open, sim: [FLAT?.key, BALL?.key] });
{
  check('[1] the app concludes the service is PRESENT', present.hook.status === 'present', present.hook.error ?? '');
  check('[1] the service\'s validator is kept', present.hook.etag === '"fnv1a-qa-308"', String(present.hook.etag));
  check(
    '[1] the whole catalogue passed the client\'s schema',
    JSON.stringify(present.hook.houseKeys) === JSON.stringify(TOOLS.map((e) => e.key)),
    `${present.hook.houseKeys.length} keys` + (present.hook.error ? ` — ${present.hook.error}` : ''),
  );
  // The tier rule from #305: the built-ins are permanent and come FIRST, so a job naming `flat-1.0`
  // still resolves with the service gone — the catalogue is appended, never a replacement.
  const builtins = present.hook.registryKeys.filter((k) => !k.startsWith('cat:'));
  check(
    '[1] the built-ins still lead the registry, then the catalogue',
    present.hook.registryKeys.length === builtins.length + TOOLS.length
      && present.hook.registryKeys.slice(0, builtins.length).every((k) => !k.startsWith('cat:'))
      && present.hook.registryKeys.slice(builtins.length).every((k) => k.startsWith('cat:')),
    `${builtins.length} built-in + ${TOOLS.length} catalogue`,
  );
  check(
    '[1] every cutter is offered in the picker',
    present.options.length === builtins.length + TOOLS.length,
    `${present.options.length} options (${builtins.length} built-in + ${TOOLS.length})`,
  );
  const opt = present.options.find((o) => o.value === FLAT.key);
  check('[1] the picker labels it with the cutter\'s own name', opt?.label === FLAT.tool.name, opt ? `"${opt.label}"` : 'absent from the picker');
  check(
    '[1] every request went to this page\'s own origin',
    present.requests.length >= 2 && present.requests.every((u) => u.startsWith(PAGE_URL.replace(/\/$/, ''))),
    present.requests.join(', '),
  );
  const unexpected = present.errors.filter((e) => !ORIGIN_404.test(e));
  check('[1] no console or page errors', unexpected.length === 0, unexpected.join(' | ') || '(none)');
}

// — the CAM path, which is what a catalogue row is FOR ---------------------------------------------
console.log('\n== 2. a catalogue cutter the CAM path can use ==');
{
  const [flat, ball] = present.runs;
  check('[2] the picker holds the chosen catalogue cutter', flat?.selected === FLAT.key, String(flat?.selected));
  // The positive half: the same 3.175 mm flat end mill as the built-in, reached through `cat:`.
  check(
    '[2] the catalogue\'s flat end mill sweeps the fixture program',
    flat?.state?.status === 'ready' && flat.state.pathVertexCount > 0 && !flat.state.errorCodes.includes('tool-refused'),
    `status ${flat?.state?.status}, ${flat?.state?.pathVertexCount} path vertices, ${flat?.seconds}s` +
      (flat?.state?.errorCodes?.length ? `, diagnostics ${flat.state.errorCodes.join(',')}` : ''),
  );
  // The negative half, which is the sharper one: a shape the sweep cannot do is refused BY NAME —
  // so the `type=` text and the shape that arrived are the catalogue's, not a default's.
  // The refusal LINE, not merely the string "Ball Nose" somewhere on the panel — the picker's own
  // label would satisfy that, and it would say nothing about what the sweep was handed. This is the
  // sweep naming the catalogue's name, its `type=` text and its shape, all three of which came out
  // of Makera's database.
  const refusalLine = (ball?.refusal ?? '').split('\n').find((l) => l.startsWith('tool-refused')) ?? '';
  check(
    '[2] the catalogue\'s ball nose is refused by name, not simulated as a flat end',
    ball?.state?.status === 'refused'
      && ball.state.errorCodes.includes('tool-refused')
      && /3\.175\*1\*3mm Ball Nose\(Metal\)" is type "Ball Nose" \(ball\)/.test(refusalLine),
    refusalLine || `status ${ball?.state?.status}, diagnostics ${JSON.stringify(ball?.state?.errorCodes)}`,
  );
}

// — 3 — nothing answering. ------------------------------------------------------------------------
console.log('\n== 3. the web build, nothing answering ==');
const absent = await scenario('3-nothing-answering', {
  route: (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' }),
});
{
  check('[3] the app concludes the service is ABSENT', absent.hook.status === 'absent', absent.hook.error ?? '');
  check('[3] the registry holds no catalogue tier', absent.hook.houseKeys.length === 0, JSON.stringify(absent.hook.houseKeys));
  check('[3] the picker is back to the built-ins alone', absent.hook.registryKeys.length === absent.options.length, `${absent.options.length} options`);
  const unexpected = absent.errors.filter((e) => !ORIGIN_404.test(e));
  check('[3] no console or page errors beyond the origin\'s own 404 line', unexpected.length === 0, unexpected.join(' | ') || '(none)');
}

writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ url: PAGE_URL, fixture: FIXTURE, source: fx.source, runs: present.runs, results }, null, 2),
);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots and results.json in ${OUT}/`);
process.exit(failures === 0 ? 0 : 1);
