// #735 item 3 — a taped through cut is judged by the BED on the Cut gate, not by the vise.
//
// #712 gave the through-cut refusal the bed's own words ("…only the bed is under it — put a 2 mm
// MDF board under it, or tape it on the wasteboard"), and #725 B7 handed those facts to the Design
// panel's fallback. The Cut gate's collector called `validateJob(job)` with no facts at all, so a
// taped through cut with no under-board of its own was blocked in the pre-#712 words ("add one
// under the part or this cut reaches the vise") — even over a wasteboard deep enough to take the
// cut, on a job the Generate itself accepts.
//
// The job is the bench set's taped through-cut fixture, j15-acrylic-keychain-proxy-adjusted (tape,
// 3 mm PLA, a two-tab cut-out). Its document carries its own 6 mm under-board; the test clears it to
// model the part taped straight on the machine's bed, which is the state the bed facts exist to
// judge. The fixture files are untouched.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preflightHub, type PreflightHubInput } from '@/engine/cnc/preflight';
import type { BedUnderFacts } from '@/engine/cnc/engrave/jobSetup';
import { bedUnderFacts } from '@/platform/bedProfiles';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { MachineRecordSchema } from '@/platform/locationClient';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_JOB = resolve(HERE, '../../../docs/bench/2026-10-27-z1-typical-jobs/jobs/j15-acrylic-keychain-proxy-adjusted.json');

const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: unknown[];
  defaults: unknown;
};
// The house's own reading: the location fixture's machine (a 10 mm wasteboard) and shop defaults.
// `bedUnderFacts` is the one builder the panel and the Cut surface use, so the test's facts are the
// app's facts.
function houseBed(job: EngraveJob): BedUnderFacts {
  const machine = MachineRecordSchema.parse(DOC.machines[0]);
  const defaults: ShopDefaults = ShopDefaultsSchema.parse(DOC.defaults);
  const bed = bedUnderFacts(machine, defaults, job.breakthrough + 1, {
    length: job.stock.length,
    width: job.stock.width,
  });
  if (bed === null) throw new Error('the location fixture no longer has an active bed profile');
  return bed;
}

/** The bench fixture's taped through-cut job, with the part taped straight on the bed. */
function tapedThroughJob(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(BENCH_JOB, 'utf8')));
  if (!parsed.ok) throw new Error(`the bench fixture no longer parses: ${JSON.stringify(parsed.errors)}`);
  expect(parsed.job.workholding.kind).toBe('tape');
  expect(parsed.job.cutouts?.length ?? 0).toBeGreaterThan(0);
  return { ...parsed.job, sacrificial: { ...parsed.job.sacrificial, under: null } };
}

function gate(job: EngraveJob, over: Partial<PreflightHubInput> = {}) {
  return preflightHub({
    job,
    generated: null,
    staleSince: null,
    package: null,
    calibration: null,
    shelfItem: null,
    ...over,
  });
}

describe('#735 item 3 — the Cut gate reads the bed for a taped through cut', () => {
  it('over the wasteboard the gate does not refuse the cut in the vise’s words', () => {
    const job = tapedThroughJob();
    const report = gate(job, { bed: houseBed(job) });
    expect(report.rows.filter((r) => r.code === 'through-needs-board')).toEqual([]);
  });

  it('on a bare bed the refusal is the design’s bed sentence, naming the house board', () => {
    const job = tapedThroughJob();
    const facts = houseBed(job);
    const bare: BedUnderFacts = {
      ...facts,
      surface: 'bare-bed',
      wasteboardMm: null,
      boardMm: 2,
      boardLengthMm: 100,
      boardWidthMm: 100,
      boardWords: '2 mm MDF',
    };
    const report = gate(job, { bed: bare });
    const row = report.rows.find((r) => r.code === 'through-needs-board');
    expect(row?.severity).toBe('error');
    expect(row?.message).toContain('only the bed is under it — put a 2 mm MDF board under it, or tape it on the wasteboard');
    expect(row?.message).not.toContain('reaches the vise');
  });

  it('with no bed facts the pre-#712 sentence is unchanged', () => {
    const job = tapedThroughJob();
    const report = gate(job);
    expect(report.rows.find((r) => r.code === 'through-needs-board')?.message).toContain('this cut reaches the vise');
  });
});
