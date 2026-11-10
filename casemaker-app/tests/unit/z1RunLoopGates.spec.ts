// #386 review — the harness's GATES: an unanswered controller, the pre-play status gate (`Idle`,
// no alarm line beside it, an answered poll), and the alarm that arrives with no line in flight.
// Split from z1RunLoop.spec.ts for parallel running; the harness lives in ./helpers/z1RunLoopHarness.

import { describe, expect, it } from 'vitest';

import {
  RUNNING,
  END,
  AFTER,
  ALARMED,
  fakeController,
  runHarness,
} from './helpers/z1RunLoopHarness';

describe('#386 run — the harness poll loop (against a fake controller)', () => {
  it(
    'gives up, non-zero, when the controller stops answering — it does not poll a dead socket forever',
    async () => {
      const controller = await fakeController([]);
      try {
        // `--first-reply` sets every reply window in the run, and the subject here is the THREE-MISS
        // rule, not the window: a window short enough to be lost to a loaded machine's start would
        // fail this test at the pre-play poll, which is a different rule entirely.
        const { code, stderr, trace } = await runHarness(controller.port, ['--first-reply', '2000']);
        expect(code).toBe(1);
        // The pre-play poll is answered (the default idle line), so the run starts; every poll AFTER
        // `play` goes unanswered.
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?']);
        expect(stderr).toContain('no status reply');
        expect(stderr).toContain('the physical stop is the stop');
        // The trace records both sides even when the machine says nothing back.
        expect(trace).toContain('> play /sd/gcodes/fake.nc');
        expect(trace).toContain('File size 791');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );
  it(
    'refuses to play unless the status reads Idle: a running job, an alarm, or a poll nobody answered',
    async () => {
      // `play` on a machine that is already running — or in an alarm — is the one way this command
      // could turn a person's intent into something else, and the status poll is the only evidence
      // this tool has. An unanswered poll is not evidence (#386 review).
      const cases = [
        { why: 'a job is already running', before: [RUNNING], said: 'not `Idle`' },
        { why: 'the controller is alarming', before: [ALARMED], said: 'ALARM' },
        // #386 item 3: the alarm need not be in the state word. The 2026-10-12 trace's own shape —
        // a perfectly `Idle` status line, and the alarm as its own line beside it — is the case a
        // state-word-only gate plays straight through.
        {
          why: 'an alarm line sits beside an Idle reply',
          before: [`${AFTER}\r\nALARM: Probe fail\r\n`],
          said: 'ALARM: Probe fail',
        },
        { why: 'the poll went unanswered', before: [], said: 'did not answer a status poll' },
      ];
      for (const { why, before, said } of cases) {
        const controller = await fakeController([RUNNING, END], { before });
        try {
          const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--first-reply', '2000']);
          expect(stderr, why).toContain(said);
          expect(stderr, why).toContain('Nothing was played');
          expect(controller.seen, why).toEqual(['?']);
          // No summary at all: there is no job to summarize.
          expect(stdout, why).toBe('');
          expect(code, why).toBe(1);
        } finally {
          await controller.close();
        }
      }
    },
    30_000,
  );
  it(
    'ends a running job on an alarm the controller said with no line in flight (#386 item 3)',
    async () => {
      // The `M491` tail's shape on the bench: the controller keeps talking after a macro, and the
      // frame lands on the socket while the poll loop is between lines, so it belongs to no line.
      // Carrying changes where that text is SHOWN, never whether an alarm is acted on: the run ends
      // as `alarm` exactly as it would if the line had answered a poll — `out.text` being empty is
      // not evidence that nothing happened.
      const controller = await fakeController([RUNNING, AFTER, AFTER], {
        unsolicited: { afterPoll: 0, text: 'ALARM: Probe fail\r\n', delayMs: 500 },
      });
      try {
        const { code, stdout, stderr, trace } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(1);
        // Two polls: the one that reported `Run`, and the one whose carry read found the alarm. A
        // third would mean the loop kept watching a machine that had said it was in an alarm.
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?']);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'alarm', polls: 2 });
        expect(stderr).toContain('ALARM: Probe fail');
        expect(stderr).toContain('with no line in flight');
        // And the trace keeps it, marked for what it is: the person reading it later sees the alarm
        // there rather than only under the next poll's reply (#386 item 3's marker).
        expect(trace).toContain('with no line in flight');
        expect(trace).toContain('ALARM: Probe fail');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );
});
