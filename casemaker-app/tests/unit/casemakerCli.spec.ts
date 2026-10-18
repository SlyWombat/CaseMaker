// #477 — the `casemaker` dispatch layer. Handlers are fakes here on purpose: the routing and the
// two flags the dispatcher owns (`--json` → the receipt switch, `machine` → #479) are what this
// spec holds, and neither needs the wasm-bearing engrave pipeline or a spawned process.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatch,
  JSON_VALUE_REFUSED,
  MACHINE_DEFERRED,
  USAGE,
  type CasemakerHandlers,
} from '../../scripts/lib/casemaker/dispatch';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { readbackMain, type ReadbackHandlers } from '../../scripts/lib/casemaker/readbackCommand';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..', 'package.json');
const SCRIPTS = join(HERE, '..', '..', 'scripts');

interface Calls {
  engrave: string[][];
  exportProject: string[][];
  location: string[][];
  readback: string[][];
  machine: string[][];
}

function fakes(code = 0): { handlers: CasemakerHandlers; calls: Calls; options: CommandOptions[] } {
  const calls: Calls = { engrave: [], exportProject: [], location: [], readback: [], machine: [] };
  const options: CommandOptions[] = [];
  const record = (name: keyof Calls) => async (argv: string[], opts: CommandOptions) => {
    calls[name].push(argv);
    options.push(opts);
    return code;
  };
  return {
    calls,
    options,
    handlers: {
      engrave: record('engrave'),
      exportProject: record('exportProject'),
      location: record('location'),
      readback: record('readback'),
      machine: record('machine'),
    },
  };
}

function io(): { lines: string[]; errors: string[]; io: { log(l: string): void; error(l: string): void } } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { log: (l) => lines.push(l), error: (l) => errors.push(l) } };
}

afterEach(() => vi.restoreAllMocks());

describe('#477 casemaker dispatch', () => {
  it('routes each subcommand to its own handler with the remaining arguments', async () => {
    const { handlers, calls } = fakes(7);
    const out = io();

    expect(await dispatch(['engrave', 'job.json', '--out', 'x'], handlers, out.io)).toBe(7);
    expect(await dispatch(['export', 'p.json'], handlers, out.io)).toBe(7);
    expect(await dispatch(['location', 'tools', '--location', 'l.json'], handlers, out.io)).toBe(7);
    expect(await dispatch(['readback', 'feeds', 'r.json', '--dry-run'], handlers, out.io)).toBe(7);
    expect(await dispatch(['machine', 'status'], handlers, out.io)).toBe(7);

    expect(calls.engrave).toEqual([['job.json', '--out', 'x']]);
    expect(calls.exportProject).toEqual([['p.json']]);
    expect(calls.location).toEqual([['tools', '--location', 'l.json']]);
    expect(calls.readback).toEqual([['feeds', 'r.json', '--dry-run']]);
    expect(calls.machine).toEqual([['status']]);
  });

  it('prints usage for help and for no command, and nothing goes to a handler', async () => {
    const { handlers, calls } = fakes();
    const help = io();
    expect(await dispatch(['--help'], handlers, help.io)).toBe(0);
    expect(help.lines.join('\n')).toContain('usage: casemaker <command>');

    const empty = io();
    expect(await dispatch([], handlers, empty.io)).toBe(2);
    expect(empty.lines.join('\n')).toBe(USAGE);

    expect(Object.values(calls).flat()).toEqual([]);
  });

  it('refuses an unknown command without running anything', async () => {
    const { handlers, calls } = fakes();
    const out = io();
    expect(await dispatch(['frobnicate', 'x'], handlers, out.io)).toBe(2);
    expect(out.errors.join('\n')).toContain('unknown command "frobnicate"');
    expect(out.errors.join('\n')).toContain('usage: casemaker');
    expect(Object.values(calls).flat()).toEqual([]);
  });

  it('strips --json wherever it appears and tells every handler about it', async () => {
    for (const argv of [
      ['engrave', 'job.json', '--json'],
      ['--json', 'export', 'p.json'],
      ['readback', 'run', 'r.json', '--json'],
    ]) {
      const { handlers, calls, options } = fakes();
      const out = io();
      expect(await dispatch(argv, handlers, out.io)).toBe(0);
      expect(options).toEqual([{ json: true }]);
      // The flag never reaches a handler as an argument — the handler reads `options.json`.
      expect(Object.values(calls).flat().every((a) => !a.includes('--json'))).toBe(true);
      expect(out.errors).toEqual([]);
    }

    const human = fakes();
    expect(await dispatch(['engrave', 'job.json'], human.handlers, io().io)).toBe(0);
    expect(human.options).toEqual([{ json: false }]);
  });

  it('refuses a value on --json, before any handler runs', async () => {
    const { handlers, calls } = fakes();
    const out = io();
    expect(await dispatch(['location', 'tools', '--json=true'], handlers, out.io)).toBe(2);
    expect(out.errors).toEqual([`casemaker: ${JSON_VALUE_REFUSED}`]);
    expect(Object.values(calls).flat()).toEqual([]);
  });

  it('keeps the machine command as an explicit #479 refusal in the shipped handlers', async () => {
    // Imported lazily so the routing cases above stay free of the command modules.
    const { defaultHandlers } = await import('../../scripts/lib/casemaker/handlers');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    expect(await defaultHandlers.machine(['status'], HUMAN)).toBe(2);
    expect(errors.join('\n')).toContain(MACHINE_DEFERRED);
    expect(MACHINE_DEFERRED).toContain('#479');
  });

  it('publishes the bin and the npm aliases without dropping any existing script', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.bin.casemaker).toBe('scripts/casemaker.mjs');
    expect(pkg.scripts.casemaker).toContain('tsx');
    expect(pkg.scripts.casemaker).toContain('tsconfig.scripts.json');
    // The old entry points are still first-class npm scripts, so nothing documented breaks.
    for (const name of ['pilot:coupon', 'sample:export', 'thread:coupon', 'magnet:coupon', 'fit:coupon']) {
      expect(pkg.scripts[name]).toBeTruthy();
    }
    // The new aliases route through the one command.
    for (const name of ['engrave', 'export:project', 'location', 'readback:feeds', 'readback:run']) {
      expect(pkg.scripts[name]).toContain('casemaker');
    }
    // And the old script files are wrappers around the extracted commands, not copies.
    const engraveWrapper = readFileSync(join(SCRIPTS, 'engrave-job.ts'), 'utf8');
    expect(engraveWrapper).toContain("from './lib/casemaker/engrave'");
    expect(engraveWrapper).toContain('process.exitCode = await engraveJobMain');
    const feedsWrapper = readFileSync(join(SCRIPTS, 'feeds-readback.ts'), 'utf8');
    expect(feedsWrapper).toContain("from './lib/casemaker/readbackFeeds'");
    const runWrapper = readFileSync(join(SCRIPTS, 'run-readback.ts'), 'utf8');
    expect(runWrapper).toContain("from './lib/casemaker/readbackRun'");
  });
});

describe('#477 casemaker readback routing', () => {
  it('routes feeds and run with the record script’s own arguments and the receipt switch', async () => {
    const seen: Record<string, string[][]> = { feeds: [], run: [] };
    const options: CommandOptions[] = [];
    const handlers: ReadbackHandlers = {
      feeds: async (argv, opts) => {
        seen.feeds!.push(argv);
        options.push(opts);
        return 3;
      },
      run: async (argv, opts) => {
        seen.run!.push(argv);
        options.push(opts);
        return 4;
      },
    };
    expect(await readbackMain(['feeds', 'record.json', '--dry-run'], { json: true }, handlers)).toBe(3);
    expect(await readbackMain(['run', 'record.json', '--history', 'h.ts'], HUMAN, handlers)).toBe(4);
    expect(seen.feeds).toEqual([['record.json', '--dry-run']]);
    expect(seen.run).toEqual([['record.json', '--history', 'h.ts']]);
    expect(options).toEqual([{ json: true }, { json: false }]);
  });

  it('refuses a missing or unknown section without calling either readback', async () => {
    let called = 0;
    const handlers: ReadbackHandlers = {
      feeds: async () => {
        called++;
        return 0;
      },
      run: async () => {
        called++;
        return 0;
      },
    };
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    expect(await readbackMain([], HUMAN, handlers)).toBe(2);
    expect(await readbackMain(['nope'], HUMAN, handlers)).toBe(2);
    expect(errors.join('\n')).toContain('one of feeds, run');
    expect(called).toBe(0);
  });
});
