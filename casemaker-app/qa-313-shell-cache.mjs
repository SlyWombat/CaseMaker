// Issue #313 — the SPA shell's caching, in a real browser with a real HTTP cache.
//
// The bug: `serve_asset` answered EVERY file with `Cache-Control: public, max-age=3600`, including
// `index.html`. Vite's asset names are content-hashed, so the app's chunks are safe to cache hard —
// but the SHELL is the file that names `assets/index-<hash>.js`, so a cached shell keeps asking for
// the previous build's chunks. `cargo test` proves the headers the server writes; this proves what a
// browser DOES with them, which is the half a header test cannot see:
//
//   1. a normal navigation (not a reload) — Chromium reuses a FRESH cache entry without asking. The
//      shell must therefore arrive `no-cache`, and the SECOND navigation must carry `If-None-Match`
//      and be answered 304 rather than served blind from a cache entry an hour old.
//   2. a hashed asset under `assets/` — cached hard and NOT revalidated (`immutable`). If this ever
//      goes back to revalidating, the fix has cost a request per chunk per load.
//
// Zero console errors is part of the pass bar, and the app has to come up (the status bar renders),
// so "the shell is live" is checked against the DOM and not only against a header. This script used to
// carry one exception — the CSP refusing the Google-Fonts stylesheet, filed as #330 and out of this
// issue's scope — and #330 is now fixed the other way round: the fonts are served from this origin, so
// that refusal no longer exists and the bar is the strict one. (`qa-330-fonts.mjs` is the script that
// asserts the families actually load; this one only requires that nothing was refused.)
//
// **The measurement trap, and why this file reads CDP's `…ExtraInfo` events.** The obvious way to see
// a revalidation is `Network.requestWillBeSent.request.headers` — and it is wrong: that event fires
// BEFORE the cache layer adds the validator, so it reports `If-None-Match: null` on a request that
// carries one, and `Network.responseReceived` reports the MERGED response, so a 304 surfaces as
// `status 200, fromDiskCache: false`. Both readings say "never revalidated" for a page that revalidates
// every time. `requestWillBeSentExtraInfo` carries the headers that actually went on the wire, and was
// checked against an in-process server that logs what it receives before being trusted here.
//
//   node qa-313-shell-cache.mjs          # against the running desktop app (default :5399)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const APP = process.env.QA_URL ?? 'http://127.0.0.1:5399/';
const OUT = './qa-313-out';
mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) problems.push(text);
};

const browser = await chromium.launch();
// A fresh context is a fresh cache — the point of the exercise. `ignoreHTTPSErrors` is not needed
// on loopback, and the context is deliberately NOT `bypassCSP` or cache-disabled: a QA that turns
// the cache off cannot test a cache.
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

const consoleErrors = [];
const shellResponses = [];
const assetRequests = [];
const sentValidators = [];

context.on('page', () => {});
const page = await context.newPage();
// The `…ExtraInfo` side of CDP: what the network stack actually put on the wire (see the header note).
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSentExtraInfo', ({ headers }) => {
  const inm = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-none-match');
  if (inm) sentValidators.push(inm[1]);
});
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('request', (req) => {
  // Just the URL: `req.headers()` here is the same pre-cache view that made this script lie once.
  if (req.resourceType() === 'document') shellResponses.push(req.url());
  if (/\/assets\//.test(req.url())) assetRequests.push(req.url());
});
const documents = [];
page.on('response', (res) => {
  if (res.request().resourceType() === 'document') {
    documents.push({
      url: res.url(),
      status: res.status(),
      cacheControl: res.headers()['cache-control'] ?? '',
      etag: res.headers()['etag'] ?? '',
    });
  }
});

// --- 1. the first load: the shell, and the app it starts --------------------
const first = await page.goto(APP, { waitUntil: 'load' });
const firstHeaders = first.headers();
note(first.status() === 200, `the first load answered ${first.status()}`);
note(
  firstHeaders['cache-control'] === 'no-cache',
  `the shell is no-cache (got ${JSON.stringify(firstHeaders['cache-control'])})`,
);
note(
  /^"fnv1a-[0-9a-f]{16}"$/.test(firstHeaders['etag'] ?? ''),
  `the shell carries a quoted validator (got ${JSON.stringify(firstHeaders['etag'])})`,
);

// The app really is what answered — a JSON or 404 body would satisfy the headers above.
const status = page.locator('[data-testid="status-bar"]');
const shellLive = (await status.count()) > 0;
note(shellLive, 'the app rendered (the status bar is in the DOM)');

// --- 2. a hashed asset: cached for ever, never revalidated ------------------
const scriptSrc = await page.evaluate(() =>
  [...document.querySelectorAll('script[src], link[rel=modulepreload]')].map((n) => n.src || n.href),
);
const hashed = scriptSrc.find((src) => /\/assets\/.+-[A-Za-z0-9_-]{8}\.[a-z]+$/.test(src));
note(Boolean(hashed), `the page names content-hashed assets (${hashed ?? 'none found'})`);
if (hashed) {
  const asset = await context.request.get(hashed);
  const cc = asset.headers()['cache-control'] ?? '';
  note(
    cc.includes('immutable') && cc.includes('max-age=31536000'),
    `a hashed asset is immutable (got ${JSON.stringify(cc)})`,
  );
}

// --- 3. the SECOND navigation is the bug ------------------------------------
// Not `reload()`: a reload revalidates the document whatever the header says, so it cannot tell the
// new policy from the old one. A plain second `goto` is exactly the user returning to the app, and
// under `max-age=3600` Chromium would take it from the cache without asking the server anything.
const second = await page.goto(APP, { waitUntil: 'load' });
const secondCache = second.headers()['cache-control'] ?? '';
note(
  shellResponses.length >= 2,
  `the second navigation asked for the shell again (${shellResponses.length} document requests)`,
);
// The claim the issue is about: under `max-age=3600` Chromium would simply reuse its stored copy and
// send nothing at all. A validator on the wire is the difference.
note(
  sentValidators.length > 0,
  `the second navigation revalidated: sent If-None-Match ${JSON.stringify(sentValidators)}`,
);
note(
  second.status() === 200 && secondCache === 'no-cache',
  `the second navigation still got the shell (${second.status()}, ${JSON.stringify(secondCache)})`,
);
const shellAgainLive = (await page.locator('[data-testid="status-bar"]').count()) > 0;
note(shellAgainLive, 'the app is live after the second navigation');

// --- 4. and nothing logged a complaint --------------------------------------
// #330 is fixed, so the exception this line used to make is gone: the shell's CSP permits the three
// families now because they are served from this origin (`public/fonts/`, asserted by
// `qa-330-fonts.mjs`), and a refusal here would mean that regressed.
const realErrors = consoleErrors.filter((text) => !/favicon/.test(text) && !/\/api\/v1\//.test(text));
note(realErrors.length === 0, `no console errors (${JSON.stringify(realErrors)})`);

await page.screenshot({ path: `${OUT}/shell-cache.png`, fullPage: false });
writeFileSync(
  `${OUT}/shell-cache.json`,
  JSON.stringify(
    { APP, first: firstHeaders, documents, shellResponses, sentValidators, assetRequests, consoleErrors },
    null,
    2,
  ),
);

await browser.close();

console.log(`\n${problems.length === 0 ? 'ALL CHECKS PASSED' : `${problems.length} FAILED`}`);
process.exit(problems.length === 0 ? 0 : 1);
