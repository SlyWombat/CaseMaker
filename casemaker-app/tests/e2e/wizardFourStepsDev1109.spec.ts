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

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

test('#1109 — the four wizard steps on the desktop bundle, one screenshot each', async ({ cm, page }) => {
  const fake = await installFakeConsole(page);
  await cm.ready();

  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  // Step 1 — the machine. The health fold is the manual route; the fake controller answers the
  // status ask, so the check finds it and the step says so in the operator's words.
  await page.getByTestId('start-wizard-machine-another').click();
  await page.getByTestId('start-wizard-address').fill('192.0.2.10');
  await page.getByTestId('start-wizard-connect-address').click();
  await expect(page.getByTestId('start-wizard-machine-state')).toContainText('Online', { timeout: 30_000 });
  expect(fake.lines()).toContain('?');
  // The manual route folds away again: the baseline is the step as it settles, not the form that
  // reached it (the route line still says how).
  await page.getByTestId('start-wizard-machine-another').click();
  await page.screenshot({ path: 'test-results/1109-dev-step1-machine.png' });

  // Step 2 — the question.
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
  // #1100's preset grid is the step's face: the engine's chip list (and so the pocket chip) sits
  // behind Something else…, which is where the walk's pick lives now.
  await page.getByTestId('start-wizard-preset-something-else').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.screenshot({ path: 'test-results/1109-dev-step2-operation.png' });

  // Step 3 — the blank.
  await page.getByTestId('start-wizard-operation-next').click();
  await expect(page.getByTestId('start-wizard-step-stock')).toBeVisible();
  await page.screenshot({ path: 'test-results/1109-dev-step3-stock.png' });

  // Step 4 — holding, which the found machine makes the VISE's (this set's point).
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-holding-picture').first()).toHaveAttribute('data-mechanism', 'vise');
  await expect(page.getByTestId('engrave-setup-mount-row-ledge')).toBeVisible();
  await page.screenshot({ path: 'test-results/1109-dev-step4-holding.png' });
});
