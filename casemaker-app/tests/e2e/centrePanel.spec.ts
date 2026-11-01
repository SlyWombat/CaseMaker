// #827 — THE REGISTER STEP'S CENTRE PANEL, end to end on the house bundle: the fake console
// carries a bore (the bench fixture's ⌀8.88 at the plan's own centre), the panel finds it, shows
// the centre and ⌀, and the press writes the G10 origin. Screenshots under
// docs/bench/img/2026-10-31-probe-centre/.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { houseServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${houseServerPort()}` });
test.setTimeout(180_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-probe-centre');
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

async function rememberMachine(page: Page): Promise<void> {
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
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      line,
    );
  }, STATUS);
}

test('#827 — a bore’s centre becomes the origin from the Register step', async ({ cm, page }) => {
  const fake = await installFakeConsole(page);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await rememberMachine(page);
  // The plan's estimate (the stock's centre) is also the feature's centre in the fake machine.
  const at = await page.evaluate(() => window.__caseMaker!.centrePanelSeed('192.0.2.10', 2222));
  if (at === null || 'reason' in at) throw new Error(`the centre seed failed: ${at === null ? 'null' : at.reason}`);
  fake.setFeature({ kind: 'bore', radiusMm: 8.88 / 2, centre: { x: at.x, y: at.y }, topZ: -8 });

  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  // The Register step's body is where the section lives; open it if it arrived folded.
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  const section = page.getByTestId('engrave-centre');
  await expect(section).toBeVisible();

  await section.getByTestId('engrave-centre-find').click();
  await page.getByTestId('engrave-centre-continue').click(); // fit the probe
  await expect(page.getByTestId('engrave-centre-result')).toBeVisible({ timeout: 60_000 });
  // The bench fixture's ⌀8.88 at the plan's own centre.
  await expect(page.getByTestId('engrave-centre-centre')).toContainText(`X ${at.x} Y ${at.y}`);
  await expect(page.getByTestId('engrave-centre-diameter')).toContainText('8.88 mm');
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'centre-found.png') });

  // The press: the origin is written with the cutter's own M491 — the G10 goes out to the machine.
  await page.getByTestId('engrave-centre-write').click();
  await page.getByTestId('engrave-centre-continue').click(); // fit the cutter
  await expect(page.getByTestId('engrave-centre-written')).toBeVisible({ timeout: 60_000 });
  const g10 = fake.lines().find((line) => line.startsWith('G10 L2 P1 '));
  expect(g10, 'the correction line went out').toBeDefined();
  await page.screenshot({ path: path.join(OUT, 'origin-written.png') });
});
