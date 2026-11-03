// #743 P-8 / #934 review — A BOARD WITH COPPER ON BOTH FACES IS REFUSED AT THE IMPORT.
//
// The engineering of a two-setup board is pinned by the unit spec (`pcbTwoSided.spec`): the
// planner, the setups, the programs, the registration on the drilled holes and the per-face copper
// oracle. The flip's SECOND-SIDE REGISTRATION has not been run on this machine, so the milestone
// refuses the flip where it is chosen — in this door, on the imported set — rather than at
// registration after the job was planned and frozen. This is that refusal in a real browser: the
// sentence appears beside the import, and no board, second setup or program exists to reach.
//
// The library is seeded (a PCB bench): a 0.1 mm engraver, the two drill sizes the tiny board's
// holes are, and a 0.8 mm corn bit that reaches through the default plank.
import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures/caseMaker';

const FIXTURES = path.resolve(process.cwd(), 'tests', 'unit', 'fixtures', 'pcb');
const ROOT = path.resolve(process.cwd(), '..');
const OUT = path.join(ROOT, 'docs', 'bench', 'img', '2026-10-31-pcb-two-sided');

test('a two-layer Gerber set is refused at the import, before any board or second setup exists', async ({ cm, page }) => {
  test.setTimeout(420_000);
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // THE APP'S OWN HOUSE READ HAS TO SETTLE BEFORE THE BENCH IS SEEDED. The tool registry loads
  // from the house service on boot and REPLACES what is there; a seed written before that answer
  // lands is gone by the time the board is imported, and the job is then "tool key not in the
  // library". Wait for the registry store to leave 'checking', then seed.
  await page.waitForFunction(() => window.__caseMaker!.getToolRegistry().status !== 'checking', undefined, {
    timeout: 60_000,
  });

  // The PCB bench's library, as the e2e needs it: every role filled, each with a PCB row, so the
  // job arrives fully assigned. flutes are long enough for the door's default plank.
  await page.evaluate(() => {
    const tool = (
      key: string,
      id: string,
      name: string,
      shape: 'engraving' | 'flat' | 'drill',
      d: number,
      extra: Record<string, number> = {},
    ) => ({
      key,
      provenance: 'the e2e’s PCB bench',
      tool: {
        number: 1,
        id,
        name,
        typeText: shape === 'engraving' ? 'Engraving' : shape === 'drill' ? 'Drill' : 'Flat End',
        shape,
        handleDiameter: 3.175,
        tipDiameter: shape === 'engraving' ? 0.1 : d,
        diameter: d,
        cornerRadius: 0,
        angle: 0,
        halfAngle: 0,
        fluteLength: 20,
        shoulderLength: 20,
        stickout: null,
        centreCutting: null,
        ...extra,
      },
    });
    window.__caseMaker!.seedCutters(
      [
        tool('inv:e2e-engrave', 'e2e-engrave-0-1-60', 'PCB engraver 0.1 mm (e2e)', 'engraving', 3.175, {
          tipDiameter: 0.1,
          halfAngle: 30,
          angle: 60,
        }),
        tool('inv:e2e-d08', 'e2e-drill-0-8', 'PCB drill 0.8 mm (e2e)', 'drill', 0.8),
        tool('inv:e2e-d10', 'e2e-drill-1-0', 'PCB drill 1 mm (e2e)', 'drill', 1.0),
        tool('inv:e2e-corn', 'e2e-corn-0-8', 'PCB corn bit 0.8 mm (e2e)', 'flat', 0.8),
      ],
      [
        { cutterId: 'e2e-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
        { cutterId: 'e2e-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
        { cutterId: 'e2e-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
        { cutterId: 'e2e-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
      ],
    );
  });
  await page.waitForFunction(
    () => window.__caseMaker!.getToolRegistry().registryKeys.includes('inv:e2e-engrave'),
    undefined,
    { timeout: 10_000 },
  );

  await page.getByTestId('engrave-pcb-input').setInputFiles([
    path.join(FIXTURES, 'tiny-F_Cu.gbr'),
    path.join(FIXTURES, 'tiny-B_Cu.gbr'),
    path.join(FIXTURES, 'tiny-Edge_Cuts.gbr'),
    path.join(FIXTURES, 'tiny-inside.drl'),
  ]);
  // #934 review — THE FLIP IS REFUSED BY NAME WHERE IT IS CHOSEN. Nothing is written: the job is
  // the one it was, there is no second setup, and there is no board to generate.
  const message = page.getByTestId('engrave-pcb-message');
  await expect(message).toContainText(/the flip’s second-side registration has not been run on this machine yet/, {
    timeout: 120_000,
  });
  await expect(message).toContainText(/cut one side/);
  await expect(page.getByTestId('engrave-pcb-stock-notice')).toHaveCount(0);
  await expect(page.getByTestId('engrave-pcb-alignment-notice')).toHaveCount(0);
  const hold = page.getByTestId('engrave-group-hold');
  if (!(await hold.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-group-hold-summary').click();
  }
  await expect(page.getByTestId('engrave-setup-2')).toHaveCount(0);
  const panel = (await page.getByTestId('engrave-panel').textContent()) ?? '';
  expect(panel).not.toContain('Isolate the bottom copper');

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'two-sided-refused.png') });
});
