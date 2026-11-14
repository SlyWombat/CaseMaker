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

/**
 * The runs API moves whole job documents and whole generated documents, not the small house
 * records `houseRequest`'s no-service default is sized for (2 s). A twenty-minute run's result can
 * be tens of megabytes over the LAN; the submit body can be a design job's meshes. Thirty seconds
 * still calls a dead service dead.
 */
const RUNS_TIMEOUT_MS = 30_000;

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
/**
 * #1175 — the inputs a Generate carries beyond the job document. The browser's call passes the
 * app's own tool library (the ideal plan's candidate set, `getTools().map((entry) => entry.tool)`)
 * and the run-sheet's ladder press; both are forwarded so the house CLI plans with the same inputs
 * rather than its own disk snapshot. Absent: the CLI keeps its bootstrap behaviour, exactly as a
 * pre-#1175 submit.
 */
export async function submitRun(body: {
  job: unknown;
  shopEtag?: string | null;
  /** #1046 — the virtual ladder on the owned plan (the CLI's `--rest-ladder`). */
  restLadder?: boolean;
  /** #961 — the ideal plan's candidate set, as the browser's Generate passes it. */
  tools?: readonly unknown[];
}): Promise<RunsSubmit> {
  const res = await houseRequest('POST', '/runs', body, { timeoutMs: RUNS_TIMEOUT_MS });
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<{ runId: string; queuePosition: number; key: RunsKey }>(res.text);
  if (!parsed.ok) return { kind: 'error', detail: parsed.detail };
  return { kind: 'ok', ...parsed.value };
}

/** Read the run's snapshot. */
export async function readRun(id: string): Promise<RunRead> {
  const res = await houseRequest('GET', `/runs/${encodeURIComponent(id)}`, undefined, { timeoutMs: RUNS_TIMEOUT_MS });
  if (res.kind !== 'ok') return res;
  const parsed = parseJson<RunSnapshot>(res.text);
  return parsed.ok ? { kind: 'ok', run: parsed.value } : { kind: 'error', detail: parsed.detail };
}

/** The result-document version this build reads (#1126 slice 2). */
export const RUN_RESULT_VERSION = 2;

export type RunResult = { kind: 'ok'; result: Record<string, unknown> } | HouseFailure;
export type RunProgramText = { kind: 'ok'; text: string } | HouseFailure;

/**
 * How long a streamed run file may go without a byte before the read is called dead. NOT a cap on
 * the total: a tray run's result and its programs can legitimately take minutes over a LAN. What is
 * not legitimate is a stalled stream, and that is what this measures — every chunk re-arms it.
 */
const RUN_STREAM_IDLE_MS = 20_000;
let runStreamIdleMs = RUN_STREAM_IDLE_MS;

/** Test seam: shrink the inactivity window so a spec can observe a stalled stream. */
export function setRunGeneratedIdleMs(ms: number): void {
  runStreamIdleMs = Math.max(1, ms);
}

function runsUrl(path: string): string {
  return `${(houseBaseUrl() || '').replace(/\/+$/, '')}${HOUSE_API_PATH}/runs${path}`;
}

/**
 * Read one streamed run file as text, with an inactivity rule rather than a total cap.
 *
 * `houseRequest` buffers a body and times the whole request; that is right for a tool list and
 * wrong for a result or a program, which can be megabytes and slow. This fetches, reads chunk by
 * chunk, re-arms the idle timer on every chunk, and assembles the text once the stream ends. `what`
 * names the file in the stall sentence, so a reader can say which transfer died.
 */
async function readStreamedText(
  url: string,
  opts: StreamRunOptions,
  what: string,
): Promise<RunProgramText> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json, text/plain' },
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (e) {
    return { kind: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) {
    // The service writes every error body as {"error": sentence}; anything else is a status.
    let message = `the runs API answered ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Not the service's shape: the status sentence stands.
    }
    return { kind: 'refused', status: res.status, message };
  }
  if (res.body === null) {
    return { kind: 'error', detail: 'the runs API answered without a body' };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      void reader.cancel();
    }, runStreamIdleMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      if (value !== undefined) chunks.push(value);
    }
  } catch (e) {
    if (!stalled) {
      return { kind: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (stalled) {
    return {
      kind: 'error',
      detail: `${what} stopped arriving for ${Math.round(runStreamIdleMs / 1000)} s`,
    };
  }
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { kind: 'ok', text: new TextDecoder().decode(bytes) };
}

/**
 * Read the run's RESULT document (#1126 slice 2, `resultVersion: 2`). It carries everything the
 * store settles with — findings, verify, cam, plans, goal checks — and NO NC text and NO `camIr`:
 * the files are named in `files` and fetched by name ({@link fetchRunProgram}).
 *
 * A version this build does not read is refused by name rather than guessed at: an older result
 * names its files differently, and a silent mis-read would hand the store another program's text.
 */
export async function readRunResult(
  id: string,
  opts: StreamRunOptions = {},
): Promise<RunResult> {
  const text = await readStreamedText(
    runsUrl(`/${encodeURIComponent(id)}/generated`),
    opts,
    'the result document',
  );
  if (text.kind !== 'ok') return text;
  const parsed = parseJson<Record<string, unknown>>(text.text);
  if (!parsed.ok) return { kind: 'error', detail: parsed.detail };
  const version = parsed.value['resultVersion'];
  if (version !== RUN_RESULT_VERSION) {
    return {
      kind: 'error',
      detail: `the house result was written by a build this one does not read (resultVersion ${String(version)}); generate again`,
    };
  }
  return { kind: 'ok', result: parsed.value };
}

/** One of the run's own files, by the name its result listed (`/programs/:name`). */
export async function fetchRunProgram(
  id: string,
  name: string,
  opts: StreamRunOptions = {},
): Promise<RunProgramText> {
  return readStreamedText(
    runsUrl(`/${encodeURIComponent(id)}/programs/${encodeURIComponent(name)}`),
    opts,
    `the program ${name}`,
  );
}

/** Cancel the run: the service terminates and reaps its child; the state settles 'cancelled'. */
export async function cancelRun(id: string): Promise<RunCancel> {
  const res = await houseRequest('POST', `/runs/${encodeURIComponent(id)}/cancel`, undefined, { timeoutMs: RUNS_TIMEOUT_MS });
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
  const url = runsUrl(`/${encodeURIComponent(id)}/events`);
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
