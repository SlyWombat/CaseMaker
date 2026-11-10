/**
 * #1126 slice 1 — THE RUNS CLIENT: the browser asks the house to generate, reads the receipt and
 * the progress stream, and cancels. The house service implements these routes over the CLI path;
 * this spec pins the browser side's contract (and the sentences the panel reads).
 *
 * The three request methods go through the house client's `call` seam (the location client's own
 * route); the event stream is its own fetch, injectable so the SSE framing is tested here without
 * a server.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import {
  cancelRun,
  readRun,
  streamRunEvents,
  submitRun,
  type RunEvent,
} from '@/platform/runsClient';

/** A fake house client whose answers the test scripts per (method, path). */
function fakeHouse(answers: Record<string, HouseCall>): { calls: { method: string; path: string; body: unknown }[] } {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = {
    call: async (method: string, path: string, body?: unknown): Promise<HouseCall> => {
      calls.push({ method, path, body });
      const answer = answers[`${method} ${path}`];
      if (answer === undefined) return { kind: 'refused', status: 404, message: `${method} ${path} is not served here` };
      return answer;
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { calls };
}

afterEach(() => setHouseClientLoader(null));

const JOB = { id: 'job-1', name: 'Tray', stock: { length: 160, width: 126, thickness: 25 } };

describe('#1126 — submitting a run', () => {
  it('posts the job and reads the runId, queue position and key', async () => {
    const house = fakeHouse({
      'POST /runs': {
        kind: 'ok',
        text: JSON.stringify({ runId: 'run-7', queuePosition: 2, key: { jobSha: 'abc123', build: 'b1' } }),
      },
    });
    const result = await submitRun({ job: JOB, shopEtag: '"loc-4"' });
    expect(result).toEqual({ kind: 'ok', runId: 'run-7', queuePosition: 2, key: { jobSha: 'abc123', build: 'b1' } });
    expect(house.calls[0]!.method).toBe('POST');
    expect(house.calls[0]!.path).toBe('/runs');
    expect(house.calls[0]!.body).toEqual({ job: JOB, shopEtag: '"loc-4"' });
  });

  it('a full queue answers the service’s plain 429 sentence', async () => {
    fakeHouse({ 'POST /runs': { kind: 'refused', status: 429, message: 'the house queue is full — try again when a run finishes' } });
    const result = await submitRun({ job: JOB });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.status).toBe(429);
    expect(result.message).toContain('queue is full');
  });

  it('a moved shop record is refused at submit with the service’s sentence', async () => {
    fakeHouse({ 'POST /runs': { kind: 'refused', status: 412, message: 'the shop changed since this page read it — read it again and press Generate' } });
    const result = await submitRun({ job: JOB, shopEtag: '"loc-3"' });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.status).toBe(412);
  });
});

describe('#1126 — reading a run', () => {
  it('returns the state, progress and receipt as served', async () => {
    const snapshot = {
      id: 'run-7',
      state: 'running',
      queuePosition: 0,
      progress: { stage: 'plan', label: 'planning the sequence — setup 1', done: 3, total: 9 },
      receipt: null,
      programs: [],
      finding: null,
    };
    fakeHouse({ 'GET /runs/run-7': { kind: 'ok', text: JSON.stringify(snapshot) } });
    const result = await readRun('run-7');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.run).toEqual(snapshot);
  });

  it('a done run carries its receipt and program names', async () => {
    const done = {
      id: 'run-7',
      state: 'done',
      progress: { stage: 'done', pct: 100 },
      receipt: { stage: 'done', programs: [{ ncFile: 'tray-p01.nc', ncHash: 'h1' }] },
      programs: [{ name: 'tray-p01.nc', hash: 'h1' }],
      finding: null,
    };
    fakeHouse({ 'GET /runs/run-7': { kind: 'ok', text: JSON.stringify(done) } });
    const result = await readRun('run-7');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.run.state).toBe('done');
    expect(result.run.programs).toEqual([{ name: 'tray-p01.nc', hash: 'h1' }]);
  });
});

describe('#1126 — cancelling a run', () => {
  it('posts the cancel and reads the settled state', async () => {
    const house = fakeHouse({ 'POST /runs/run-7/cancel': { kind: 'ok', text: JSON.stringify({ state: 'cancelled' }) } });
    const result = await cancelRun('run-7');
    expect(result).toEqual({ kind: 'ok', state: 'cancelled' });
    expect(house.calls[0]!.path).toBe('/runs/run-7/cancel');
  });
});

describe('#1126 — the progress stream', () => {
  it('parses SSE frames into the engine’s own progress objects', async () => {
    const frames = [
      'data: {"stage":"plan","label":"planning the sequence — setup 1","done":3,"total":9,"at":"2026-11-10T01:00:00Z"}\n\n',
      'data: {"stage":"note","label":"  pick      cutter 1 — 0.8 mm flat"}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const seen: RunEvent[] = [];
    await streamRunEvents('run-7', (e) => {
      seen.push(e);
    }, { fetchImpl });
    expect(seen).toEqual([
      { stage: 'plan', label: 'planning the sequence — setup 1', done: 3, total: 9, at: '2026-11-10T01:00:00Z' },
      { stage: 'note', label: '  pick      cutter 1 — 0.8 mm flat' },
    ]);
  });

  it('stops at the end of the stream and ignores non-data frames', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        controller.enqueue(new TextEncoder().encode('event: progress\ndata: {"stage":"verify","label":"verifying program 1"}\n\n'));
        controller.close();
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const seen: RunEvent[] = [];
    await streamRunEvents('run-7', (e) => {
      seen.push(e);
    }, { fetchImpl });
    expect(seen).toEqual([{ stage: 'verify', label: 'verifying program 1' }]);
  });
});
