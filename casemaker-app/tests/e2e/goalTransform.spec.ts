// #831 — A GOAL TOO TALL FOR ITS BLANK, TURNED TO FIT. The maintainer's case: a mesh standing
// 75 mm tall on a 43 × 32 mm blank, with no way to turn it. The panel offers "Lay it flat" unasked,
// the press turns it to its shallowest orientation and fits it to the stock, and the line states
// the new depth. The on-canvas X ring is then dragged a quarter turn along its own circle (the
// placed extents show it: Y and Z swap), Undo puts the flat orientation back, and Generate goes
// through. REAL screenshots are kept under `docs/bench/img/2026-10-31-goal-transform/`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(600_000);

const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-goal-transform');
const WORK = path.join(process.cwd(), 'test-results', 'goal-transform');

type V = [number, number, number];

/** A binary STL of a closed box, with a raised boss on its +Y face (so its top is not one flat). */
function tallStl(): Buffer {
  const boxes: [number, number, number, number, number, number][] = [
    [0, 30, 0, 20, 0, 75],
    [8, 22, 20, 24, 20, 55],
  ];
  const tris: [V, V, V][] = [];
  for (const [x0, x1, y0, y1, z0, z1] of boxes) {
    const c: V[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const q = (a: number, b: number, d: number, e: number): [V, V, V][] => [
      [c[a]!, c[b]!, c[d]!],
      [c[a]!, c[d]!, c[e]!],
    ];
    tris.push(...q(4, 5, 6, 7), ...q(0, 3, 2, 1), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7));
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      buf.writeFloatLE(v[0], off);
      buf.writeFloatLE(v[1], off + 4);
      buf.writeFloatLE(v[2], off + 8);
      off += 12;
    }
    off += 2;
  }
  return buf;
}

function tallJob(): EngraveJob {
  const bytes = tallStl();
  const target: EngraveTargetObject = {
    id: 'goal-tall',
    name: 'tall-column.stl',
    format: 'stl',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
    size: { x: 30, y: 24, z: 75 },
    position: { x: 21.5, y: 16, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  const job = defaultEngraveJob();
  job.name = 'Tall goal';
  job.stock = { ...job.stock, length: 43, width: 32, thickness: 20, material: 'softwood' };
  job.labels = [];
  job.shapes = [];
  job.targetObject = target;
  job.toolKey = 'flat-1.0';
  return job;
}

async function openJob(page: Page, job: EngraveJob): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'tall-goal.job.json');
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

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, name) });
}

function placement(page: Page) {
  return page.evaluate(() => window.__caseMaker!.engraveTargetPlacement());
}

test('a 75 mm goal on a 43 × 32 blank: Lay it flat, a quarter turn on the X ring, then Generate', async ({ cm, page }) => {
  await cm.ready();
  await openJob(page, tallJob());

  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  if ((await page.getByTestId('engrave-target-layflat-0').count()) === 0) {
    await page.getByTestId('engrave-target-expand-0').click();
  }
  // Offered without being asked: it stands 75 mm, and could lie 24 mm deep.
  const suggest = page.getByTestId('engrave-target-layflat-suggest-0');
  await expect(suggest).toHaveText('It stands 75 mm tall; laid flat it would be 24 mm deep. Press Lay it flat.');
  await shoot(page, 'goal-tall-before.png');

  await page.getByTestId('engrave-target-layflat-0').click();
  const said = page.getByTestId('engrave-target-layflat-said-0');
  await expect(said).toBeVisible();
  const text = (await said.textContent()) ?? '';
  const m = /: ([\d.]+) mm deep instead of 75 mm, fitted to the stock at ([\d.]+) %\.$/.exec(text);
  expect(m, `the line states the new depth: "${text}"`).not.toBeNull();
  const depth = Number(m![1]);
  expect(depth).toBeLessThan(20); // within the 20 mm blank now
  const after = await placement(page);
  expect(after!.placed.z).toBeCloseTo(depth, 1);
  expect(after!.placed.x).toBeLessThanOrEqual(41 + 1e-6);
  expect(after!.placed.y).toBeLessThanOrEqual(30 + 1e-6);
  await expect(suggest).toHaveCount(0);
  await shoot(page, 'goal-laid-flat.png');

  // THE X RING, dragged a quarter turn along its own circle. The handles are drawn while the row is
  // open; the test surface gives the client pixel of a point on the ring at an angle.
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);
  const pt = (deg: number) => page.evaluate((d) => window.__caseMaker!.engraveGoalHandlePoint('ring', 'x', d), deg);
  await expect.poll(() => pt(0)).not.toBeNull();
  const before = (await placement(page))!;
  // Grab the ring where, on screen, it is farthest from the other two rings and the arrows (they
  // cross it in projection, and the nearest handle under the pointer takes the press).
  const others: { x: number; y: number }[] = [];
  for (let d = 0; d < 360; d += 5) {
    others.push((await page.evaluate((a) => window.__caseMaker!.engraveGoalHandlePoint('ring', 'y', a), d))!);
    others.push((await page.evaluate((a) => window.__caseMaker!.engraveGoalHandlePoint('ring', 'z', a), d))!);
  }
  for (const axis of ['x', 'y'] as const) {
    for (let mm = 0; mm <= 60; mm += 2) {
      const p = await page.evaluate(([ax, v]) => window.__caseMaker!.engraveGoalHandlePoint('arrow', ax, v), [axis, mm] as const);
      if (p !== null) others.push(p);
    }
  }
  let start = 0;
  let clearest = -1;
  for (let d = 0; d < 360; d += 5) {
    const p = (await pt(d))!;
    const gap = Math.min(...others.map((o) => Math.hypot(o.x - p.x, o.y - p.y)));
    if (gap > clearest) {
      clearest = gap;
      start = d;
    }
  }
  const p0 = (await pt(start))!;
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let d = start + 5; d <= start + 90; d += 5) {
    const p = (await pt(d))!;
    await page.mouse.move(p.x, p.y, { steps: 2 });
  }
  await expect(page.getByTestId('engrave-goal-handle-readout')).toHaveText('X +90°');
  // Shot mid-drag as it is (no reframing: that would move the held pointer).
  await page.screenshot({ path: path.join(OUT, 'goal-ring-drag.png') });
  await page.mouse.up();
  const turned = (await placement(page))!;
  // A quarter turn about X swaps the length and the height; the width is untouched.
  expect(turned.placed.x).toBeCloseTo(before.placed.x, 3);
  expect(turned.placed.y).toBeCloseTo(before.placed.z, 3);
  expect(turned.placed.z).toBeCloseTo(before.placed.y, 3);

  // Undo puts the laid-flat orientation back.
  await page.getByTestId('engrave-target-turn-undo-0').click();
  const undone = (await placement(page))!;
  expect(undone.turns).toEqual(before.turns);

  // Generate goes through on the laid-flat goal (the Undo above put it back).
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await shoot(page, 'goal-laid-flat-generated.png');
});
