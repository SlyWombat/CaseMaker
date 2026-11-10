// #1126 — the CLI's `--events` protocol: the house service spawns `casemaker cut … --json
// --events` and follows the run by reading one JSON line per stage from stderr. The flag is the
// dispatcher's (stripped everywhere, like `--json`), and the shape is the smallest one that can
// grow: `{ stage, pct, at? }` — the same object the runs client's SSE frames carry.
//
// `pct` is null until the engine's own `onProgress` counts are wired through (slice 2). The point
// of this spec is that a progress line and a human line cannot be confused: with `--events`,
// stderr is JSON and nothing else.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatch,
  EVENTS_VALUE_REFUSED,
  type CasemakerHandlers,
} from '../../scripts/lib/casemaker/dispatch';
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
    const event = JSON.parse(stderr[0]!) as { stage: string; pct: number | null; at?: string };
    expect(event.stage).toBe('  pick      cutter 1 — 0.8 mm flat');
    expect(event.pct).toBeNull();
    // `at` is an ISO timestamp when present — the service passes it through, it does not invent one.
    if (event.at !== undefined) expect(Number.isNaN(Date.parse(event.at))).toBe(false);
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
