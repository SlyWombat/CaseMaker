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
import { verifyCheck } from '@/engine/cnc/uploadGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: string[] = [];
/**
 * A controller: Idle before play; then `runFor` polls of Run before it finishes; Idle after abort.
 * #655 — `toolPolls` first answers the firmware's `Tool` state (a `T1 M6` waiting for `M490.2`).
 */
function client(runFor: number, opts: { toolPolls?: number } = {}): MachineConsoleClient {
  let played = false;
  let aborted = false;
  let polls = 0;
  let toolLeft = opts.toolPolls ?? 0;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          let text = 'ok';
          if (line === '?') {
            if (!played || aborted) text = '<Idle|MPos:0,0,0>';
            else if (toolLeft > 0) {
              toolLeft -= 1;
              text = '<Tool|MPos:-10.090,-12.830,-3.000|WPos:0,0,0|T:0,-9.757,1>';
            } else text = polls++ < runFor ? '<Run|MPos:0,0,0|P:10,20,5>' : '<Idle|P:9,100,4>';
          } else if (line === 'M490.2') {
            // #655 — the bench's continuation: the tool is measured at the sensor and the change ends.
            toolLeft = 0;
            text = 'ok\nM493.2 T1\nok\nDone ATC';
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
const upload = (
  nc = 'M02\n',
  onProgramLine?: (line: number | null) => void,
  runContext?: { toolKey?: string },
) => (
  <EngraveMachineUpload
    blocker={null}
    machine={MACHINE}
    program={{ nc, check: verifyCheck(VERIFY) }}
    filename="job.nc"
    lift={{ zMachine: -3, zFloorMachine: -102 }}
    onProgramLine={onProgramLine}
    {...(runContext === undefined ? {} : { runContext })}
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
    // The prepare the app makes says the file owns the vacuum (#469 R20), rather than leaving the
    // runner to infer it from the text of one file of the job.
    expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.context?.vacuumOwned).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeout: 6000 });
    // #469 (R20) — the app's upload OWNS the vacuum, so the runner adds no `M331`/`M332` of its
    // own here, even though this fixture program states neither: a job's span is the post's
    // decision, and an `air: false` file legitimately carries no words. The machine homes on
    // every finish; it is the file (or its absence) that switches the vacuum.
    expect(sent).toEqual(['?', 'play /sd/gcodes/job.nc', '?', '$H']);
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

  // #618 — Pause sits beside Stop while the job runs; the suspend goes out at the run's next poll
  // boundary, the entry records where it paused, and the same button resumes it.
  it('pauses at the run’s boundary and resumes from the same button', async () => {
    setMachineConsoleLoader(async () => client(100));
    render(upload());
    await uploadIt();
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await waitFor(() => expect(screen.getByTestId('engrave-run-progress').textContent).toContain('20 %'), { timeout: 6000 });

    fireEvent.click(screen.getByTestId('engrave-run-pause'));
    await waitFor(() => expect(sent).toContain('suspend'), { timeout: 6000 });
    await waitFor(() => expect(screen.getByTestId('engrave-run-pause').textContent).toContain('Resume'), { timeout: 6000 });
    expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.paused).toBe(true);
    expect((useMachineRunStore.getState().runs[machineKey(TARGET)]?.lines ?? []).join('\n')).toContain('Paused at line');

    fireEvent.click(screen.getByTestId('engrave-run-pause'));
    await waitFor(() => expect(sent).toContain('resume'), { timeout: 6000 });
    await waitFor(() => expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.paused).toBe(false), { timeout: 6000 });

    fireEvent.click(screen.getByTestId('engrave-run-stop'));
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), { timeout: 12000 });
    expect(sent.filter((l) => l === 'suspend')).toHaveLength(1);
    expect(sent.filter((l) => l === 'resume')).toHaveLength(1);
  }, 40000);

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

// #655 — THE FIRMWARE'S TOOL STOP, in the panel. The first cut sat at `Tool` with Pause/Stop only;
// the prompt names the tool and its cutter, and Continue sends `M490.2`, after which the program
// runs to its finish.
describe('#655 the tool-change stop', () => {
  it('shows the prompt in our words and Continue carries the program on', async () => {
    setMachineConsoleLoader(async () => client(1, { toolPolls: 8 }));
    render(upload());
    await uploadIt();
    fireEvent.click(screen.getByTestId('engrave-run-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-run-start'));

    await screen.findByTestId('engrave-run-tool-prompt', undefined, { timeout: 8000 });
    // An upload with no run context (a file outside the job flow) names the tool number only.
    expect(screen.getByTestId('engrave-run-tool-words').textContent).toBe(
      'The machine is waiting for tool 1 to be in the spindle.',
    );
    // Nothing to suspend while it waits: Pause is not offered, Stop still is.
    expect(screen.queryByTestId('engrave-run-pause')).toBeNull();
    expect(screen.getByTestId('engrave-run-stop')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-run-tool-continue'));
    await waitFor(() => expect(sent).toContain('M490.2'), { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeout: 8000 });
    expect(screen.queryByTestId('engrave-run-tool-prompt')).toBeNull();
  }, 30000);
});

// The naming half of the same prompt: the run's OWN cutter, by the same display name the strip and
// the run sheet use.
describe('#655 the prompt names the run’s cutter', () => {
  it('says which cutter tool 1 is', () => {
    const key = machineKey(TARGET);
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'h', { nc: 'M02\n', toolKey: 'flat-1.0' });
    const entry = useMachineRunStore.getState().runs[key]!;
    useMachineRunStore.setState({ runs: { [key]: { ...entry, running: true, toolWaiting: { awaited: 1 } } } });
    render(<EngraveMachineRun target={TARGET} />);
    expect(screen.getByTestId('engrave-run-tool-words').textContent).toBe(
      // #687 — the display form carries the ⌀ (and the flute when the record states one).
      'The machine is waiting for tool 1 — the ⌀ 1 mm flat end — to be in the spindle.',
    );
  });
});
