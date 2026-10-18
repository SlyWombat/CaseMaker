// #206 end to end, in a real browser: the default job goes from a fresh page load to a saved
// `.nc` with four ticks, and editing the job after a Generate blocks Save until it is regenerated.
//
// The run itself (generate → verify → simulate → oracle) is exercised for real — the worker, the
// sweep and the oracle all run. Assertions read the panel's own words and the downloaded bytes,
// never pixel colours.

import { readFileSync } from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

/** Load a board (which shows the sidebar) and open the Engrave panel on the deterministic job. */
async function openEngravePanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
}

/**
 * A 12 × 12 mm plate: one closed, FILLED path, and the size stated in millimetres on the element —
 * so the parser takes the file's own units instead of assuming 96 px/inch, and the dialog has
 * nothing to warn about (#217). Written here rather than checked in, so the drawing and the row
 * asserted against it are in one file.
 */
const PLATE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12mm" height="12mm" viewBox="0 0 12 12">' +
  '<path d="M0 0 H12 V12 H0 Z"/></svg>';

// The sweep and the oracle run in the worker; under swiftshader a full run takes tens of seconds,
// so these get well past Playwright's 30 s default.
test.setTimeout(240_000);

test('the default job generates, verifies, simulates and saves a .nc', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();

  // The four rows tick, one by one, as the pipeline advances.
  await expect(page.getByTestId('engrave-run-toolpath')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-verified')).toHaveAttribute('data-state', 'tick');
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.stage).toBe('done');
  expect(state.oracleOk).toBe(true);
  expect(state.verifyErrors).toBe(0);
  expect(state.canSave).toBe(false); // the acknowledgement is still required

  // Tick the clearance box, then Save.
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-save')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('engrave-save').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.nc$/);

  const path = await download.path();
  expect(path).not.toBeNull();
  const nc = readFileSync(path!, 'utf8');
  expect(nc.startsWith(';@MKR|BEGIN')).toBe(true);
  expect(nc.trimEnd().endsWith('M02')).toBe(true);
});

test('editing the job after Generate makes the result stale and blocks Save', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-save')).toBeEnabled();

  // Change a label's depth: the run no longer describes the job on screen. #411 folds a job's
  // rows, so the field is behind the chevron.
  await page.getByTestId('engrave-label-expand-0').click();
  const depth = page.getByTestId('engrave-label-depth-0');
  await depth.fill('1.8');
  await depth.blur();

  await expect(page.getByTestId('engrave-save')).toBeDisabled();
  await expect(page.getByTestId('engrave-save-blocked')).toContainText('the job or the machine frame changed since it was generated');
});

test("the saved .nc, reloaded as a stranger's file, removes the same volume", async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  // The in-app run's own simulation: what Generate loaded and swept.
  const inApp = await page.evaluate(() => window.__caseMaker!.getSimState());
  expect(inApp.status).toBe('ready');
  expect(inApp.errorCodes).toEqual([]);
  expect(inApp.removedVolume).toBeGreaterThan(0);

  // Save the exact bytes, then open them in "Simulate .nc" as though they came from someone else.
  await page.getByTestId('engrave-ack').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('engrave-save').click();
  const path = await (await downloadPromise).path();
  expect(path).not.toBeNull();
  const nc = readFileSync(path!, 'utf8');

  await page.evaluate((text) => window.__caseMaker!.simOpenText('stranger.nc', text), nc);
  await page.evaluate(() => window.__caseMaker!.simRun());

  const reloaded = await page.evaluate(() => window.__caseMaker!.getSimState());
  expect(reloaded.status).toBe('ready');
  expect(reloaded.errorCodes).toEqual([]);
  // Same bytes, same header-declared stock and tool ⇒ the same removed volume.
  expect(reloaded.removedVolume).toBeCloseTo(inApp.removedVolume, 3);
});

// #260 — the drill half of #220 is reachable from the panel, not only by hand-editing a job:
// a hole added in the Add menu is cut as an operation of its own beside the three labels.
test('a hole added in the panel is cut as its own operation', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-drill').click();
  await expect(page.getByTestId('engrave-drill-row-0')).toBeVisible();
  // The hole is exactly the cutter's — the row says so rather than offering a diameter.
  await expect(page.getByTestId('engrave-drill-row-0')).toContainText('the cutter’s diameter');

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.ok).toBe(true);
  expect(state.stage).toBe('done');
  expect(state.verifyErrors).toBe(0);
  expect(state.operations).toBe(4); // three labels + the one hole
});

// #288 — the previewed blank drew only the REGION items, so a drilled hole was cut by the program
// and missing from the picture. The viewport's legend is built from `preview.floors`, and a floor
// exists only for a cut that was drawn — so a hole at a depth none of the three labels shares can
// only reach the legend if the preview drew it. The three label depths are 2.0, 1.0 and 0.5.
test('a drilled hole reaches the preview, not only the program (#288)', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  // The labels' own depths are on the legend before anything is added…
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible();
  for (const d of ['2', '1', '0.5']) await expect(page.getByTestId(`engrave-legend-${d}`)).toBeVisible();
  await expect(page.getByTestId('engrave-legend-3.5')).toHaveCount(0);

  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-drill').click();
  await expect(page.getByTestId('engrave-drill-row-0')).toBeVisible();
  await page.getByTestId('engrave-drill-depth-0').fill('3.5');

  // …and the hole's own depth joins them, which it can only do through a drawn floor.
  await expect(page.getByTestId('engrave-legend-3.5')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('engrave-legend-3.5')).toContainText('3.5 mm');
});

// #207's mount: "Run sheet" opens the printable operator sheet for a generated, verified job.
// The sheet is a DOCUMENT — it names the file Save writes, and under print media the app's
// chrome (the sheet's own toolbar included) is hidden so only the sheet reaches the paper.
test('the run sheet opens for a verified job, names the saved file, and prints without chrome', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  // Nothing generated yet: the sheet is not offered.
  await expect(page.getByTestId('engrave-run-sheet')).toBeDisabled();

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-run-sheet')).toBeEnabled();

  // Save writes THREE files (#273, #277): the job, the frame beside it, then the run record. Awaiting
  // only the first download is what let the frame go missing unnoticed.
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByTestId('engrave-save').click();
  await expect.poll(() => downloads.length).toBe(3);
  const suggested = downloads[0]!;
  expect(suggested).toMatch(/\.nc$/);
  expect(suggested).not.toContain('-frame.nc');
  expect(downloads[1]).toBe(suggested.replace(/\.nc$/, '-frame.nc'));
  // The record sits beside the program, named after it, and cannot be mistaken for it.
  expect(downloads[2]).toBe(suggested.replace(/\.nc$/, '-run.json'));

  // …is the name the sheet prints.
  await page.getByTestId('engrave-run-sheet').click();
  const sheet = page.getByTestId('run-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(suggested);

  // #244 — §6 names the generated frame file instead of telling the operator to raise Z by hand,
  // and #273 makes that name the file Save just wrote.
  await expect(sheet).toContainText(downloads[1]!);
  await expect(sheet).not.toContainText('Raise the work Z');

  // The print preview shows the sheet and hides the app chrome (the sheet's own toolbar too).
  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('run-sheet-print')).toBeHidden();
  await expect(page.getByTestId('sidebar-button-cnc-engrave')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByTestId('sidebar-button-cnc-engrave')).toBeVisible();
});

// #277 — the round trip. Save writes a run record beside the program with its measured half BLANK;
// the bench fills it in; opening it puts the measured wall clock BESIDE the cycle estimate, never in
// place of it. The file is the app's own download, filled in exactly as the operator would, so this
// is the whole flow and not a fixture.
test('a filled run record shows its measured run beside the estimate', async ({ cm, page }) => {
  await cm.ready();
  await openEngravePanel(page);

  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  await page.getByTestId('engrave-ack').check();
  await expect(page.getByTestId('engrave-save')).toBeEnabled();

  const downloads: { name: string; file: Download }[] = [];
  page.on('download', (d) => downloads.push({ name: d.suggestedFilename(), file: d }));
  await page.getByTestId('engrave-save').click();
  await expect.poll(() => downloads.length).toBe(3);

  const ncFile = downloads[0]!.name;
  const record = downloads.find((d) => d.name.endsWith('-run.json'))!;
  const text = readFileSync((await record.file.path())!, 'utf8');
  const blank = JSON.parse(text);

  // What the app wrote: everything it can know, and NOTHING it cannot. Not a zero, not a guess.
  expect(blank.kind).toBe('casemaker-run');
  expect(blank.ncFile).toBe(ncFile);
  expect(blank.cutOn).toBeNull();
  expect(blank.minutes).toBeNull();
  expect(blank.legible).toBeNull();
  expect(blank.finish).toBeNull();
  expect(blank.stockProudMm).toBeNull();
  expect(blank.cutter).toEqual({ fluteLengthMm: null, stickOutMm: null });
  expect(blank.ncHash).toMatch(/^[0-9a-f]{8}$/);
  // One blank per §9 depth row, and there is at least one — the sheet asks for them, so the file
  // has somewhere to answer.
  expect(blank.depths.length).toBeGreaterThan(0);
  expect(blank.depths.every((d: { measured: number | null }) => d.measured === null)).toBe(true);

  // Opening the untouched file is not an error — it is simply not a result, and nothing shows.
  const asSaved = await page.evaluate((t) => window.__caseMaker!.openRunRecordText(t), text);
  expect(asSaved.ok).toBe(true);
  await expect(page.getByTestId('engrave-last-measured')).toBeHidden();

  // The bench fills it in: the date the job was cut, and the wall clock it took.
  const filled = { ...blank, cutOn: '2026-10-05', minutes: 12.5 };
  const opened = await page.evaluate(
    (t) => window.__caseMaker!.openRunRecordText(t),
    JSON.stringify(filled),
  );
  expect(opened.ok).toBe(true);
  expect(opened.ncFile).toBe(ncFile);

  // The reading appears, with its duration and its date…
  const measured = page.getByTestId('engrave-last-measured');
  await expect(measured).toBeVisible();
  await expect(measured).toContainText('12:30');
  await expect(measured).toContainText('2026-10-05');

  // …and the estimate above it is untouched. This is the whole point of the feature: the measured
  // figure sits beside the planning figure, and neither one replaces the other.
  const estimate = await page.getByTestId('engrave-run-toolpath').textContent();
  expect(estimate).not.toContain('12:30');
  expect(estimate).toMatch(/~\d+:\d\d/);

  // The rule, end to end: the same readings with the date deleted are refused, and the line stays
  // as it was. A measurement with no date is a number nobody can place.
  const undated = await page.evaluate(
    (t) => window.__caseMaker!.openRunRecordText(t),
    JSON.stringify({ ...filled, cutOn: null }),
  );
  expect(undated.ok).toBe(false);
  expect(undated.reason).toContain('no cutOn date');
  await expect(measured).toContainText('12:30');
});

test('#368 — a badge that states its print reaches Engrave with a live colour split', async ({
  cm,
  page,
}) => {
  // The template is the route the issue is about: before #368 its badge stated no print, so the
  // blank arrived with no layer grid, the depth limit stayed analytic, and the two-state control
  // had nothing to offer — the whole two-colour half of the app was dormant on the one part it
  // was built for. This walks the user path end to end and reads what they would see.
  await cm.ready();
  await page.getByTestId('welcome-template-badge-blank').click();
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });

  const engrave = page.getByTestId('sidebar-button-cnc-engrave');
  if ((await engrave.getAttribute('aria-pressed')) !== 'true') await engrave.click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // "Use the badge blank": the job takes the badge's stock, magnet pocket and print together.
  await page.getByTestId('engrave-stock-from-badge').click();

  // The legend turns from a plain depth key into the two colours plus the plane they part at.
  //
  // #497 — this is the preview-dependent step: `takeBadgeBlank` writes the stock, and the preview
  // store rebuilds on a debounce; the legend is not rendered at all until that rebuild lands. Under
  // full-suite load it can exceed Playwright's 5 s default (reproduced: the locator was still absent
  // at 5 s), so wait for the actual post-preview state — the split row — with the 60 s budget this
  // file gives its other worker-backed steps. The assertions below are unchanged.
  const legend = page.getByTestId('engrave-preview-legend');
  // 3.0 mm of split under 0.2 mm layers: the boundary lands on the 0.8 mm line.
  await expect(page.getByTestId('engrave-legend-split')).toHaveText('split 0.8 mm down', {
    timeout: 60_000,
  });
  await expect(legend).toContainText('Colour');
  await expect(page.getByTestId('engrave-legend-top')).toContainText('top colour');
  await expect(page.getByTestId('engrave-legend-bottom')).toContainText('bottom colour');

  // The seeded line is clear of both jaws (#369), so the blank's own colour split is what binds it
  // and the walk writes the reveal itself: 0.8 + 0.2 = 1.0, one printed layer PAST the boundary — so
  // the control opens with that state already pressed. #411: the route SEEDS the line, so the row
  // arrives folded like any other.
  await page.getByTestId('engrave-label-expand-0').click();
  const depth = page.getByTestId('engrave-label-depth-0');
  await expect(depth).toHaveValue('1');
  await expect(page.getByTestId('engrave-label-reveal-0')).toHaveAttribute('aria-pressed', 'true');
  // The other state is one press away, on the other side of the same plane: the boundary less the
  // margin, 0.8 − 0.2 = 0.6, written in the same patch — which is the arithmetic the control
  // promises, read off the field the user is looking at.
  await page.getByTestId('engrave-label-surface-0').click();
  await expect(depth).toHaveValue('0.6');
  await expect(page.getByTestId('engrave-label-surface-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('engrave-label-reveal-0')).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: 'test-results/368-badge-print-split.png' });
});

test('#411 — ten items each on one line, remove at the front of the line, and undo at its site', async ({
  cm,
  page,
}) => {
  // The maintainer's own report: the list was "very cluttered", the objects could not "be easily
  // collapsed to a single line", and the remove control sat at the far right of a WRAPPING second
  // line, away from the item's name. So this is measured, not asserted in words: at a narrow-ish
  // panel every one of ten rows is ONE line, remove is the leftmost thing on it, beside the
  // show/hide box, and nothing pushes the panel sideways. The design's acceptance is "ten items fit
  // at 1440 × 900"; this runs NARROWER than that on purpose — at 1024 the rail is at its tightest,
  // so a row that fits here fits there.
  await page.setViewportSize({ width: 1024, height: 768 });
  await cm.ready();
  await openEngravePanel(page);

  // One press to open the Add menu (it is a `<details>`: pressing the summary again would close it),
  // then seven labels. The default job ships three.
  await page.getByTestId('engrave-add-summary').click();
  for (let i = 0; i < 7; i += 1) await page.getByTestId('engrave-add-label').click();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('10');
  // A row a person just added arrives OPEN (they are looking for exactly its fields); the claim
  // below is about the folded list, which is what the panel shows for a job it did not just extend.
  await page.getByTestId('engrave-item-collapse-all').click();

  const geometry = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="engrave-label-row-"]'));
    const panel = document.querySelector<HTMLElement>('[data-testid="context-panel"]')!;
    return {
      rows: rows.length,
      // One line each: every child of the head shares a vertical centre, so the row cannot be the
      // two-line box the report describes.
      split: rows.flatMap((row, i) => {
        const kids = Array.from(row.querySelector('.engrave-item-row__head')!.children) as HTMLElement[];
        const centres = kids.map((k) => {
          const r = k.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        return Math.max(...centres) - Math.min(...centres) > 2 ? [i] : [];
      }),
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      // Front cluster order, left to right, and where the name starts.
      order: rows.map((row) => {
        const at = (sel: string) => {
          const el = row.querySelector<HTMLElement>(sel);
          return el ? el.getBoundingClientRect().left : null;
        };
        return { remove: at('.engrave-item-row__remove'), show: at('.engrave-item-row__show'), name: at('.engrave-item-row__name') };
      }),
      overflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      headHeight: document.querySelector<HTMLElement>('.engrave-item-row__head')!.getBoundingClientRect().height,
    };
  });

  expect(geometry.rows).toBe(10);
  expect(geometry.split, 'rows whose head wrapped onto a second line').toEqual([]);
  // Every row is one head line plus the border: no row is a two-line box.
  expect(Math.max(...geometry.heights)).toBeLessThanOrEqual(Math.ceil(geometry.headHeight) + 12);
  for (const [i, o] of geometry.order.entries()) {
    expect(o.remove, `row ${i} has no remove on its line`).not.toBeNull();
    expect(o.remove!, `row ${i}: remove is not the frontmost control`).toBeLessThan(o.show!);
    expect(o.remove!, `row ${i}: remove wrapped away from the name`).toBeLessThan(o.name!);
  }
  expect(geometry.overflowing, 'rows whose content runs past the row').toBe(0);
  expect(geometry.panelOverflow, 'the item list pushed the panel sideways').toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/411-ten-items-one-line.png' });

  // Remove from the COLLAPSED line — the row is folded, which is the state the report was about.
  await expect(page.getByTestId('engrave-label-expand-0')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('engrave-label-remove-0').click();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('9');
  await expect(page.getByTestId('engrave-undo-what')).toHaveText('Label “CASE” removed.');

  // The undo puts it back at the index it came from, not at the end of the list.
  await page.getByTestId('engrave-undo').click();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('10');
  await expect(page.locator('[data-testid="engrave-label-row-0"] .engrave-item-row__name')).toHaveText('CASE');
  await expect(page.getByTestId('engrave-undo-strip')).toHaveCount(0);
});

test('#411 — ten MIXED items and a void on one line at 1440 × 900, and Ctrl-Z', async ({
  cm,
  page,
}) => {
  // The design's acceptance — "ten items fit at 1440 × 900" — on a job of MIXED kinds, because the
  // uniform case is the one that cannot fail: a shape pocket and a trace are different editors with
  // different widths, a void is the panel's other list, and the rows that carry a `⚠` are the ones
  // the maintainer's review changed (the sentences moved into the body, so the line must NOT have
  // grown). The list is measured where the panel is at its widest, which is where ten rows have the
  // most room and the least excuse.
  await page.setViewportSize({ width: 1440, height: 900 });
  await cm.ready();
  await openEngravePanel(page);
  await page.getByTestId('engrave-add-summary').click();

  // Ten rows, and every ROAD to one: four labels (the default job's three, which arrive folded, plus
  // one added), a shape pocket, a COMBINED shape built from the others, both kinds of trace (a
  // polyline and single-line text — different editors, same line), a hole, and an outline imported
  // FROM A FILE. The imported one is the only kind that arrives through a dialog and a parse rather
  // than a button, and the combined one is the only kind whose contents are other rows — so those
  // two are what a row's summary could quietly differ on.
  await page.getByTestId('engrave-add-label').click();
  await page.getByTestId('engrave-add-rect').click();
  await page.getByTestId('engrave-add-border').click();
  await page.getByTestId('engrave-add-line').click();
  await page.getByTestId('engrave-add-stroke-label').click();
  await page.getByTestId('engrave-add-drill').click();
  // The picker, answered the way `engraveTrace.spec.ts` answers the trace one: the e2e build uses
  // the plain file input, so this is the app's own import path and not a seam of the test's own.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('engrave-add-import-outline').click();
  await (await chooser).setFiles({
    name: 'plate.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(PLATE_SVG),
  });
  await expect(page.getByTestId('engrave-import-dialog')).toBeVisible();
  await page.getByTestId('engrave-import-accept').click();
  await expect(page.getByTestId('engrave-vector-row-0')).toBeVisible();
  // …and it is an ordinary tenth item: the vector reached the same list, with the same shell.
  await expect(page.getByTestId('engrave-vector-row-0')).toHaveCount(1);
  await expect(page.getByTestId('engrave-item-count')).toHaveText('10');

  // A VOID as well, because the review asked for one and it is the panel's other list: the same
  // shell, drawn ABOVE the items, so it pushes the ten rows down — which is the harder version of
  // "ten items fit at 1440 × 900" and the one worth measuring.
  await page.getByTestId('engrave-add-keepout-rect').click();
  await expect(page.getByTestId('engrave-keepout-row-0')).toBeVisible();

  // TWO kinds of `⚠`, because they are two claims: an ERROR blocks Generate and a WARNING does not,
  // and a line that counted them the same would be hiding the difference.
  //
  // The error is a label the person made too deep for the blank. Its row arrives open (a row just
  // added is open), so its fields are here without a press, and 11.5 mm is past the 11 mm the panel
  // says this stock allows — the finding the line must count without growing.
  await page.getByTestId('engrave-label-depth-3').fill('11.5');
  await expect(page.getByTestId('engrave-label-warn-3')).toBeVisible();
  await expect(page.getByTestId('engrave-label-warn-3')).toHaveClass(/engrave-item-row__warn--error/);
  // The warning is the hole's, and it is the default cutter's own uncertainty rather than anything
  // typed here: nothing records that the built-in cutter centre-cuts, so a job that plunges gets
  // `plunge-unproven` as a warning (`jobSetup.ts`). It sits on a FOLDED row — the drill's — which is
  // where the `⚠` has to be legible, and it must NOT be wearing the error's class.
  await expect(page.getByTestId('engrave-drill-warn-0')).toBeVisible();
  await expect(page.getByTestId('engrave-drill-warn-0')).not.toHaveClass(/engrave-item-row__warn--error/);
  await expect(page.getByTestId('engrave-drill-warn-0')).toHaveAttribute('aria-label', /warning/);
  // And a name too long for the line, on the other open row (the added pocket's name field): the name
  // has to ELIDE rather than push the front cluster away — the maintainer's "remove must never wrap
  // away from the item's name".
  await page.getByTestId('engrave-shape-name-0').fill('A NAME LONG ENOUGH THAT IT CANNOT POSSIBLY FIT');

  await page.getByTestId('engrave-item-collapse-all').click();
  await page.getByTestId('engrave-keepout-collapse-all').click();

  const geometry = await page.evaluate(() => {
    const itemRows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="engrave-label-row-"], [data-testid^="engrave-shape-row-"], ' +
          '[data-testid^="engrave-combined-row-"], [data-testid^="engrave-trace-row-"], ' +
          '[data-testid^="engrave-vector-row-"], [data-testid^="engrave-drill-row-"]',
      ),
    );
    const voidRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="engrave-keepout-row-"]'),
    );
    // Every row of either list, in document order — one shell, one set of claims.
    const rows = [...voidRows, ...itemRows];
    const head = rows[0]!.querySelector<HTMLElement>('.engrave-item-row__head')!;
    const panel = document.querySelector<HTMLElement>('[data-testid="context-panel"]')!;
    // The panel is a scroller, and a press in the Stock section above leaves it scrolled; the
    // acceptance is about the LIST, so the box it is measured in is put back at the top first.
    for (let el: HTMLElement | null = itemRows[0]!; el; el = el.parentElement) el.scrollTop = 0;
    const itemsHeading = document.querySelector<HTMLElement>('[data-testid="engrave-item-count"]')!.closest('h3')!;
    return {
      items: itemRows.length,
      voids: voidRows.length,
      // One line each: every child of the head shares a vertical centre. This is the claim the
      // maintainer's report was about, and it is the one a `⚠` or a long name could break.
      split: rows.flatMap((row, i) => {
        const centres = Array.from(row.querySelector('.engrave-item-row__head')!.children).map((k) => {
          const r = k.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        return Math.max(...centres) - Math.min(...centres) > 2 ? [i] : [];
      }),
      headHeight: head.getBoundingClientRect().height,
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      warnings: rows.filter((r) => r.querySelector('.engrave-item-row__warn') !== null).length,
      // …and the two kinds of `⚠` counted apart, because they are two claims: the class is what the
      // row uses to say which (`__warn--error`). A job with only errors in it would pass a bare
      // "something was flagged" count, so the warning-only one is counted on its own.
      warnOnly: rows.filter(
        (r) =>
          r.querySelector('.engrave-item-row__warn') !== null &&
          r.querySelector('.engrave-item-row__warn--error') === null,
      ).length,
      warnError: rows.filter((r) => r.querySelector('.engrave-item-row__warn--error') !== null).length,
      // The long name is CUT OFF rather than allowed to push the controls: a name that fits is not
      // evidence of anything, so this counts the rows whose name element is wider than its box.
      elided: rows.filter((r) => {
        const name = r.querySelector<HTMLElement>('.engrave-item-row__name');
        return name !== null && name.scrollWidth > name.clientWidth + 1;
      }).length,
      overflowing: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
      listOverflow: panel.scrollWidth - panel.clientWidth,
      // The ten item rows and their own heading, from the heading's top to the tenth row's bottom.
      // This is the design's "ten items fit at 1440 × 900" stated as what it is about: the LIST's
      // own extent. Measured on the list rather than on the panel's scroll position, because the
      // panel legitimately scrolls — the guided-setup buttons, the stock fields and the void list
      // all sit above the items, so "is the tenth row on screen right now" is a question about
      // where the scroller happens to be, not about whether the rows are one line each.
      itemsBlockHeight: Math.round(
        itemRows[itemRows.length - 1]!.getBoundingClientRect().bottom - itemsHeading.getBoundingClientRect().top,
      ),
      // …and the window that block has to fit in: the panel's own visible height, so "without
      // scrolling" is a claim about the list rather than about the whole panel.
      scrollerHeight: (() => {
        for (let el = itemRows[0]!.parentElement; el; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1) return el.clientHeight;
        }
        return window.innerHeight;
      })(),
    };
  });

  expect(geometry.items).toBe(10);
  expect(geometry.voids).toBe(1);
  expect(geometry.split, 'rows whose head wrapped onto a second line').toEqual([]);
  expect(geometry.warnings, 'the finding never reached a line').toBeGreaterThan(0);
  // Both kinds are on the line, and neither wore the other's class — which is also what keeps the
  // warning-only case honest: it is measured on the rows, not read off the panel's total.
  expect(geometry.warnOnly, 'no warning-only ⚠ — nothing tested the class that must NOT be set').toBeGreaterThan(0);
  expect(geometry.warnError, 'no error ⚠ on any row').toBeGreaterThan(0);
  expect(geometry.elided, 'the long name was not cut off — the line grew instead').toBeGreaterThan(0);
  // One head line plus the border, for every kind — including the row with the `⚠` and the long name.
  expect(Math.max(...geometry.heights)).toBeLessThanOrEqual(Math.ceil(geometry.headHeight) + 12);
  expect(geometry.overflowing, 'a row ran past its own box').toBe(0);
  expect(geometry.listOverflow, 'the list pushed the panel sideways').toBeLessThanOrEqual(0);
  // Ten rows are one line each, so the block cannot be taller than ten head lines plus the header —
  // which is the whole content of "ten items fit at 1440 × 900". Stated as arithmetic rather than as
  // a magic number: the block is what ten single-line rows and one header come to.
  expect(
    geometry.itemsBlockHeight,
    `the ten item rows and their header need ${geometry.itemsBlockHeight} px`,
  ).toBeLessThanOrEqual(10 * (Math.ceil(geometry.headHeight) + 12) + 80);
  expect(geometry.itemsBlockHeight).toBeLessThanOrEqual(900);
  // …and "without scrolling": the whole list — its header and all ten rows — fits the panel's own
  // visible height, so the person never scrolls WITHIN the list. The panel scrolls as a whole (the
  // set-up buttons, the stock fields and the void list are above it), which is what it did before
  // #411 and is not what this acceptance is about.
  expect(
    geometry.itemsBlockHeight,
    `the list needs ${geometry.itemsBlockHeight} px of the panel's ${geometry.scrollerHeight} px`,
  ).toBeLessThanOrEqual(geometry.scrollerHeight);
  await page.screenshot({ path: 'test-results/411-mixed-items-1440.png' });

  // Ctrl-Z, in the real app: the shortcut in `AppShell` gives a pending removal precedence over the
  // project's undo. The unit spec pins the rule; only here is the key actually pressed.
  await page.getByTestId('engrave-label-remove-0').click();
  await expect(page.getByTestId('engrave-item-count')).toHaveText('9');
  // Focus went to the take-back rather than to `<body>`: the press that removed the item unmounted
  // the control that held it, and a keyboard user would otherwise have to hunt along the panel for
  // the way back. Only a real browser can answer this — jsdom does not move focus on unmount.
  await expect(page.getByTestId('engrave-undo')).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('engrave-item-count')).toHaveText('10');
  await expect(page.locator('[data-testid="engrave-label-row-0"] .engrave-item-row__name')).toHaveText('CASE');
  await expect(page.getByTestId('engrave-undo-strip')).toHaveCount(0);
  // …and it comes BACK the same way it went: the Undo button was inside the strip, so taking the
  // undo removes the focused element and focus would fall to `<body>` a second time. It lands on
  // the list's own header control instead (#411 review) — the nearest thing that belongs to the
  // same list and is always there.
  await expect(page.getByTestId('engrave-item-collapse-all')).toBeFocused();
  // …and with nothing pending the key is the PROJECT's again. What that press must not do is take
  // the removal a second time: two presses after one `✕` leave the job exactly as one press did —
  // ten items, row 0 still the label it was, no strip. (The project half of that fall-through is
  // about the case, not the engrave job, and is deliberately not asserted here.)
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('engrave-item-count')).toHaveText('10');
  await expect(page.locator('[data-testid="engrave-label-row-0"] .engrave-item-row__name')).toHaveText('CASE');
  await expect(page.getByTestId('engrave-undo-strip')).toHaveCount(0);
});
