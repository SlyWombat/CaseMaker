// Issue #330 — the type stack, in a real browser, against whatever origin you point it at.
//
// The bug: the three families were loaded from `fonts.googleapis.com`, and the desktop shell's CSP
// (`default-src 'self' …`, no `font-src`) refuses a remote stylesheet — so the app rendered in the
// system stack there and said nothing about it. The fix is self-hosting, and this script is the
// browser half of the evidence: `cargo test` proves the shell SERVES `/fonts/fonts.css` and the three
// woff2 files with the right types (server.rs), the unit suite proves nothing about fonts, and only a
// browser can say whether a font actually loaded and rendered.
//
// TWO TRAPS THIS SCRIPT IS BUILT AROUND.
//
//  1. `document.fonts.check()` is not a tautology. It answers "can I render this text with a loaded
//     face of this family", and a matching `@font-face` still in the `unloaded`/`loading` state makes
//     it FALSE — which is exactly the state a refused CDN stylesheet leaves behind. So it is a real
//     check and it is the headline one.
//  2. THE SHELL ANSWERS A MISSING ASSET WITH index.html AND STATUS 200 (`serve_asset`'s SPA
//     fallback). A deleted or misnamed woff2 therefore still "requests fine" — it comes back as HTML.
//     The per-request CONTENT TYPE is what separates a font from that fallback, so every font request
//     is checked for `font/woff2` and every stylesheet for `text/css`, never for status alone.
//
//   node qa-330-fonts.mjs                  # dev server / a `vite preview` of dist/, :5199
//   QA_URL=http://127.0.0.1:5399/ node qa-330-fonts.mjs   # the DESKTOP SHELL's own server (#313)
//
// Run it from Windows: `node_modules` is the Windows flavour, and so is the Playwright cache.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE_URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
/** Per origin, so a dev-server run and a desktop-shell run (#313's :5399) do not overwrite each other. */
const OUT = `./qa-330-out/${new URL(PAGE_URL).port || 'default'}`;
mkdirSync(OUT, { recursive: true });

/** The origin the page came from: fonts must come from THIS one, whatever it is. */
const ORIGIN = new URL(PAGE_URL).origin;

const FAMILIES = ['Space Grotesk', 'Inter', 'JetBrains Mono'];

/** The three files, as `public/fonts/` names them — and the only woff2 this page may fetch. */
const FILES = ['SpaceGrotesk-Variable.woff2', 'Inter-Variable.woff2', 'JetBrainsMono-Variable.woff2'];

const CDN = /fonts\.(googleapis|gstatic)\.com/;

const results = [];
let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

/**
 * A fresh browser and a fresh page, with every network event the question needs.
 *
 * Playwright's `request`/`response` listeners are used rather than CDP: nothing here turns on the
 * HTTP cache, so there is no cache layer between the two to mislead a reading (that trap is
 * `qa-313-shell-cache.mjs`'s, and it does not apply to a cold load).
 */
async function open() {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  /** Every request the page made for a font file, with the response it got. */
  const fontHits = [];
  const cssHits = [];
  const cdnHits = [];

  page.on('pageerror', (e) => errors.push({ text: String(e).split('\n')[0], url: '' }));
  page.on('console', (m) => {
    // Chromium puts the failing resource's URL in the message's LOCATION, not in its text, so the
    // text alone cannot tell the house probe's 404 (`/api/v1/health` on a dev server that serves no
    // house — the normal, expected absence) from a font that did not arrive.
    if (m.type() === 'error') errors.push({ text: m.text().slice(0, 240), url: m.location()?.url ?? '' });
  });
  page.on('request', (req) => {
    if (CDN.test(req.url())) cdnHits.push(req.url());
  });
  page.on('response', async (res) => {
    const req = res.request();
    const url = res.url();
    const type = res.headers()['content-type'] ?? '';
    if (/\.woff2?(\?|$)/.test(url) || req.resourceType() === 'font') {
      fontHits.push({ url, status: res.status(), type, sameOrigin: url.startsWith(ORIGIN) });
    }
    // Only THIS stylesheet counts as "the font stylesheet": Vite's dev server serves every other
    // source `*.css` as a JS module, and matching those by extension made this check read
    // `text/javascript` for files that have nothing to do with fonts.
    if (url.includes('/fonts/fonts.css')) {
      cssHits.push({ url, status: res.status(), type, sameOrigin: url.startsWith(ORIGIN) });
    }
  });

  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  // The app has to be UP for its fonts to matter: the status bar is the cheapest proof of that.
  await page.waitForSelector('[data-testid="status-bar"]', { timeout: 30000 });

  return { browser, page, errors, fontHits, cssHits, cdnHits };
}

const { browser, page, errors, fontHits, cssHits, cdnHits } = await open();

console.log(`== ${PAGE_URL}`);
console.log(`   origin ${ORIGIN}\n`);

// — 4/5 first, deliberately: a face is only FETCHED when something renders in it, and the welcome
// screen does not necessarily draw all three families. Asking for them explicitly is what makes the
// fetch observable and the width measurable — it does not stand in for the app using them, which is
// asserted separately against the elements the app actually draws.
//
// `document.fonts.load()` resolves with the matched faces and rejects only on a parse failure, so the
// `check()` calls after it are the same question asked twice: once as "did it load", once as "would
// this text render in it".
const fonts = await page.evaluate(async (families) => {
  const loaded = await Promise.all(
    families.map((f) => document.fonts.load(`600 40px '${f}'`, 'WmmHHO0 12345 — Case Maker')),
  );
  await document.fonts.ready;

  // The DECLARED stack is true whether or not the file loaded, so it cannot answer this alone. The
  // measured width of the same run in the family, versus a generic serif and monospace, can: identical
  // widths would mean nothing but the fallback is being drawn.
  const probe = (family) => {
    const el = document.createElement('span');
    el.style.cssText = `position:absolute;left:-9999px;white-space:nowrap;font:600 40px ${family}`;
    el.textContent = 'WmmHHO0 12345 — Case Maker';
    document.body.appendChild(el);
    const w = el.getBoundingClientRect().width;
    el.remove();
    return Math.round(w * 100) / 100;
  };

  return {
    facesLoaded: loaded.map((faces, i) => ({ family: families[i], faces: faces.length })),
    declared: [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, status: f.status })),
    // A matching face that is unloaded or still loading answers false — see the header note.
    checks: Object.fromEntries(families.map((f) => [f, document.fonts.check(`16px '${f}'`)])),
    widths: {
      ...Object.fromEntries(families.map((f) => [`'${f}'`, probe(`'${f}'`)])),
      serif: probe('serif'),
      monospace: probe('monospace'),
    },
  };
}, FAMILIES);

// — 1. the stylesheet is this origin's, and it is a stylesheet —
check('[1] the font stylesheet was fetched', cssHits.length > 0, JSON.stringify(cssHits.map((h) => new URL(h.url).pathname)));
check(
  '[1] it came from this origin, not a CDN',
  cssHits.every((h) => h.sameOrigin),
  JSON.stringify(cssHits.map((h) => h.url)),
);
check(
  '[1] and it is served as a stylesheet, not as the SPA fallback',
  cssHits.every((h) => h.status === 200 && h.type.includes('text/css')),
  JSON.stringify(cssHits.map((h) => `${h.status} ${h.type}`)),
);

// — 2. the browser did not go anywhere for a font —
check(
  '[2] nothing was requested from fonts.googleapis.com or fonts.gstatic.com',
  cdnHits.length === 0,
  JSON.stringify(cdnHits),
);

// — 3. the three files came from this origin, as fonts —
check(
  '[3] all three families were fetched',
  FILES.every((f) => fontHits.some((h) => h.url.includes(f))),
  JSON.stringify(fontHits.map((h) => new URL(h.url).pathname)),
);
check(
  '[3] every font file came from this origin',
  fontHits.length > 0 && fontHits.every((h) => h.sameOrigin),
  JSON.stringify(fontHits.map((h) => h.url)),
);
// The trap: a missing file is answered with index.html and 200 by the desktop shell's fallback. The
// type is what says "this was the font", and `font-display: swap` means a 4xx would still render.
check(
  '[3] and each came back as a font, not as the SPA fallback’s index.html',
  fontHits.length > 0 && fontHits.every((h) => h.status === 200 && /font\/woff2/.test(h.type)),
  JSON.stringify(fontHits.map((h) => `${h.status} ${h.type}`)),
);

// — 4. and the families are LOADED, not merely referenced —
check(
  `[4] a face was found and loaded for all three families (${JSON.stringify(fonts.facesLoaded)})`,
  fonts.facesLoaded.every((f) => f.faces > 0),
);
check(
  `[4] all three families pass a render check (${JSON.stringify(fonts.checks)})`,
  FAMILIES.every((f) => fonts.checks[f]),
);
check(
  '[4] the faces on the page are the three families, all loaded',
  new Set(fonts.declared.map((f) => f.family)).size === 3 &&
    FAMILIES.every((f) => fonts.declared.some((d) => d.family === f && d.status === 'loaded')),
  JSON.stringify(fonts.declared),
);

// — 5. and the text measures like those faces, not like a generic one —
check(
  '[5] text in each family measures like itself, not like a generic face',
  FAMILIES.every((f) => {
    const w = fonts.widths[`'${f}'`];
    return w !== fonts.widths.serif && w !== fonts.widths.monospace;
  }),
  JSON.stringify(fonts.widths),
);

// The app's own elements, not a probe: `getComputedStyle` answers from the cascade, so this says the
// tokens were APPLIED to something the app draws. Which elements is not guessed — the page is walked
// and the first element that resolves each family is named, because a hand-listed selector is a guess
// about markup that a later refactor quietly invalidates.
const chrome = await page.evaluate(() => {
  const first = {};
  for (const el of document.querySelectorAll('*')) {
    const family = (getComputedStyle(el).fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
    if (family && !first[family]) {
      first[family] = el.className && typeof el.className === 'string' ? el.className : el.tagName.toLowerCase();
    }
  }
  return { first, body: getComputedStyle(document.body).fontFamily };
});
check(
  '[5] the body token resolves to Inter',
  /Inter/.test(chrome.body),
  chrome.body,
);
for (const [family, why] of [
  ['Space Grotesk', 'the display face'],
  ['Inter', 'the body face'],
  ['JetBrains Mono', 'the numeric/code face'],
]) {
  check(
    `[5] ${family} is drawn by the app itself (${why})`,
    Object.prototype.hasOwnProperty.call(chrome.first, family),
    chrome.first[family] ?? `nothing on screen resolves to ${family}; drawn: ${JSON.stringify(chrome.first)}`,
  );
}

// — 6. nothing complained —
// The one failure a dev server produces on purpose: the house service probe, which no `npm run dev`
// answers (the app concludes "absent" from it and says so — #306). Anything else on the console, and
// any failed response outside `/api/v1/`, is a real failure.
const houseProbe = (e) => /\/api\/v1\//.test(e.url) && /404|Failed to load resource/.test(e.text);
const realErrors = errors.filter((e) => !/favicon/.test(e.url) && !houseProbe(e));
check('[6] no page or console errors', realErrors.length === 0, JSON.stringify(realErrors));
check(
  '[6] no font or stylesheet request failed',
  [...fontHits, ...cssHits].every((h) => h.status === 200),
  JSON.stringify([...fontHits, ...cssHits].filter((h) => h.status !== 200)),
);

await page.screenshot({ path: `${OUT}/fonts.png` });
writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify({ url: PAGE_URL, origin: ORIGIN, fontHits, cssHits, cdnHits, fonts, chrome, errors, results }, null, 2),
);

await browser.close();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshot and results.json in ${OUT}/`);
process.exit(failures === 0 ? 0 : 1);
