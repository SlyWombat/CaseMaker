/**
 * #1154 — Save all writes the kept heartbeat lines beside the program they belong to, and Save
 * (one program) does the same through the same list.
 *
 * The run-log entry — the house copy of the finished-program record — carries `statusLog`; the
 * file name is the program's own `.nc` name with `-status.log` where `.nc` was, so it sits beside
 * `A-job-p02.nc` exactly as the run record (`A-job-run.json`) sits beside them all.
 */
import { describe, expect, it } from 'vitest';

import { runSaveFiles, statusLogFiles, type ProgramFilesSource } from '@/engine/cnc/engrave/programFiles';

const PROGRAMS: ProgramFilesSource[] = [
  { nc: 'G1 X1\nM2', frameNc: null, programHash: 'aa' },
  { nc: 'G1 X2\nM2', frameNc: null, programHash: 'bb' },
];
const RUN_LOG = [
  { programHash: 'aa', statusLog: '# a log\n' },
  { programHash: 'bb', statusLog: '# b log\n' },
];

describe('#1154 — the status logs Save all writes', () => {
  it('names each after its program and carries the kept text', () => {
    const status = statusLogFiles(PROGRAMS, 'A job', RUN_LOG);
    expect(status.map((f) => f.name)).toEqual(['A-job-p1-status.log', 'A-job-p2-status.log']);
    expect(status.map((f) => f.bytes)).toEqual(['# a log\n', '# b log\n']);
    expect(status.every((f) => f.kind === 'status')).toBe(true);
  });

  it('appends them after the programs, the record and the run log', () => {
    const files = runSaveFiles(
      PROGRAMS,
      'A job',
      { name: 'A-job-run.json', bytes: '{}' },
      { name: 'A-job-run.log', bytes: 'ticks\n' },
      statusLogFiles(PROGRAMS, 'A job', RUN_LOG),
    );
    expect(files.map((f) => f.name)).toEqual([
      'A-job-p1.nc',
      'A-job-p2.nc',
      'A-job-run.json',
      'A-job-run.log',
      'A-job-p1-status.log',
      'A-job-p2-status.log',
    ]);
  });

  it('writes nothing for a program that has not run', () => {
    const status = statusLogFiles(PROGRAMS, 'A job', [RUN_LOG[0]!]);
    expect(status.map((f) => f.name)).toEqual(['A-job-p1-status.log']);
    expect(statusLogFiles(PROGRAMS, 'A job', undefined)).toEqual([]);
    expect(statusLogFiles(PROGRAMS, 'A job', [])).toEqual([]);
  });

  it('a faced run’s skim gets its own -face-status.log, not a program number', () => {
    const programs: ProgramFilesSource[] = [
      { kind: 'facing', nc: 'G1 Z-0.5\nM2', frameNc: null, programHash: 'face' },
      { nc: 'G1 X1\nM2', frameNc: null, programHash: 'aa' },
    ];
    const status = statusLogFiles(programs, 'A job', [{ programHash: 'face', statusLog: '# face log\n' }]);
    expect(status.map((f) => f.name)).toEqual(['A-job-face-status.log']);
  });
});
