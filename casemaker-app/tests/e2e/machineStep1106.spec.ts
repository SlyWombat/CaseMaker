// #1106 items 9 + 11 — STEP 1 IS A PICKER, ON THE HOUSE'S OWN RECORDS. The location is served, so
// the step shows real rows: the Z1 is selected and Next is clickable at once (nothing is gated on
// the check), and each row draws its bed. Two states are pinned as baselines: one machine, and the
// three-record fixture with the last-used record first and selected.
import { test, expect } from './fixtures/caseMaker';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

const doc = locationDocument();
const M1 = doc.machines[0] as Record<string, unknown>;

test('step 1: one machine — selected, and Next clickable at once', async ({ cm, page }) => {
  await serveHouse(page, { location: locationView(doc) });
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  const row = page.getByTestId('start-wizard-machine-row-machine-1a2b3c');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('start-wizard-next')).toBeEnabled();
  await expect(page.getByTestId('start-wizard-step-machine')).toHaveScreenshot('machine-step-one-record.png');
});

test('step 1: three records — last used first, each row draws its bed', async ({ cm, page }) => {
  const names = ['Alpha', 'Bravo', 'Charlie'];
  const machines = ['m-a', 'm-b', 'm-c'].map((id, i) => ({
    ...M1,
    id,
    name: `Makera_Z1_00000${i + 1}`,
    nickname: names[i],
    address: { host: `192.0.2.1${i + 1}`, port: 2222 },
  }));
  // The last used machine is the SECOND record: the list puts it first, selected, with its bed drawn.
  await page.addInitScript(() => window.localStorage.setItem('casemaker.lastMachineId', 'm-b'));
  await serveHouse(page, { location: locationView({ ...doc, machines }) });
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();

  const list = page.getByTestId('start-wizard-machine-list');
  const rows = list.locator('button[data-testid^="start-wizard-machine-row-"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'start-wizard-machine-row-m-b');
  await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('start-wizard-machine-bed-m-b')).toHaveAttribute('data-mount', /vise|rotary|bed/);
  await expect(page.getByTestId('start-wizard-step-machine')).toHaveScreenshot('machine-step-three-records.png');
});
