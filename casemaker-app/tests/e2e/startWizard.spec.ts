// Issue #280, in a real browser: the welcome screen's way IN.
//
// #274's complaint was that a cutting job had no door — every card on the welcome screen creates a
// project first, and the engrave/simulate panels only exist inside a project. This walks the door:
// the wizard, the machine check, the blank, and the Engrave panel with its stock already filled in.
//
// The dev server serves the WEB target, so the machine step's honest answer here is "unavailable,
// and here is why" — which is the state worth pinning: it must never fake a success, and it must
// never block.

import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(180_000);

test('welcome → wizard → blank → the Engrave panel, with the stock already filled', async ({ cm, page }) => {
  await cm.ready();

  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // Step 1 — the e2e server is the relay-less web build, and the wizard says why instead of
  // offering a check it cannot run (#346/#821): the note, Cancel, and Continue without a machine.
  await expect(page.getByTestId('start-wizard-machine-note-build')).toContainText(
    'without the machine relay',
  );
  await expect(page.getByTestId('start-wizard-check')).toHaveCount(0);
  await expect(page.getByTestId('start-wizard-next')).toHaveText('Continue without a machine');
  await page.getByTestId('start-wizard-next').click();

  // Step 2 — the question, first since #897: its answer is what the blank is sized from.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
  await page.getByTestId('start-wizard-op-text').fill('Hello');
  await page.getByTestId('start-wizard-operation-next').click();

  // Step 3 — the stock: #930 proposes the house's stick for a line of text (the work no longer
  // sizes a plate from its ink). The starters are the door's (#680), not a list under the step.
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText(
    'The stock this workshop keeps: a 36 × 36 × 100 mm hardwood stick, worked on its 36 × 100 face.',
  );
  await page.getByTestId('start-wizard-close').click();
  // #1123 item 2 — ✕ leaves the operator in the CNC workspace, not on the door. The starters are
  // the door's, so this walk reloads (a fresh load opens there) before taking one.
  await cm.ready();
  await page.getByTestId('welcome-starter-blank').click();

  // Step 3 — the SAME modal, one counter: the project is made and the mount question follows.
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-flow')).toHaveCount(0);
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // The blank's rail: Part, Export and the two CNC panels, and nothing board-shaped.
  await expect(page.getByTestId('sidebar-button-part')).toBeVisible();
  await expect(page.getByTestId('sidebar-button-export')).toBeVisible();
  await expect(page.getByTestId('sidebar-button-cnc-engrave')).toBeVisible();
  await expect(page.getByTestId('sidebar-button-cnc-sim')).toBeVisible();
  for (const id of ['board', 'case', 'ports', 'hats', 'features', 'assets', 'rack', 'insert']) {
    await expect(page.getByTestId(`sidebar-button-${id}`), `${id} should be hidden`).toHaveCount(0);
  }

  // The panel is open on the seeded job: the blank's own size, on the one stock line (#686).
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-line')).toContainText('100 × 60 × 12 mm');
  // The line's hover says where the numbers came from — the wizard's seed, not a typed value.
  await expect(page.getByTestId('engrave-stock-line')).toHaveAttribute('title', /length computed/);

  // #686 — the blank's twin route is no longer a button under a field grid: the line's edit opens
  // the wizard's stock step, where the same blank starter lives. The panel still reads what the
  // seed wrote, which is what the assertions above prove.
  // #807 — the Stock row is the disclosure; its edit is in the opened body.
  await page.getByTestId('engrave-stock-line').click();
  await expect(page.getByTestId('engrave-stock-edit')).toBeEnabled();

  // And the geometry really is the one centred plate — no placeholder PCB, no shell.
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
  const graph = await page.evaluate(() =>
    window.__caseMaker!.getSceneGraph().map((n) => n.id),
  );
  expect(graph).toEqual(['blank']);

  // #282 — the blank's own parameters, editable at last. The corner radius is the one #282 called
  // unreachable by ANY route: no bridge carried it, and no section could hold it.
  await page.getByTestId('sidebar-button-part').click();
  await expect(page.getByTestId('part-panel')).toBeVisible();
  await expect(page.getByTestId('blank-corner-radius')).toHaveValue('3');

  await page.getByTestId('blank-corner-radius').fill('12');
  await expect(page.getByTestId('part-summary')).toContainText('R12');
  await page.evaluate(async () => {
    await window.__caseMaker!.waitForIdle();
  });
  // Still one piece, and a rounded one: the radius removed no geometry, it added facets.
  const rounded = await page.evaluate(() =>
    window.__caseMaker!.getSceneGraph().map((n) => n.id),
  );
  expect(rounded).toEqual(['blank']);
  await expect(page.getByTestId('part-summary')).toContainText('100 × 60 × 12');

  // ...and an impossible one is a stated reason, not a blank panel.
  await page.getByTestId('blank-corner-radius').fill('40');
  await expect(page.getByTestId('part-problem')).toContainText('too big for a 100 × 60 mm blank');
});

test('the wizard opens over the CNC workspace, and closes leaving the operator there', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  // #1123 item 2 — ✕ puts the wizard away, not the operator: the Job panel is the screen behind it.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
});

test('step 2 with nothing picked creates the empty job and lands on the Job panel (#1123 item 3)', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText(
    'Step 2 of 4 · What are you cutting?',
  );
  // Nothing picked: the press CREATES the empty job instead of waiting for invented text.
  await expect(page.getByTestId('start-wizard-operation-next')).toHaveText('Create the job');
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-job-file-name')).toContainText('Untitled job');
  await expect(page.getByTestId('welcome-overlay')).toHaveCount(0);
});

// #897 — A MESH GOAL SIZES ITS BLANK. The question comes first, so the file is read before the
// stock is asked; the blank it proposes is the mesh's own box plus the stated margin, and the goal
// is seated at the centre of THAT blank (not the demo plank it was read against).
const BLOCK = fileURLToPath(new URL('./fixtures/chamfered-block.stl', import.meta.url));

test('#897 — a mesh goal proposes its box, and is centred on the blank it lands on', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');

  await page.getByTestId('engrave-setup-what-surface').click();
  await page.getByTestId('start-wizard-op-surface-file').setInputFiles(BLOCK);
  await expect(page.getByTestId('start-wizard-op-surface-name')).toHaveText('chamfered-block.stl');
  await expect(page.getByTestId('start-wizard-operation-next')).toBeEnabled();
  await page.getByTestId('start-wizard-operation-next').click();

  // The 20 × 20 × 6 mm block, plus 5 mm each side and 1 mm under it.
  await expect(page.getByTestId('engrave-setup-stock-provenance')).toContainText('Sized from the mesh');
  await expect(page.getByTestId('start-wizard-make-length')).toHaveValue('30');
  await expect(page.getByTestId('start-wizard-make-width')).toHaveValue('30');
  await expect(page.getByTestId('start-wizard-make-thickness')).toHaveValue('7');

  // The hold follows from the blank, and the last step creates the goal.
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  // #1103 — THE SEAT READS THE WORK: a 6 mm surfacing pass reaches the blank's edge, so the reason
  // line states what the recommendation judged instead of the wizard silently gripping it as a
  // block. The screenshot is the hand-in's record.
  const reason = page.getByTestId('engrave-setup-recommendation-reason');
  await expect(reason).toBeVisible();
  await expect(reason).toContainText('Recommended:');
  await expect(reason).toContainText('jaw');
  await page.getByTestId('engrave-setup-step-holding').screenshot({ path: 'test-results/1103-holding-seat.png' });
  await expect(page.getByTestId('engrave-setup-next')).toBeEnabled();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  const job = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('casemaker.engraveJob.v3') ?? 'null'),
  );
  expect(job.stock).toMatchObject({ length: 30, width: 30, thickness: 7 });
  expect(job.targetObject.position).toEqual({ x: 15, y: 15, z: 0 });
  expect(job.targetObject.size).toEqual({ x: 20, y: 20, z: 6 });
});

// #680 — the welcome door's starter job. The card's "Name badge" is the badge-blank template: the
// same path the stock step's template card took, from the door, with the wizard's one counter unchanged.
test('a starter on the welcome door opens the wizard with its blank as the stock', async ({ cm, page }) => {
  await cm.ready();

  const door = page.getByTestId('welcome-door-cnc');
  await expect(door).toBeVisible();
  await expect(door).toContainText('Carve hardwood on the CNC — a name plate, a coaster, a pocket, an engraving.');
  // A fresh browser has no saved job files, and the card says nothing about that.
  await expect(page.getByTestId('welcome-recent-jobs')).toHaveCount(0);
  await expect(page.getByTestId('welcome-starters')).toContainText('Name badge');
  await expect(page.getByTestId('welcome-starters')).toContainText('Bare blank');

  await page.getByTestId('welcome-starter-badge-blank').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // The badge's blank, turned a quarter turn for the vise (#383): 38.1 across X, 76.2 along Y.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-line')).toContainText('38.1 × 76.2 × 3.81 mm');
});

// #698 — the orientation fold is the operator's bench instruction, not a job field: three labelled
// pictures of the landmarks, drawn in the Holding step's own top-view frame (fixed jaw LEFT, the
// operator's front BOTTOM), with the pictures really drawn and not overlapping on a phone.
test('#698 — the orientation fold draws the three landmarks, on the desktop and at 390 px', async ({ cm, page }) => {
  await cm.ready();

  // The badge starter brings a printed blank — a face worth telling apart — and lands on Holding.
  await page.getByTestId('welcome-starter-badge-blank').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();

  // #1101 — the hold cards and the landmarks are ONE fold now, "Which way round".
  const fold = page.getByTestId('engrave-setup-hold-fold');
  await expect(fold).toBeVisible();
  await expect(fold.locator('summary')).toContainText('Which way round');
  await fold.locator('summary').click();
  await expect(fold).toHaveJSProperty('open', true);

  const cards = [
    { key: 'face-up', label: 'Face up', caption: /The printed face is up, where the cutter can reach it\./ },
    { key: 'fixed-jaw', label: 'Against the fixed jaw', caption: /The left edge is flat against the fixed jaw/ },
    { key: 'nearest', label: 'Nearest you', caption: /The front edge is closest to you/ },
  ];
  for (const card of cards) {
    await expect(page.getByTestId(`engrave-setup-orientation-label-${card.key}`)).toHaveText(card.label);
    await expect(page.getByTestId(`engrave-setup-orientation-caption-${card.key}`)).toHaveText(card.caption);
    await expect(page.getByTestId(`engrave-setup-orientation-picture-${card.key}`)).toBeVisible();
  }
  // Stated facts, not a choice: nothing to operate among the landmark pictures (A10). The hold
  // cards beside them are the fold's own choice (#1101), not part of the landmark list.
  await expect(page.getByTestId('engrave-setup-orientation-pictures').locator('select, input, button')).toHaveCount(0);

  type Box = { key: string; left: number; top: number; right: number; bottom: number; w: number; h: number };
  const boxes = async (): Promise<Box[]> =>
    page.evaluate(() => {
      const out: Box[] = [];
      for (const key of ['face-up', 'fixed-jaw', 'nearest']) {
        const el = document.querySelector<SVGSVGElement>(
          `[data-testid="engrave-setup-orientation-picture-${key}"]`,
        );
        if (el === null) continue;
        const r = el.getBoundingClientRect();
        out.push({ key, left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height });
      }
      return out;
    });
  const assertDrawnNoOverlap = (found: Box[]): void => {
    expect(found.map((b) => b.key)).toEqual(['face-up', 'fixed-jaw', 'nearest']);
    for (const b of found) {
      expect(b.w, `${b.key} width`).toBeGreaterThan(0);
      expect(b.h, `${b.key} height`).toBeGreaterThan(0);
    }
    for (let i = 0; i < found.length; i += 1) {
      for (let j = i + 1; j < found.length; j += 1) {
        const a = found[i]!;
        const b = found[j]!;
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlap, `${a.key} overlaps ${b.key}`).toBe(false);
      }
    }
  };

  // Desktop: all three pictures draw, each with its own label, and none overlaps another.
  await fold.scrollIntoViewIfNeeded();
  assertDrawnNoOverlap(await boxes());
  await page.screenshot({ path: 'test-results/698-orientation-desktop.png' });

  // Phone width: the same three pictures still draw; still no overlap, no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fold).toBeVisible();
  await fold.scrollIntoViewIfNeeded();
  assertDrawnNoOverlap(await boxes());
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll, 'phone horizontal scroll').toBeLessThanOrEqual(width.client);
  await page.screenshot({ path: 'test-results/698-orientation-phone.png' });
});
