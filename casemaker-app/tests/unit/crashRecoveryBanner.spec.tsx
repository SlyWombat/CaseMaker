// @vitest-environment jsdom
// #787 — the banner the recorder's leftover marker earns: the sentence, the one write it offers,
// and the rule that nothing happens until a press.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CrashRecoveryBanner, crashBannerSentence } from '@/components/layout/CrashRecoveryBanner';
import { __resetFlightRecorderStoreForTests, setCrashSaveIO, useFlightRecorderStore } from '@/store/flightRecorderStore';
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
  stoppedAt: new Date(2026, 9, 30, 17, 2).getTime(),
  work: 'generate',
  stage: 'rough',
  label: 'roughing level 41 of 112',
  heapMb: 3_800,
  lastCrumbAt: new Date(2026, 9, 30, 17, 2).getTime(),
};

function prime(): void {
  useFlightRecorderStore.setState({ previous: PREVIOUS, moment: MOMENT, started: true });
}

describe('#787 — the crash banner', () => {
  it('says when it stopped, what it was doing, the stage and the heap', () => {
    expect(crashBannerSentence(MOMENT)).toBe(
      'Case Maker stopped unexpectedly at 17:02 while generating (roughing level 41 of 112, heap 3.7 GB). Save a crash report?',
    );
    // With nothing known but the time, the sentence stays true and quiet.
    expect(
      crashBannerSentence({ stoppedAt: MOMENT.stoppedAt, work: null, stage: null, label: null, heapMb: null, lastCrumbAt: null }),
    ).toBe('Case Maker stopped unexpectedly at 17:02. Save a crash report?');
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
    // There is no send control until the house half exists: nothing leaves the machine.
    expect(screen.queryByTestId('crash-send')).toBeNull();
  });
});
