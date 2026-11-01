// #895 — A STALL GETS A REPORT. The simulation stopping on silence is a fault, not a slow program,
// and the person can save one JSON file with the moment, the program and the recorder's crumbs —
// written only on the press. Pure builder, so its shape is pinned without a file picker.
import { describe, expect, it } from 'vitest';

import { buildSimStallReport, simStallReportFileName } from '@/engine/jobs/simStallReport';

describe('#895 — the sim stall report', () => {
  it('carries the moment, the job, the stall and the run’s diagnostics', () => {
    const at = new Date(2026, 10, 1, 16, 12).getTime();
    const report = buildSimStallReport({
      at,
      jobName: 'nude-panther',
      message: 'the simulation stalled: no progress for 30 s after checkpoint 49915 of 341707. This is a fault, not a slow program',
      progress: { done: 49_915, total: 341_707 },
      program: { index: 1, count: 2 },
      engine: 'column',
      diagnostics: [
        { source: 'sweep', severity: 'error', code: 'sweep-stalled', checkpoint: 49_915, message: 'the simulation stalled' },
      ],
      crumbs: [{ at, kind: 'session', data: { version: '1.0.0' } }],
    });

    expect(report.kind).toBe('casemaker-sim-stall-report');
    expect(report.schemaVersion).toBe(1);
    expect(report.at).toBe(new Date(at).toISOString());
    expect(report.jobName).toBe('nude-panther');
    expect(report.stall).toMatchObject({
      progress: { done: 49_915, total: 341_707 },
      program: { index: 1, count: 2 },
      engine: 'column',
    });
    expect(report.diagnostics).toHaveLength(1);
    expect((report.diagnostics as { code: string }[])[0]!.code).toBe('sweep-stalled');
    // Crash-style: the recorder's own crumbs ride along, so a reader sees where the session was.
    expect(report.crumbs).toHaveLength(1);
    expect((report.crumbs as { kind: string }[])[0]!.kind).toBe('session');
  });

  it('names the file by the moment it was saved', () => {
    const at = new Date(2026, 10, 1, 16, 12).getTime();
    expect(simStallReportFileName(at)).toBe('casemaker-sim-stall-2026-11-01-1612.json');
  });
});
