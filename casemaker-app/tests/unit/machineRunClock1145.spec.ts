// @vitest-environment jsdom
// #1145 — THE RUN'S ELAPSED IS OURS. The watch stamps the first `P:` it sees and counts wall time
// (minus suspended stretches); the run's recorded elapsed is that clock, never the controller's
// third `P:` value. The 2026-11-09 bench samples showed that field is not seconds: the same
// ~5-minute program read 1,776 at ~25 s in and 4,641 at ~4 min. Here the fake controller reports
// `P:…,50,4641` and `P:…,100,4641` throughout; the run must record a few seconds, not 77 minutes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { machineKey, resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { runClockSeconds } from '@/engine/cnc/engrave/runProgress';

const TARGET = { host: '192.0.2.10', port: 2222 };
const KEY = machineKey(TARGET);
const sent: string[] = [];

/** A controller running `runFor` polls of 50 % before finishing at 100 %; field 3 is absurd on purpose. */
function controller(runFor = 2): MachineConsoleClient {
  let played = false;
  let polls = 0;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          let text = 'ok';
          if (line === '?') {
            if (!played) text = '<Idle|MPos:0,0,0>';
            else if (polls++ < runFor) text = '<Run|MPos:0,0,0|P:10,50,4641>';
            else text = '<Idle|P:9,100,4641>';
          } else if (line.startsWith('play')) {
            played = true;
            text = 'File size 10';
          }
          return { ok: true, line, text, frames: 1, elapsedMs: 1 };
        },
        async close() {},
      };
    },
  };
}

const settings = { pollMs: 2000, noProgressMs: 600_000, missLimit: 5 };

beforeEach(() => {
  sent.length = 0;
  resetMachineRunStore();
});

afterEach(() => {
  setMachineConsoleLoader(null);
  resetMachineRunStore();
});

async function runOnce(): Promise<void> {
  useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1', { nc: 'M02\n' });
  useMachineRunStore.getState().start(TARGET, settings);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entry = useMachineRunStore.getState().runs[KEY];
    if (entry?.outcome !== null && entry?.outcome !== undefined) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the run did not end');
}

describe('#1145 — the run records OUR clock, not the controller’s third P: field', () => {
  it('stamps the first P:, and the finished run’s elapsed is seconds of wall clock — never 4,641', async () => {
    setMachineConsoleLoader(async () => controller(2));
    await runOnce();

    const entry = useMachineRunStore.getState().runs[KEY]!;
    expect(entry.firstProgressAt).not.toBeNull();
    expect(entry.firstProgressAt).toEqual(expect.any(Number));

    const outcome = entry.outcome!;
    const elapsed = 'last' in outcome ? outcome.last.elapsedS : null;
    expect(elapsed).not.toBeNull();
    // The fake's field 3 is 4,641 s (77 min); a real run of two 2 s polls is a handful of seconds.
    expect(elapsed).not.toBe(4641);
    expect(elapsed!).toBeGreaterThan(0);
    expect(elapsed!).toBeLessThan(60);
  }, 30_000);

  it('keeps the percent from the controller and resets the clock for the next run on the machine', async () => {
    setMachineConsoleLoader(async () => controller(2));
    await runOnce();
    const first = useMachineRunStore.getState().runs[KEY]!;
    expect('last' in first.outcome! ? first.outcome!.last.percent : null).toBe(100);
    expect(runClockSeconds(first, Date.now())).not.toBeNull();

    // A new run on the same machine starts with no clock until its first P:.
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-2', { nc: 'M02\n' });
    const next = useMachineRunStore.getState().runs[KEY]!;
    expect(next.firstProgressAt ?? null).toBeNull();
    expect(runClockSeconds(next, Date.now())).toBeNull();
  }, 30_000);
});
