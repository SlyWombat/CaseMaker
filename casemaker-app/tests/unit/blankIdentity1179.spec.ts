// #1179 blank identity — the Register card's guard reads the BLANK, not the machine.
//
// The analyst's fields (issue comment 6776457695): `currentBlank[jobId]` on the machine record,
// `blankId` on every finished run, `cutMaps` per setup. Before this module the card's trigger was
// machine-level (`finishedPrograms.length > 0 || runLog.some(finished)`), so a keyless entry from
// yesterday put EVERY job on the measured path. These cases pin the replacement rule:
// a job with an id scopes to that id; a job without one takes the safe default.
import { describe, expect, it } from 'vitest';

import { blankScopeFor } from '@/engine/cnc/registration/blankIdentity';
import type { FinishedRun, MachineRecord } from '@/platform/locationClient';

const STOCK = { lengthMm: 100, widthMm: 60, thicknessMm: 25 };

function run(over: Partial<FinishedRun> = {}): FinishedRun {
  return {
    hash: 'h1',
    jobId: 'job-1',
    finishedAt: '2026-11-10T09:00:00.000Z',
    stock: STOCK,
    ...over,
  } as FinishedRun;
}

function machine(over: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'fx-machine-1',
    name: 'QA Z1',
    host: '192.0.2.10',
    port: 2222,
    updatedAt: '2026-11-10T09:00:00.000Z',
    finishedPrograms: [],
    finishedRuns: [],
    ...over,
  } as unknown as MachineRecord;
}

const completeMap = (cellMm = 2) => ({
  cellMm,
  cols: 2,
  rows: 2,
  x0Mm: 0,
  y0Mm: 0,
  stepMm: 0.05,
  flat: { encoding: 'rle' as const, data: '4:1' },
  depth: { encoding: 'rle' as const, data: '4:40' },
});

describe('#1179 the blank scope — the guard reads the BLANK', () => {
  it('a job WITH an id ignores legacy entries and other blanks: a fresh single touch', () => {
    const scope = blankScopeFor({
      machine: machine({
        finishedPrograms: ['yesterdays-keyless-hash'],
        currentBlank: { 'job-1': 'blank-X' },
        finishedRuns: [
          // Another blank's run, and a legacy id-less run: neither counts for blank X.
          run({ hash: 'h-a', blankId: 'blank-Y' }),
          run({ hash: 'h-b' }),
        ],
      }),
      jobId: 'job-1',
      setupIndex: 1,
      packageHashes: ['h1'],
      runLogFinished: true,
    });
    expect(scope.blankId).toBe('blank-X');
    expect(scope.cutsOnThisBlank, 'legacy/other-blank entries do not put the job on the measured path').toBe(false);
    expect(scope.reason).toBe('fresh');
    expect(scope.setupMap).toBeNull();
  });

  it('the blank’s own run triggers, and the newest record’s map for the registered setup is surfaced', () => {
    const scope = blankScopeFor({
      machine: machine({
        currentBlank: { 'job-1': 'blank-X' },
        finishedRuns: [
          run({ hash: 'h1', blankId: 'blank-X', finishedAt: '2026-11-10T09:00:00.000Z' }),
          run({
            hash: 'h2',
            blankId: 'blank-X',
            setupIndex: 2,
            finishedAt: '2026-11-10T10:00:00.000Z',
            cutMaps: [
              { setupIndex: 1, state: 'complete', map: completeMap(2) },
              { setupIndex: 2, state: 'unknown', unknownReason: 'the stream overflowed at 8 mm' },
            ],
          }),
        ],
      }),
      jobId: 'job-1',
      setupIndex: 1,
      packageHashes: ['h1'],
      runLogFinished: false,
    });
    expect(scope.cutsOnThisBlank).toBe(true);
    expect(scope.reason).toBe('blank-cut');
    expect(scope.newestRun?.hash).toBe('h2');
    // The registered setup's entry, carried forward on the newest record.
    expect(scope.setupMap).toMatchObject({ setupIndex: 1, state: 'complete' });
    expect(scope.setupMap?.map?.cellMm).toBe(2);
  });

  it('an unknown setup entry is surfaced as unknown, with its reason', () => {
    const scope = blankScopeFor({
      machine: machine({
        currentBlank: { 'job-1': 'blank-X' },
        finishedRuns: [run({ hash: 'h1', blankId: 'blank-X', cutMaps: [{ setupIndex: 1, state: 'unknown', unknownReason: 'merge failed' }] })],
      }),
      jobId: 'job-1',
      setupIndex: 1,
      packageHashes: [],
      runLogFinished: false,
    });
    expect(scope.setupMap).toMatchObject({ state: 'unknown', unknownReason: 'merge failed' });
  });

  it('a NO-ID job on a legacy machine takes the safe default (unknown cuts, press offered)', () => {
    const scope = blankScopeFor({
      machine: machine({ finishedPrograms: ['yesterdays-keyless-hash'] }),
      jobId: 'job-1',
      setupIndex: 1,
      packageHashes: [],
      runLogFinished: false,
    });
    expect(scope.blankId).toBeNull();
    expect(scope.cutsOnThisBlank).toBe(true);
    expect(scope.reason).toBe('legacy-maybe-cut');
  });

  it('a NO-ID job on a clean machine is fresh — the single touch', () => {
    const scope = blankScopeFor({
      machine: machine(),
      jobId: 'job-1',
      setupIndex: 1,
      packageHashes: [],
      runLogFinished: false,
    });
    expect(scope.cutsOnThisBlank).toBe(false);
    expect(scope.reason).toBe('fresh');
  });

  it('the registration mint fires only when EVERY package program is finished under this blank', () => {
    const current = machine({
      currentBlank: { 'job-1': 'blank-X' },
      finishedRuns: [run({ hash: 'h1', blankId: 'blank-X' }), run({ hash: 'h2', blankId: 'blank-X' })],
    });
    expect(
      blankScopeFor({ machine: current, jobId: 'job-1', setupIndex: 1, packageHashes: ['h1', 'h2'], runLogFinished: false })
        .packageFinishedUnderBlank,
    ).toBe(true);
    expect(
      blankScopeFor({ machine: current, jobId: 'job-1', setupIndex: 1, packageHashes: ['h1', 'h2', 'h3'], runLogFinished: false })
        .packageFinishedUnderBlank,
    ).toBe(false);
    // The same hashes under another blank do not count.
    expect(
      blankScopeFor({
        machine: machine({ currentBlank: { 'job-1': 'blank-Y' }, finishedRuns: [run({ hash: 'h1', blankId: 'blank-X' })] }),
        jobId: 'job-1',
        setupIndex: 1,
        packageHashes: ['h1'],
        runLogFinished: false,
      }).packageFinishedUnderBlank,
    ).toBe(false);
  });
});
