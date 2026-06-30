// Probe R3F internals to find camera + controls.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.goto('http://127.0.0.1:8088/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
await page.click('[data-testid="welcome-template-protective-case"]');
await page.waitForFunction(() => !!(window).__caseMaker, { timeout: 30000 });
await page.evaluate(async () => { await (window).__caseMaker.waitForIdle(); });
await page.waitForFunction(
  () => /Ready/.test(document.querySelector('[data-testid="status-bar"]')?.textContent || ''),
  { timeout: 60000 },
);
await page.waitForSelector('[data-testid="viewport-canvas"]');
await page.waitForTimeout(500);

const probe = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="viewport-canvas"]');
  if (!canvas) return { canvas: false };
  // R3F attaches __r3f symbol-key; try various access paths.
  const out = {
    keys: Object.keys(canvas),
    symKeys: Object.getOwnPropertySymbols(canvas).map(String),
    hasR3f: '__r3f' in canvas,
    r3fType: typeof canvas.__r3f,
    parentKeys: canvas.parentElement ? Object.keys(canvas.parentElement) : [],
  };
  if (canvas.__r3f) {
    out.r3fKeys = Object.keys(canvas.__r3f);
    if (canvas.__r3f.root) out.rootKeys = Object.keys(canvas.__r3f.root);
    if (canvas.__r3f.store) out.storeKeys = Object.keys(canvas.__r3f.store);
  }
  return out;
});
console.log(JSON.stringify(probe, null, 2));

// Attempt to walk to camera through R3F's root
const cam = await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="viewport-canvas"]');
  const r3f = canvas?.__r3f;
  if (!r3f) return { found: false };
  // Try root.store
  const root = r3f.root;
  if (!root) return { found: false, reason: 'no root' };
  const rootKeys = Object.keys(root);
  let state = null;
  if (root.getState) state = root.getState();
  else if (root.store && root.store.getState) state = root.store.getState();
  if (!state) return { found: false, reason: 'no state', rootKeys };
  return {
    found: true,
    stateKeys: Object.keys(state),
    cameraType: state.camera?.type,
    cameraPos: state.camera ? [state.camera.position.x, state.camera.position.y, state.camera.position.z] : null,
    controlsTarget: state.controls?.target ? [state.controls.target.x, state.controls.target.y, state.controls.target.z] : null,
    hasInvalidate: typeof state.invalidate,
  };
});
console.log('camera probe:', JSON.stringify(cam, null, 2));

await browser.close();
