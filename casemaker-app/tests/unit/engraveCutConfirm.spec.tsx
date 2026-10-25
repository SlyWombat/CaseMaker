// @vitest-environment jsdom
// #656 — the ONE SCREEN between the cutter prompt and the cut: the program, the cutter (already
// confirmed at the prompt), the check's verdict, the dome choice when the top is curved, ONE
// statement folding the three old ticks, and ONE Cut press that uploads, prepares and starts
// through the same seams the manual path uses. Nothing here reaches a machine or the shelf.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveCutConfirm } from '@/components/panels/EngraveCutConfirm';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import { resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { resetRunConfirmStore, runKey, useRunConfirmStore } from '@/store/runConfirmStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { programHash } from '@/platform/machineRun';
import type { MachineObservation } from '@/platform/machineProbe';
import type { ReleaseSource } from '@/engine/cnc/engrave/release';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };
const MACHINE: MachineObservation = {
  name: 'Z1',
  host: TARGET.host,
  port: TARGET.port,
  busy: false,
  ip: null,
  mac: null,
  status: '<Idle|MPos:0,0,0>',
  profileId: 'Z1',
  observedAt: '2026-10-25T00:00:00.000Z',
  notes: [],
};
const VERIFY: VerifyReport = { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } } };
const NC = 'G90\nT1 M6\nM02\n';
const SOURCE: ReleaseSource = { setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', nc: NC, hash: programHash(NC), verify: VERIFY };
const OK_ORACLE: OracleReport = { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } };

const uploads: { filename: string; content: string }[] = [];
let uploadKind: 'uploaded' | 'refused' = 'uploaded';

function confirm(over: Partial<Parameters<typeof EngraveCutConfirm>[0]> = {}) {
  return (
    <EngraveCutConfirm
      job={{ id: 'job-1', name: 'badge' } as never}
      machine={MACHINE}
      source={SOURCE}
      filename="badge-1.nc"
      oracle={OK_ORACLE}
      blocker={null}
      dome={null}
      domeBlocker={null}
      runContext={{}}
      {...over}
    />
  );
}

const prepareSpy = vi.fn(() => true);
const startSpy = vi.fn(() => true);

beforeEach(() => {
  uploads.length = 0;
  uploadKind = 'uploaded';
  cleanup();
  resetMachineRunStore();
  resetRunConfirmStore();
  useEngraveRunStore.setState({ acknowledged: false });
  prepareSpy.mockClear();
  startSpy.mockClear();
  useMachineRunStore.setState({ prepare: prepareSpy as never, start: startSpy as never });
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async (_target, program) => {
      if (uploadKind === 'refused') return { ok: false as const, reason: 'refused' as const, detail: 'the card is full' };
      uploads.push({ filename: program.filename, content: new TextDecoder().decode(program.content) });
      return { ok: true, bytes: program.content.length, packets: 1, alreadyPresent: false };
    },
  }));
});

afterEach(() => {
  cleanup();
  setMachineUploadLoader(null);
  resetMachineRunStore();
});

describe('#656 the one screen', () => {
  it('names the program and the cutter the frozen package was posted for', () => {
    render(confirm());
    expect(screen.getByTestId('engrave-cut-confirm-program').textContent).toContain('badge-1.nc');
    expect(screen.getByTestId('engrave-cut-confirm-cutter').textContent).toContain('1 mm flat end');
    expect(screen.getByTestId('engrave-cut-confirm-cutter').textContent).toContain('T1');
    expect(screen.getByTestId('engrave-cut-confirm-oracle').getAttribute('data-ok')).toBe('true');
    // One button, disabled until the ONE statement is ticked.
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-cut-statement'));
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(false);
    // The statement IS the run gate's acknowledgement, kept in step as it is ticked.
    expect(useEngraveRunStore.getState().acknowledged).toBe(true);
  });

  it('uploads, prepares and starts on the one press, with the frozen program’s own cutter', async () => {
    render(confirm());
    fireEvent.click(screen.getByTestId('engrave-cut-statement'));
    fireEvent.click(screen.getByTestId('engrave-cut-go'));

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]!.filename).toBe('badge-1.nc');
    expect(uploads[0]!.content).toBe(NC);
    await waitFor(() => expect(startSpy).toHaveBeenCalled());
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const [target, filename, hash, context] = prepareSpy.mock.calls[0] as unknown as [
      { host: string; port: number },
      string,
      string,
      { toolKey?: string; vacuumOwned?: boolean; nc?: string; setupId?: string },
    ];
    expect(target).toEqual(TARGET);
    expect(filename).toBe('badge-1.nc');
    expect(hash).toBe(programHash(NC));
    expect(context.toolKey).toBe('flat-1.0');
    expect(context.vacuumOwned).toBe(true);
    expect(context.nc).toBe(NC);
    expect(context.setupId).toBe('setup-1');
    // The statement carried the once-per-program at-machine confirmation too.
    expect(useRunConfirmStore.getState().isConfirmed(runKey(TARGET, programHash(NC)))).toBe(true);
  });

  it('stops with the upload’s own sentence and starts nothing', async () => {
    uploadKind = 'refused';
    render(confirm());
    fireEvent.click(screen.getByTestId('engrave-cut-statement'));
    fireEvent.click(screen.getByTestId('engrave-cut-go'));
    await waitFor(() => expect(screen.getByTestId('engrave-cut-confirm-error').textContent).toContain('the card is full'));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('refuses the press until the check is 0/0, and says why', () => {
    render(confirm({ oracle: { ...OK_ORACLE, ok: false, worst: { underCut: 2, overCut: 0 } } }));
    fireEvent.click(screen.getByTestId('engrave-cut-statement'));
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-oracle').textContent).toContain('not 0/0');
    expect(screen.getByTestId('engrave-cut-confirm-oracle').getAttribute('data-ok')).toBe('false');
  });

  it('shows the gate’s own sentence and stays disabled while it holds', () => {
    render(confirm({ blocker: 're-post against the tilt first — the frozen program is flat but the blank is tilted' }));
    fireEvent.click(screen.getByTestId('engrave-cut-statement'));
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-blocked').textContent).toContain('re-post against the tilt first');
  });

  it('carries the dome verdict’s choice on the same screen', () => {
    const onG32 = vi.fn();
    render(
      confirm({
        dome: { accept: null, g32Acked: false, floorAccepted: false, onG32, onFloor: vi.fn(), recommendation: 'G32 R1 X1 Y1' },
        domeBlocker: 'confirm how the dome is handled before uploading',
      }),
    );
    expect(screen.getByTestId('engrave-cut-dome-g32')).toBeTruthy();
    fireEvent.click(screen.getByTestId('engrave-cut-dome-g32-ack'));
    expect(onG32).toHaveBeenCalledWith(true);
  });
});
