// @vitest-environment jsdom
/**
 * #1187 — A STOPPED MACHINE ACTION'S REPORT. The document is built from the action's own facts (its
 * transcript, the error, the machine's last status line, the build, the job/package), only a
 * transport or controller error offers the action, and only the operator's press sends anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StopReportAction } from '@/components/panels/StopReportAction';
import { buildMachineStopReport, lastStatusLine, stopIsReportable } from '@/platform/machineStopReport';
import type { MachineStopReport } from '@/platform/machineStopReport';
import {
  __resetMachineStopReportStoreForTests,
  setStopReportSendIO,
  useMachineStopReportStore,
} from '@/store/machineStopReportStore';

afterEach(() => {
  cleanup();
  __resetMachineStopReportStoreForTests();
});

const APP = { version: '1.0.0', commit: 'abc1234', desktop: true };
const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

const TRANSCRIPT = [
  { line: '?', reply: STATUS },
  { line: '$H', reply: 'ok' },
  { line: 'G54', reply: 'ok' },
  { line: '?', reply: '<Run|MPos:1,2,3|WPos:0,0,0>' },
  { line: 'M491', reply: 'read failed: Connection reset by peer (os error 104)' },
];

const INPUT = {
  action: 'register' as const,
  target: { host: '192.0.2.10', port: 2222 },
  error: 'M491: error — read failed: Connection reset by peer (os error 104)',
  transcript: TRANSCRIPT,
  job: { id: 'job-7', name: 'tray', packageHash: 'pack1234' },
  now: Date.parse('2026-11-10T20:30:00.000Z'),
};

describe('#1187 — the machine-stop report document', () => {
  it('carries the press’s own transcript, error, last status line, build and job/package', () => {
    const report = buildMachineStopReport(INPUT, APP);
    expect(report.kind).toBe('casemaker-machine-stop-report');
    expect(report.version).toBe(1);
    expect(report.createdAt).toBe('2026-11-10T20:30:00.000Z');
    expect(report.app).toEqual(APP);
    expect(report.action).toBe('register');
    expect(report.machine).toEqual({ host: '192.0.2.10', port: 2222 });
    expect(report.error).toBe(INPUT.error);
    // The LAST status line read — the Run one, not the opening Idle — and nothing invented.
    expect(report.lastStatus).toBe('<Run|MPos:1,2,3|WPos:0,0,0>');
    expect(report.job).toEqual({ id: 'job-7', name: 'tray', packageHash: 'pack1234' });
    expect(report.transcript).toEqual(TRANSCRIPT);
    // A copy, not the panel's array: the document must not change under the press.
    expect(report.transcript).not.toBe(TRANSCRIPT);
    // #1208 — a report that carries the whole conversation says nothing about dropped polls.
    expect('droppedStatusPolls' in report).toBe(false);
  });

  // #1208 — THE REPORT SAYS ITS STATUS TAIL IS A TAIL: the ring dropped exchanges, and the count
  // is the run's own fact, never a silent truncation.
  it('carries how many status polls a bounded transcript dropped', () => {
    const report = buildMachineStopReport({ ...INPUT, droppedStatusPolls: 5_370 }, APP);
    expect(report.droppedStatusPolls).toBe(5_370);
    // The transcript itself is unchanged: commands plus the kept tail.
    expect(report.transcript).toEqual(TRANSCRIPT);
    expect(buildMachineStopReport({ ...INPUT, droppedStatusPolls: 0 }, APP).droppedStatusPolls).toBeUndefined();
  });

  it('a session that never read a status line reports none', () => {
    expect(lastStatusLine([{ line: '?', reply: 'error' }, { line: '$H', reply: 'ok' }])).toBeNull();
    expect(buildMachineStopReport({ ...INPUT, transcript: [], job: null }, APP).lastStatus).toBeNull();
    expect(buildMachineStopReport({ ...INPUT, transcript: [], job: null }, APP).job).toBeNull();
  });

  it('offers only for a transport or controller error, never for the app’s own refusals', () => {
    // A line that never reached the controller, or a link that failed mid-answer.
    expect(stopIsReportable('?: error — read failed: Connection reset by peer (os error 104)')).toBe(true);
    expect(stopIsReportable('M491: timeout — no answer within 30000 ms')).toBe(true);
    expect(stopIsReportable('could not open a console on 192.168.10.43:2222: connection refused')).toBe(true);
    expect(stopIsReportable('the machine closed the connection')).toBe(true);
    // The controller's own words.
    expect(stopIsReportable('G0 X10: the controller answered error:Alarm lock')).toBe(true);
    expect(stopIsReportable('G38.3 Z-5 F60: ALARM:Probe fail')).toBe(true);
    // Not a machine fault: a measurement refusal, the settings gate, or the operator's Stop.
    expect(stopIsReportable('no origin is written from this measurement: spread 1.2 mm is outside the 0.7 mm band')).toBe(false);
    expect(stopIsReportable('nothing was sent: the touch count is 0')).toBe(false);
    expect(stopIsReportable('stopped: the operator pressed Stop')).toBe(false);
    expect(stopIsReportable('the machine reads Alarm, not Idle')).toBe(false);
  });
});

describe('#1187 — the stop card’s action', () => {
  const props = {
    action: 'register' as const,
    target: INPUT.target,
    error: INPUT.error,
    transcript: TRANSCRIPT,
    job: INPUT.job,
  };

  it('sends nothing until the press, then sends the report and says where it went', async () => {
    const sent: unknown[] = [];
    setStopReportSendIO(async (report) => {
      sent.push(report);
      return { kind: 'ok', path: 'crash-reports/stop-1794342073154-1.json' };
    });
    render(<StopReportAction {...props} />);
    expect(sent).toHaveLength(0);
    expect(screen.getByTestId('stop-report-send').textContent).toBe('Send a report of this stop');

    fireEvent.click(screen.getByTestId('stop-report-send'));
    await waitFor(() => expect(sent).toHaveLength(1));
    const report = sent[0] as MachineStopReport;
    expect(report.kind).toBe('casemaker-machine-stop-report');
    expect(report.error).toBe(INPUT.error);
    expect(report.transcript).toEqual(TRANSCRIPT);
    expect(report.lastStatus).toBe('<Run|MPos:1,2,3|WPos:0,0,0>');
    expect(report.job?.packageHash).toBe('pack1234');
    await waitFor(() =>
      expect(screen.getByTestId('stop-report-sent').textContent).toContain('crash-reports/stop-1794342073154-1.json'),
    );
    // Once sent, the action is not offered again for this stop.
    expect(screen.queryByTestId('stop-report-send')).toBeNull();
  });

  it('a refused send says why, and the action stays available', async () => {
    setStopReportSendIO(async () => ({ kind: 'absent', reason: 'no house service answered' }));
    render(<StopReportAction {...props} />);
    fireEvent.click(screen.getByTestId('stop-report-send'));
    await waitFor(() =>
      expect(screen.getByTestId('stop-report-error').textContent).toContain('no house service answered'),
    );
    expect(screen.getByTestId('stop-report-send')).toBeTruthy();
  });

  it('a NEW stop starts fresh: reset puts the action back, so one stop cannot claim another’s send', async () => {
    setStopReportSendIO(async () => ({ kind: 'ok', path: 'crash-reports/stop-1-0.json' }));
    render(<StopReportAction {...props} />);
    fireEvent.click(screen.getByTestId('stop-report-send'));
    await waitFor(() => expect(screen.getByTestId('stop-report-sent')).toBeTruthy());
    expect(screen.queryByTestId('stop-report-send')).toBeNull();
    // The registration panel calls this when the next run starts.
    act(() => useMachineStopReportStore.getState().reset());
    expect(screen.getByTestId('stop-report-send')).toBeTruthy();
    expect(screen.queryByTestId('stop-report-sent')).toBeNull();
  });
});
