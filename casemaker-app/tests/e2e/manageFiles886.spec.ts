// #886 — THE CARD'S FILE LIST DELETES ANY FILE AFTER ONE CONFIRMATION. On k3 the list only
// offered Delete for files this browser had uploaded, so an older program on the card could not be
// removed from the app at all. The confirm sentence now names the file and says Case Maker did not
// upload it; the two hard blocks stay (a job running, the program the machine holds), and a 1980
// stamp reads "no date" rather than a date the card made up.
//
// The card is the fake console's: `ls -e -s` answers its seeded listing and `rm` takes an entry
// away, through the house HTTP bridge the app itself uses. Nothing here ships.
import { houseServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${houseServerPort()}` });

const STATUS = '<Idle|MPos:-1,-1,-1|WPos:0,0,0>';

async function plantMachine(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: line,
        profileId: 'Z1',
        observedAt: new Date().toISOString(),
        notes: [],
      },
      line,
    );
  }, STATUS);
}

async function openFiles(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('machine-pin-open').click();
  await expect(page.getByTestId('manage-machine-card')).toBeVisible();
  const summary = page.getByTestId('manage-files-summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(page.getByTestId('manage-files-table')).toBeVisible();
}

test('#886 — a card file Case Maker did not upload asks once, in its own words, then is deleted', async ({ cm, page }) => {
  const fake = await installFakeConsole(page, {
    files: [
      { name: 'bench.nc', size: 2048, stamp: '20261031141700' },
      { name: 'old', size: 0, directory: true },
      // A card with no clock reports the epoch; the row must not say 1980-01-01.
      { name: 'spare.nc', size: 512 },
    ],
  });
  await cm.ready();
  await page.setViewportSize({ width: 1280, height: 800 });
  await plantMachine(page);
  await openFiles(page);

  // The listing is the card's, ordered as the controller gave it; the epoch stamp reads "no date".
  await expect(page.getByTestId('manage-files-name').nth(0)).toHaveText(/bench\.nc/);
  await expect(page.getByTestId('manage-files-name').nth(1)).toHaveText(/old/);
  await expect(page.getByTestId('manage-files-table')).toContainText('no date');

  // The first press asks and names the file; nothing has been sent.
  await page.getByTestId('manage-files-delete-0').click();
  const confirm = page.getByTestId('manage-files-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('didn’t upload');
  await expect(confirm).toContainText('bench.nc');
  expect(fake.lines().filter((l) => l.startsWith('rm '))).toEqual([]);

  // The second press sends Makera's own `rm <path> -e` and the card is read again.
  await page.getByTestId('manage-files-confirm-0').click();
  await expect.poll(() => fake.files().map((f) => f.name)).toEqual(['old', 'spare.nc']);
  expect(fake.lines()).toContain('rm /sd/gcodes/bench.nc -e');
  await expect(page.getByTestId('manage-files-note')).toContainText("was deleted from the machine's card");
  await expect(page.getByTestId('manage-files-name').nth(0)).toHaveText(/old/);
});

test('#886 — the program the machine holds offers no delete, confirmed or not', async ({ cm, page }) => {
  const fake = await installFakeConsole(page, {
    files: [
      { name: 'job.nc', size: 4096, stamp: '20261031141700' },
      { name: 'spare.nc', size: 512, stamp: '20261031141700' },
    ],
  });
  await cm.ready();
  await page.setViewportSize({ width: 1280, height: 800 });
  await plantMachine(page);
  // The program the machine holds, as an upload's last step leaves it.
  const prepared = await page.evaluate(() =>
    window.__caseMaker!.machineRunPrepare('192.0.2.10', 2222, 'job.nc', 'M03\nM05\n'),
  );
  expect(prepared).toBe(true);
  await openFiles(page);

  const loaded = page.getByTestId('manage-files-row').nth(0);
  await expect(loaded).toContainText('the program the machine holds');
  await expect(loaded.getByTestId('manage-files-delete-0')).toHaveCount(0);
  // Its neighbour is still offered: the block is the loaded program, not the list.
  await expect(page.getByTestId('manage-files-delete-1')).toBeVisible();
  expect(fake.lines().filter((l) => l.startsWith('rm '))).toEqual([]);
});
