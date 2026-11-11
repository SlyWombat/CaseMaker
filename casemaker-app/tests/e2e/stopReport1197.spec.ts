// #1197 — A HOME PRESS THAT DIES ON THE LINK OFFERS ITS OWN REPORT, on the fake machine.
//
// #1187's rule: every stop on a transport or controller error offers "Send a report of this stop".
// The run panel's Stop is answered by the fake, so the reportable failure here is the Home press
// that follows it: `$H` goes out and its answer never comes, the session's reads fail with the
// relay's own words, and the panel says "Home was not sent" — with that Home's report under it.
// The report carries THIS press's failure sentence and the run's transcript, and nothing is posted
// until the operator's press.
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { prepareFakeRun } from './fixtures/generatedRun';
import type { Json } from './fixtures/fakeHouse';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

test('#1197 — a Home press on a dead link offers its own report, and the report carries that session', async ({
  cm,
  page,
}) => {
  // The house's crash-report route, captured: the only POST a report makes.
  const reports: Json[] = [];
  await page.route('**/api/v1/crash-reports', async (route) => {
    reports.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ path: 'crash-reports/stop-1197-1.json' }),
    });
  });
  const fake = await installFakeConsole(page, { steps: 12 });
  await cm.ready();
  await prepareFakeRun(page);

  const runPanel = page.getByTestId('engrave-run').first();
  await expect(runPanel).toBeVisible();
  await runPanel.getByTestId('engrave-run-start').click();
  await expect.poll(() => fake.lines().includes('play /sd/gcodes/job.nc'), { timeout: 20_000 }).toBe(true);

  // Stop is CONFIRMED by the fake (abort answered, Idle seen), so Home is offered — and it is the
  // operator's press that sends `$H`.
  await runPanel.getByTestId('engrave-run-stop').click();
  await expect(runPanel.getByTestId('engrave-run-end')).toHaveAttribute('data-kind', 'stopped', { timeout: 60_000 });
  const home = runPanel.getByTestId('engrave-run-home');
  await expect(home).toBeVisible();

  // THE LINK DIES ON THE HOME PRESS: the write goes out, its answer never comes.
  fake.failHomeWith('read failed: Connection reset by peer (os error 104)');
  await home.click();
  const note = runPanel.getByTestId('engrave-run-home-note');
  await expect(note).toContainText('Home was not sent', { timeout: 30_000 });
  await expect(note).toContainText('read failed: Connection reset by peer');
  const action = runPanel.getByTestId('stop-report-action');
  await expect(action).toHaveAttribute('data-action', 'home');
  // NOTHING has been posted: the action is the only door.
  expect(reports).toHaveLength(0);

  await action.getByTestId('stop-report-send').click();
  await expect(action.getByTestId('stop-report-sent')).toContainText('crash-reports/stop-1197-1.json');
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report['kind']).toBe('casemaker-machine-stop-report');
  expect(report['version']).toBe(1);
  expect(report['action']).toBe('home');
  // THAT press's failure sentence, not the panel's "home it by hand" note.
  expect(String(report['error'])).toContain('read failed: Connection reset by peer (os error 104)');
  // THIS run's conversation, not the dock's display strings (#1208): the play line is the app's,
  // with the controller's answer beside it, and every status poll is a real `?` line.
  const transcript = report['transcript'] as { line: string; reply: string }[];
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript.some((entry) => entry.line === 'play /sd/gcodes/job.nc')).toBe(true);
  expect(transcript.every((entry) => entry.line !== '')).toBe(true);
  expect(transcript.some((entry) => entry.line === '?')).toBe(true);
  // The machine and the job the entry names.
  const machine = report['machine'] as { host: string; port: number };
  expect(machine).toEqual({ host: '192.0.2.10', port: 2222 });
  const job = report['job'] as { id: string; name: string; packageHash: string | null };
  expect(job.id.length).toBeGreaterThan(0);
  expect(typeof job.name).toBe('string');
});
