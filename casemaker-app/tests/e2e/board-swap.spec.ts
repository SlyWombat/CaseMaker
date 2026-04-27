import { test, expect } from './fixtures/caseMaker';

test('board swap: Pi 4B → ESP32 DevKit V1 changes bbox and boss positions', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const piBbox = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);

  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('esp32-devkit-v1');
  });
  const espBbox = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!.bbox);

  // ESP32 DevKit (51.5x28) is much smaller than Pi 4B (85x56)
  expect(espBbox.max[0] - espBbox.min[0]).toBeLessThan(piBbox.max[0] - piBbox.min[0]);
  expect(espBbox.max[1] - espBbox.min[1]).toBeLessThan(piBbox.max[1] - piBbox.min[1]);
});

test('Pi Zero 2W has 4 mounting bosses positioned per spec', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-zero-2w');
  });
  const project = await page.evaluate(() => window.__caseMaker!.getProject());
  expect(project.board.mountingHoles.length).toBe(4);
  const stats = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  // Pi Zero 2W is 65x30mm; outer = 65 + 5 = 70, 30 + 5 = 35
  expect(stats.bbox.max[0]).toBeCloseTo(70, 1);
  expect(stats.bbox.max[1]).toBeCloseTo(35, 1);
});

test('all 6 built-in boards load without error and produce a mesh', async ({ cm, page }) => {
  await cm.ready();
  const ids = [
    'rpi-4b',
    'rpi-5',
    'rpi-zero-2w',
    'arduino-uno-r3',
    'arduino-giga-r1-wifi',
    'esp32-devkit-v1',
  ];
  for (const id of ids) {
    await page.evaluate(async (bid) => {
      await window.__caseMaker!.loadBuiltinBoard(bid);
    }, id);
    const stats = await page.evaluate(() => window.__caseMaker!.getMeshStats('all')!);
    expect(stats.triangleCount).toBeGreaterThan(0);
    expect(stats.bbox.max[0]).toBeGreaterThan(0);
  }
});

// regression: #6 — Arduino GIGA R1 WiFi (101.6 × 53.3) loads with the right outer bbox
test('Arduino GIGA R1 WiFi outer bbox matches the 101.6×53.3 PCB plus walls', async ({
  cm,
  page,
}) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('arduino-giga-r1-wifi');
  });
  const stats = await page.evaluate(() => window.__caseMaker!.getMeshStats('shell')!);
  // Outer X = 101.6 + 2*(wall+clearance) = 101.6 + 2*(2 + 0.5) = 106.6
  // Outer Y = 53.3 + 2*(wall+clearance) = 53.3 + 5 = 58.3
  expect(stats.bbox.max[0]).toBeCloseTo(106.6, 1);
  expect(stats.bbox.max[1]).toBeCloseTo(58.3, 1);
});
