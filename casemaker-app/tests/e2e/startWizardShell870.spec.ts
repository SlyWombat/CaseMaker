// #870 slices 1 and 2 — the start wizard's shell and its one file control, in a real browser, at a
// phone (400 × 900) and a desktop (1280 × 800).
//
// Slice 1: on a phone the dialog is a full-height sheet (no 128 px band above it), and on every
// step the button that leaves it is on the screen without scrolling — the header and footer are
// pinned and only the body scrolls. On a desktop the card is centred and does not scroll when its
// body is short. The counter's text is unchanged; Close is an icon with the name "Close".
//
// Slice 2: the browser's native file control is never shown, so "No file chosen" never appears
// beside the file that WAS chosen; the name sits in the row with Change. A refused file says why in
// red and the button reads "Choose another…". Part-or-mould is asked only once a mesh is read, and
// never for a picture.

import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(180_000);

const PCB = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'pcb');

/** A closed 10 × 10 × 10 mm cube, as ASCII STL. */
function cubeStl(): Buffer {
  const v = (x: number, y: number, z: number): string => `${x * 10} ${y * 10} ${z * 10}`;
  const quads: [number, number, number][][] = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  ];
  const tri = (a: number[], b: number[], c: number[]): string =>
    `facet normal 0 0 0\nouter loop\nvertex ${v(a[0]!, a[1]!, a[2]!)}\nvertex ${v(b[0]!, b[1]!, b[2]!)}\nvertex ${v(c[0]!, c[1]!, c[2]!)}\nendloop\nendfacet\n`;
  const body = quads.map(([a, b, c, d]) => tri(a!, b!, c!) + tri(a!, c!, d!)).join('');
  return Buffer.from(`solid cube\n${body}endsolid cube\n`);
}

/** A 4 × 4 grey PNG, drawn by the browser so the bytes are a real image. */
async function smallPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const g = c.getContext('2d')!;
    g.fillStyle = '#808080';
    g.fillRect(0, 0, 4, 4);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}

const VIEWPORTS = [
  { name: 'phone', width: 400, height: 900 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** The element is wholly inside the viewport as painted — no scroll asked for, none done. */
async function expectOnScreen(page: Page, el: Locator, what: string): Promise<void> {
  const vp = page.viewportSize()!;
  const b = await el.boundingBox();
  expect(b, what).not.toBeNull();
  expect(b!.y, `${what}: top`).toBeGreaterThanOrEqual(0);
  expect(b!.x, `${what}: left`).toBeGreaterThanOrEqual(0);
  expect(b!.y + b!.height, `${what}: bottom`).toBeLessThanOrEqual(vp.height + 0.5);
  expect(b!.x + b!.width, `${what}: right`).toBeLessThanOrEqual(vp.width + 0.5);
}

/** Two elements share a row: their vertical centres are within a line of each other. */
async function expectSameRow(a: Locator, b: Locator, what: string): Promise<void> {
  const ba = (await a.boundingBox())!;
  const bb = (await b.boundingBox())!;
  expect(Math.abs(ba.y + ba.height / 2 - (bb.y + bb.height / 2)), what).toBeLessThan(12);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}×${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('slice 1 — the shell: sheet or centred card, pinned footer, header and ✕', async ({ cm, page }) => {
      await cm.ready();
      await page.getByTestId('welcome-start-cnc').click();
      const dialog = page.getByTestId('start-wizard-dialog');
      await expect(dialog).toBeVisible();

      // Header: the eyebrow and the title, one counter text, the ✕ named Close, and the strip.
      await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 1 of 4 · Machine');
      await expect(page.getByTestId('start-wizard-close')).toHaveAccessibleName('Close');
      await expect(page.getByTestId('start-wizard-close')).toHaveText('✕');
      await expect(page.getByTestId('start-wizard-progress-strip').locator('.sw-progress__seg--on')).toHaveCount(1);

      const vpSize = page.viewportSize()!;
      const box = (await dialog.boundingBox())!;
      if (vp.name === 'phone') {
        // A sheet from the top edge, not a card floating 128 px down.
        expect(box.y).toBeLessThanOrEqual(16);
        expect(box.height).toBeGreaterThanOrEqual(vpSize.height - 1);
      } else {
        // Centred, and a short body leaves nothing to scroll.
        expect(Math.abs(box.x + box.width / 2 - vpSize.width / 2)).toBeLessThanOrEqual(8);
        expect(Math.abs(box.y + box.height / 2 - vpSize.height / 2)).toBeLessThanOrEqual(8);
        const scroll = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="start-wizard-dialog"]') as HTMLElement;
          const body = document.querySelector('[data-testid="start-wizard-body"]') as HTMLElement;
          return { card: card.scrollHeight - card.clientHeight, body: body.scrollHeight - body.clientHeight };
        });
        expect(scroll.card).toBeLessThanOrEqual(0);
        expect(scroll.body).toBeLessThanOrEqual(0);
      }

      // Step 1: no Back; the one primary is on the screen.
      await expect(page.getByTestId('start-wizard-back')).toHaveCount(0);
      await expectOnScreen(page, page.getByTestId('start-wizard-next'), 'step 1 primary');
      await page.getByTestId('start-wizard-next').click();

      // Step 2 — the question (#897): its primary on the screen, Back to its left.
      await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
      await expect(page.getByTestId('start-wizard-progress-strip').locator('.sw-progress__seg--on')).toHaveCount(2);
      await expectOnScreen(page, page.getByTestId('start-wizard-operation-next'), 'step 2 primary');
      await expectOnScreen(page, page.getByTestId('start-wizard-back'), 'step 2 Back');
      const back = (await page.getByTestId('start-wizard-back').boundingBox())!;
      const primary = (await page.getByTestId('start-wizard-operation-next').boundingBox())!;
      expect(back.x).toBeLessThan(primary.x);
      expect(primary.x + primary.width).toBeGreaterThan(box.x + box.width - 40);

      // #930 — a pocket gets the same house stock: the blank step opens with the stick proposed,
      // so there is no arrival sentence and the primary is live at once.
      await page.getByTestId('engrave-setup-what-pocket').click();
      await page.getByTestId('start-wizard-operation-next').click();

      // Step 3 — the blank.
      await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
      await expect(page.getByTestId('start-wizard-stock-unblock')).toHaveCount(0);
      await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText('The house’s stock');
      await expect(page.getByTestId('start-wizard-form-block')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('start-wizard-make-length')).toHaveValue('36');
      await expect(page.getByTestId('start-wizard-make-width')).toHaveValue('100');
      await expect(page.getByTestId('start-wizard-make-thickness')).toHaveValue('36');
      await expectOnScreen(page, page.getByTestId('start-wizard-stock-next'), 'step 3 primary');
      await expectOnScreen(page, page.getByTestId('start-wizard-back'), 'step 3 Back');

      await page.getByTestId('start-wizard-form-plate').click();
      await page.getByTestId('start-wizard-make-length').fill('76.2');
      await page.getByTestId('start-wizard-make-width').fill('38.1');
      await page.getByTestId('start-wizard-make-thickness').fill('3.81');
      await page.getByTestId('start-wizard-stock-next').click();

      // Step 4 — the tallest step — its primary is still on the screen without a scroll.
      await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
      await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
      await expect(page.getByTestId('start-wizard-progress-strip').locator('.sw-progress__seg--on')).toHaveCount(4);
      await expectOnScreen(page, page.getByTestId('engrave-setup-next'), 'step 4 primary');
      await page.screenshot({ path: `test-results/870-shell-${vp.name}-holding.png` });

      await page.getByTestId('start-wizard-close').click();
      await expect(page.getByTestId('start-wizard')).toHaveCount(0);
    });

    test('slice 2 — the file field: a name with Change, never "No file chosen"', async ({ cm, page }) => {
      await cm.ready();
      await page.getByTestId('welcome-start-cnc').click();
      await expect(page.getByTestId('start-wizard')).toBeVisible();
      await page.getByTestId('start-wizard-next').click();
      const dialog = page.getByTestId('start-wizard-dialog');

      // Step 2's mesh: part/mould is not asked before a mesh is read.
      await page.getByTestId('engrave-setup-what-surface').click();
      const makePart = page.getByTestId('start-wizard-op-surface-make-part');
      await expect(makePart).toHaveCount(0);
      await expect(page.getByTestId('start-wizard-op-surface-picker-choose')).toHaveText('Choose a file…');

      // An unreadable file: the reason under the field, and the button offers another.
      const surfaceInput = page.getByTestId('start-wizard-op-surface-file');
      await surfaceInput.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      await expect(page.getByTestId('start-wizard-op-surface-error')).toBeVisible();
      await expect(page.getByTestId('start-wizard-op-surface-error')).toHaveCSS('color', 'rgb(240, 180, 173)');
      await expect(page.getByTestId('start-wizard-op-surface-picker-choose')).toHaveText('Choose another…');
      await expect(makePart).toHaveCount(0);
      await expect(page.getByTestId('start-wizard-operation-next')).toBeDisabled();

      // A picture: read, named, and no part/mould question.
      await surfaceInput.setInputFiles({ name: 'relief.png', mimeType: 'image/png', buffer: await smallPng(page) });
      await expect(page.getByTestId('start-wizard-op-surface-name')).toHaveText('relief.png');
      await expect(page.getByTestId('start-wizard-op-surface-error')).toHaveCount(0);
      await expect(makePart).toHaveCount(0);

      // A mesh: the name and its box beside Change, then the part/mould question.
      await surfaceInput.setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cubeStl() });
      const surfaceName = page.getByTestId('start-wizard-op-surface-name');
      await expect(surfaceName).toHaveText('cube.stl');
      await expect(page.getByTestId('start-wizard-op-surface-picker')).toContainText('10 × 10 × 10 mm');
      await expectSameRow(surfaceName, page.getByTestId('start-wizard-op-surface-picker-change'), 'mesh name and Change');
      await expect(makePart).toBeVisible();
      await expect(dialog).not.toContainText('No file chosen');
      await expect(page.getByTestId('start-wizard-operation-next')).toBeEnabled();

      // #874 — the circuit board is a chip in "From a file". Picking it REPLACES the mesh choice,
      // and its Gerber set is the one field: the walk is blocked until the set reads (B.3's bug —
      // an import used to leave the engrave choice on, so the button stayed disabled with a
      // sentence about text nobody had been asked for).
      await page.getByTestId('engrave-setup-what-pcb').click();
      await expect(page.getByTestId('engrave-setup-what-pcb')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('start-wizard-op-surface-file')).toHaveCount(0);
      await expect(page.getByTestId('start-wizard-operation-next')).toBeDisabled();
      await expect(page.getByTestId('start-wizard-create-unblock')).toHaveText(
        "Choose the board's Gerber and drill files.",
      );

      // The circuit board's Gerbers: the set named in the row with Change.
      await page.getByTestId('start-wizard-op-pcb-files').setInputFiles(
        ['tiny-F_Cu.gbr', 'tiny-Edge_Cuts.gbr', 'tiny.drl'].map((f) => ({
          name: f,
          mimeType: 'application/octet-stream',
          buffer: fs.readFileSync(path.join(PCB, f)),
        })),
      );
      const pcbName = page.getByTestId('start-wizard-op-pcb-name');
      await expect(pcbName).toHaveText('3 files · tiny-F_Cu.gbr');
      await expect(page.getByTestId('start-wizard-op-pcb-summary')).toContainText('The board is in');
      await expectSameRow(pcbName, page.getByTestId('start-wizard-op-pcb-picker-change'), 'Gerber set and Change');
      await expect(dialog).not.toContainText('No file chosen');
      await expect(page.getByTestId('start-wizard-operation-next')).toBeEnabled();

      // The board sizes its own blank: on to the stock step, whose proposal is the board's outline.
      await page.getByTestId('start-wizard-operation-next').click();
      await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
      await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText('board');

      // Step 3's drop target lives under Technical since #1098: open the fold, then the stock
      // file's name sits in the row with Change.
      await page.getByTestId('start-wizard-stock-technical').locator('summary').click();
      await expect(page.getByTestId('start-wizard-load-hint')).toBeVisible();
      await page.getByTestId('start-wizard-load-file').setInputFiles({
        name: 'cube.stl',
        mimeType: 'model/stl',
        buffer: cubeStl(),
      });
      await expect(page.getByTestId('start-wizard-load-name')).toHaveText('cube.stl');
      await expect(page.getByTestId('start-wizard-load-change')).toBeVisible();
      await expectSameRow(page.getByTestId('start-wizard-load-name'), page.getByTestId('start-wizard-load-change'), 'step 3 name and Change');
      await expect(dialog).not.toContainText('No file chosen');
      await expect(page.getByTestId('start-wizard-stock-next')).toBeEnabled();
      await page.getByTestId('start-wizard-stock-next').click();
      await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
      await page.screenshot({ path: `test-results/870-file-field-${vp.name}.png` });

      // The last step adds no extra item: the files ARE the job's items, and there is nothing on
      // the picker's `pcb` choice for the shell to make.
      const items = (): Promise<number> =>
        page.evaluate(() => {
          const job = JSON.parse(localStorage.getItem('casemaker.engraveJob.v3') ?? '{}') as Record<string, { length?: number } | undefined>;
          const lists = ['labels', 'shapes', 'traces', 'drills', 'threads', 'primitives', 'cutouts', 'vectors', 'chamfers', 'faces'];
          return lists.reduce((n, k) => n + (job[k]?.length ?? 0), 0);
        });
      const before = await items();
      expect(before).toBeGreaterThan(0);
      await page.getByTestId('engrave-setup-next').click();
      await expect(page.getByTestId('start-wizard')).toHaveCount(0);
      expect(await items()).toBe(before);
    });
  });
}
