// #1179 — THE FINISHED-RUN RECORD (slice A): the shape is additive beside the hash list, an old
// document parses unchanged, and a partial record is still true. The fixture is the LIVE k3
// location's machine record (machine-lejqjgb73q), fetched read-only on 2026-11-10.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MachineRecordSchema } from '@/platform/locationClient';
import { finishedRunsFor, useLocationStore } from '@/store/locationStore';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/location-k3-machine-2026-11-10.json', import.meta.url), 'utf8'),
) as { machine: unknown };

describe('#1179 the finished-run record', () => {
  it('the live k3 record (written before the section) parses unchanged', () => {
    const parsed = MachineRecordSchema.parse(fixture.machine);
    expect(parsed.finishedPrograms).toEqual(['5343dd8c', '1e4e7ef9']);
    expect(parsed.finishedRuns).toEqual([]);
  });

  it('a full record parses, and a hash-only record parses too', () => {
    const base = MachineRecordSchema.parse(fixture.machine);
    const full = MachineRecordSchema.parse({
      ...base,
      finishedRuns: [
        {
          hash: 'a1b2c3d4',
          jobId: 'job-1',
          jobName: 'M1 tray',
          packageKey: 'package-1',
          key8: 'package-',
          programIndex: 1,
          programCount: 17,
          programName: 'tray-p01.nc',
          cutterKey: 'inv:flat-25',
          setupIndex: 1,
          finishedAt: '2026-11-10T14:02:00.000Z',
          stock: { lengthMm: 160, widthMm: 126, thicknessMm: 25 },
          registration: {
            surfaceMachineZ: -60.487,
            g54: { x: 77.344, y: 63 },
            topSource: 'touch',
            measuredTopMachineZ: -60.487,
            impliedThicknessMm: 25.3,
            measuredAt: '2026-11-10T13:00:00.000Z',
            planExpectedTopMachineZ: -60.0,
          },
          cutMap: {
            cellMm: 2,
            cols: 80,
            rows: 63,
            x0Mm: 0,
            y0Mm: 0,
            stepMm: 0.05,
            flat: { encoding: 'rle', data: '5040:1' },
            depth: { encoding: 'rle', data: '5040:0' },
          },
        },
      ],
    });
    expect(full.finishedRuns[0]).toMatchObject({
      hash: 'a1b2c3d4',
      programIndex: 1,
      programCount: 17,
      registration: { surfaceMachineZ: -60.487, measuredTopMachineZ: -60.487, topSource: 'touch' },
      cutMap: { cellMm: 2, cols: 80, rows: 63, stepMm: 0.05 },
    });
    // Every field but the hash is optional — a record from a caller that knows less still parses.
    const partial = MachineRecordSchema.parse({ ...base, finishedRuns: [{ hash: 'a1b2c3d4' }] });
    expect(partial.finishedRuns[0]).toEqual({ hash: 'a1b2c3d4' });
    // A cut map over the cap is refused by the schema (the whole map, never a partial grid).
    expect(() =>
      MachineRecordSchema.parse({
        ...base,
        finishedRuns: [
          {
            hash: 'a1b2c3d4',
            cutMap: { cellMm: 2, cols: 80, rows: 63, x0Mm: 0, y0Mm: 0, stepMm: 0.05, flat: { encoding: 'rle', data: 'x'.repeat(4097) }, depth: { encoding: 'rle', data: '1:0' } },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('#1179 finishedRunsFor', () => {
  it('returns the records for the machine at the target; none for another address', () => {
    const base = MachineRecordSchema.parse(fixture.machine);
    useLocationStore.setState({
      location: {
        machines: [
          {
            ...base,
            address: { host: '192.0.2.10', port: 2222 },
            finishedRuns: [{ hash: 'a1b2c3d4', programIndex: 1 }],
          },
        ],
      } as never,
    });
    expect(finishedRunsFor({ host: '192.0.2.10', port: 2222 }).map((r) => r.hash)).toEqual(['a1b2c3d4']);
    expect(finishedRunsFor({ host: '192.0.2.99', port: 2222 })).toEqual([]);
  });
});
