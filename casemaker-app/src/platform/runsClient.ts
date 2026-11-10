/**
 * #1126 — THE HOUSE'S RUNS API, from the browser's side.
 *
 * Generate asks the house to plan, post, verify, simulate and check (the CLI's own path, spawned
 * by the house service); the browser reads progress, the receipt and the programs, and cancels.
 * Slice 1's routes:
 *
 *   POST /api/v1/runs                 { job, shopEtag? } → 202 { runId, queuePosition, key }
 *   GET  /api/v1/runs/<id>            the run's snapshot (state, progress, receipt, programs)
 *   GET  /api/v1/runs/<id>/events     the CLI's progress frames as SSE (see {@link RunEvent})
 *   POST /api/v1/runs/<id>/cancel     terminate the child; the run settles 'cancelled'
 *
 * The three request methods go through `houseRequest` (the location client's own route), so every
 * fake client in the specs serves them with `call`; the stream is plain `fetch` with an injectable
 * implementation, because SSE is not a request/response.
 *
 * THE KEY IS `(jobSha, build)` — never the location's ETag: the ETag moves on every finished-
 * program write, so an ETag-keyed run would be lost after program 1 (#1123-11). The shop ETag is
 * checked at SUBMIT only (412 when it moved), and a restored run is judged by its own inputs.
 */

import { HOUSE_API_PATH, houseRequest, type HouseFailure } from './houseClient';
import { houseBaseUrl } from './houseBaseUrl';

export interface RunsKey {
  jobSha: string;
  build: string;
}

export type RunsSubmit =
  | { kind: 'ok'; runId: string; queuePosition: number; key: RunsKey }
  | HouseFailure;

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** One program the run posted: the name a release saves and the hash the gate reads. */
export interface RunProgram {
  name: string;
  hash: string;
}

export interface RunSnapshot {
  id: string;
  state: RunState;
  queuePosition?: number;
  /** The run's latest progress frame (see {@link RunEvent}). */
  progress?: RunEvent | null;
  /** The CLI's `--json` receipt once the run is done (null while it runs). */
  receipt?: unknown;
  programs?: RunProgram[];
  /** A stated finding when the run failed or was killed (e.g. the wall-clock cap). */
  finding?: string | null;
}

export type RunRead = { kind: 'ok'; run: RunSnapshot } | HouseFailure;
export type RunCancel = { kind: 'ok'; state: RunState } | HouseFailure;

/**
 * One progress frame, exactly as the CLI wrote it with `--events` (#1126):
 *
 *   - the ENGINE'S OWN `EngraveProgress` objects — `{ stage, label, done?, total? }` — the same
 *     objects the browser worker reports, so the panel reads a house run's progress with the type
 *     it already reads an in-page run's with;
 *   - `{ stage: 'note', label }` for each human progress line (pick words, advisories).
 *
 * `at` is added by the service when it relays a frame; the CLI never invents a timestamp.
 */
export interface RunEvent {
  stage: string;
  label?: string;
  done?: number;
  total?: number;
  at?: string;
}

function parseJson<T>(text: string): { ok: true; value: T } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, detail: 'the runs API answered unreadable JSON' };
  }
}

/** Submit a job. The service validates the shop's ETag (412 when it moved) and the queue (429). */
export async function submitRun(body: { job: unknown; shopEtag?: string | null }): Promise<RunsSubmit> {
  const res = await houseRequest('POST', '/runs', body);
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<{ runId: string; queuePosition: number; key: RunsKey }>(res.text);
  if (!parsed.ok) return { kind: 'error', detail: parsed.detail };
  return { kind: 'ok', ...parsed.value };
}

/** Read the run's snapshot. */
export async function readRun(id: string): Promise<RunRead> {
  const res = await houseRequest('GET', `/runs/${encodeURIComponent(id)}`);
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<RunSnapshot>(res.text);
  return parsed.ok ? { kind: 'ok', run: parsed.value } : { kind: 'error', detail: parsed.detail };
}

export type RunGenerated = { kind: 'ok'; generated: unknown } | HouseFailure;

/**
 * Read the run's generated document — the plain-data result the CLI's `--generated` wrote beside
 * the programs. It is the same object the browser's worker returns from `engraveGenerate`, so the
 * panel settles a house run with it exactly as it settles an in-page one.
 */
export async function readRunGenerated(id: string): Promise<RunGenerated> {
  const res = await houseRequest('GET', `/runs/${encodeURIComponent(id)}/generated`);
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<unknown>(res.text);
  return parsed.ok ? { kind: 'ok', generated: parsed.value } : { kind: 'error', detail: parsed.detail };
}

/** Cancel the run: the service terminates and reaps its child; the state settles 'cancelled'. */
export async function cancelRun(id: string): Promise<RunCancel> {
  const res = await houseRequest('POST', `/runs/${encodeURIComponent(id)}/cancel`);
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<{ state: RunState }>(res.text);
  return parsed.ok ? { kind: 'ok', state: parsed.value.state } : { kind: 'error', detail: parsed.detail };
}

export interface StreamRunOptions {
  signal?: AbortSignal;
  /** Test seam: the fetch the stream runs on (the real one in the app). */
  fetchImpl?: typeof fetch;
}

/**
 * Follow the run's progress stream until it closes. Each SSE `data:` frame is one stage tick; a
 * `: keep-alive` comment and other event fields are ignored. A stream that cannot be read simply
 * ends — the panel polls `readRun` as the fallback, so a lost stream is not a lost run.
 */
export async function streamRunEvents(
  id: string,
  onEvent: (event: RunEvent) => void,
  opts: StreamRunOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(houseBaseUrl() || '').replace(/\/+$/, '')}${HOUSE_API_PATH}/runs/${encodeURIComponent(id)}/events`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'text/event-stream' },
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch {
    return;
  }
  if (!res.ok || res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames end with a blank line; a `data:` line carries one JSON event.
      let cut = buffer.indexOf('\n\n');
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const parsed = parseJson<RunEvent>(line.slice('data:'.length).trim());
          if (parsed.ok) onEvent(parsed.value);
        }
        cut = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // An aborted or broken stream ends the follow; the caller polls `readRun`.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A reader already released by an abort: nothing to do.
    }
  }
}
