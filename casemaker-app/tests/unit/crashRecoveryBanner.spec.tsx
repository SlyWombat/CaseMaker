// @vitest-environment jsdom
// #787 — the banner the recorder's leftover marker earns: the sentence, the one write it offers,
// and the rule that nothing happens until a press.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CrashRecoveryBanner } from '@/components/layout/CrashRecoveryBanner';
import { crashBannerSentence } from '@/components/layout/crashBannerSentence';
import {
  __resetFlightRecorderStoreForTests,
  CRASH_BANNER_CONFIRM_MS,
  setCrashSaveIO,
  setCrashSendIO,
  useFlightRecorderStore,
} from '@/store/flightRecorderStore';
import type { CrashMoment, PreviousSession } from '@/platform/flightRecorder';
import { setMeshBlobIO } from '@/platform/meshBlobs';

afterEach(() => {
  cleanup();
  __resetFlightRecorderStoreForTests();
  setMeshBlobIO(null);
});

const PREVIOUS: PreviousSession = {
  marker: {
    id: 's-crashed',
    startedAt: new Date(2026, 9, 30, 16, 50).getTime(),
    appVersion: '1.0.0',
    commit: 'abc1234',
    work: 'generate',
    stage: 'rough',
    label: 'roughing level 41 of 112',
  },
  crumbs: [
    {
      at: new Date(2026, 9, 30, 17, 2).getTime(),
      kind: 'work',
      work: 'generate',
      stage: 'start',
      data: {
        jobName: 'nude-panther',
        meshes: [{ name: 'panther.stl', sha256: 'a'.repeat(64), format: 'stl', bytes: 9_204_512 }],
      },
    },
  ],
};

const MOMENT: CrashMoment = {
  // #1072 — "30 Oct at 17:02" is the current year's date, so the dated sentence prints no year and
  // this fixture's pin stays stable as the calendar moves on.
  stoppedAt: new Date(new Date().getFullYear(), 9, 30, 17, 2).getTime(),
  work: 'generate',
  stage: 'rough',
  label: 'roughing level 41 of 112',
  heapMb: 3_800,
  lastCrumbAt: new Date(2026, 9, 30, 17, 2).getTime(),
};

function prime(houseOk = false): void {
  useFlightRecorderStore.setState({ previous: PREVIOUS, moment: MOMENT, started: true, houseOk });
}

describe('#787 — the crash banner', () => {
  it('#1072 — the sentence carries the DATE, so a days-old stop cannot read as tonight', () => {
    // The sent marker was 2026-11-03T22:58:33.239Z — 17:58 local on the maintainer's machine (EST),
    // the "17:58" banner. Built from LOCAL components so this pin holds in ANY runner time zone:
    // the product renders the viewer's local time, and the sentence must carry its date.
    const stale = new Date(2026, 10, 3, 17, 58).getTime();
    expect(
      crashBannerSentence({ stoppedAt: stale, work: null, stage: null, label: null, heapMb: null, lastCrumbAt: stale }),
    ).toBe('Case Maker stopped unexpectedly on 3 Nov at 17:58. Save a crash report?');
  });

  it('#1072 — the year is carried only when the stop is not in the current year', () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const moment = (at: number): CrashMoment => ({ stoppedAt: at, work: null, stage: null, label: null, heapMb: null, lastCrumbAt: at });
    const now = new Date();
    // A marker from today says today’s date the same way, with no year.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
    expect(crashBannerSentence(moment(today))).toBe(
      `Case Maker stopped unexpectedly on ${now.getDate()} ${MONTHS[now.getMonth()]} at 09:05. Save a crash report?`,
    );
    // An earlier year is named, so the sentence cannot be misread across a year boundary either.
    const lastYear = now.getFullYear() - 1;
    expect(crashBannerSentence(moment(new Date(lastYear, 10, 3, 17, 58).getTime()))).toBe(
      `Case Maker stopped unexpectedly on 3 Nov ${lastYear} at 17:58. Save a crash report?`,
    );
  });

  it('says when it stopped, what it was doing, the stage and the heap', () => {
    expect(crashBannerSentence(MOMENT)).toBe(
      'Case Maker stopped unexpectedly on 30 Oct at 17:02 while generating (roughing level 41 of 112, heap 3.7 GB). Save a crash report?',
    );
    // With nothing known but the time, the sentence stays true and quiet.
    expect(
      crashBannerSentence({ stoppedAt: MOMENT.stoppedAt, work: null, stage: null, label: null, heapMb: null, lastCrumbAt: null }),
    ).toBe('Case Maker stopped unexpectedly on 30 Oct at 17:02. Save a crash report?');
  });

  it('renders only when there is a previous session, and Dismiss puts it away', () => {
    const { rerender } = render(<CrashRecoveryBanner />);
    expect(screen.queryByTestId('crash-banner')).toBeNull();
    prime();
    rerender(<CrashRecoveryBanner />);
    expect(screen.getByTestId('crash-banner-sentence').textContent).toContain('roughing level 41 of 112');
    fireEvent.click(screen.getByTestId('crash-dismiss'));
    expect(screen.queryByTestId('crash-banner')).toBeNull();
  });

  it('writes only on the press, and passes the “include the models” choice through', async () => {
    prime();
    const calls: { text: string; filename: string }[] = [];
    setCrashSaveIO({ save: async (text, filename) => void calls.push({ text, filename }) });
    setMeshBlobIO({ put: async () => undefined, get: async () => 'QUJD' });
    render(<CrashRecoveryBanner />);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId('crash-include-meshes'));
    fireEvent.click(screen.getByTestId('crash-save'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const report = JSON.parse(calls[0]!.text) as { meshes?: { name: string; data: string }[] };
    // The unticked box never carries bytes; the tick names the store's own copy.
    expect(report.meshes).toHaveLength(1);
    expect(report.meshes?.[0]).toMatchObject({ name: 'panther.stl', data: 'QUJD' });
    await waitFor(() => expect(screen.getByTestId('crash-saved')).toBeTruthy());
    // No house answered: there is no send control at all, so nothing can leave the machine.
    expect(screen.queryByTestId('crash-send')).toBeNull();
  });

  it('#890 — the confirmation line shows, then the banner puts itself away', async () => {
    vi.useFakeTimers();
    try {
      prime();
      setCrashSaveIO({ save: async () => undefined });
      render(<CrashRecoveryBanner />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('crash-save'));
      });
      // The line the press earned is visible…
      expect(screen.getByTestId('crash-saved')).toBeTruthy();
      expect(screen.getByTestId('crash-banner')).toBeTruthy();
      // …and it is not left standing: the banner goes on its own, without a second press.
      act(() => vi.advanceTimersByTime(CRASH_BANNER_CONFIRM_MS));
      expect(screen.queryByTestId('crash-banner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Send only where a house answered, and sends only on its press', async () => {
    prime(true);
    const sent: unknown[] = [];
    setCrashSendIO(async (report) => {
      sent.push(report);
      return { kind: 'ok', path: 'crash-reports/crash-2-0.json' };
    });
    render(<CrashRecoveryBanner />);
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByTestId('crash-send'));
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('crash-sent').textContent).toContain('crash-reports/crash-2-0.json'));
  });
});
