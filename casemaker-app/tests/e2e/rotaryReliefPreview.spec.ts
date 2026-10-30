// #723 R-4 — THE RELIEF ON A ROD, SEEN: Map, Stock, Simulate turning and Simulate Unroll, with
// REAL screenshots committed under `docs/bench/img/2026-10-30-rotary-relief/`.
//
// The part is a lobed shaft, r(θ) = 8 + 1.2·cos(3θ) along 20 mm of X — the around-the-rod axis, so
// the picture must show the lobes turning with the rod, not a turned profile. The job is a real
// document (built here from `defaultEngraveJob`, opened through the app's Open), the program for
// the Simulate legs is the app's own Generate read back through the test surface — a rotary job's
// Save is refused by the bench line — and every assertion about the drawing reads the WebGL
// canvas' pixels (the viewport keeps its drawing buffer for e2e) rather than trusting a screenshot
// to be right by eye.
//
// A REFUSED PART IS DRAWN TOO. The second job's lobes exceed the rod's radius, so the generator
// refuses it (`goal-rotary-oversize`) — and the design's rule is that the field still samples and
// the preview still draws the part, so the refusal and its cause stand side by side.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(900_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-30-rotary-relief');
const WORK = path.join(process.cwd(), 'test-results', 'rotary-relief-preview');

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

const TAU = Math.PI * 2;
const ROD_RADIUS = 10;
const LENGTH = 20;

/** The lobed side, as rings along the axis: r(θ) at every station. */
function lobedSide(maxLobe: number, length = LENGTH, rings = 20, seg = 144): Tri[] {
  const tris: Tri[] = [];
  const at = (i: number, s: number): V => {
    const x = -length / 2 + (i / rings) * length;
    const a = (s / seg) * TAU;
    const r = 8 + (maxLobe - 8) * Math.cos(3 * a);
    return [x, r * Math.sin(a), r * Math.cos(a)];
  };
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < seg; s++) {
      tris.push([at(i, s), at(i + 1, s), at(i + 1, s + 1)], [at(i, s), at(i + 1, s + 1), at(i, s + 1)]);
    }
  }
  return tris;
}

function target(maxLobe: number): EngraveTargetObject {
  const data = stl(lobedSide(maxLobe));
  // The REAL digest of the bytes: the app compares it when the document loads, and a made-up
  // one raises its "mesh does not match the fingerprint" note (and blocks Generate).
  const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  return {
    id: 'lobed-shaft',
    name: 'lobed-shaft.stl',
    format: 'stl',
    sha256,
    data,
    // The STATED size fits the blank (a larger one is refused before Generate by the goal-vs-blank
    // check, with its own sentence); the MESH is what is wider than the rod, which is the rotary
    // refusal this test is about.
    size: { x: LENGTH, y: 18, z: 18 },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    // COARSE ON PURPOSE, and on the TARGET object: the rotary dispatch reads the goal's own
    // surface settings (`goal.surface`), and the program it posts is what Simulate then sweeps on
    // the column engine, a union per checkpoint — a cut-resolution program was 258 681
    // checkpoints, hours on Swiftshader. These still show the lobes (25 rows round, 3 lobes) and
    // sweep in minutes. The PREVIEW keeps its own fine pitch, so the pictures are unaffected.
    surface: {
      gridPitchMm: 1,
      roughStepOverMm: 3,
      roughStepDownMm: 2,
      finishStepOverMm: 2.5,
      stockToLeaveMm: 0.3,
    },
  };
}

function reliefJob(name: string, maxLobe: number): EngraveJob {
  const job = defaultEngraveJob();
  job.name = name;
  job.stock = { ...job.stock, length: 100, width: 2 * ROD_RADIUS, thickness: 2 * ROD_RADIUS, material: 'pla', shape: 'cylinder', diameter: 2 * ROD_RADIUS };
  job.workholding = {
    kind: 'rotary-chuck',
    rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'e2e' },
  };
  job.labels = [];
  job.shapes = [];
  job.targetObject = target(maxLobe);
  job.toolKey = 'flat-3.175x12-metal';
  return job;
}

/** Write a job document and open it through the app's Open (the file menu's own door). */
async function openReliefJob(page: Page, job: EngraveJob, stem: string): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, `${stem}.job.json`);
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
  // A rotary job offers the Map | Stock switch; its presence is the app's own "this is a rod".
  await expect(page.getByTestId('rotary-view-controls')).toBeVisible();
}

/**
 * How many pixels of the viewport's canvas are the relief's own colour (`#8fb4ff`, lit): strongly
 * blue-dominant and bright. Reads the drawing buffer the viewport keeps for e2e; -1 means there
 * was no canvas to read (an assertion of its own).
 */
async function goalPixels(page: Page): Promise<number> {
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
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // The relief's colour (#8fb4ff) is the only blue-dominant thing in the scene: the stock is
      // tan, the fixtures grey, the background near-black. Threshold low enough for the lit face.
      if (b >= 110 && b - r >= 12 && b >= g - 10) blue++;
    }
    return blue;
  });
}

/** Fail fast, with the app's own blocker sentence, when Generate cannot be pressed. */
async function assertGenerateEnabled(page: Page): Promise<void> {
  const button = page.getByTestId('engrave-generate');
  await expect(button).toBeVisible();
  if (await button.isDisabled()) {
    const blocker = page.getByTestId('engrave-generate-blocker');
    const text = (await blocker.count()) > 0 ? await blocker.textContent() : '(no blocker sentence)';
    throw new Error(`Generate is disabled: ${text}`);
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, name) });
}

test('the relief draws on the map and the rod, and cuts to the program the sheet names', async ({ cm, page }) => {
  await cm.ready();
  await openReliefJob(page, reliefJob('Lobed shaft relief', 9.2), 'lobed-shaft');

  // ── The Map view (the default): the field unrolled, x along, the arc around. ──
  await expect(page.getByTestId('rotary-view-map')).toHaveAttribute('aria-pressed', 'true');
  // The preview worker builds asynchronously; poll rather than trusting one read.
  await expect.poll(() => goalPixels(page), { timeout: 60_000 }).toBeGreaterThan(200);
  const mapPixels = await goalPixels(page);
  await shoot(page, 'lobed-shaft-map.png');

  // ── The Stock view: the SAME buffer wrapped onto the rod, so the lobes turn with it. ──
  await page.getByTestId('rotary-view-stock').click();
  await expect(page.getByTestId('rotary-view-stock')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => goalPixels(page), { timeout: 30_000 }).toBeGreaterThan(200);
  const stockPixels = await goalPixels(page);
  expect(stockPixels, 'the relief is drawn on the rod').toBeGreaterThan(200);
  expect(stockPixels, 'a different view of the part, not the map again').not.toBe(mapPixels);
  await shoot(page, 'lobed-shaft-stock.png');

  // ── Simulate: the app GENERATES the relief, and its own text goes through Simulate's door. ──
  // A rotary job's Save is refused (the bench line: simulate-only), so the program is read from
  // the run store through the test surface's `engraveProgramText` — the same bytes Save would
  // write. A blocked Generate is reported with its OWN sentence rather than as a click timeout.
  await assertGenerateEnabled(page);
  await page.getByTestId('engrave-generate').click();
  await page.waitForFunction(() => window.__caseMaker!.engraveProgramText() !== null, undefined, { timeout: 300_000 });
  const nc = await page.evaluate(() => window.__caseMaker!.engraveProgramText());
  expect(nc, 'the app generated the relief program').not.toBeNull();
  expect(nc!).toContain('A');
  fs.mkdirSync(WORK, { recursive: true });
  const ncFile = path.join(WORK, 'lobed-shaft-relief.nc');
  fs.writeFileSync(ncFile, nc!);

  // The generate also STARTED the run's own simulation on the shared sim store, and Simulate's
  // button stays disabled while it loads. Reset the run (the panel's own door then owns the
  // session), which is what a person does by leaving the job.
  await page.evaluate(() => window.__caseMaker!.engraveReset());
  await page.getByTestId('sidebar-button-cnc-sim').click();
  await expect(page.getByTestId('sim-panel')).toBeVisible();
  const [ncChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('sim-open').click()]);
  await ncChooser.setFiles(ncFile);
  await expect(page.getByTestId('sim-rotary-file')).toContainText('the stock is a rod in the rotary chuck');
  await page.getByTestId('sim-simulate').click();
  await expect(page.getByTestId('sim-result')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('sim-backend')).toContainText(/column/i);

  // Mid-program, turning: the stock is a rod and the cut is part-way.
  const max = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), Math.floor(max * 0.5));
  await shoot(page, 'lobed-shaft-simulate-turning.png');

  // Unroll at the end: the same program opened flat, at the last step.
  await page.getByTestId('sim-view-unroll').click();
  await expect(page.getByTestId('sim-view-unroll')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewport-camera-top').click();
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), max);
  await shoot(page, 'lobed-shaft-simulate-unroll.png');
  const state = await page.evaluate(() => window.__caseMaker!.getSimState());
  // 'ready' is the store's finished state (the panel draws its Result block on it); the sweep
  // really removed material and its cuts were recorded.
  expect(state.status).toBe('ready');
  expect(state.removedVolume).toBeGreaterThan(0);
});

test('a part wider than the rod is refused by name and STILL drawn beside the refusal', async ({ cm, page }) => {
  await cm.ready();
  await openReliefJob(page, reliefJob('Oversize lobes', 12), 'oversize-lobes');

  // The generator refuses the part: its lobes reach 12 mm on a ⌀20 rod.
  await assertGenerateEnabled(page);
  await page.getByTestId('engrave-generate').click();
  // The generator's own refusal sentence, where the Generate step shows it.
  const refusal = page.getByText(/cannot be reproduced from this rod/i);
  await expect(refusal).toBeVisible({ timeout: 120_000 });
  await expect(refusal).toContainText(/reaches r 12 mm/);
  // ...and the design's rule holds: the field still samples, so the part is drawn.
  await expect.poll(() => goalPixels(page), { timeout: 30_000 }).toBeGreaterThan(200);
  const pixels = await goalPixels(page);
  expect(pixels, 'a refused part is still drawn').toBeGreaterThan(200);
  await shoot(page, 'oversize-refused-with-drawing.png');
});
