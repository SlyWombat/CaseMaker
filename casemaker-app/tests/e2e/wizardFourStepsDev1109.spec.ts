// #1109 §8 — THE FOUR STEPS ON THE DEV BUILD (vise). The desktop bundle is served to a plain browser
// (the same page a local install gives a LAN browser), the machine console is G's fake controller
// (`fixtures/fakeConsole.ts`), and the wizard's own check reaches it at a typed address over the
// bridge. One screenshot per step, for the maintainer's wording review beside the web set.
//
// Step 1 is the reason this set exists: the web build cannot reach a machine, so only here do the
// state words, the found line and the device row run on the real path. Steps 2–4 walk the same
// answers as `wizardFourSteps1109.spec.ts` (web).
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

test('#1109 — the four wizard steps on the desktop bundle, one screenshot each', async ({ cm, page }) => {
  // The location is served BEFORE the console so the console's own routes stay the most recent
  // (Playwright runs the last-registered handler first).
  await serveHouse(page, { location: locationView(locationDocument()) });
  const fake = await installFakeConsole(page);
  await cm.ready();

  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // Step 1 — the machine: the location's record is the selected ROW (#1106 item 7: the old
  // "another machine…" address fold is gone). The check on open can race the location load on this
  // bundle, so the walk presses the step's own Check again once the row (and its address) is in;
  // the recorded batch is what finds the fake controller.
  await expect(page.getByTestId('start-wizard-machine-row-machine-1a2b3c')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('start-wizard-check').click();
  await expect(page.getByTestId('start-wizard-machine-state')).toContainText('Online', { timeout: 30_000 });
  expect(fake.lines()).toContain('?');
  // The baseline is the step as it settles, not a form that reached it (the route line still says how).
  await expect(page).toHaveScreenshot('1109-dev-step1-machine.png');

  // Step 2 — the question.
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you making?');
  // #1100's preset grid is the step's face: the engine's chip list (and so the pocket chip) sits
  // behind Something else…, which is where the walk's pick lives now.
  await page.getByTestId('start-wizard-preset-something-else').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await expect(page).toHaveScreenshot('1109-dev-step2-operation.png');

  // Step 3 — the blank.
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await expect(page).toHaveScreenshot('1109-dev-step3-stock.png');

  // Step 4 — holding, which the found machine makes the VISE's (this set's point).
  // #1259 — a bare pocket states no size, so the step proposes no blank: the operator types the
  // piece (the stick's numbers, so Holding below is the one it always was).
  await page.getByTestId('start-wizard-form-block').click();
  await page.getByTestId('start-wizard-make-length').fill('36');
  await page.getByTestId('start-wizard-make-width').fill('100');
  await page.getByTestId('start-wizard-make-thickness').fill('36');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-picture').first()).toHaveAttribute('data-mechanism', 'vise');
  await expect(page.getByTestId('engrave-setup-mount-row-ledge')).toBeVisible();
  await expect(page).toHaveScreenshot('1109-dev-step4-holding.png');
});
