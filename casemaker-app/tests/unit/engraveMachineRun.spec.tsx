// @vitest-environment jsdom
// #423 — the run panel, mounted in the REAL tree (`EngraveMachineUpload` → run): upload, run, unmount
// the whole panel, remount it — the run is still there, watched, with its Stop, and Stop works. Also:
// "I am at the machine" once per program (Q17), Home only after a confirmed stop, Upload locked while
// a run goes. The upload and the console are fake clients; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveMachineRun } from '@/components/panels/EngraveMachineRun';
import { EngraveMachineUpload } from '@/components/panels/EngraveMachineUpload';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import { resetRunConfirmStore } from '@/store/runConfirmStore';
import { machineKey, resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import type { MachineObservation } from '@/platform/machineProbe';
import type { VerifyReport } from '@/engine/cnc/verify';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: string[] = [];
/** A controller: Idle before play; then `runFor` polls of Run before it finishes; Idle after abort. */
function client(runFor: number): MachineConsoleClient {
  let played = false;
  let aborted = false;
  let polls = 0;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          let text = 'ok';
          if (line === '?') {
            if (!played || aborted) text = '<Idle|MPos:0,0,0>';
            else text = polls++ < runFor ? '<Run|MPos:0,0,0|P:10,20,5>' : '<Idle|P:9,100,4>';
          } else if (line.startsWith('play')) {
            played = true;
            text = 'File size 10';
          } else if (line === 'abort') {
            aborted = true;
            text = 'ok\nAborted playing or paused file.';
          }
          return { ok: true, line, text, frames: 1, elapsedMs: 1 };
        },
        async close() {},
      };
    },
  };
}

const TARGET = { host: '192.0.2.10', port: 2222 };
const MACHINE: MachineObservation = {
  name: 'Z1', host: TARGET.host, port: TARGET.port, busy: false, ip: null, mac: null,
  status: '<Idle|MPos:0,0,0>', profileId: 'Z1', observedAt: '2026-10-16T00:00:00.000Z', notes: [],
};
const VERIFY: VerifyReport = { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } } };
const upload = (nc = 'M02\n') => (
  <EngraveMachineUpload blocker={null} machine={MACHINE} program={{ nc, verify: VERIFY }} filename="job.nc" />
);

beforeEach(() => {
  sent.length = 0;
  resetRunConfirmStore();
  resetMachineRunStore();
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async () => ({ ok: true, bytes: 4, packets: 1, alreadyPresent: false }),
  }));
});
afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
  setMachineUploadLoader(null);
});

async function uploadIt(): Promise<void> {
  fireEvent.click(screen.getByTestId('engrave-upload'));
  fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));
  await screen.findByTestId('engrave-run');
}

describe('#423 the run panel, in the real tree', () => {
  it('upload → run → close the panel → reopen it: the run is still watched, Stop is there, and it works', async () => {
    setMachineConsoleLoader(async () => client(100));
    const first = render(upload());
    await uploadIt();
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await waitFor(() => expect(screen.getByTestId('engrave-run-progress').textContent).toContain('20 %'), { timeout: 6000 });

    first.unmount(); // the engrave panel closes mid-run
    const polledBefore = sent.filter((l) => l === '?').length;
    await waitFor(() => expect(sent.filter((l) => l === '?').length).toBeGreaterThan(polledBefore), { timeout: 6000 });
    expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.running).toBe(true); // still watching

    render(upload()); // reopened: the run, from the store
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(true); // Upload locked
    const stop = await screen.findByTestId('engrave-run-stop');
    fireEvent.click(stop);
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), { timeout: 12000 });
    expect(sent).toContain('abort');
    expect(sent.at(-1)).toBe('M332');
    expect(sent).not.toContain('$H');
    expect(screen.getByTestId('engrave-run-home')).toBeTruthy(); // offered after a confirmed stop
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(false);
  }, 30000);

  it('a finished run homes by itself, offers no Home, and asks "I am at the machine" once per program', async () => {
    setMachineConsoleLoader(async () => client(0));
    render(upload('M02\n'));
    await uploadIt();
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeout: 6000 });
    expect(sent).toEqual(['?', 'M331', 'play /sd/gcodes/job.nc', '?', 'M332', '$H']);
    expect(screen.queryByTestId('engrave-run-home')).toBeNull();
    // The same program again: no question. A different program under the same name: asked again.
    expect(screen.queryByTestId('engrave-run-at-machine')).toBeNull();
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'another-hash');
    cleanup();
    render(<EngraveMachineRun target={TARGET} />);
    expect(screen.getByTestId('engrave-run-at-machine')).toBeTruthy();
  }, 15000);

  it('draws nothing for a machine with no prepared program', () => {
    render(<EngraveMachineRun target={TARGET} />);
    expect(screen.queryByTestId('engrave-run')).toBeNull();
  });
});
