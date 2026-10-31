// #811 — THE GOAL DRAWN ON FLAT STOCK, SEEN: the part standing in the cleared blank (item), and
// the cavity a mold leaves. REAL screenshots are committed under
// `docs/bench/img/2026-10-31-goal-drawing/`.
//
// The part is the 20 × 20 × 6 mm chamfered block — the #535 fixture, a closed mesh with a sloped
// top. The job is a real document opened through the app's Open; the preview worker builds the
// volumes from the same mesh and the same placed frame the CAM samples. The assertions read the
// test surface's volumes against closed forms (the blank, the part's own volume) and the legend's
// words; the pictures are the evidence a person reads for "the goal is visible through the
// ghosted stock".
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(600_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-goal-drawing');
const WORK = path.join(process.cwd(), 'test-results', 'goal-drawing');
const STL = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'chamfered-block.stl');

/** Signed volume of a binary STL's triangle soup (divergence theorem), mm³. */
function stlVolumeMm3(bytes: Buffer): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(80, true);
  let v = 0;
  let off = 84;
  for (let t = 0; t < count; t++) {
    const p = (k: number): [number, number, number] => [
      dv.getFloat32(off + 12 + k * 12, true),
      dv.getFloat32(off + 16 + k * 12, true),
      dv.getFloat32(off + 20 + k * 12, true),
    ];
    const a = p(0);
    const b = p(1);
    const c = p(2);
    v +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    off += 50;
  }
  return Math.abs(v / 6);
}

const PART_MM3 = stlVolumeMm3(fs.readFileSync(STL));
const BLANK_MM3 = 100 * 60 * 12; // the default job's stock — stated below, not inferred

function goalJob(): EngraveJob {
  const data = fs.readFileSync(STL).toString('base64');
  // The REAL digest of the bytes: the app compares it when the document loads.
  const sha256 = createHash('sha256').update(fs.readFileSync(STL)).digest('hex');
  const target: EngraveTargetObject = {
    id: 'goal-block',
    name: 'chamfered-block.stl',
    format: 'stl',
    sha256,
    data,
    size: { x: 20, y: 20, z: 6 },
    // Top flush with the stock's top face: the part occupies the top 6 mm of the blank.
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const job = defaultEngraveJob();
  job.name = 'Goal drawing';
  job.stock = { ...job.stock, length: 100, width: 60, thickness: 12, material: 'softwood' };
  job.labels = [];
  job.shapes = [];
  job.targetObject = target;
  job.toolKey = 'flat-1.0';
  return job;
}

/** Open a job document through the file menu's own door, once the engrave screen is up. */
async function openJob(page: Page, job: EngraveJob): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'goal-drawing.job.json');
  fs.writeFileSync(file, JSON.stringify(job));
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  const menu = page.getByTestId('engrave-file-menu');
  if (!(await menu.isVisible())) await page.getByTestId('engrave-file-menu-toggle').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('engrave-job-open').click()]);
  await chooser.setFiles(file);
  await expect(page.getByTestId('engrave-job-file-name')).toContainText(job.name);
}

/** The goal drawing the preview has built, or null while the preview is still on its way. */
async function goalDrawing(page: Page): Promise<{ mode: string; partVolumeMm3: number | null; removedVolumeMm3: number | null } | null> {
  return page.evaluate(() => window.__caseMaker!.engraveGoalDrawing());
}

/**
 * Wait until the preview has built a goal drawing of `mode`. The worker can be slow when the
 * machine is loaded (another full suite running), so the budget is generous — and a preview that
 * ERRORED stops the wait with its own sentence rather than as a bare timeout.
 */
async function waitForMode(page: Page, mode: 'item' | 'mold'): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      preview: window.__caseMaker!.engravePreviewState(),
      drawing: window.__caseMaker!.engraveGoalDrawing(),
    }));
    if (state.preview.status === 'error') {
      throw new Error(`the preview worker failed: ${state.preview.error ?? '(no message)'}`);
    }
    if (state.drawing?.mode === mode) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`the preview never drew the goal as "${mode}"`);
}

/**
 * How much of the viewport is the REMOVED layer's colour (#ff5a36): red-dominant with a low green
 * share — the tan stock (#c9a26b) and the background never qualify. The overlay is translucent,
 * so the test asks that it is drawn at all and that the item's overlay covers far more of the
 * canvas than the mold's cavity does, not for an exact count.
 */
async function removedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="viewport-canvas"]');
    const canvas = host instanceof HTMLCanvasElement ? host : host?.querySelector('canvas') ?? null;
    if (canvas === null) return -1;
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d');
    if (ctx === null) return -1;
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // Orange, after lighting and the 25 % blend: red clearly above blue and green clearly the
      // minority channel. The tan stock (r−g ≈ 40, g−b ≈ 55) fails the second half.
      if (r > 110 && r - b > 70 && r - g > 60 && g - b < 40) count++;
    }
    return count;
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  // Frame the stock, then close in: the picture the issue asks for is the GOAL read through the
  // stock, not the machine it sits in.
  await page.getByTestId('viewport-fit').click();
  for (let i = 0; i < 3; i++) await page.getByTestId('viewport-zoom-in').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, name) });
}

test('the goal on flat stock: item draws the part in the cleared blank, mold draws the cavity', async ({ cm, page }) => {
  await cm.ready();
  await openJob(page, goalJob());

  // The row's own switch is where the goal is, and the legend names what the drawing shows. The
  // row's fields sit behind its expand control (#799).
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  const expand = page.getByTestId('engrave-target-expand-0');
  if ((await expand.count()) > 0) await expand.click();
  await expect(page.getByTestId('engrave-target-goal-mode-0')).toBeVisible();
  await waitForMode(page, 'item');
  await expect(page.getByTestId('engrave-legend-goal')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('engrave-legend-goal')).toContainText('Goal: the part, standing proud');

  // item: the part's own volume, and the rest of the blank as the removed volume.
  const item = await goalDrawing(page);
  expect(item).not.toBeNull();
  expect(item!.partVolumeMm3).toBeCloseTo(PART_MM3, 0);
  expect(item!.removedVolumeMm3).toBeCloseTo(BLANK_MM3 - PART_MM3, 0);
  const itemPixels = await removedPixels(page);
  expect(itemPixels, 'the removed overlay is drawn in the item view').toBeGreaterThan(0);
  await shoot(page, 'goal-item.png');

  // mold: the part becomes the cavity — the same volume, clipped to the blank, nothing standing.
  await page.getByTestId('engrave-target-goal-mode-0').selectOption('mold');
  await waitForMode(page, 'mold');
  await expect(page.getByTestId('engrave-legend-goal')).toContainText('Goal: a mold of the part');
  const mold = await goalDrawing(page);
  expect(mold!.partVolumeMm3).toBeNull();
  expect(mold!.removedVolumeMm3).toBeCloseTo(PART_MM3, 0);
  const moldPixels = await removedPixels(page);
  expect(moldPixels, 'the cavity is drawn in the removed colour').toBeGreaterThan(0);
  await shoot(page, 'goal-mold.png');
  // The VOLUMES above are what prove the picture follows the mode (closed forms, read off the
  // drawing the scene renders). The pixel counts are only the "the removed layer is on screen in
  // both" sanity check: they swing with the camera and the lighting, so no ratio is asserted.
  expect(itemPixels).toBeGreaterThan(moldPixels);
});
