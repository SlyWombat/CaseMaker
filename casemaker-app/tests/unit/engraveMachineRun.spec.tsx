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
import { machineKey, resetMachineRunStore, runContextFor, useMachineRunStore } from '@/store/machineRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { Tool } from '@/engine/cnc/tool';
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
const upload = (nc = 'M02\n', onProgramLine?: (line: number | null) => void) => (
  <EngraveMachineUpload
    blocker={null}
    machine={MACHINE}
    program={{ nc, verify: VERIFY }}
    filename="job.nc"
    lift={{ zMachine: -3, zFloorMachine: -102 }}
    onProgramLine={onProgramLine}
  />
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

  // #442's #423 item — "the viewport follows P": the run panel hands the panel the source line the
  // controller reports, and reports each line ONCE, so a follower is not re-seeked per render.
  it('reports the machine’s source line to the panel as it changes, once per change', async () => {
    setMachineConsoleLoader(async () => client(1));
    const lines: (number | null)[] = [];
    render(upload('M02\n', (line) => lines.push(line)));
    await uploadIt();
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    // The fake controller runs reporting `P:10,20,5` and finishes on `P:9,100,4`.
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeout: 12000 });
    expect(lines).toContain(10);
    expect(lines).toContain(9);
    // Consecutive repeats are dropped: the effect is keyed on the line, not on renders.
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]).not.toBe(lines[i - 1]);
  }, 20000);
});

// #442 (#414/#464) — what the engrave panel hands the run, built once and tested here rather than
// by rendering the whole panel behind `canDriveMachine`.
describe('runContextFor', () => {
  const tool: Tool = {
    number: 1, id: null, name: 'A 30° engraver', typeText: 'type=tapered-ball', shape: 'tapered-ball',
    handleDiameter: 3.175, tipDiameter: 0.4, diameter: 3.175, cornerRadius: null, angle: 30,
    halfAngle: 15, fluteLength: null, shoulderLength: null, stickout: null, centreCutting: null,
  };

  it('names the job, the stock in the job’s frame, the cutter, the base material and its fibre', () => {
    const job = defaultEngraveJob();
    const ctx = runContextFor({ ...job, stock: { ...job.stock, length: 120, width: 80, material: 'petg', fibre: 'cf' } }, tool);
    expect(ctx.jobId).toBe(job.id);
    expect(ctx.stockXY).toEqual({ x: 120, y: 80 });
    expect(ctx.toolRadius).toBe(0.2); // the cutting half-diameter, not the shank
    expect(ctx.toolKey).toBe(job.toolKey);
    expect(ctx.material).toBe('petg'); // the base plastic decides the feeds
    expect(ctx.fibre).toBe('cf'); // the fibre is beside it (#464), and makes the wear abrasive
  });

  it('omits partAt: the job never says where its part sits, so the offcut logic uses the stock edges', () => {
    expect('partAt' in runContextFor(defaultEngraveJob(), tool)).toBe(false);
  });

  it('omits the shelf entry, the radius and the fibre when the job states none of them', () => {
    const job = defaultEngraveJob();
    const ctx = runContextFor({ ...job, stockEntry: undefined, stock: { ...job.stock, fibre: undefined } }, null);
    expect('stockEntryId' in ctx).toBe(false);
    expect('toolRadius' in ctx).toBe(false); // never a zero
    expect('fibre' in ctx).toBe(false);
    expect(ctx.material).toBe(job.stock.material);
  });

  it('carries the shelf entry the job reserved', () => {
    const job = defaultEngraveJob();
    const ctx = runContextFor(
      { ...job, stockEntry: { kind: 'shelf', shelfId: 'inv:stock-7', file: null, form: 'plate', finish: 'finished', conductive: false } },
      tool,
    );
    expect(ctx.stockEntryId).toBe('inv:stock-7');
  });
});
