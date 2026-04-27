import { test, expect } from './fixtures/caseMaker';

test('arrow-key nudges selected port by 0.1mm; Shift+arrow by 1mm', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const portId = await page.evaluate(() => {
    // Pick a -y facing port so left/right nudges X
    return window.__caseMaker!.getProject().ports.find((p) => p.facing === '-y')!.id;
  });
  const before = await page.evaluate((id) => {
    window.__caseMaker!.selectPort(id);
    return window.__caseMaker!.getProject().ports.find((p) => p.id === id)!.position;
  }, portId);

  // Click viewport canvas to ensure key events flow to window (not to a form input)
  await page.locator('body').click({ position: { x: 200, y: 200 } });

  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  const afterSmall = await page.evaluate(
    (id) => window.__caseMaker!.getProject().ports.find((p) => p.id === id)!.position,
    portId,
  );
  expect(afterSmall.x).toBeCloseTo(before.x + 0.1, 4);

  await page.keyboard.press('Shift+ArrowRight');
  await page.evaluate(() => window.__caseMaker!.waitForIdle());
  const afterBig = await page.evaluate(
    (id) => window.__caseMaker!.getProject().ports.find((p) => p.id === id)!.position,
    portId,
  );
  expect(afterBig.x).toBeCloseTo(before.x + 0.1 + 1, 4);
});

test('arrow-key nudges DO NOT fire while typing in an input', async ({ cm, page }) => {
  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  const portId = await page.evaluate(() => {
    const id = window.__caseMaker!.getProject().ports.find((p) => p.facing === '-y')!.id;
    window.__caseMaker!.selectPort(id);
    return id;
  });
  const before = await page.evaluate(
    (id) => window.__caseMaker!.getProject().ports.find((p) => p.id === id)!.position,
    portId,
  );

  // Focus a numeric input in the sidebar and fire arrow keys there
  const wallInput = page.getByTestId('wall-thickness-num');
  await wallInput.focus();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => window.__caseMaker!.waitForIdle());

  const after = await page.evaluate(
    (id) => window.__caseMaker!.getProject().ports.find((p) => p.id === id)!.position,
    portId,
  );
  expect(after.x).toBe(before.x);
});
