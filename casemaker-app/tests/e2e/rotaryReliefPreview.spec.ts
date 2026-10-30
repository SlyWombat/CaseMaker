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
 * What the viewport's canvas shows of the relief, measured rather than eyeballed: how many pixels
 * are the part's own colour (the depth ramp is blue-dominant, the stock tan, the background
 * near-black), and — the #723 R-4 review's point — whether the colour VARIES along the screen's
 * vertical axis, which in the Map view is the stock's arc. A three-lobe shaft is three crests
 * across 62.8 mm around, so the row-mean brightness must rise and fall at least four times;
 * "pixels differ from the background" once passed a picture a user could not read.
 */
async function goalDrawState(page: Page): Promise<{ count: number; alternations: number; spread: number }> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="viewport-canvas"]');
    const canvas = host instanceof HTMLCanvasElement ? host : host?.querySelector('canvas') ?? null;
    if (canvas === null) return { count: -1, alternations: -1, spread: -1 };
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d');
    if (ctx === null) return { count: -1, alternations: -1, spread: -1 };
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let count = 0;
    const rows = new Map<number, { sum: number; n: number }>();
    for (let y = 0; y < off.height; y++) {
      for (let x = 0; x < off.width; x++) {
        const i = (y * off.width + x) * 4;
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        // The relief's ramp is the only blue-dominant thing in the scene (#d6ecff … #1e40af).
        if (b >= 120 && b - r >= 10) {
          count++;
          const row = rows.get(y) ?? { sum: 0, n: 0 };
          row.sum += (r + g + b) / 3;
          row.n += 1;
          rows.set(y, row);
        }
      }
    }
    // Rows the part really covers, in screen order, then the sign changes of their mean brightness.
    const means = [...rows.entries()].filter(([, v]) => v.n >= 20).sort((a, b) => a[0] - b[0]).map(([, v]) => v.sum / v.n);
    let alternations = 0;
    let last = 0;
    for (let i = 1; i < means.length; i++) {
      const d = Math.sign((means[i] as number) - (means[i - 1] as number));
      if (d !== 0 && last !== 0 && d !== last) alternations++;
      if (d !== 0) last = d;
    }
    const spread = means.length === 0 ? 0 : Math.max(...means) - Math.min(...means);
    return { count, alternations, spread };
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

/** Each canvas row's mean brightness — a cheap fingerprint of what the stock looks like. */
async function canvasRowMeans(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="viewport-canvas"]');
    const canvas = host instanceof HTMLCanvasElement ? host : host?.querySelector('canvas') ?? null;
    if (canvas === null) return [];
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d');
    if (ctx === null) return [];
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    const means: number[] = [];
    for (let y = 0; y < off.height; y++) {
      let sum = 0;
      for (let x = 0; x < off.width; x++) {
        const i = (y * off.width + x) * 4;
        sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      }
      means.push(sum / off.width);
    }
    return means;
  });
}

/**
 * The stock's silhouette, measured from the canvas: its pixel count, its extent across the rod
 * in 16 bins along the silhouette's own (PCA) axis, and how completely the pixels fill their
 * convex hull. For a lone, closed cylinder the silhouette is a convex band, so the hull fill is
 * ~1 and the width varies only by perspective; a mesh whose ends are missing or whose sides are
 * boxed in its bounding box leaves notches, a wall sliver and a square plate to see instead.
 */
async function stockSilhouette(page: Page): Promise<{
  count: number;
  widths: number[];
  wMaxOverMin: number;
  hullFill: number;
}> {
  return page.evaluate(() => {
    const empty = { count: 0, widths: [] as number[], wMaxOverMin: 0, hullFill: 0 };
    const host = document.querySelector('[data-testid="viewport-canvas"]');
    const canvas = host instanceof HTMLCanvasElement ? host : host?.querySelector('canvas') ?? null;
    if (canvas === null) return empty;
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const ctx = off.getContext('2d');
    if (ctx === null) return empty;
    ctx.drawImage(canvas, 0, 0);
    const W = off.width,
      H = off.height;
    const data = ctx.getImageData(0, 0, W, H).data;
    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * W + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    // The viewport clears to black; anything meaningfully off it is the stock (the only body on
    // screen while every other layer is switched off).
    const bg = at(0, 0);
    const pts: [number, number][] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = at(x, y);
        if (Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) > 28) pts.push([x, y]);
      }
    }
    if (pts.length < 10) return { ...empty, count: pts.length };
    // The silhouette's own axis: the rod is the one long thing in the frame.
    let mx = 0,
      my = 0;
    for (const [x, y] of pts) {
      mx += x;
      my += y;
    }
    mx /= pts.length;
    my /= pts.length;
    let sxx = 0,
      sxy = 0,
      syy = 0;
    for (const [x, y] of pts) {
      const dx = x - mx,
        dy = y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(angle),
      uy = Math.sin(angle);
    const vx = -uy,
      vy = ux;
    const us = pts.map(([x, y]) => (x - mx) * ux + (y - my) * uy);
    const vs = pts.map(([x, y]) => (x - mx) * vx + (y - my) * vy);
    const uMin = Math.min(...us),
      uMax = Math.max(...us);
    const N = 16;
    const widths: number[] = [];
    for (let b = 0; b < N; b++) {
      const lo = uMin + ((uMax - uMin) * b) / N;
      const hi = uMin + ((uMax - uMin) * (b + 1)) / N;
      const vv: number[] = [];
      for (let i = 0; i < pts.length; i++) if (us[i]! >= lo && us[i]! < hi) vv.push(vs[i]!);
      if (vv.length === 0) {
        widths.push(0);
        continue;
      }
      vv.sort((a, b2) => a - b2);
      const q = (f: number): number => vv[Math.min(vv.length - 1, Math.max(0, Math.floor(f * (vv.length - 1))))]!;
      widths.push(Math.round((q(0.98) - q(0.02)) * 10) / 10);
    }
    // The convex hull (monotone chain), as the area the pixels must FILL if the outline is solid.
    const hp = [...pts].sort((a, b2) => a[0] - b2[0] || a[1] - b2[1]);
    const cross = (o: [number, number], a: [number, number], b2: [number, number]): number =>
      (a[0] - o[0]) * (b2[1] - o[1]) - (a[1] - o[1]) * (b2[0] - o[0]);
    const lower: [number, number][] = [];
    for (const p of hp) {
      while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: [number, number][] = [];
    for (let i = hp.length - 1; i >= 0; i--) {
      const p = hp[i]!;
      while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    let hullArea = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]!,
        b2 = hull[(i + 1) % hull.length]!;
      hullArea += a[0] * b2[1] - b2[0] * a[1];
    }
    hullArea = Math.abs(hullArea) / 2;
    const positive = widths.filter((w) => w > 0);
    return {
      count: pts.length,
      widths,
      wMaxOverMin: Math.round((Math.max(...positive) / Math.max(1, Math.min(...positive))) * 100) / 100,
      hullFill: Math.round((pts.length / Math.max(1, hullArea)) * 1000) / 1000,
    };
  });
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
  await expect.poll(async () => (await goalDrawState(page)).count, { timeout: 60_000 }).toBeGreaterThan(200);
  const map = await goalDrawState(page);
  // THE LOBES MUST READ. Three crests around the map's arc are several brightness swings in the
  // row-mean profile — a uniform band (the defect the manager saw) measures zero.
  expect(map.alternations, 'the depth ramp varies around the stock (the lobes are legible)').toBeGreaterThanOrEqual(4);
  expect(map.spread, 'crests and troughs differ in colour, not just in position').toBeGreaterThan(8);
  await shoot(page, 'lobed-shaft-map.png');

  // ── The Stock view: the SAME buffer wrapped onto the rod, so the lobes turn with it. ──
  await page.getByTestId('rotary-view-stock').click();
  await expect(page.getByTestId('rotary-view-stock')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await goalDrawState(page)).count, { timeout: 30_000 }).toBeGreaterThan(200);
  const stock = await goalDrawState(page);
  expect(stock.count, 'the relief is drawn on the rod').toBeGreaterThan(200);
  expect(stock.count, 'a different view of the part, not the map again').not.toBe(map.count);
  expect(stock.spread, 'the wrapped copy keeps the depth colours').toBeGreaterThan(8);
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
  // #723 R-4 review — the two diagnostics that fired on EVERY rotary job are gone from the panel:
  // the file states its starting tool (`;@CM|START|tool=empty`), and the chuck/tailstock fact is
  // stated once in the coverage sentence instead of as a per-sweep info.
  const panelText = (await page.getByTestId('sim-panel').textContent()) ?? '';
  expect(panelText).not.toContain('starting tool was not stated');
  expect(panelText).not.toContain('NOT checked');
  expect(panelText).toContain('checked as keep-out bands');

  // Mid-program, turning: the stock is a rod and the cut is part-way.
  const max = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), Math.floor(max * 0.5));

  // ── THE ROD MUST BE THE ROD (#723 R-4 review) ─────────────────────────────────────────────
  // The first pictures drew the ⌀20 rod as a flat-sided wedge: both end caps gone, a sliver
  // along the bottom and a square plate at each end. The FLAT stock's #552 cleanup ("drop every
  // vertical triangle, rebuild the four sides as bbox walls") was being applied to the ROTARY
  // mesh as well. With every other layer switched off the canvas holds the stock ALONE, so the
  // silhouette itself is what is measured.
  for (const key of ['removed', 'path', 'rapids', 'tool', 'fixture', 'sacrificial', 'touches'] as const) {
    const box = page.getByTestId(`viewport-layer-${key}`);
    if (await box.isChecked()) await box.uncheck();
  }
  await page.getByTestId('viewport-camera-perspective').click();
  await page.waitForTimeout(400);
  const rod = await stockSilhouette(page);
  expect(rod.count, 'the rod is drawn').toBeGreaterThan(3000);
  // Across the axis the silhouette is a band whose width changes only as perspective foreshortens
  // it along X (1.21 under this fixed camera); the boxed rod's walls and plate corners took it to
  // 1.39 — a wedge, not a rod.
  expect(rod.wMaxOverMin, 'the rod is a band of near-constant width along X, not a wedge').toBeLessThan(1.3);
  // And the outline is FILLED: pixel area over the convex hull's is 1.00 for a cylinder seen
  // obliquely, 0.94 for the boxed mesh — its plate corners and wall sliver were background inside
  // the rod's outline, the triangular gaps at the ends.
  expect(rod.hullFill, 'the rod’s outline is solid — no gaps at the ends and no sliver').toBeGreaterThan(0.97);
  // End-on, down the rod's axis, the silhouette is a DISC — the end cap the flat cleanup deleted.
  // The boxed mesh put a square plate there instead (hull fill 0.86 against a disc's 1.02).
  await page.getByTestId('viewport-camera-side').click();
  await page.waitForTimeout(500);
  const endOn = await stockSilhouette(page);
  expect(endOn.hullFill, 'down the rod’s axis the silhouette is a filled disc, not a square plate').toBeGreaterThan(0.97);
  // Back to the turning picture — the tool for context; the other layers stay off so the cut reads.
  await page.getByTestId('viewport-camera-perspective').click();
  await page.getByTestId('viewport-layer-tool').check();
  await shoot(page, 'lobed-shaft-simulate-turning.png');

  // Unroll at the end: the same program opened flat, at the last step. The PATH and RAPIDS layers
  // are left off (the review's ask): their overlay buried the cut, and the blue depth band is what
  // this picture exists to show.
  await page.getByTestId('sim-view-unroll').click();
  await expect(page.getByTestId('sim-view-unroll')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewport-camera-top').click();
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), max);
  // A FINISHED RELIEF MUST READ AS CUT. Measured directly: the SAME unrolled view at step 0
  // (uncut) and at the last step, row by row. The cut takes the tan surface away across the part's
  // width, so a row the cut reaches is measurably darker; a sheet that only carries the path
  // overlay differs in a few thin rows, not across the band. This holds whatever ramp is used.
  await page.evaluate(() => window.__caseMaker!.simSetStep(0));
  await page.waitForTimeout(900);
  const uncut = await canvasRowMeans(page);
  await page.evaluate((step: number) => window.__caseMaker!.simSetStep(step), max);
  await page.waitForTimeout(900);
  const cut = await canvasRowMeans(page);
  expect(uncut.length).toBe(cut.length);
  const changed = uncut.filter((m, i) => Math.abs(m - (cut[i] as number)) > 3).length;
  expect(changed, 'the cut changes the unrolled stock itself, not only the path overlay').toBeGreaterThan(20);
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
  await expect.poll(async () => (await goalDrawState(page)).count, { timeout: 30_000 }).toBeGreaterThan(200);
  const drawn = await goalDrawState(page);
  expect(drawn.count, 'a refused part is still drawn').toBeGreaterThan(200);
  await shoot(page, 'oversize-refused-with-drawing.png');
});
