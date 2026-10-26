// Issue #280, in a real browser: the welcome screen's way IN.
//
// #274's complaint was that a cutting job had no door — every card on the welcome screen creates a
// project first, and the engrave/simulate panels only exist inside a project. This walks the door:
// the wizard, the machine check, the blank, and the Engrave panel with its stock already filled in.
//
// The dev server serves the WEB target, so the machine step's honest answer here is "unavailable,
// and here is why" — which is the state worth pinning: it must never fake a success, and it must
// never block.

import { test, expect } from './fixtures/caseMaker';

test.setTimeout(180_000);

test('welcome → wizard → blank → the Engrave panel, with the stock already filled', async ({ cm, page }) => {
  await cm.ready();

  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // Step 1 — a browser cannot open a raw socket, and the wizard says so instead of offering a
  // check it cannot run (#346): the note, Cancel, and Continue without a machine.
  await expect(page.getByTestId('start-wizard-machine-note-build')).toContainText(
    'cannot control a machine',
  );
  await expect(page.getByTestId('start-wizard-check')).toHaveCount(0);
  await expect(page.getByTestId('start-wizard-next')).toHaveText('Continue without a machine');
  await page.getByTestId('start-wizard-next').click();

  // Step 2 — the stock itself. The starters are the door's (#680), not a list under the step.
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  await page.getByTestId('welcome-starter-blank').click();

  // Step 3 — the SAME modal, one counter: the project is made and the mount question follows.
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
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

  // The panel is open on the seeded job: the blank's own size, tagged as computed.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-length')).toHaveValue('100');
  await expect(page.getByTestId('engrave-stock-width')).toHaveValue('60');
  await expect(page.getByTestId('engrave-stock-thickness')).toHaveValue('12');
  await expect(page.getByTestId('engrave-stock-length-source')).toBeVisible();

  // The badge's twin button works on the blank too.
  await expect(page.getByTestId('engrave-stock-from-blank')).toBeEnabled();
  await page.getByTestId('engrave-stock-from-blank').click();
  await expect(page.getByTestId('engrave-blank-notes')).toBeVisible();

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

test('the wizard opens over an empty welcome screen and closes without making anything', async ({ cm, page }) => {
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  // Still on the welcome screen: the wizard is a way in, not a mode.
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();
});

// #680 — the welcome door's starter job. The card's "Name badge" is the badge-blank template: the
// same path step 2's template card took, from the door, with the wizard's one counter unchanged.
test('a starter on the welcome door opens the wizard with its blank as the stock', async ({ cm, page }) => {
  await cm.ready();

  const door = page.getByTestId('welcome-door-cnc');
  await expect(door).toBeVisible();
  await expect(door).toContainText('Cut something on the CNC — a badge, a plate, a pocket, an engraving.');
  // A fresh browser has no saved job files, and the card says nothing about that.
  await expect(page.getByTestId('welcome-recent-jobs')).toHaveCount(0);
  await expect(page.getByTestId('welcome-starters')).toContainText('Name badge');
  await expect(page.getByTestId('welcome-starters')).toContainText('Bare blank');

  await page.getByTestId('welcome-starter-badge-blank').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
  await page.getByTestId('start-wizard-close').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // The badge's blank, turned a quarter turn for the vise (#383): 38.1 across X, 76.2 along Y.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-stock-length')).toHaveValue('38.1');
  await expect(page.getByTestId('engrave-stock-width')).toHaveValue('76.2');
  await expect(page.getByTestId('engrave-stock-thickness')).toHaveValue('3.81');
});
