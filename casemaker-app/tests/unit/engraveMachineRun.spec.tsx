// @vitest-environment jsdom
// #423 — the run panel, mounted in the REAL tree (`EngraveMachineUpload` → run): upload, run, unmount
// the whole panel, remount it — the run is still there, watched, with its Stop, and Stop works. Also:
// "I am at the machine" once per program (Q17), Home only after a confirmed stop, Upload locked while
// a run goes. The upload and the console are fake clients; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { advanceUntil } from './helpers/fakeTime';
import { EngraveMachineRun } from '@/components/panels/EngraveMachineRun';
import { EngraveMachineUpload } from '@/components/panels/EngraveMachineUpload';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import { resetRunConfirmStore } from '@/store/runConfirmStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useCncModeStore } from '@/store/cncModeStore';
import { machineKey, resetMachineRunStore, runContextFor, useMachineRunStore } from '@/store/machineRunStore';
import type { MachineStopReport } from '@/platform/machineStopReport';
import { __resetMachineStopReportStoreForTests, setStopReportSendIO } from '@/store/machineStopReportStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { Tool } from '@/engine/cnc/tool';
import type { MachineObservation } from '@/platform/machineProbe';
import type { VerifyReport } from '@/engine/cnc/verify';
import { verifyCheck } from '@/engine/cnc/uploadGate';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { MachineRecordSchema, type LocationView } from '@/platform/locationClient';
import { toolChangeIdentity } from '@/platform/toolChangeDry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: string[] = [];
/**
 * A controller: Idle before play; then `runFor` polls of Run before it finishes; Idle after abort.
 * #655 — `toolPolls` first answers the firmware's `Tool` state (a `T1 M6` waiting for `M490.2`).
 * #1197 — `firstStatus` scripts the opening poll (an alarm, or a machine mid-job) and `abort` /
 * `home` script those two lines' answers, so a transport failure is a scripted reply.
 */
function client(
  runFor: number,
  opts: { toolPolls?: number; firstStatus?: string; abort?: ConsoleSend; home?: ConsoleSend } = {},
): MachineConsoleClient {
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
            if (!played) text = opts.firstStatus ?? '<Idle|MPos:0,0,0>';
            else if (aborted) text = '<Idle|MPos:0,0,0>';
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
            if (opts.abort !== undefined) return opts.abort;
            text = 'ok\nAborted playing or paused file.';
          } else if (line === '$H' && opts.home !== undefined) {
            return opts.home;
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

/**
 * #1202 — a location record for TARGET. A stated GRBL profile carries no controller frame, so its
 * clearance is UNKNOWN: the card must refuse the line rather than review it against an invented 0.
 */
function seedMachine(completedShape?: string, profileId = 'grbl:shapeoko-4'): void {
  const record = MachineRecordSchema.parse({
    id: 'm-1',
    profileId,
    address: { host: TARGET.host, port: TARGET.port },
    updatedAt: '2026-11-11T09:00:00.000Z',
    completedRoutines:
      completedShape === undefined
        ? []
        : [{ routine: 'tool-change', shape: completedShape, at: '2026-11-11T09:00:00.000Z', build: { version: '1.0.0', commit: null } }],
  });
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: 'loc-1',
    name: 'QA',
    createdAt: '2026-11-11T00:00:00.000Z',
    machines: [record],
    accessories: [],
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetRunConfirmStore();
  resetMachineRunStore();
  resetLocationStore();
  __resetMachineStopReportStoreForTests();
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async () => ({ ok: true, bytes: 4, packets: 1, alreadyPresent: false }),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setMachineConsoleLoader(null);
  setMachineUploadLoader(null);
});

async function uploadIt(): Promise<void> {
  fireEvent.click(screen.getByTestId('engrave-upload'));
  fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));
  await advanceUntil(() => screen.getByTestId('engrave-run'));
}

describe('#423 the run panel, in the real tree', () => {
  it('upload → run → close the panel → reopen it: the run is still watched, Stop is there, and it works', async () => {
    setMachineConsoleLoader(async () => client(100));
    const first = render(upload());
    await uploadIt();
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    // #801 — THE CONTROLS ARE VERBS, with the how in ONE caption; the progress lives on the strip.
    expect(screen.getByTestId('engrave-run-pause').textContent).toBe('Pause');
    expect(screen.getByTestId('engrave-run-stop').textContent).toBe('Stop');
    expect(screen.getByTestId('engrave-run-controls-caption').textContent).toContain(
      'Pause takes effect at the next status read.',
    );
    expect(screen.queryByTestId('engrave-run-progress')).toBeNull();
    await advanceUntil(() =>
      expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.progress?.percent).toBe(20),
      { timeoutMs: 6000 },
    );

    first.unmount(); // the engrave panel closes mid-run
    const polledBefore = sent.filter((l) => l === '?').length;
    await advanceUntil(() => expect(sent.filter((l) => l === '?').length).toBeGreaterThan(polledBefore), { timeoutMs: 6000 });
    expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.running).toBe(true); // still watching

    render(upload()); // reopened: the run, from the store
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(true); // Upload locked
    await advanceUntil(() => screen.getByTestId('engrave-run-stop'));
    const stop = screen.getByTestId('engrave-run-stop');
    fireEvent.click(stop);
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), { timeoutMs: 12000 });
    expect(sent).toContain('abort');
    expect(sent.at(-1)).toBe('M852');
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
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeoutMs: 6000 });
    // #469 (R20) — the app's upload OWNS the vacuum, so the runner adds no `M331`/`M332` of its
    // own here, even though this fixture program states neither: a job's span is the post's
    // decision, and an `air: false` file legitimately carries no words. The machine homes on
    // every finish; it is the file (or its absence) that switches the vacuum.
    expect(sent).toEqual(['?', 'play /sd/gcodes/job.nc', '?', '$H']);
    expect(screen.queryByTestId('engrave-run-home')).toBeNull();
    // #806 / #819 — THE DONE CARD: the run and its clock in one title, ONE line for the machine's
    // end state, the offcut question only when there is one, and ONE primary action. The run end's
    // bookkeeping and a second Start are not in it.
    expect(screen.getByTestId('engrave-run-end').dataset.kind).toBe('finished');
    expect(screen.getByTestId('engrave-run-done-title').textContent).toMatch(/^Finished( · .+)?$/);
    expect(screen.queryByTestId('engrave-run-offcut')).toBeNull();
    const card = screen.getByTestId('engrave-run-end');
    expect(card.querySelectorAll('p')).toHaveLength(2); // the title and the one line
    expect(card.querySelectorAll('button')).toHaveLength(1); // Cut another
    expect(screen.getByTestId('engrave-run-outcome').textContent).toContain('vacuum');
    expect(screen.getByTestId('engrave-run-outcome').textContent).toMatch(/homed\.$/);
    expect(screen.queryByTestId('engrave-run-start')).toBeNull();
    expect(screen.queryByTestId('engrave-run-vacuum')).toBeNull();
    fireEvent.click(screen.getByTestId('engrave-run-another'));
    expect(useCncModeStore.getState().mode).toBe('design');
    // #797 — the at-machine statement is Cut step 1's ONE statement now; this panel asks nothing
    // of its own, on this program or on the next.
    expect(screen.queryByTestId('engrave-run-at-machine')).toBeNull();
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'another-hash');
    cleanup();
    render(<EngraveMachineRun target={TARGET} />);
    expect(screen.queryByTestId('engrave-run-at-machine')).toBeNull();
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
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    await advanceUntil(() =>
      expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.progress?.percent).toBe(20),
      { timeoutMs: 6000 },
    );

    fireEvent.click(screen.getByTestId('engrave-run-pause'));
    await advanceUntil(() => expect(sent).toContain('suspend'), { timeoutMs: 6000 });
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-pause').textContent).toContain('Resume'), { timeoutMs: 6000 });
    expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.paused).toBe(true);
    expect((useMachineRunStore.getState().runs[machineKey(TARGET)]?.lines ?? []).join('\n')).toContain('Paused at line');

    fireEvent.click(screen.getByTestId('engrave-run-pause'));
    await advanceUntil(() => expect(sent).toContain('resume'), { timeoutMs: 6000 });
    await advanceUntil(() => expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.paused).toBe(false), { timeoutMs: 6000 });

    fireEvent.click(screen.getByTestId('engrave-run-stop'));
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), { timeoutMs: 12000 });
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
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));
    // The fake controller runs reporting `P:10,20,5` and finishes on `P:9,100,4`.
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeoutMs: 12000 });
    expect(lines).toContain(10);
    expect(lines).toContain(9);
    // Consecutive repeats are dropped: the effect is keyed on the line, not on renders.
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]).not.toBe(lines[i - 1]);
  }, 20000);
});

// #1197 — THE RUN PANEL'S STOPS CARRY THEIR OWN REPORT. #1187's rule is that every stop on a
// transport or controller error offers one; the run's stop and its Home press are stops too, and
// the end card is where the operator reads them.
describe('#1197 — the run panel’s stop reports', () => {
  async function startRun(): Promise<void> {
    render(upload());
    await uploadIt();
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));
  }

  it('offers the report when the abort failed on the transport, with this run’s own facts', async () => {
    const reports: MachineStopReport[] = [];
    setStopReportSendIO(async (report) => {
      reports.push(report as MachineStopReport);
      return { kind: 'ok', path: 'crash-reports/stop-run.json' };
    });
    setMachineConsoleLoader(async () =>
      client(100, {
        abort: {
          ok: false,
          reason: 'refused',
          line: 'abort',
          detail: 'read failed: Connection reset by peer (os error 104)',
          text: '',
        },
      }),
    );
    await startRun();
    await advanceUntil(() => expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.progress?.percent).toBe(20), {
      timeoutMs: 6000,
    });
    fireEvent.click(screen.getByTestId('engrave-run-stop'));
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), {
      timeoutMs: 12000,
    });

    // The card states the transport error, and this stop — not the previous session — is the report.
    expect(screen.getByTestId('engrave-run-outcome').textContent).toContain('read failed: Connection reset by peer');
    const action = screen.getByTestId('stop-report-action');
    expect(action.dataset.action).toBe('run');

    fireEvent.click(screen.getByTestId('stop-report-send'));
    await advanceUntil(() => expect(reports).toHaveLength(1));
    const entry = useMachineRunStore.getState().runs[machineKey(TARGET)]!;
    const report = reports[0]!;
    expect(report.action).toBe('run');
    expect(report.error).toBe('read failed: Connection reset by peer (os error 104)');
    // The run log is the session's transcript, mapped as the store holds it (a string per line).
    expect(report.transcript).toEqual(entry.lines.map((s) => ({ line: '', reply: s })));
    // An upload outside the job flow names the file; there is no package to claim.
    expect(report.job).toEqual({ id: 'job.nc', name: 'job.nc', packageHash: null });
  }, 30000);

  it('offers the home’s report when the Home press fails on the transport', async () => {
    const reports: MachineStopReport[] = [];
    setStopReportSendIO(async (report) => {
      reports.push(report as MachineStopReport);
      return { kind: 'ok', path: 'crash-reports/stop-home.json' };
    });
    setMachineConsoleLoader(async () =>
      client(100, {
        home: { ok: false, reason: 'timeout', line: '$H', detail: 'timeout — no reply within 60000 ms', text: '' },
      }),
    );
    await startRun();
    await advanceUntil(() => expect(useMachineRunStore.getState().runs[machineKey(TARGET)]?.progress?.percent).toBe(20), {
      timeoutMs: 6000,
    });
    fireEvent.click(screen.getByTestId('engrave-run-stop'));
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('aborted'), {
      timeoutMs: 12000,
    });
    fireEvent.click(screen.getByTestId('engrave-run-home'));

    await advanceUntil(() => screen.getByTestId('engrave-run-home-note'));
    expect(screen.getByTestId('engrave-run-home-note').textContent).toBe(
      'Home was not sent: timeout — no reply within 60000 ms',
    );
    const action = screen.getByTestId('stop-report-action');
    expect(action.dataset.action).toBe('home');

    fireEvent.click(screen.getByTestId('stop-report-send'));
    await advanceUntil(() => expect(reports).toHaveLength(1));
    const entry = useMachineRunStore.getState().runs[machineKey(TARGET)]!;
    expect(reports[0]!.action).toBe('home');
    expect(reports[0]!.error).toBe('timeout — no reply within 60000 ms');
    expect(reports[0]!.transcript).toEqual(entry.lines.map((s) => ({ line: '', reply: s })));
    expect(reports[0]!.job).toEqual({ id: 'job.nc', name: 'job.nc', packageHash: null });
  }, 30000);

  it('offers the report when the controller refuses to start in an alarm', async () => {
    const reports: MachineStopReport[] = [];
    setStopReportSendIO(async (report) => {
      reports.push(report as MachineStopReport);
      return { kind: 'ok', path: 'crash-reports/stop-alarm.json' };
    });
    setMachineConsoleLoader(async () => client(0, { firstStatus: '<Idle|MPos:0,0,0>\nALARM: Probe fail' }));
    await startRun();
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('refused'), {
      timeoutMs: 8000,
    });
    expect(screen.getByTestId('engrave-run-outcome').textContent).toContain('ALARM: Probe fail');
    const action = screen.getByTestId('stop-report-action');
    expect(action.dataset.action).toBe('run');

    fireEvent.click(screen.getByTestId('stop-report-send'));
    await advanceUntil(() => expect(reports).toHaveLength(1));
    expect(reports[0]!.action).toBe('run');
    expect(reports[0]!.error).toContain('ALARM: Probe fail');
  }, 30000);

  it('never offers a report for the app’s own refusal', async () => {
    setMachineConsoleLoader(async () => client(0, { firstStatus: '<Run|MPos:0,0,0|P:10,20,5>' }));
    await startRun();
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('refused'), {
      timeoutMs: 8000,
    });
    expect(screen.getByTestId('engrave-run-outcome').textContent).toContain('not Idle');
    expect(screen.queryByTestId('stop-report-action')).toBeNull();
  }, 15000);
});

// #442 (#414/#464) — what the engrave panel hands the run, built once and tested here rather than
// by rendering the whole panel behind `canReachMachine`.
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
    seedMachine(undefined, 'Z1'); // a read frame: the preview's clearance is known
    setMachineConsoleLoader(async () => client(1, { toolPolls: 8 }));
    render(upload());
    await uploadIt();
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));

    await advanceUntil(() => screen.getByTestId('engrave-run-tool-prompt'), { timeoutMs: 8000 });
    // An upload with no run context (a file outside the job flow) names the tool number only.
    expect(screen.getByTestId('engrave-run-tool-words').textContent).toBe(
      'The machine is waiting for tool 1 to be in the spindle.',
    );
    // Nothing to suspend while it waits: Pause is not offered, Stop still is.
    expect(screen.queryByTestId('engrave-run-pause')).toBeNull();
    expect(screen.getByTestId('engrave-run-stop')).toBeTruthy();
    // #1202 — the tool change is a motion routine: an unrecorded shape is marked and the operator's
    // own statement holds the Continue (this window has no machine record: it has never run here).
    expect(screen.getByTestId('engrave-registration-first-run')).toBeTruthy();
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));

    fireEvent.click(screen.getByTestId('engrave-run-tool-continue'));
    await advanceUntil(() => expect(sent).toContain('M490.2'), { timeoutMs: 8000 });
    await advanceUntil(() => expect(screen.getByTestId('engrave-run-outcome').dataset.state).toBe('finished'), { timeoutMs: 8000 });
    expect(screen.queryByTestId('engrave-run-tool-prompt')).toBeNull();
  }, 30000);
});

// #1202 — THE CLEARANCE THE PREVIEW REVIEWS AGAINST. Without a reading the guard's verdict is
// refused, never invented; but only a FIRST-RUN press is held by it — a proved shape keeps the
// only way on from a mid-job tool stop.
describe('#1202 the tool-change preview’s clearance', () => {
  it('holds a first-run Continue on an unknown clearance, even when its statement is ticked', async () => {
    // No location record for this host:port — there is no frame to read, so the card refuses.
    setMachineConsoleLoader(async () => client(1, { toolPolls: 8 }));
    render(upload());
    await uploadIt();
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));

    await advanceUntil(() => screen.getByTestId('engrave-run-tool-prompt'), { timeoutMs: 8000 });
    expect(screen.getByTestId('engrave-registration-first-run')).toBeTruthy();
    expect(screen.getByTestId('engrave-registration-dry-error').textContent).toContain('clearance unknown');
    const cont = (): HTMLButtonElement => screen.getByTestId('engrave-run-tool-continue') as HTMLButtonElement;
    expect(cont().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));
    expect(cont().disabled).toBe(true); // no reading is not a statement: the press stays held
  }, 30000);

  it('keeps a proved shape’s Continue on an unknown clearance, and still shows the refusal', async () => {
    seedMachine(toolChangeIdentity().shape);
    setMachineConsoleLoader(async () => client(1, { toolPolls: 8 }));
    render(upload());
    await uploadIt();
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    fireEvent.click(screen.getByTestId('engrave-run-start'));

    await advanceUntil(() => screen.getByTestId('engrave-run-tool-prompt'), { timeoutMs: 8000 });
    // Recorded here before: NOT a first run — the refusal is shown, the way on is not taken away.
    expect(screen.queryByTestId('engrave-registration-first-run')).toBeNull();
    expect(screen.getByTestId('engrave-registration-dry-error').textContent).toContain('clearance unknown');
    const cont = screen.getByTestId('engrave-run-tool-continue') as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);
    await advanceUntil(() => expect(sent).toContain('M490.2'), { timeoutMs: 8000 });
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
