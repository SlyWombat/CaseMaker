// @vitest-environment jsdom
/**
 * #1205 — THE MANAGE MACHINE CARD'S HOME CARRIES ITS OWN STOP REPORT.
 *
 * #1187 rule 3: a Home press that stops on a transport or controller error offers "Send a report
 * of this stop". The job cards got it in #1197; the Manage card's Home still dropped the console's
 * sentence. This pins both halves of the rule on that card: the report appears (with the console's
 * own failure sentence, the machine's address and no job), and the app's own refusal — an alarm,
 * not Idle — never offers one.
 *
 * Red first: the action does not exist on this card before the wiring, so the first test fails on
 * the missing testid and the second would pass vacuously; the first is the proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MachineStop } from '@/components/manage/MachineStop';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import {
  __resetMachineStopReportStoreForTests,
  setStopReportSendIO,
} from '@/store/machineStopReportStore';
import type { MachineStopReport } from '@/platform/machineStopReport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

const HOST = '192.0.2.10';
const PORT = 2222;
const RESET = 'read failed: Connection reset by peer (os error 104)';

/** A console that answers `?` with `status` and `$H` with `home` (ok by default). */
function fakeConsole(opts: { status?: string; home?: ConsoleSend } = {}): { sent: string[] } {
  const sent: string[] = [];
  setMachineConsoleLoader(async () => ({
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          if (line === '$H' && opts.home !== undefined) return opts.home;
          return line === '?'
            ? { ok: true, line, text: opts.status ?? '<Idle|MPos:0,0,0>', frames: 1, elapsedMs: 10 }
            : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 10 };
        },
        async close() {},
      };
    },
  }));
  return { sent };
}

function renderCard(): void {
  render(<MachineStop host={HOST} port={PORT} stopLive={false} canHome />);
}

beforeEach(() => {
  caps.drive = true;
  resetShopDefaultsStore();
  __resetMachineStopReportStoreForTests();
});
afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
});

describe('#1205 — the Manage card’s Home report', () => {
  it('offers the report when the home dies on the link, and posts only on the press', async () => {
    const reports: MachineStopReport[] = [];
    setStopReportSendIO(async (report) => {
      reports.push(report as MachineStopReport);
      return { kind: 'ok', path: 'crash-reports/stop-home.json' };
    });
    fakeConsole({
      home: { ok: false, reason: 'refused', line: '$H', detail: RESET, text: '' },
    });
    renderCard();

    fireEvent.click(screen.getByTestId('manage-stop-home'));
    await waitFor(() => expect(screen.getByTestId('manage-stop-note').textContent).toContain('Home did not complete'));
    // The note is the app's words; the action carries the console's sentence (its own `action`
    // field is asserted on the posted report below — land18's component predates #1197's
    // data-action attribute, so the test does not read it here).
    expect(screen.getByTestId('stop-report-action')).toBeTruthy();
    expect(reports).toHaveLength(0); // nothing leaves the machine on the failure

    await act(async () => {
      fireEvent.click(screen.getByTestId('stop-report-send'));
    });
    await waitFor(() => expect(reports).toHaveLength(1));
    const report = reports[0]!;
    expect(report.kind).toBe('casemaker-machine-stop-report');
    expect(report.action).toBe('home');
    expect(report.error).toContain(RESET);
    expect(report.machine).toEqual({ host: HOST, port: PORT });
    expect(report.job).toBeNull();
  });

  it('never offers one for the app’s own refusal — an alarm is not a transport failure', async () => {
    fakeConsole({ status: '<Alarm|MPos:0,0,0|WPos:0,0,0>\r\nALARM: Probe fail' });
    renderCard();
    fireEvent.click(screen.getByTestId('manage-stop-home'));
    await waitFor(() => expect(screen.getByTestId('manage-stop-note')).toBeTruthy());
    expect(screen.getByTestId('manage-stop-note').textContent).toContain('Home did not complete');
    expect(screen.queryByTestId('stop-report-action')).toBeNull();
  });
});
