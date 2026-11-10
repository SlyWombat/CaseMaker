/**
 * #1154 — end to end through the run store: the app's own `?` heartbeat lines are kept during the
 * run, and at the run's end they land in the job's run-log entry — the house copy of the
 * finished-program record — with the header, one ISO line per sample (state, raw P:, WPos) and a
 * stated thinning note. Save / Save all then write them as `<program>-status.log` (the file-list
 * spec covers the naming; this one covers the data reaching the record).
 *
 * FAKE CONTROLLER: the replies below are the shapes the Z1 answers (the bench's status line), and
 * nothing here touches a machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { programHash } from '@/platform/machineRun';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { freezePackage } from '@/engine/cnc/engrave/package';
import {
  resetMachineRunStore,
  setRunEndIO,
  useMachineRunStore,
  type RunContext,
  type RunEndIO,
} from '@/store/machineRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { VerifyReport } from '@/engine/cnc/verify';

const TARGET = { host: '192.0.2.10', port: 2222 };
const M = `${TARGET.host}:${TARGET.port}`;
const NC = [
  'G90 G21',
  'T1 M6',
  'G53 G0 Z-3',
  'S12000 M3',
  'G0 X30 Y0',
  'G0 Z1',
  'G1 Z-0.5 F600',
  'G1 X30 Y100 F600',
  'G0 Z5',
  'M5',
  'M2',
].join('\n');
const VERIFY: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

/** Nothing is written at the end: this spec is about the heartbeat, not the shelf. */
function quietIO(): RunEndIO {
  return {
    refreshStock: async () => {},
    stockItem: () => null,
    consume: async () => ({ ok: true, text: '' }),
    addOffcut: async () => ({ ok: true, text: '' }),
    inventory: () => [],
    updateItem: async () => ({ ok: true, text: '' }),
    machineIdFor: () => null,
    recordFinishedProgram: async () => ({ ok: true, added: true, text: '' }),
    minSideMm: () => 20,
    offerOffcuts: () => false,
    wearWeight: () => ({ value: 1, source: 'test' }),
    newId: () => 'offcut-1',
    now: () => '2026-11-10T00:00:00.000Z',
  };
}

/** Idle, then two Run polls with the raw fields, then Idle at 100 %: a finished program. */
function z1(): MachineConsoleClient {
  let played = false;
  let runs = 0;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          let text = 'ok';
          if (line === '?') {
            if (!played) text = '<Idle|MPos:0,0,0>';
            else if (runs === 0) {
              runs = 1;
              text = '<Run|MPos:-3.000,-2.000,-1.000|WPos:12.345,20.100,-0.500|F:600.0|S:12000.0|P:10,20,5>';
            } else if (runs === 1) {
              runs = 2;
              text = '<Run|MPos:-3.000,-2.000,-1.000|WPos:12.400,20.100,-0.500|F:600.0|S:12000.0|P:20,40,10>';
            } else text = '<Idle|MPos:0,0,0|P:30,100,30>';
          } else if (line.startsWith('play')) {
            played = true;
            text = 'File size 10';
          }
          return { ok: true, line, text, frames: 1, elapsedMs: 1 };
        },
        async close() {},
      };
    },
  };
}

async function waitForEnd(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (useMachineRunStore.getState().runs[M]?.end) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the run did not end: ${JSON.stringify(useMachineRunStore.getState().runs[M]?.outcome)}`);
}

beforeEach(() => {
  setMachineConsoleLoader(async () => z1());
  setRunEndIO(quietIO());
  resetMachineRunStore();
});

afterEach(() => {
  setMachineConsoleLoader(null);
  setRunEndIO(null);
});

describe('#1154 — the run keeps its own heartbeat, end to end', () => {
  it('lands the kept status lines in the run-log entry with the header and the sample format', async () => {
    const job = defaultEngraveJob();
    job.name = 'Status job';
    const program = {
      setupIndex: 1,
      setupId: 'setup-1',
      toolKey: job.toolKey,
      nc: NC,
      verify: VERIFY,
      frameNc: null,
      frameVerify: null,
      programHash: programHash(NC),
      cam: null,
    };
    const made = freezePackage(job, [program], '2026-11-10T00:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    useEngraveJobStore.setState({ job: { ...job, package: made.package, runLog: undefined } });
    const ctx: RunContext = {
      nc: NC,
      jobId: job.id,
      programHash: programHash(NC),
      setupIndex: 1,
      setupId: 'setup-1',
      toolKey: job.toolKey,
      programIndex: 2,
      programTotal: 5,
    };

    useMachineRunStore.getState().prepare(TARGET, 'Status-job.nc', programHash(NC), ctx);
    expect(useMachineRunStore.getState().start(TARGET, { pollMs: 2000, noProgressMs: 30000, missLimit: 3 })).toBe(true);
    await waitForEnd();
    expect(useMachineRunStore.getState().runs[M]!.outcome?.kind).toBe('finished');

    const entry = useEngraveJobStore
      .getState()
      .job.runLog?.find((e) => e.programHash === programHash(NC));
    expect(entry, 'the run log must carry the finished program').toBeDefined();
    const text = entry!.statusLog;
    expect(text, 'the heartbeat lines are kept with the finished-program record').toBeDefined();
    const lines = text!.split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe('# Status job — program 2 of 5; status lines from the run’s own ? polls');
    expect(lines[1]).toContain('no thinning');
    // One line per kept sample: ISO time, state, the P: fields raw, WPos.
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}Run {2}P:10,20,5 {2}WPos:12\.345,20\.100,-0\.500$/);
    expect(lines[3]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}Run {2}P:20,40,10 {2}WPos:12\.400,20\.100,-0\.500$/);
    // The finish's own Idle reply is a sample too (every poll is kept inside the first 5 min).
    expect(lines[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}Idle {2}P:30,100,30 {2}WPos:-$/);
    expect(lines).toHaveLength(5);
  }, 30000);
});
