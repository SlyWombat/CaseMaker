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

  // #1035 item 11 — THE RUN COMPLETES ON THE LAID-FLAT JOB, and that is the truth of this fixture:
  // the quarter turn fits it inside the 43 × 32 blank (the placement above asserts 24 mm deep of
  // 32, inside x and y), so the finish cuts the blank's own face — the jaws stand BESIDE the stock,
  // not under the path. The old tail asserted the opposite, a jaw collision with its "would cut
  // into the vise" sentence; that sentence never came from this job: measured at bcbb8427d, the run
  // CROSSED on the sim refusing the program's cutter ("program 1 (112111313812) names
  // 112111313812, which is not on this bench"), and #1032's registry resolution removed that
  // refusal, so the sim now evaluates the real program and finds no collision. The oracle row below
  // still carries the goal check's own verdict.
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });
  // A clean run states no error row at all — neither the old jaw sentence nor the refusal it
  // actually failed on before #1032.
  await expect(page.getByTestId('engrave-run-errors')).toHaveCount(0);
  await shoot(page, 'goal-laid-flat-generated.png');

  // Cut reads the same run (#931) and, since #1036, reads it the way the run's own gate does: the
  // plan substituted the job's ⌀1 flat-1.0 for flat-3.175x12-metal, and the scopes follow the
  // POSTED programs — so the gate is the clean one the run earned, not "no program was produced".
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-surface')).not.toContainText('no program was produced');
  // The goal card's own end state: the judged coverage passes its line.
  await expect(page.getByTestId('engrave-cut-goal')).toHaveAttribute('data-state', 'match');
  await expect(page.getByTestId('engrave-cut-goal')).toHaveText('Matches the design (goal)');
});

// #949 — THE OVERSIZED GOAL IS REFUSED AT THE CAM, BEFORE A TOOLPATH EXISTS. The 30 × 24 column
// stands 75 tall but fits the 43 × 32 blank until it is moved to x 36: 8 mm of its width then lies
// past the right edge, where a clipped toolpath's finish would run along the jaws. The CAM refuses
// with its own sentence (the side, the amount, the three fixes) and posts nothing.
//
// #949 — THE REFUSAL IS `generated.errors` WITH STAGE 'cam', AND THE GATE PRINTS IT. The apply
// (`runErrorCodes`/`firstRunError`, `engraveRunGate.ts`) reads a generated error as a run error with
// its own message as the line, for any stage — so the sentence appears beside Generate and Cut reads
// the same run as "did not pass". This case is the acceptance for that surface fix.
test('#949 — the CAM refusal sentence reaches the operator, before any toolpath', async ({ cm, page }) => {
  await cm.ready();
  const job = tallJob();
  job.targetObject!.position.x = 36;
  await openJob(page, job);
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();

  await page.getByTestId('engrave-generate').click();
  const errors = page.getByTestId('engrave-run-errors');
  await expect(errors).toContainText('larger than the blank', { timeout: 120_000 });
  await expect(errors).toContainText(/mm past the (left|right|front|back) edge/);
  await expect(errors).toContainText('Fit to the stock');
  // No toolpath was built for the clipped goal. A run refused before posting states ONE sentence
  // instead of the four rows (#888), so the toolpath row is not on screen at all — and if a future
  // layout draws it, it must never tick.
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveCount(0);

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  await expect(page.getByTestId('engrave-cut-verdict')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('engrave-cut-verdict-sentence')).toContainText('larger than the blank');
});
// #876 — THE RING'S GRADUATED SCALE AND ZONE SNAP. The cursor's radius picks the precision, as
// the maintainer asked (PrusaSlicer's model): a drag whose pointer stays on the scale band tracks
// the ticks and lands exactly on a major line; the same angular drag with the pointer outside the
// band is free. No modifier key either way.
test('#876 — a ring drag in the scale band snaps; the same drag outside it does not', async ({ cm, page }) => {
  await cm.ready();
  await openJob(page, tallJob());
  await expect(page.getByTestId('engrave-target-row-0')).toBeVisible();
  // #876 — THE DISCOVERABILITY FIX. A job from a file arrives with its rows closed (#411), and
  // selecting the mesh needs the Select tool (the default is orbit), so the old "selected or row
  // open" gate left the handles undrawn — the maintainer's "I don't have axis controls" on a
  // phone. Fold the row closed if it is open, and the goal's handles must still be there.
  if ((await page.getByTestId('engrave-target-layflat-0').count()) > 0) {
    await page.getByTestId('engrave-target-expand-0').click();
  }
  await expect.poll(() => page.evaluate(() => window.__caseMaker!.engraveGoalHandleCentre())).not.toBeNull();
  if ((await page.getByTestId('engrave-target-layflat-0').count()) === 0) {
    await page.getByTestId('engrave-target-expand-0').click();
  }
  // #876 — LAY IT FLAT FIRST. Turning the 75 mm column changes the scene's diagonal by more than
  // the 35 % AutoFrame threshold, so the camera reframes MID-DRAG and the probe pixels go stale
  // (the drag then reads a free angle off the ring). A flat part's quarter turn barely changes its
  // bounding size, so the view holds still — the same reason the #831 drag above works.
  await page.getByTestId('engrave-target-layflat-0').click();
  await expect(page.getByTestId('engrave-target-layflat-said-0')).toBeVisible();
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(600);

  const pt = (deg: number) => page.evaluate((d) => window.__caseMaker!.engraveGoalHandlePoint('ring', 'x', d), deg);
  const centre = () => page.evaluate(() => window.__caseMaker!.engraveGoalHandleCentre());
  await expect.poll(() => pt(0)).not.toBeNull();

  // The clearest point on the X ring: the farthest, on screen, from the other rings and the arrows
  // (they cross it in projection, and the nearest handle under the pointer takes the press).
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
  const readout = page.getByTestId('engrave-goal-handle-readout');
  const before = (await placement(page))!;

  // IN THE BAND: press on the ring and drag along it to 90° after the start. The 90° major line
  // absorbs the pixel quantisation (mouse events carry INTEGER client pixels; on this ring a pixel
  // is worth more than a degree), and the drag lands on it exactly.
  const p0 = (await pt(start))!;
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (let d = start + 5; d <= start + 90; d += 5) {
    const p = (await pt(d))!;
    await page.mouse.move(p.x, p.y, { steps: 2 });
  }
  await expect(readout).toHaveText('X +90°');
  await page.mouse.up();
  expect((await placement(page))!.turns).not.toEqual(before.turns);
  await page.getByTestId('engrave-target-turn-undo-0').click();
  expect((await placement(page))!.turns).toEqual(before.turns);

  // OUTSIDE THE BAND: the same ring, but the pointer is pushed 40 px outward from it (the
  // fine-pointer band is 24 px deep, half of it outside the line), so the drag is free. The target
  // is 62.5° — deliberately between ticks: a snap would land on 60 or 65, the free value does not.
  const c = (await centre())!;
  const rim = (await pt(start + 62.5))!;
  const len = Math.hypot(rim.x - c.x, rim.y - c.y);
  const out = { x: c.x + ((rim.x - c.x) * (len + 40)) / len, y: c.y + ((rim.y - c.y) * (len + 40)) / len };
  const p0b = (await pt(start))!;
  await page.mouse.move(p0b.x, p0b.y);
  await page.mouse.down();
  await page.mouse.move(out.x, out.y, { steps: 3 });
  const text = (await readout.textContent()) ?? '';
  const m = /^X \+(\d+(?:\.\d)?)°$/.exec(text);
  expect(m, `the free readout is a plain angle: "${text}"`).not.toBeNull();
  const freeDeg = Number(m![1]);
  expect(Math.abs(freeDeg - 62.5)).toBeLessThan(2.5);
  // Not on the 5° grid: the free drag did not snap.
  expect(Math.abs(freeDeg - Math.round(freeDeg / 5) * 5)).toBeGreaterThan(0.3);
  await page.mouse.up();
  expect((await placement(page))!.turns).not.toEqual(before.turns);

  // #876 — THE Z ARROW: depth in the stock, the same 1 mm snap. Press at HALF the compass radius
  // along it — the rings pass the +Z axis at the full radius and the X/Y arrows lie along their
  // own axes, so half the radius is the point farthest from every other pick tube. Drag to +5 mm
  // and the stored top moves by exactly that.
  const zAt = (mm: number) => page.evaluate((v) => window.__caseMaker!.engraveGoalHandlePoint('arrow', 'z', v), mm);
  const beforeZ = (await placement(page))!.position.z;
  const placed = (await placement(page))!.placed;
  const handleR = Math.max(6, 0.5 * Math.max(placed.x, placed.y, placed.z) + 4);
  const h0 = 0.5 * handleR;
  const za = (await zAt(h0))!;
  const zb = (await zAt(h0 + 5))!;
  await page.mouse.move(za.x, za.y);
  await page.mouse.down();
  await page.mouse.move(zb.x, zb.y, { steps: 3 });
  await expect(readout).toHaveText('ΔZ +5 mm');
  await page.mouse.up();
  expect((await placement(page))!.position.z).toBeCloseTo(beforeZ + 5, 3);
});
