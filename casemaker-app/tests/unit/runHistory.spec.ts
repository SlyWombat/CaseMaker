/**
 * The measured-run list (#277): the region `scripts/run-readback.ts` writes, and the three pure
 * functions the panel reads it through.
 *
 * The region round trip is the part that needs a spec rather than an eyeball. The readback script
 * REWRITES `runHistory.ts` in place, so a rendering that does not match the region it replaces
 * corrupts a source file — and the failure would show up as a confusing diff, not as a red test.
 * Splicing the shipped file's own contents back into it must return the file BYTE FOR BYTE.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  MEASURED_RUNS,
  allRuns,
  lastTimedRun,
  mergeMeasuredRuns,
} from '@/engine/cnc/engrave/runHistory';
import {
  RUNS_BEGIN,
  RUNS_END,
  extractMeasuredRuns,
  regionBounds,
  renderMeasuredRuns,
  spliceMeasuredRuns,
} from '@/engine/cnc/engrave/runHistoryRegion';
import {
  isMeasuredRun,
  parseRunRecord,
  runRecordFileName,
  RUN_RECORD_INSTRUCTIONS,
  RUN_RECORD_KIND,
  RUN_RECORD_SCHEMA_VERSION,
  type RunRecord,
} from '@/engine/cnc/engrave/runRecord';
import { runSheetFileName } from '@/engine/cnc/engrave/runSheet';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'engine', 'cnc', 'engrave');
const HISTORY_PATH = join(SRC, 'runHistory.ts');
const REGION_PATH = join(SRC, 'runHistoryRegion.ts');

/** A measured run of `ncFile`, cut on `cutOn` in `minutes`. Only the fields these functions read. */
function run(ncFile: string, cutOn: string | null, minutes: number | null): RunRecord {
  return {
    kind: RUN_RECORD_KIND,
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    job: ncFile.replace(/\.nc$/, ''),
    ncFile,
    ncHash: 'abc12345',
    tool: 'flat-1.0',
    cuttingDiameter: 1,
    estimatedSeconds: 95,
    generatedOn: '2026-10-04',
    cutOn,
    minutes,
    cutter: { fluteLengthMm: null, stickOutMm: null },
    stockProudMm: null,
    depths: [],
    legible: null,
    finish: null,
    notes: '',
    instructions: RUN_RECORD_INSTRUCTIONS,
  };
}

describe('mergeMeasuredRuns (#277)', () => {
  it('adds a new run at the end', () => {
    const a = run('a.nc', '2026-10-01', 5);
    const b = run('b.nc', '2026-10-02', 6);
    expect(mergeMeasuredRuns([a], b)).toEqual([a, b]);
  });

  it('replaces the entry for the same program instead of appending a second', () => {
    const first = run('a.nc', '2026-10-01', 5);
    const again = run('a.nc', '2026-10-03', 7);
    const merged = mergeMeasuredRuns([first], again);
    expect(merged).toEqual([again]);
    // The readback's idempotence rests on this: running it twice on one record changes nothing.
    expect(mergeMeasuredRuns(merged, again)).toEqual(merged);
  });

  it('leaves other programs alone', () => {
    const a = run('a.nc', '2026-10-01', 5);
    const b = run('b.nc', '2026-10-02', 6);
    expect(mergeMeasuredRuns([a, b], run('a.nc', '2026-10-04', 9)).map((r) => r.ncFile)).toEqual([
      'b.nc',
      'a.nc',
    ]);
  });
});

describe('allRuns (#277)', () => {
  it('is the list it is given when this build ships no baked run', () => {
    const a = run('a.nc', '2026-10-01', 5);
    expect(allRuns([])).toEqual(MEASURED_RUNS);
    expect(allRuns([a])).toContainEqual(a);
  });

  it('keeps one entry per program, the imported one winning', () => {
    const baked = run('a.nc', '2026-10-01', 5);
    const imported = run('a.nc', '2026-10-05', 8);
    const both = allRuns([baked, imported]);
    const a = both.filter((r) => r.ncFile === 'a.nc');
    expect(a).toHaveLength(1);
    expect(a[0]!.minutes).toBe(8);
  });

  it('ships only records a person dated', () => {
    // Whatever the region holds, it must be a real measured run. A fabricated entry here would put
    // a bench result in front of the operator that nobody took — the thing #277 exists to prevent.
    for (const r of MEASURED_RUNS) {
      expect(parseRunRecord(r).ok, r.ncFile).toBe(true);
      expect(isMeasuredRun(r), r.ncFile).toBe(true);
    }
  });
});

describe('lastTimedRun (#277)', () => {
  const job = 'CNC 2 acceptance';
  const nc = runSheetFileName(job);

  it('finds the most recent measured run of this job\'s program', () => {
    const older = run(nc, '2026-10-01', 9);
    const newer = run(nc, '2026-10-06', 12);
    expect(lastTimedRun(job, [older, newer])?.minutes).toBe(12);
    // Order in the list does not matter; the cut date decides.
    expect(lastTimedRun(job, [newer, older])?.minutes).toBe(12);
  });

  it('ignores another job\'s program', () => {
    expect(lastTimedRun(job, [run('something-else.nc', '2026-10-06', 12)])).toBeNull();
  });

  it('ignores an undated record and a dated one with no clock', () => {
    expect(lastTimedRun(job, [run(nc, null, 12)])).toBeNull();
    expect(lastTimedRun(job, [run(nc, '2026-10-06', null)])).toBeNull();
    // And a dated, timed record is still found when those sit beside it.
    const good = run(nc, '2026-10-06', 12);
    expect(lastTimedRun(job, [run(nc, null, 1), run(nc, '2026-10-07', null), good])?.cutOn).toBe(
      '2026-10-06',
    );
  });

  it('lets the later entry win a shared cut date, so an imported run beats a baked one', () => {
    const baked = run(nc, '2026-10-06', 12);
    const imported = { ...run(nc, '2026-10-06', 20), notes: 're-measured at the bench' };
    expect(lastTimedRun(job, [baked, imported])?.minutes).toBe(20);
  });

  it('is null for a job nothing has been cut from', () => {
    expect(lastTimedRun('never cut', [])).toBeNull();
  });
});

describe('the <runs-measured> region (#277)', () => {
  const source = readFileSync(HISTORY_PATH, 'utf8');

  it('holds one marker pair, and the region module holds no copy of them', () => {
    // A second copy of the marker inside `runHistoryRegion.ts` would make a scan of the wrong file
    // splice the wrong place — silently, into source. That is why the markers are built from a name.
    expect(source.split(RUNS_BEGIN)).toHaveLength(2);
    expect(source.split(RUNS_END)).toHaveLength(2);
    const region = readFileSync(REGION_PATH, 'utf8');
    expect(region).not.toContain(RUNS_BEGIN);
    expect(region).not.toContain(RUNS_END);
  });

  it('reads back the runs it rendered, and renders the shipped file byte for byte', () => {
    const held = extractMeasuredRuns(source, HISTORY_PATH);
    expect(held).toEqual(MEASURED_RUNS);
    // The whole trade of the readback: what it writes is exactly what it would read. If these ever
    // disagree, running the script rewrites a source file with a rendering that is not its own.
    expect(spliceMeasuredRuns(source, held, HISTORY_PATH)).toBe(source);
    expect(spliceMeasuredRuns(source, [], HISTORY_PATH)).toBe(source);
  });

  it('is idempotent under a merge, and only touches the region', () => {
    const before = source.slice(0, regionBounds(source, HISTORY_PATH).start);
    const after = source.slice(regionBounds(source, HISTORY_PATH).end);

    const one = spliceMeasuredRuns(source, mergeMeasuredRuns([], run('a.nc', '2026-10-05', 4)));
    expect(one).not.toBe(source);
    expect(one.startsWith(before)).toBe(true);
    expect(one.endsWith(after)).toBe(true);

    const twice = spliceMeasuredRuns(one, extractMeasuredRuns(one, HISTORY_PATH));
    expect(twice).toBe(one);
  });

  it('refuses a file with no region rather than splicing nothing', () => {
    expect(() => extractMeasuredRuns('export const MEASURED_RUNS = [];', 'other.ts')).toThrow(/region/);
    expect(() => spliceMeasuredRuns('', [], 'other.ts')).toThrow(/region/);
  });

  it('round trips the records it renders', () => {
    const runs = [run('a.nc', '2026-10-05', 4), run('b.nc', '2026-10-06', 11)];
    const text = renderMeasuredRuns(runs);
    expect(text).toContain(`${RUNS_BEGIN}\n`);
    expect(text.endsWith(`\n${RUNS_END}`)).toBe(true);
    expect(extractMeasuredRuns(`const x = 1;\n${text}\nconst y = 2;\n`)).toEqual(runs);
  });
});

describe('the record file the readback is pointed at (#277)', () => {
  it('is the one the panel saves beside the program', () => {
    // The script is handed a path; the panel is what wrote it. One naming rule, one file.
    expect(runRecordFileName('CNC 2 acceptance')).toBe(
      `${runSheetFileName('CNC 2 acceptance').slice(0, -3)}-run.json`,
    );
  });
});
