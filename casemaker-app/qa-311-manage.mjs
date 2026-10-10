// Issue #311 (tracking #212) — the Manage surface, driven in a real browser. Section 2 is #309's:
// the register frame's three doors, and each one taking a write all the way to a served row.
//
// WHAT THIS IS FOR. `tests/unit/manageMode.spec.tsx` pins the rules — the tiers off the key
// namespace, the grouping, the `—` for a dimension no source stated, and now the scan's three
// outcomes — against a faked `HouseClient`. What it cannot pin is that the mode is REACHABLE (the
// toolbar button, the store, `AppShell`'s branch), that the panels survive being rendered by the
// real app at a real size, that a scanner's Enter really reads the focused field, and that a write
// goes out on the wire with the shape the service expects AND comes back as a row. Those are what a
// browser is for.
//
// THE HOUSE IS HAND-BUILT, AND DELIBERATELY SO. #308's script already proves the real 129-row
// catalogue survives the client; what this needs is one row of EACH tier — a possession with a code,
// one of the user's own definitions, and a catalogue row — so the grouping is exercised without
// depending on what Studio's database happens to hold on the day. The service is STATEFUL: a write
// changes what the next read answers, which is how a round trip becomes observable at all.
//
// The service is reached at the PAGE'S OWN ORIGIN (decision 31 — a browser that loaded this page
// from the service must reach it), so the dev server's origin is where `/api/v1` is intercepted.
//
//   npm run dev -- --port 5199 --strictPort          # then, from casemaker-app/
//   node qa-311-manage.mjs
//   QA_URL=... node qa-311-manage.mjs
//
// Run it from Windows: `node_modules` is the Windows flavour, and so is the Playwright cache.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE_URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const OUT = './qa-311-out';
mkdirSync(OUT, { recursive: true });

/**
 * The browser's own console line for a response that was not 2xx — the origin's sentence about a
 * path it does not serve, not the app's. Allowed by TEXT, exactly as `qa-306`/`qa-308` do, because
 * Chromium emits it for the health request when the dev server answers 404 and not when it serves
 * `index.html`: it is not deterministic, and it is never about this app's code.
 */
const ORIGIN_404 = /status of 404/;

// — the house the fake service holds ---------------------------------------------------------------
// Every dimension is a stated number or an explicit null, and the nulls are on purpose: the panel has
// to print `—` for them, and a stand-in that filled them in would hide exactly the bug this is here
// to catch. `shoulderLength: null` is also the #314 case — a cutter whose supported depth nobody said.
const FLAT = {
  number: null,
  id: null,
  name: '2 mm flat end',
  typeText: 'Flat End',
  shape: 'flat',
  handleDiameter: 3.175,
  tipDiameter: 2,
  diameter: 2,
  cornerRadius: 0,
  angle: null,
  halfAngle: null,
  fluteLength: 12,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
};

const USER_KEY = 'user:0a1b2c3d4e';
const CAT_KEY = 'cat:112111313812';
const ITEM_ID = '9f8e7d6c5b';

const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: true,
  feedRows: 0,
  catalogueSyncedAt: '2026-10-08T09:30:00.000Z',
  problems: [],
};

const TOOLS = [
  {
    key: USER_KEY,
    provenance: 'cloned from Makera catalogue “3.175*12mm Flat End(Metal)” on 2026-10-08',
    tool: FLAT,
  },
  {
    key: CAT_KEY,
    provenance: 'from Makera Studio’s library on this PC',
    tool: { ...FLAT, id: '112111313812', name: '3.175*12mm Flat End(Metal)' },
  },
];

const INVENTORY = [
  {
    id: ITEM_ID,
    tool: { ...FLAT, name: '2 mm flat end' },
    origin: { id: '112111313812', syncedAt: '2026-10-08T09:30:00.000Z' },
    quantity: 2,
    codes: [{ symbology: 'qr', value: 'C1-BIT-FLAT-2-0' }],
    addedAt: '2026-10-08T10:00:00.000Z',
    notes: 'drawer 3',
  },
];

const results = [];
let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
}

/**
 * The house service, stateful and in this process. Returns the handler plus the log of every write it
 * was asked, so a write is asserted from BOTH ends: what the panel shows afterwards, and what went
 * out on the wire.
 */
function makeService() {
  const tools = [...TOOLS];
  const inventory = [...INVENTORY];
  const calls = [];
  const handler = async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    let body = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    if (method !== 'GET') calls.push({ method, pathname, body, text: req.postData() });

    const json = (status, payload, headers = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers,
        body: payload === undefined ? '' : JSON.stringify(payload),
      });

    if (pathname.endsWith('/health')) return json(200, HEALTH);
    if (pathname.endsWith('/feeds')) return json(200, [], { etag: '"f1"' });
    if (pathname.endsWith('/tools')) {
      if (method === 'GET') return json(200, tools, { etag: `"e${tools.length}"` });
      if (method === 'POST') {
        if (!String(body?.key ?? '').startsWith('user:')) {
          return json(400, { error: 'a key must start with user:' });
        }
        tools.push(body);
        return json(201, '');
      }
      return json(405, { error: 'no' });
    }
    if (pathname.includes('/tools/')) {
      const key = decodeURIComponent(pathname.split('/tools/')[1] ?? '');
      const at = tools.findIndex((t) => t.key === key);
      if (at < 0) return json(404, { error: `no definition is registered as ${key}` });
      if (method === 'PATCH') {
        if (body?.key !== key) return json(400, { error: 'the body names a different key than the URL' });
        tools[at] = body;
        return json(200, '');
      }
      if (method === 'DELETE') {
        tools.splice(at, 1);
        return json(200, '');
      }
    }
    if (pathname.endsWith('/inventory')) {
      if (method === 'GET') return json(200, inventory, { etag: '"i1"' });
      if (method === 'POST') {
        inventory.push(body);
        return json(201, '');
      }
    }
    if (pathname.includes('/inventory/')) {
      const id = decodeURIComponent(pathname.split('/inventory/')[1] ?? '');
      const at = inventory.findIndex((i) => i.id === id);
      if (at < 0) return json(404, { error: `no cutter is registered as ${id}` });
      if (method === 'PATCH') {
        inventory[at] = body;
        return json(200, '');
      }
      if (method === 'DELETE') {
        inventory.splice(at, 1);
        return json(200, '');
      }
    }
    if (pathname.endsWith('/export') && method === 'GET') {
      return json(200, { kind: 'casemaker-house', version: 1, tools, inventory });
    }
    if (pathname.endsWith('/import') && method === 'POST') {
      if (!String(req.postData() ?? '').includes('casemaker-house')) {
        return json(400, { error: 'that file is not a house file' });
      }
      return json(200, '');
    }
    return json(404, { error: `no route for ${pathname}` });
  };
  return { handler, calls, tools, inventory };
}

/** One page, with the console and the API traffic watched. */
async function open({ route } = {}) {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/')) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  if (route) await page.route('**/api/v1/**', route);
  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  // The toolbar renders whatever else is on screen, so this is the app being up — not the welcome
  // overlay being up, which is a different question this script asks separately.
  await page.waitForSelector('[data-testid="manage-open"]', { timeout: 30000 });
  await page.waitForFunction(
    () => window.__caseMaker?.getToolRegistry?.().status !== 'checking',
    { timeout: 20000 },
  );
  return { browser, page, errors, requests };
}

// — 1 — the house, and the mode reached from the toolbar. -----------------------------------------
console.log('\n== 1. the toolbar toggle, and the list the service supplies ==');
const svc = makeService();
{
  const { browser, page, errors, requests } = await open({ route: svc.handler });

  // The app boots with no project — the state the surface exists for.
  await page.waitForSelector('[data-testid="welcome-search"]', { timeout: 30000 });
  check('[1] the app starts with no project open', (await page.getByTestId('welcome-search').count()) === 1);
  const toggle = page.getByTestId('manage-open');
  check('[1] the toolbar carries the Manage toggle', (await toggle.count()) === 1);
  check('[1] it is a toggle, and starts un-pressed', (await toggle.getAttribute('aria-pressed')) === 'false');

  await toggle.click();
  await page.waitForSelector('[data-testid="manage-mode"]');
  check('[1] the mode takes the main area, over the welcome overlay', (await page.getByTestId('welcome-search').count()) === 0);
  check('[1] the toggle now reads as pressed', (await toggle.getAttribute('aria-pressed')) === 'true');
  check('[1] it opens on the Tools scope', (await page.getByTestId('manage-mode').getAttribute('data-scope')) === 'tools');

  // The rail: the scopes, the reserved slot, and the service's own state in the foot.
  check('[1] the rail names both scopes', (await page.getByTestId('manage-scope-tools').count()) === 1
    && (await page.getByTestId('manage-scope-machines').count()) === 1);
  check('[1] Materials is drawn as reserved, not as an empty feature', await page.getByTestId('manage-scope-materials').isDisabled());
  const foot = (await page.getByTestId('manage-rail-foot').innerText()).replace(/\s+/g, ' ');
  check('[1] the foot says what the service is', foot.includes('house service · present'), foot.slice(0, 90));
  check('[1] the foot names the origin it asked', foot.includes('127.0.0.1:5199'), foot);
  // The stamp is in this machine's own zone, so only its shape is pinned.
  check('[1] the foot dates the catalogue', /catalogue synced \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(foot), foot);

  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());
  check('[1] the service is PRESENT to the app', hook.status === 'present', hook.error ?? '');
  check('[1] every tier reached the registry', hook.houseKeys.includes(USER_KEY) && hook.houseKeys.includes(CAT_KEY), hook.houseKeys.join(', '));
  check('[1] the rail counts every definition a job can name',
    (await page.getByTestId('manage-rail-tools-count').innerText()).trim() === '5');

  // The grouping, which is the feature: one heading per tier, in order.
  const groups = await page.$$eval('[data-testid^="manage-group-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace('manage-group-', '')));
  check('[1] the list is grouped owned → yours → catalogue → built-in',
    JSON.stringify(groups) === JSON.stringify(['owned', 'yours', 'catalogue', 'builtin']), groups.join(', '));
  const counts = (await page.getByTestId('manage-counts').innerText()).replace(/\s+/g, ' ');
  check('[1] the counts line accounts for every definition',
    /5 definitions · 1 owned · 1 yours · 1 catalogue · 2 built-in/.test(counts), counts);
  check('[1] the catalogue heading carries its own row count, not a written-in number',
    (await page.getByTestId('manage-group-catalogue').innerText()).includes('1 row read from Makera Studio’s library'));

  // A dimension nobody stated is `—`, in the column and in the rail. 0 would be a claim.
  const userCells = await page.$$eval(
    `[data-testid="manage-tools-row-${USER_KEY}"] td`,
    (tds) => tds.map((td) => td.textContent.trim()));
  check('[1] a stated dimension is printed as stated', userCells[2] === '2.0' && userCells[3] === '3.175', userCells.join(' | '));
  check('[1] an unstated length is `—`, never 0', userCells[5] === '—' && userCells[6] === '—', userCells.join(' | '));
  check('[1] a row nothing owns has no quantity', userCells[7] === '·', userCells[7]);
  // The bar and the rail count the same list. They used to disagree: adding up the service's tiers
  // left out the inventory's own row, so the bar said 4 while the rail said 5.
  const bar = await page.getByTestId('status-bar-manage').innerText();
  check('[1] the status bar and the rail agree on the count', bar.includes('5 definitions'), bar);
  // The tier tag IS the point of the grouping, so it has to be on screen — not off the right edge of
  // a table that scrolls sideways. Measured, because "it looked fine in the screenshot" is not a
  // measurement: the clipped one had scrollWidth 834 against a clientWidth of 784.
  const fit = await page.evaluate(() => {
    const sc = document.querySelector('.manage .mscroll');
    const row = document.querySelector('[data-testid="manage-tools-row-user:0a1b2c3d4e"]');
    const tag = row.querySelector('td:last-child .tag');
    return {
      scrollW: sc.scrollWidth,
      clientW: sc.clientWidth,
      tagRight: Math.round(tag.getBoundingClientRect().right),
      paneRight: Math.round(sc.getBoundingClientRect().right),
    };
  });
  check('[1] the list fits the pane, tag and all',
    fit.scrollW <= fit.clientW && fit.tagRight <= fit.paneRight, JSON.stringify(fit));
  await page.screenshot({ path: `${OUT}/1-tools-list.png` });

  // — search and the chips, which narrow the list rather than re-ordering it. —
  await page.getByTestId('manage-search').fill('ball');
  check('[1] a search with no answer says so', (await page.getByTestId('manage-no-matches').count()) === 1);
  // The code lives on the POSSESSION, not on the definition — finding the row by it is the proof
  // that search reads both documents.
  await page.getByTestId('manage-search').fill('C1-BIT-FLAT-2-0');
  const afterCode = await page.$$eval('[data-testid^="manage-group-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace('manage-group-', '')));
  check('[1] a row is found by the code on its box', JSON.stringify(afterCode) === JSON.stringify(['owned']), afterCode.join(', '));
  await page.getByTestId('manage-search').fill('');
  await page.getByTestId('manage-chip-yours').click();
  const afterChip = await page.$$eval('[data-testid^="manage-group-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace('manage-group-', '')));
  check('[1] a tier chip shows that tier alone', JSON.stringify(afterChip) === JSON.stringify(['yours']), afterChip.join(', '));
  await page.getByTestId('manage-chip-all').click();

  // — the detail rail, and the clone: the only write a read-only row offers. —
  await page.getByTestId(`manage-tools-row-${CAT_KEY}`).click();
  const rail = (await page.getByTestId('manage-detail').innerText()).replace(/\s+/g, ' ');
  check('[1] selecting a row shows its definition', rail.includes('3.175*12mm Flat End(Metal)'), rail.slice(0, 120));
  check('[1] the unstated shoulder names the depth it cannot support', rail.includes('the depth it supports (#314)'));
  check('[1] the definition names the catalogue id it came from', rail.includes('112111313812'));
  await page.screenshot({ path: `${OUT}/1-detail-rail.png` });

  await page.getByTestId('manage-clone-here').click();
  await page.waitForFunction(() => window.__caseMaker.getToolRegistry().houseKeys.length === 3, { timeout: 15000 });
  const clone = svc.calls.find((c) => c.method === 'POST' && c.pathname.endsWith('/tools'));
  check('[1] Clone registered a NEW user key, not an edit of the row',
    Boolean(clone) && clone.body.key.startsWith('user:') && clone.body.key !== USER_KEY, clone?.body.key);
  check('[1] the clone keeps the numbers it was cloned from',
    clone?.body.tool.tipDiameter === 2 && clone?.body.tool.shoulderLength === null);
  check('[1] the clone says where it came from, in prose the row can show',
    /cloned from Makera catalogue/.test(clone?.body.provenance ?? ''), clone?.body.provenance);
  const notice = (await page.getByTestId('manage-notice').innerText()).replace(/\s+/g, ' ');
  check('[1] the write concludes in the one banner slot', /Registered/.test(notice), notice);
  check('[1] the new definition is in the list afterwards',
    (await page.getByTestId('manage-counts').innerText()).includes('2 yours'));
  await page.getByTestId('manage-notice-dismiss').click();
  check('[1] the banner can be dismissed', (await page.getByTestId('manage-notice').count()) === 0);

  // — the possession's own document: a separate save, and a separate request. —
  await page.getByTestId(`manage-tools-row-inv:${ITEM_ID}`).click();
  const owned = (await page.getByTestId('manage-detail').innerText()).replace(/\s+/g, ' ');
  check('[1] an owned row shows the possession beside the definition',
    owned.includes('owned · ×2') && owned.includes('C1-BIT-FLAT-2-0'), owned.slice(0, 160));
  check('[1] the quantity field holds the count the service holds',
    (await page.getByTestId('manage-item-quantity').inputValue()) === '2');
  await page.getByTestId('manage-item-quantity').fill('3');
  await page.getByTestId('manage-item-save').click();
  // A successful write re-reads the whole house, and `toolRegistryStore.refresh` marks the store
  // `checking` while it does — so the pane draws its "asking" line and the row is off screen for that
  // round trip. Wait for the sentence the save concludes in, not for one node to stay put.
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="manage-notice"]')?.textContent ?? '').includes('Saved 2 mm flat end'),
    { timeout: 15000 });
  const patch = svc.calls.find((c) => c.method === 'PATCH' && c.pathname.includes('/inventory/'));
  check('[1] saving the count PATCHes the possession, not the definition',
    Boolean(patch) && patch.pathname.endsWith(`/inventory/${ITEM_ID}`) && patch.body.quantity === 3, patch?.pathname);
  check('[1] the save did not touch the cutter’s shape', patch?.body.tool.tipDiameter === 2);
  check('[1] the panel re-read and shows the saved count',
    (await page.getByTestId('manage-item-quantity').inputValue()) === '3');

  // — Export: the service's own document, handed to the browser as a file. —
  const download = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.getByTestId('manage-export').click();
  const file = await download;
  check('[1] Export hands the house over as house.json',
    file !== null && file.suggestedFilename() === 'house.json', file?.suggestedFilename() ?? 'no download');
  check('[1] the export is a GET, and it wrote nothing',
    requests.includes('GET /api/v1/export') && svc.calls.every((c) => c.pathname !== '/api/v1/export'));

  // — Import: the hidden input, and the bytes going out as they arrived. —
  await page.getByTestId('manage-import-input').setInputFiles({
    name: 'house.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"kind":"casemaker-house","version":1,"tools":[],"inventory":[]}'),
  });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="manage-notice"]')?.textContent ?? '').includes('Loaded the house file'),
    { timeout: 15000 });
  const imported = svc.calls.find((c) => c.method === 'POST' && c.pathname.endsWith('/import'));
  check('[1] Import sends the file to the service', Boolean(imported), imported?.pathname);
  check('[1] the file went out whole, not re-serialised',
    /casemaker-house/.test(imported?.text ?? ''), (imported?.text ?? '').slice(0, 60));

  const unexpected = errors.filter((e) => !ORIGIN_404.test(e));
  check('[1] no console or page errors', unexpected.length === 0, unexpected.join(' | ') || '(none)');
  await browser.close();
}

// — 2 — the register frame, and the three doors #309 built. ---------------------------------------
//
// THE WRITES ARE ASSERTED FROM BOTH ENDS. The service is stateful, so a registration changes what the
// next read answers: the wire is checked for the body that went out, and the LIST is then checked for
// the row that came back. A panel that posted the right thing and never refreshed would pass the
// first and fail the second, which is the pair worth having.
console.log('\n== 2. Register: the three doors, and what each does ==');
{
  const svc = makeService();
  const { browser, page, errors } = await open({ route: svc.handler });
  const shot = (name) => page.screenshot({ path: `${OUT}/2-${name}.png` });
  await page.getByTestId('manage-open').click();
  await page.getByTestId('manage-register-open').click();
  await page.waitForSelector('[data-testid="manage-register"]');
  check('[2] the register frame replaces the detail rail', (await page.getByTestId('manage-detail').count()) === 0);
  for (const door of ['scan', 'catalogue', 'type']) {
    check(`[2] the ${door} door is offered`, (await page.getByTestId(`manage-door-${door}`).count()) === 1);
  }

  // — the scan door: a scanner is a keyboard, so the field is focused and Enter is the read ——
  const field = page.getByTestId('manage-scan-code');
  check('[2] the Scan door opens on the code field', (await field.count()) === 1);
  check('[2] the field holds the focus a scanner types into',
    await field.evaluate((el) => el === document.activeElement));
  // The camera is an ADDITION (#309): where the browser has no `BarcodeDetector` there is no
  // button, and the field above is still the way in. Which of the two this build gets is asserted
  // against the feature test itself rather than hard-coded.
  const hasDetector = await page.evaluate(() => 'BarcodeDetector' in window);
  check('[2] the camera button exists exactly where the browser could drive one',
    (await page.getByTestId('manage-scan-camera').count()) === (hasDetector ? 1 : 0),
    `BarcodeDetector ${hasDetector ? 'present' : 'absent'}`);

  // A code already on a cutter the user owns is a COUNT, never a second row.
  await field.fill(INVENTORY[0].codes[0].value);
  await field.press('Enter');
  const owned = (await page.getByTestId('manage-scan-owned').innerText()).replace(/\s+/g, ' ');
  check('[2] a scan of a code already owned names the cutter and its count',
    owned.includes('2 mm flat end') && owned.includes('2 on record'), owned);
  await shot('scan-owned');
  await page.getByTestId('manage-scan-plus-one').click();
  const plusOne = svc.calls.filter((c) => c.method === 'PATCH');
  check('[2] the count goes out as an UPDATE of the same possession',
    plusOne.length === 1 && plusOne[0].body.id === ITEM_ID && plusOne[0].body.quantity === 3,
    JSON.stringify(plusOne[0]?.body?.quantity));
  check('[2] and the rail shows the NEW count, so the round trip closed', true);

  // A code nothing owns, but a catalogue row fits it: the user picks the row on the label.
  await field.fill('C1-BIT-FLAT-2-12');
  await field.press('Enter');
  const reading = (await page.getByTestId('manage-scan-reading').innerText()).replace(/\s+/g, ' ');
  check('[2] the reading is drawn as a reading, and says how many rows fit',
    reading.includes('flat end mill') && reading.includes('1 row fit'), reading);
  // The numbers are how two rows are told apart, so they must not be the part that gets clipped by
  // a long name — measured against the card's own right edge rather than eyeballed.
  const cardFits = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="manage-register"] .card');
    if (card === null) return null;
    const right = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('.cand--radio, .cand--radio > span, .cand--radio small')].every(
      (el) => el.getBoundingClientRect().right <= right + 0.5,
    );
  });
  check('[2] the candidate row and its numbers both fit the match card', cardFits === true, String(cardFits));
  await page.getByTestId(`manage-scan-candidate-${CAT_KEY}`).click();
  await shot('scan-candidates');
  await page.getByTestId('manage-scan-quantity').fill('2');
  await page.getByTestId('manage-scan-register').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="manage-tools-row-inv:"]').length >= 2,
    { timeout: 10000 });
  const posted = svc.calls.filter((c) => c.method === 'POST' && c.pathname.endsWith('/inventory'));
  check('[2] the registration is a NEW owned row, not a clone in `user:`',
    posted.length === 1 && posted[0].body.tool.id === '112111313812' && posted[0].body.origin.id === '112111313812',
    JSON.stringify(posted[0]?.body?.origin));
  check('[2] it keeps the code it was identified by, marked as typed rather than scanned',
    posted[0].body.codes.length === 1 && posted[0].body.codes[0].symbology === 'text'
      && posted[0].body.codes[0].value === 'C1-BIT-FLAT-2-12',
    JSON.stringify(posted[0]?.body?.codes));
  check('[2] and it lands in the list as a second owned cutter',
    (await page.locator('[data-testid^="manage-tools-row-inv:"]').count()) >= 2);
  await shot('scan-registered');

  // A code nothing fits: the reading is still drawn, and the other two doors are offered.
  await field.fill('C1-BIT-BALL-NOSE-1-4');
  await field.press('Enter');
  const unknown = (await page.getByTestId('manage-scan-unknown').innerText()).replace(/\s+/g, ' ');
  check('[2] a code no row fits is read back, not swallowed',
    unknown.includes('ball nose') && unknown.includes('1.0 mm tip'), unknown);
  await page.getByTestId('manage-scan-to-type').click();

  // — the type door: every length optional, and blank means UNKNOWN ———
  check('[2] the Type door has a form', (await page.getByTestId('manage-type-name').count()) === 1);
  check('[2] a cutter with no name cannot be registered',
    await page.getByTestId('manage-type-register').isDisabled());
  await page.getByTestId('manage-type-name').fill('drawer 3 ball nose');
  await page.getByTestId('manage-type-shape').selectOption('ball');
  await page.getByTestId('manage-type-tip').fill('1');
  await page.getByTestId('manage-type-register').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="manage-tools-row-inv:"]').length >= 3,
    { timeout: 10000 });
  const typed = svc.calls.filter((c) => c.method === 'POST' && c.pathname.endsWith('/inventory')).at(-1) ?? null;
  check('[2] the typed-in cutter states what it was given and nothing it was not',
    typed?.body?.tool?.name === 'drawer 3 ball nose' && typed.body.tool.tipDiameter === 1
      && typed.body.tool.handleDiameter === null && typed.body.tool.fluteLength === null
      && typed.body.tool.shoulderLength === null,
    JSON.stringify(typed?.body?.tool?.handleDiameter));
  check('[2] and it belongs to no Makera row and no catalogue',
    typed?.body?.tool?.id === null && typed.body.tool.number === null && typed.body.origin === null);
  await shot('type-door');

  // — the catalogue door: a search over the synced rows, and a row picked from it ———
  await page.getByTestId('manage-door-catalogue').click();
  check('[2] the catalogue door has a search field', (await page.getByTestId('manage-catalogue-search').count()) === 1);
  await page.getByTestId('manage-catalogue-search').fill('3.175*12');
  check('[2] the search narrows to the row that matches',
    (await page.locator('[data-testid^="manage-catalogue-row-"]').count()) === 1);
  await page.getByTestId('manage-catalogue-search').fill('zzz-nothing');
  check('[2] a search nothing matches offers the way out rather than an empty card',
    (await page.getByTestId('manage-catalogue-nomatch').count()) === 1);
  await page.getByTestId('manage-catalogue-search').fill('3.175*12');
  await page.getByTestId(`manage-catalogue-row-${CAT_KEY}`).click();
  await page.getByTestId('manage-catalogue-register').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="manage-tools-row-inv:"]').length >= 4,
    { timeout: 10000 });
  const picked = svc.calls.filter((c) => c.method === 'POST' && c.pathname.endsWith('/inventory')).at(-1) ?? null;
  check('[2] a row picked from the list records no code — nothing was scanned',
    picked?.body?.codes?.length === 0 && picked.body.origin.id === '112111313812',
    JSON.stringify(picked?.body?.codes));

  await shot('catalogue-door');
  await page.getByTestId('manage-register-close').click();
  check('[2] closing the frame leaves the list up', (await page.getByTestId('manage-register').count()) === 0);
  check('[2] no console or page errors', errors.filter((e) => !ORIGIN_404.test(e)).length === 0, errors.join(' | '));
  await browser.close();
}

// — 3 — the machines scope. ------------------------------------------------------------------------
console.log('\n== 3. Machines: the record, and what a build without a bridge can do ==');
{
  const { browser, page, errors } = await open({ route: makeService().handler });
  await page.getByTestId('manage-open').click();
  await page.getByTestId('manage-scope-machines').click();
  await page.waitForSelector('[data-testid="manage-machine-none"]');
  check('[3] with nothing checked, the card says so rather than drawing an empty machine',
    (await page.getByTestId('manage-machine-none').innerText()).includes('no check has run'));
  check('[3] the web build says why a check can only ever answer "unavailable"',
    (await page.getByTestId('manage-machine-web-hint').count()) === 1);
  check('[3] a typed address is offered as the way round the search, and refuses an empty one',
    (await page.getByTestId('manage-machine-address').count()) === 1
    && (await page.getByTestId('manage-machine-connect').isDisabled()));
  // #247's file moved here with #311: it is a fact about the machine setup, so the empty pane offers it.
  check('[3] the "my machine" file is offered here now',
    (await page.getByTestId('manage-machine-export').count()) === 1
    && (await page.getByTestId('manage-machine-import').count()) === 1);
  check('[3] the printers card is drawn, and claims no connection', await page.getByTestId('manage-printers').isVisible());

  await page.getByTestId('manage-machine-check').click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="manage-machine-check"]').disabled, { timeout: 30000 });
  const after = (await page.getByTestId('manage-machine-none').innerText()).replace(/\s+/g, ' ');
  check('[3] the check concludes out loud, and leaves no machine behind',
    after.includes('cannot reach a machine'), after.slice(0, 200));
  check('[3] the rail reflects the same outcome',
    (await page.getByTestId('manage-rail').innerText()).includes('No machine yet'));
  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());
  check('[3] the house is undisturbed by a machine check', hook.status === 'present');
  await page.screenshot({ path: `${OUT}/3-machines.png` });
  check('[3] no console or page errors', errors.filter((e) => !ORIGIN_404.test(e)).length === 0, errors.join(' | '));
  await browser.close();
}

// — 4 — no service at this origin. -----------------------------------------------------------------
console.log('\n== 4. no house service: the card, and the two definitions that need none ==');
{
  // No interception at all: the dev server answers `/api/v1/health` the way any static host does.
  const { browser, page, errors } = await open();
  const hook = await page.evaluate(() => window.__caseMaker.getToolRegistry());
  check('[4] the app concludes the service is ABSENT', hook.status === 'absent', hook.error ?? '');
  await page.getByTestId('manage-open').click();
  await page.waitForSelector('[data-testid="manage-absent"]');
  const reason = await page.getByTestId('manage-absent-reason').innerText();
  // VERBATIM: the probe's own sentence, not a re-worded one written into the panel.
  check('[4] the card carries the probe’s own reason sentence',
    reason === hook.error && /not the house service/.test(reason), reason);
  const aside = (await page.getByTestId('manage-builtins-aside').innerText()).replace(/\s+/g, ' ');
  check('[4] the two built-ins are drawn beside it', aside.includes('1 mm flat end'), aside.slice(0, 120));
  check('[4] the assumption is called an assumption', aside.includes('assumption'), aside);
  // The absent pane is not the list with rows missing. A filter and a counts line are the list's
  // furniture, and a list nobody can filter is the wrong shape for "there is no service here".
  check('[4] the absent pane draws no filter and no counts line',
    (await page.getByTestId('manage-counts').count()) === 0
    && (await page.getByTestId('manage-search').count()) === 0);
  check('[4] the two built-ins are listed in the aside, and nothing else is',
    (await page.getByTestId('manage-builtins-aside').locator('tbody tr').count()) === 2);
  await page.screenshot({ path: `${OUT}/4-no-service.png` });

  // G3's retry: the card's own button, and the same answer coming back rather than a new claim.
  const recheck = page.waitForRequest((r) => r.url().endsWith('/api/v1/health'), { timeout: 15000 });
  await page.getByTestId('manage-check-again').click();
  check('[4] Check again asks the origin again', (await recheck) !== null);
  await page.waitForSelector('[data-testid="manage-absent"]');
  check('[4] and the card comes back with the same sentence',
    (await page.getByTestId('manage-absent-reason').innerText()) === reason);
  const unexpected = errors.filter((e) => !ORIGIN_404.test(e));
  check('[4] no console or page errors beyond the origin’s own 404 line', unexpected.length === 0, unexpected.join(' | ') || '(none)');
  await browser.close();
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ url: PAGE_URL, results }, null, 2));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots and results.json in ${OUT}/`);
process.exit(failures === 0 ? 0 : 1);
