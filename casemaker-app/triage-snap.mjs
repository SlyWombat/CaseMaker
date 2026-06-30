// Reproduce "Not manifold" with Snap-fit test cube template.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:8088/';
const screenshotPath = resolve(__dirname, 'local-docs', 'snap-fit-error.png');

const consoleEvents = [];
const pageErrors = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('console', (m) => {
  const entry = { type: m.type(), text: m.text() };
  consoleEvents.push(entry);
  if (m.type() === 'error' || m.type() === 'warning' || /manifold|worker|compile/i.test(entry.text)) {
    console.log(`[${entry.type}]`, entry.text);
  }
});
page.on('pageerror', (e) => {
  pageErrors.push({ message: e.message, stack: e.stack });
  console.log('[pageerror]', e.message);
  if (e.stack) console.log(e.stack);
});
page.on('worker', (worker) => {
  console.log('[worker]', worker.url());
  worker.on('console', (m) => {
    const entry = { type: m.type(), text: m.text(), source: 'worker' };
    consoleEvents.push(entry);
    console.log(`[worker:${m.type()}]`, m.text());
  });
});

console.log('navigate', TARGET_URL);
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

try {
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
  console.log('welcome overlay visible');
} catch {
  console.log('no welcome overlay; checking page state');
  console.log('  url=', page.url());
  console.log('  title=', await page.title());
}

// Try to find templates pulldown — may need to open it first.
const ddSelectors = [
  '[data-testid="welcome-templates-toggle"]',
  '[data-testid="welcome-templates-button"]',
  'button:has-text("Templates")',
];
for (const sel of ddSelectors) {
  const el = await page.$(sel);
  if (el) {
    console.log('clicking templates toggle:', sel);
    try { await el.click(); } catch {}
    break;
  }
}

const templateSelectors = [
  '[data-testid="welcome-template-snap-fit-test"]',
  '[data-testid="template-snap-fit-test"]',
  'text=Snap-fit test cube',
];
let clicked = false;
for (const sel of templateSelectors) {
  const el = await page.$(sel);
  if (el) {
    console.log('clicking template:', sel);
    await el.click();
    clicked = true;
    break;
  }
}
if (!clicked) {
  console.log('!! could not find Snap-fit test cube selector; dumping welcome HTML');
  const html = await page.evaluate(() => document.querySelector('[data-testid="welcome-overlay"]')?.outerHTML || document.body.innerHTML);
  console.log(html.slice(0, 4000));
}

// Wait for engine to attempt compile.
try { await page.waitForFunction(() => !!(window).__caseMaker, { timeout: 30000 }); } catch {}

// Wait until status is Ready or Error or 30s timeout.
const status = await page.waitForFunction(() => {
  const t = document.querySelector('[data-testid="status-bar"]')?.textContent || '';
  if (/Ready|Error|Failed|manifold/i.test(t)) return t;
  return null;
}, { timeout: 60000 }).catch((err) => {
  console.log('status-bar wait timeout:', err.message);
  return null;
});

await page.waitForTimeout(1500); // settle any async error logs

const statusText = await page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent || '');
console.log('STATUS BAR:', JSON.stringify(statusText));

const qaBanner = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="floaters-banner"]') || document.querySelector('[data-testid="qa-banner"]') || document.querySelector('[data-testid="placement-banner"]');
  return el?.textContent || null;
});
console.log('QA BANNER:', JSON.stringify(qaBanner));

// Try compileProject if exposed.
const compileSummary = await page.evaluate(async () => {
  try {
    const cm = (window).__caseMaker;
    if (!cm) return { error: 'no __caseMaker' };
    const out = {};
    out.keys = Object.keys(cm);
    if (cm.compileProject) {
      try {
        const plan = await cm.compileProject();
        out.plan = plan;
      } catch (e) {
        out.compileError = String(e?.message || e);
        out.compileStack = e?.stack;
      }
    }
    if (cm.getProject) {
      try { out.project = cm.getProject(); } catch {}
    }
    if (cm.useProjectStore) {
      try { out.storeState = cm.useProjectStore.getState ? cm.useProjectStore.getState() : null; } catch {}
    }
    return out;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
});

// Stringify, dropping cycles / functions.
function safeStringify(obj, max = 8000) {
  const seen = new WeakSet();
  const s = JSON.stringify(obj, (k, v) => {
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'bigint') return String(v);
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
    }
    return v;
  });
  return s && s.length > max ? s.slice(0, max) + '...[TRUNC]' : s;
}
console.log('COMPILE/PROJECT SUMMARY:');
console.log(safeStringify(compileSummary, 12000));

// Try to extract snap catches + case params from the project store.
const snapInfo = await page.evaluate(() => {
  try {
    const cm = (window).__caseMaker;
    const proj = cm?.getProject ? cm.getProject() : (cm?.useProjectStore?.getState ? cm.useProjectStore.getState().project : null);
    if (!proj) return null;
    return {
      caseParams: proj.caseParams || proj.params || null,
      snapCatches: proj.snapCatches || proj.snaps || null,
      lid: proj.lid || null,
      ports: (proj.ports || []).length,
      fixtures: (proj.fixtures || []).length,
      nodes: Array.isArray(proj.nodes) ? proj.nodes.map((n) => ({ id: n.id, kind: n.kind, op: n.op })) : null,
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
});
console.log('SNAP INFO:');
console.log(safeStringify(snapInfo, 8000));

// Take a screenshot of error state.
try {
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('screenshot ->', screenshotPath);
} catch (e) {
  console.log('screenshot failed:', e.message);
}

// Dump the captured pageerrors and worker errors.
console.log('\n=== ALL PAGE ERRORS ===');
for (const e of pageErrors) {
  console.log(e.message);
  if (e.stack) console.log(e.stack);
}
console.log('\n=== ERROR-LEVEL CONSOLE EVENTS ===');
for (const ev of consoleEvents) {
  if (ev.type === 'error' || /manifold|not manifold|Not manifold/i.test(ev.text)) {
    console.log(`[${ev.type}${ev.source ? ':' + ev.source : ''}]`, ev.text);
  }
}

await browser.close();
console.log('done.');
