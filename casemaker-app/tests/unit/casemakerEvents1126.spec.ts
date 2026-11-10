// #1126 — the CLI's `--events` protocol: the house service spawns `casemaker cut … --json
// --events` and follows the run by reading one JSON line at a time from stderr. The flag is the
// dispatcher's (stripped everywhere, like `--json`). Two frames ride the channel:
//
//   - the ENGINE'S OWN progress objects (`{ stage, label, done?, total? }`) — the very objects the
//     browser's worker reports, written unchanged by `eventProgress`, so the panel reads them with
//     the type it already reads the worker's with;
//   - `{ stage: 'note', label }` for each human progress line (pick words, advisories), so the run
//     log keeps them without a second channel.
//
// The point of this spec is that a human line and a machine event cannot be confused: with
// `--events`, stderr is JSON and nothing else.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatch,
  EVENTS_VALUE_REFUSED,
  type CasemakerHandlers,
} from '../../scripts/lib/casemaker/dispatch';
import { eventProgress } from '../../scripts/lib/casemaker/engrave';
import { commandOutput, HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';

function fakes(): { handlers: CasemakerHandlers; options: CommandOptions[]; argv: string[][] } {
  const options: CommandOptions[] = [];
  const argv: string[][] = [];
  const record = async (args: string[], opts: CommandOptions) => {
    argv.push(args);
    options.push(opts);
    return 0;
  };
  return {
    argv,
    options,
    handlers: {
      engrave: record,
      exportProject: record,
      location: record,
      readback: record,
      machine: record,
    },
  };
}

const io = { log: () => {}, error: () => {} };

afterEach(() => vi.restoreAllMocks());

describe('#1126 — `--events`', () => {
  it('is the dispatcher’s flag: stripped from the handler’s arguments and reported in options', async () => {
    const { handlers, options, argv } = fakes();
    expect(await dispatch(['cut', 'job.json', '--json', '--events', '--out', 'x'], handlers, io)).toBe(0);
    expect(argv[0]).toEqual(['job.json', '--out', 'x']);
    expect(options[0]).toMatchObject({ json: true, events: true });
  });

  it('refuses a value, as `--json` does: there is one event shape, not a format to negotiate', async () => {
    const { handlers, options } = fakes();
    const errors: string[] = [];
    expect(await dispatch(['cut', 'job.json', '--events=human'], handlers, { log: () => {}, error: (l) => errors.push(l) })).toBe(2);
    expect(errors.join('\n')).toContain(EVENTS_VALUE_REFUSED);
    expect(options).toHaveLength(0);
  });

  it('writes one JSON line per progress line to stderr, and no human text there', () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });

    const out = commandOutput({ ...HUMAN, json: true, events: true });
    out.progress('  pick      cutter 1 — 0.8 mm flat');

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]!.endsWith('\n')).toBe(true);
    const event = JSON.parse(stderr[0]!) as { stage: string; label: string; at?: string };
    expect(event.stage).toBe('note');
    expect(event.label).toBe('  pick      cutter 1 — 0.8 mm flat');
    // `at` is an ISO timestamp when present — the service passes it through, it does not invent one.
    if (event.at !== undefined) expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it('carries the engine’s own progress objects unchanged, one JSON line each', () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });

    const onProgress = eventProgress({ ...HUMAN, json: true, events: true });
    expect(onProgress).toBeDefined();
    const progress = { stage: 'plan' as const, label: 'planning the sequence — setup 1', done: 3, total: 9 };
    onProgress!(progress);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]!.endsWith('\n')).toBe(true);
    // Byte-for-byte the engine's object: the panel reads this with `EngraveProgress`.
    expect(JSON.parse(stderr[0]!)).toEqual(progress);

    // Without the flag there is no callback at all — the run is not made to pay for a channel
    // nobody reads.
    expect(eventProgress({ ...HUMAN, json: true })).toBeUndefined();
  });

  it('without the flag, a human run is unchanged: progress is text, not JSON', () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });

    const out = commandOutput({ ...HUMAN, json: true });
    out.progress('  pick      cutter 1 — 0.8 mm flat');
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['  pick      cutter 1 — 0.8 mm flat\n']);
    expect(() => JSON.parse(stderr[0]!.trim())).toThrow();
  });
});
