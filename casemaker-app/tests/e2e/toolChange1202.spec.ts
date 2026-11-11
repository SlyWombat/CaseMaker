// #1202 — THE TOOL CHANGE'S OWN CARD, ON THE FAKE MACHINE.
//
// The firmware stops in `Tool` after the program's `T<n> M6`; the app's Continue sends `M490.2`.
// That line MOVES (the controller measures the tool at the sensor and returns), so it is a motion
// routine of its own under the 2026-11-10 rule: before the press the card shows the exact line,
// marks a shape this machine has never completed, and takes the operator's own statement. The
// completion — recorded only when the controller leaves `Tool` after OUR line — is what unmarks the
// next change.
import fs from 'node:fs';
import path from 'node:path';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { houseHealth, locationDocument, serveHouse } from './fixtures/fakeHouse';
import { prepareFakeRun } from './fixtures/generatedRun';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

const OUT = path.resolve(process.cwd(), '..', 'docs', 'bench', 'img', '2026-11-11-1202-tool-change');

test('#1202 — the tool-change card shows its line, marks the first run, and the completion is recorded', async ({
  cm,
  page,
}) => {
  // The served house is real enough to hold the machine record the completion is written to; the
  // fixture machine is the one `rememberMachine` remembers (192.0.2.10:2222).
  const house = await serveHouse(page, {
    location: locationDocument(),
    health: houseHealth(),
    defaults: locationDocument().defaults,
    movingEtag: true,
    writes: 'applied',
  });
  await page.route('**/api/v1/defaults/**', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  // The controller parks in `Tool` after a few status reads and stays there until M490.2.
  const fake = await installFakeConsole(page, { steps: 40, toolWaitAtLine: 4 });
  await cm.ready();
  await prepareFakeRun(page);

  // #1123 item 8 — the Cut step's ONE Start is the run card's; the panel beside it is `startless`.
  await page.getByTestId('engrave-cut-card-start').click();
  await expect.poll(() => fake.lines().some((l) => l.startsWith('play /sd/gcodes/')), { timeout: 20_000 }).toBe(true);

  // THE STOP: the run is waiting for the tool, and the WAITING CARD carries the preview — #1123
  // item 9 moved the recovery (and A's #1202 preview with it) onto the card, where the operator is.
  const card = page.getByTestId('engrave-cut-recovery-waiting');
  await expect(card).toBeVisible({ timeout: 120_000 });
  const routine = card.getByTestId('engrave-registration-routine');
  await expect(routine).toHaveAttribute('data-routine', 'tool-change');
  const shape = await routine.getAttribute('data-shape');
  expect(shape).toMatch(/^[0-9a-f]{8}$/);
  // This machine has never continued a tool change: marked, with its own statement gate.
  await expect(card.getByTestId('engrave-registration-first-run')).toContainText(
    'has not run on this machine before',
  );
  const continueButton = card.getByTestId('engrave-cut-recovery-continue');
  await expect(continueButton).toBeDisabled();

  // THE SHOWN LIST: exactly the line the Continue will send, and the card says what it is.
  const shown = await card.evaluate((el) =>
    [...el.querySelectorAll('[data-testid^="engrave-registration-dry-line-"]')].map((line) =>
      ((line.querySelector('code')?.textContent ?? '') as string).trim(),
    ),
  );
  expect(shown).toEqual(['M490.2']);
  await expect(card.getByTestId('engrave-registration-dry-note')).toContainText('M490.2 macro');

  // Keep the proof: the marked card, above the press it holds. Taken here — the card is gone once
  // the run carries on, and a screenshot after the press waits for an element that no longer is.
  fs.mkdirSync(OUT, { recursive: true });
  await routine.screenshot({ path: path.join(OUT, 'tool-change-marked.png') });

  // THE STATEMENT, then the press.
  await card.getByTestId('engrave-registration-first-run-tick').check();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // SHOWN == SENT: the console received the line the card showed.
  await expect.poll(() => fake.lines().includes('M490.2'), { timeout: 20_000 }).toBe(true);
  for (const line of shown) expect(fake.lines(), `shown line "${line}" was sent`).toContain(line);

  // THE RUN CARRIES ON, and the record says this shape has now run here — written only after the
  // controller left `Tool` (the watch's tool-done), through the merge-safe machine PUT.
  await expect(page.getByTestId('engrave-run-lines')).toContainText('The tool change is done', {
    timeout: 60_000,
  });
  await expect
    .poll(
      () =>
        ((house.machine()['completedRoutines'] ?? []) as { routine?: string; shape?: string }[]).some(
          (e) => e.routine === 'tool-change' && e.shape === shape,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
});
