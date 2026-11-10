/**
 * #1126 — GENERATE ON THE HOUSE, from the panel's side: submit, follow, settle.
 *
 * The service's routes are faked at the client seam (`runsClient`'s five calls and the health
 * probe), because what this spec holds is the browser's half of the contract: the shop ETag goes
 * with the submit and only with the submit, a done run's generated document is what the caller
 * gets back, a failed run throws the service's own finding, and the CLI's progress frames become
 * the panel's `EngraveProgress` without inventing stages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/houseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/houseClient')>();
  return { ...actual, probeHouse: vi.fn() };
});

vi.mock('@/platform/runsClient', () => ({
  submitRun: vi.fn(),
  readRun: vi.fn(),
  readRunGenerated: vi.fn(),
  streamRunEvents: vi.fn(async () => undefined),
  cancelRun: vi.fn(async () => ({ kind: 'ok', state: 'cancelled' as const })),
}));

import { probeHouse } from '@/platform/houseClient';
import * as runs from '@/platform/runsClient';
import {
  houseEngraveGenerate,
  houseFailureSentence,
  houseGenerationAvailable,
  setHouseRunPollMs,
} from '@/platform/houseGenerate';
import { useLocationStore } from '@/store/locationStore';
import type { EngraveProgress } from '@/workers/sim/engraveGenerate';

const mocked = {
  probeHouse: vi.mocked(probeHouse),
  submitRun: vi.mocked(runs.submitRun),
  readRun: vi.mocked(runs.readRun),
  readRunGenerated: vi.mocked(runs.readRunGenerated),
  streamRunEvents: vi.mocked(runs.streamRunEvents),
};

const JOB = { name: 'Tray', stock: { length: 160, width: 126, thickness: 25 } };

beforeEach(() => {
  setHouseRunPollMs(5);
  useLocationStore.setState({ etag: '"loc-4"' });
});

afterEach(() => {
  // resetAllMocks, not clearAllMocks: a mock IMPLEMENTATION set in one test (the stream's frame
  // replay) must not leak into the next one and fire before the submit's own frames.
  vi.resetAllMocks();
  useLocationStore.setState({ etag: null });
});

describe('#1126 — is the house able to generate?', () => {
  it('is true only when the service answers and says it can run generation', async () => {
    mocked.probeHouse.mockResolvedValue({
      kind: 'present',
      health: { runs: true } as never,
      base: '',
    });
    expect(await houseGenerationAvailable()).toBe(true);

    mocked.probeHouse.mockResolvedValue({
      kind: 'present',
      health: { runs: false } as never,
      base: '',
    });
    expect(await houseGenerationAvailable()).toBe(false);

    // No service is not an error: the in-page path is the answer.
    mocked.probeHouse.mockResolvedValue({ kind: 'absent', reason: 'no service here' });
    expect(await houseGenerationAvailable()).toBe(false);
  });
});

describe('#1126 — following a house run', () => {
  it('submits with the shop ETag, follows the frames, and returns the generated document', async () => {
    const generated = { ok: true, stage: 'done', nc: 'G0 X0 Y0' };
    mocked.submitRun.mockResolvedValue({
      kind: 'ok',
      runId: 'run-7',
      queuePosition: 0,
      key: { jobSha: 'abc', build: 'b1' },
    });
    mocked.readRun
      .mockResolvedValueOnce({
        kind: 'ok',
        run: { id: 'run-7', state: 'running', programs: [], receipt: null, finding: null },
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        run: { id: 'run-7', state: 'done', programs: [], receipt: { ok: true }, finding: null },
      });
    mocked.readRunGenerated.mockResolvedValue({ kind: 'ok', generated });
    mocked.streamRunEvents.mockImplementation(async (_id, onEvent) => {
      onEvent({ stage: 'plan', label: 'planning the sequence — setup 1', done: 3, total: 9 });
      onEvent({ stage: 'note', label: '  pick      cutter 1 — 0.8 mm flat' });
      onEvent({ stage: 'not-a-stage', label: 'ignored' });
    });

    const progress: EngraveProgress[] = [];
    const result = await houseEngraveGenerate({
      job: JOB as never,
      tool: null,
      catalogue: [],
      calibration: null,
      margins: {} as never,
      onProgress: (p) => progress.push(p),
    });

    expect(result).toBe(generated);
    expect(mocked.submitRun).toHaveBeenCalledTimes(1);
    expect(mocked.submitRun).toHaveBeenCalledWith({ job: JOB, shopEtag: '"loc-4"' });
    // The engine's frame is passed through; the note keeps the stage it was emitted in; an
    // unknown stage is not guessed at.
    expect(progress).toEqual([
      { stage: 'plan', label: 'planning the sequence — setup 1', done: 3, total: 9 },
      { stage: 'plan', label: '  pick      cutter 1 — 0.8 mm flat' },
    ]);
  });

  it('omits the shop ETag when this page has not read the location', async () => {
    useLocationStore.setState({ etag: null });
    mocked.submitRun.mockResolvedValue({
      kind: 'ok',
      runId: 'run-8',
      queuePosition: 0,
      key: { jobSha: 'abc', build: 'b1' },
    });
    mocked.readRun.mockResolvedValue({
      kind: 'ok',
      run: { id: 'run-8', state: 'done', programs: [], receipt: {}, finding: null },
    });
    mocked.readRunGenerated.mockResolvedValue({ kind: 'ok', generated: { ok: true } });
    await houseEngraveGenerate({
      job: JOB as never,
      tool: null,
      catalogue: [],
      calibration: null,
      margins: {} as never,
    });
    expect(mocked.submitRun).toHaveBeenCalledWith({ job: JOB });
  });

  it('reports a queued run, so the silence watchdog does not time a run that is waiting', async () => {
    mocked.submitRun.mockResolvedValue({
      kind: 'ok',
      runId: 'run-q',
      queuePosition: 2,
      key: { jobSha: 'abc', build: 'b1' },
    });
    mocked.readRun.mockResolvedValue({
      kind: 'ok',
      run: { id: 'run-q', state: 'done', programs: [], receipt: {}, finding: null },
    });
    mocked.readRunGenerated.mockResolvedValue({ kind: 'ok', generated: { ok: true } });
    const progress: EngraveProgress[] = [];
    await houseEngraveGenerate({
      job: JOB as never,
      tool: null,
      catalogue: [],
      calibration: null,
      margins: {} as never,
      onProgress: (p) => progress.push(p),
    });
    expect(progress[0]).toEqual({ stage: 'prepare', label: 'queued on the house — position 2' });
  });

  it('throws the service’s own sentence when the submit is refused', async () => {
    mocked.submitRun.mockResolvedValue({
      kind: 'refused',
      status: 429,
      message: 'the house queue is full — try again when a run finishes',
    });
    await expect(
      houseEngraveGenerate({
        job: JOB as never,
        tool: null,
        catalogue: [],
        calibration: null,
        margins: {} as never,
      }),
    ).rejects.toThrow('the house queue is full — try again when a run finishes');
  });

  it('throws the run’s stated finding when the run fails', async () => {
    mocked.submitRun.mockResolvedValue({
      kind: 'ok',
      runId: 'run-9',
      queuePosition: 0,
      key: { jobSha: 'abc', build: 'b1' },
    });
    mocked.readRun.mockResolvedValue({
      kind: 'ok',
      run: {
        id: 'run-9',
        state: 'failed',
        programs: [],
        receipt: null,
        finding: 'the run exceeded the house’s 3600 s wall-clock cap and was stopped',
      },
    });
    await expect(
      houseEngraveGenerate({
        job: JOB as never,
        tool: null,
        catalogue: [],
        calibration: null,
        margins: {} as never,
      }),
    ).rejects.toThrow('wall-clock cap');
  });
});

describe('#1126 — failure sentences', () => {
  it('surfaces a refusal, an absent service and a read error each in their own words', () => {
    expect(houseFailureSentence({ kind: 'refused', status: 412, message: 'the shop changed' })).toBe('the shop changed');
    expect(houseFailureSentence({ kind: 'absent', reason: 'no service here' })).toBe('no service here');
    expect(houseFailureSentence({ kind: 'error', detail: 'unreadable JSON' })).toBe('unreadable JSON');
  });
});
