// Render protective-case template — 5 canvas-cropped PNGs.
// Outputs: local-docs/pelican-render-{iso,side,top,bottom,exploded}.png
//
// Strategy: use the toolbar's canonical view buttons (perspective/top/side/
// front + complete/exploded) for cam direction, then dolly OUT via wheel
// events so the entire ~150x100x60 mm protective case fits in the frame
// (the default views are tuned for smaller boards). For "bottom", drag-orbit
// from the Top camera.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = (name) => resolve(__dirname, 'local-docs', `pelican-render-${name}.png`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:8088/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
await page.click('[data-testid="welcome-template-protective-case"]');
await page.waitForFunction(() => !!(window).__caseMaker, { timeout: 30000 });
await page.evaluate(async () => { await (window).__caseMaker.waitForIdle(); });
await page.waitForFunction(
  () => /Ready/.test(document.querySelector('[data-testid="status-bar"]')?.textContent || ''),
  { timeout: 120000 },
);
console.log('engine ready');
await page.waitForSelector('[data-testid="viewport-canvas"]');

// Hide overlays.
await page.addStyleTag({
  content: `
    [data-testid="floaters-banner"], [data-testid="placement-banner"] { display: none !important; }
    /* Also hide the toolbar so it doesn't appear in canvas crops */
    [data-testid="viewport-toolbar"] { opacity: 0 !important; pointer-events: auto !important; }
  `,
});

async function setViewMode(mode) {
  // Toolbar is now opacity 0 but still clickable; force in case anything
  // intercepts.
  await page.click(`[data-testid="viewport-view-${mode}"]`, { force: true });
  await page.waitForTimeout(300);
}
async function setCameraMode(mode) {
  await page.click(`[data-testid="viewport-camera-${mode}"]`, { force: true });
  await page.waitForTimeout(450);
}

// Dispatch wheel events on the canvas to dolly camera. Positive deltaY = zoom out.
async function dolly(deltaY, steps = 6) {
  const c = await page.$('[data-testid="viewport-canvas"]');
  const b = await c.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
}

async function dragOrbit(dx, dy) {
  const c = await page.$('[data-testid="viewport-canvas"]');
  const b = await c.boundingBox();
  // Avoid the top 80px which the toolbar overlaps.
  const startX = b.x + b.width / 2;
  const startY = b.y + 100;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'left' });
  // Several intermediate moves ensure pointer events are dispatched.
  const targetX = Math.max(b.x + 5, Math.min(b.x + b.width - 5, startX + dx));
  const targetY = Math.max(b.y + 5, Math.min(b.y + b.height - 5, startY + dy));
  await page.mouse.move(targetX, targetY, { steps: 40 });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(500);
}

async function shoot(name) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const c = await page.$('[data-testid="viewport-canvas"]');
  await c.screenshot({ path: out(name) });
  console.log('  saved', out(name));
}

// 1) ISO — perspective + complete (lid closed). Default perspective is
// already 3/4-ish; just dolly out to fit the case.
console.log('1) iso');
await setViewMode('complete');
await setCameraMode('perspective');
await dolly(150, 6);
await shoot('iso');

// 2) SIDE — toolbar Side. Dolly out further; case is 150mm long.
console.log('2) side');
await setCameraMode('side');
await dolly(150, 8);
await shoot('side');

// 3) TOP
console.log('3) top');
await setCameraMode('top');
await dolly(150, 8);
await shoot('top');

// 4) BOTTOM — Top + 180° orbit downward. Drag down well past canvas to
// rotate around X. Multiple drags since one is bounded by canvas height.
console.log('4) bottom');
await setCameraMode('top');
await dolly(150, 8);
// Make sure orbit tool is active.
await page.click('[data-testid="viewport-tool-orbit"]', { force: true });
await page.waitForTimeout(150);
// Each drag flips ~half-rotation; do 3 separate drags totaling ~270°.
for (let i = 0; i < 3; i++) await dragOrbit(0, 700);
await shoot('bottom');

// 5) EXPLODED — perspective + exploded
console.log('5) exploded');
await setCameraMode('perspective');
await setViewMode('exploded');
await dolly(150, 6);
await shoot('exploded');

await browser.close();
console.log('done.');
