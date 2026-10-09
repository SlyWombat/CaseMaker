/**
 * Screenshot the static CNC UI mockup (issue #195) — one 1440×900 PNG per state.
 *
 * Deliberately does NOT touch the Vite dev server: it opens docs/assets/cnc-mockup.html
 * straight from disk over file://, so it works with no dev port held and no network.
 * Run with the project's pinned Playwright (1.61.0) through Windows Node:
 *
 *   powershell.exe -NoProfile -Command "node scripts/screenshot-cnc-mockup.mjs"
 *
 * Each .frame element is sized 1440×900 in the page, so an element screenshot is
 * exactly 1440×900 — no clipping maths.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, '..', '..', 'docs', 'assets', 'cnc-mockup.html');
const outDir = resolve(here, '..', '..', 'docs', 'assets');
const url = pathToFileURL(htmlPath).href;

// frame id (in the HTML) -> output file. Order matches the issue's A–F listing.
const STATES = [
  ['shot-sidebar', 'cnc-mockup-sidebar.png'],
  ['shot-sim-idle', 'cnc-mockup-sim-idle.png'],
  ['shot-sim-tool-required', 'cnc-mockup-sim-tool-required.png'],
  ['shot-sim-running', 'cnc-mockup-sim-running.png'],
  ['shot-sim-ready', 'cnc-mockup-sim-ready.png'],
  ['shot-sim-refused', 'cnc-mockup-sim-refused.png'],
  ['shot-viewport-ready', 'cnc-mockup-viewport-ready.png'],
  ['shot-transport', 'cnc-mockup-transport.png'],
  ['shot-sim-paused', 'cnc-mockup-sim-paused.png'],
  ['shot-engrave-editing', 'cnc-mockup-engrave-editing.png'],
  ['shot-engrave-tool-recommendation', 'cnc-mockup-engrave-tool-recommendation.png'],
  ['shot-engrave-findings', 'cnc-mockup-engrave-findings.png'],
  ['shot-engrave-generated', 'cnc-mockup-engrave-generated.png'],
  ['shot-engrave-generated-blocked', 'cnc-mockup-engrave-generated-blocked.png'],
  ['shot-engrave-viewport', 'cnc-mockup-engrave-viewport.png'],
  ['shot-manage-tools', 'cnc-mockup-manage-tools.png'],
  ['shot-manage-register', 'cnc-mockup-manage-register.png'],
  ['shot-manage-absent', 'cnc-mockup-manage-absent.png'],
  ['shot-manage-machines', 'cnc-mockup-manage-machines.png'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(url, { waitUntil: 'load' });

let missing = 0;
for (const [id, file] of STATES) {
  const el = page.locator(`#${id}`);
  const count = await el.count();
  if (count === 0) {
    console.error(`MISSING  #${id} — section not found`);
    missing++;
    continue;
  }
  const box = await el.boundingBox();
  const size = box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '?';
  await el.screenshot({ path: resolve(outDir, file) });
  console.log(`ok  ${file}  (element ${size})`);
}

await browser.close();

if (consoleErrors.length) {
  console.error(`\nCONSOLE ERRORS (${consoleErrors.length}):`);
  for (const e of consoleErrors) console.error('  ' + e);
} else {
  console.log('\nno console errors, no page errors');
}
if (missing) {
  console.error(`${missing} section(s) missing`);
  process.exitCode = 1;
}
