// #313's browser gate, for real: load the built app, change the shell, rebuild, reload — the NEW
// shell must arrive on the FIRST load. The catch is that this only proves anything if the second
// run reuses the first run's cache, so both phases share one persistent profile directory.
//
//   node qa-313-rebuild.mjs before     # load, record {status, etag, marker}
//   ...edit dist/index.html, rebuild, restart the app...
//   node qa-313-rebuild.mjs after      # load again: must be the NEW shell, on the first load
//
// The marker is a `<meta name="qa-build">` in the shell's <head> — React does not touch it, so
// finding it in the DOM is evidence the browser executed the new HTML and not a cached old one.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP = process.env.QA_URL ?? 'http://127.0.0.1:5399/';
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) {
  console.error('usage: node qa-313-rebuild.mjs before|after');
  process.exit(2);
}
const OUT = resolve('./qa-313-out');
mkdirSync(OUT, { recursive: true });
const PROFILE = resolve(OUT, 'profile'); // shared on purpose: the "after" run must see "before"'s cache
const record = resolve(OUT, `${phase}.json`);

const context = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1200, height: 800 } });
const page = await context.newPage();
const conditional = [];
context.on('page', () => {});
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSentExtraInfo', ({ headers }) => {
  const inm = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-none-match');
  if (inm) conditional.push(inm[1]);
});

const res = await page.goto(APP, { waitUntil: 'load' });
await page.waitForTimeout(600);
const observed = {
  status: res.status(),
  etag: res.headers()['etag'] ?? null,
  cacheControl: res.headers()['cache-control'] ?? null,
  marker: await page.evaluate(() => document.querySelector('meta[name=qa-build]')?.content ?? null),
  rendered: (await page.locator('[data-testid="status-bar"]').count()) > 0,
  conditionalValidators: conditional.length,
};
writeFileSync(record, JSON.stringify({ APP, phase, ...observed }, null, 2));

console.log(`${phase}: ${JSON.stringify(observed)}`);
if (phase === 'before') {
  console.log('now: add <meta name="qa-build" content="rebuild-A"> to dist/index.html, restart the app');
} else {
  const before = JSON.parse(readFileSync(resolve(OUT, 'before.json'), 'utf8'));
  const ok = [
    [observed.rendered, 'the app rendered on the first load'],
    [observed.status === 200, `the first load answered ${observed.status}`],
    [observed.etag !== before.etag, `the shell changed: ${before.etag} -> ${observed.etag}`],
    [observed.marker === 'rebuild-A', `the NEW shell reached the DOM: marker=${JSON.stringify(observed.marker)}`],
    [observed.conditionalValidators > 0, 'the browser sent its stored validator for the old shell'],
  ];
  for (const [pass, text] of ok) console.log(`${pass ? 'PASS' : 'FAIL'}  ${text}`);
  await context.close();
  process.exit(ok.every(([p]) => p) ? 0 : 1);
}
await context.close();
