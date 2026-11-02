/**
 * #881 / #902 — THE ONE CDP HEAP PROBE.
 *
 * The app's memory lives in the page AND in its dedicated workers (the sim worker, the roughing
 * level pool). Node RSS and `performance.memory` see neither shape, so this probe speaks the
 * browser's own DevTools protocol: `Target.getTargets` to find the targets, an attach per target,
 * and `Runtime.getHeapUsage` on each.
 *
 * The gpd-dave lessons, which are the whole reason this is a shared library:
 *
 * - A dedicated WORKER answers only `Runtime.getHeapUsage`. Asking it for domains or documents
 *   that the page normally answers wedges the call.
 * - A DEAD TARGET never settles a request. Every CDP call here is raced against a timeout, so a
 *   worker that died mid-run costs one `null`, never a hung probe.
 * - A report never claims a measurement it did not take: `page` is `null` (not 0) and a worker's
 *   `heapBytes` is `null` when its reading failed.
 *
 * `heapBytes` is `usedSize + backingStorageSize`: the packed move stores are typed arrays, whose
 * memory lives in the backing store rather than the JS heap, and a probe that ignored it would
 * under-report every planner by most of its cost. The components are reported beside the sum.
 *
 * Sampling is per CONNECTION: `sampleHeaps` opens the browser endpoint, reads every target, and
 * closes again. `watchHeaps` does that on an interval and hands each sample to the caller, whose
 * stop function ends the watch. Used by `scripts/sim-memory-probe.mts` (the CLI) and by the
 * in-repo measurements for #881 and #902.
 */

/** One target the probe saw, as the protocol names it. */
export interface HeapTarget {
  id: string;
  type: string;
  url: string;
}

/** One worker's reading; nulls say the reading was not taken. */
export interface WorkerHeap extends HeapTarget {
  /** `usedSize + backingStorageSize`, or null when the target could not be read. */
  heapBytes: number | null;
  usedBytes: number | null;
  backingBytes: number | null;
}

/** One sample of the page and its workers. */
export interface HeapSample {
  /** `Date.now()` when the sample was taken. */
  at: number;
  /** The page target's `usedSize + backingStorageSize`, or null when it could not be read. */
  page: number | null;
  /** Every target the protocol listed, so a caller can group (the pool's workers, the sim's). */
  targets: HeapTarget[];
  /** The dedicated and service workers, each with its own reading. */
  workers: WorkerHeap[];
}

export interface HeapProbeOptions {
  /** The browser endpoint's WebSocket URL, e.g. `ws://127.0.0.1:9333/devtools/browser/...`. */
  cdpUrl: string;
  /** Every CDP call is raced against this, ms. A dead target costs one null, not a hang. */
  timeoutMs?: number;
}

export interface WatchHeapsOptions extends HeapProbeOptions {
  /** Time between samples, ms. */
  intervalMs?: number;
}

/** The browser websocket from a `--remote-debugging-port` endpoint (http://host:port). */
export async function cdpWebSocketUrl(endpoint: string, timeoutMs = 5000): Promise<string> {
  const url = endpoint.endsWith('/') ? `${endpoint}json/version` : `${endpoint}/json/version`;
  const response = await withTimeout(fetch(url), timeoutMs, `GET ${url}`);
  if (!response.ok) throw new Error(`the DevTools endpoint answered ${String(response.status)}`);
  const body = (await withTimeout(response.json(), timeoutMs, `read ${url}`)) as {
    webSocketDebuggerUrl?: string;
  };
  if (body.webSocketDebuggerUrl === undefined) {
    throw new Error('the DevTools endpoint named no webSocketDebuggerUrl');
  }
  return body.webSocketDebuggerUrl;
}

/** A promise that rejects after `ms` — the guard every CDP call is raced against. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/** One connection to the browser endpoint, with per-call timeouts. */
class CdpConnection {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly socket: WebSocket;
  private readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP error'));
      else waiter.resolve(message.result);
    };
    this.socket.onclose = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('the CDP connection closed'));
      this.pending.clear();
    };
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        this.socket.onopen = () => resolve();
        this.socket.onerror = () => reject(new Error('the CDP connection failed'));
      }),
      this.timeoutMs,
      'the CDP handshake',
    );
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.id;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
    return withTimeout(promise, this.timeoutMs, method).finally(() => this.pending.delete(id));
  }

  close(): void {
    this.socket.close();
  }
}

/** Read one target's heap through an attached session; null when the reading fails. */
async function readTargetHeap(
  connection: CdpConnection,
  targetId: string,
): Promise<{ heapBytes: number | null; usedBytes: number | null; backingBytes: number | null }> {
  let sessionId: string | null = null;
  try {
    const attached = (await connection.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId?: string;
    };
    sessionId = attached.sessionId ?? null;
    if (sessionId === null) throw new Error('the target attached without a session');
    const usage = (await connection.send('Runtime.getHeapUsage', {}, sessionId)) as {
      usedSize?: number;
      backingStorageSize?: number;
    };
    const used = typeof usage.usedSize === 'number' ? usage.usedSize : null;
    const backing = typeof usage.backingStorageSize === 'number' ? usage.backingStorageSize : null;
    return {
      heapBytes: used === null ? null : used + (backing ?? 0),
      usedBytes: used,
      backingBytes: backing,
    };
  } catch {
    return { heapBytes: null, usedBytes: null, backingBytes: null };
  } finally {
    if (sessionId !== null) void connection.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

/**
 * ONE sample: the page's heap and every worker's, through a fresh connection. `page` is null when
 * the page target could not be read; a worker's fields are null when that worker could not be.
 */
export async function sampleHeaps(options: HeapProbeOptions): Promise<HeapSample> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const connection = new CdpConnection(options.cdpUrl, timeoutMs);
  const at = Date.now();
  try {
    await connection.open();
    const listed = (await connection.send('Target.getTargets')) as {
      targetInfos?: { targetId: string; type: string; url: string }[];
    };
    const targets: HeapTarget[] = (listed.targetInfos ?? []).map((t) => ({
      id: t.targetId,
      type: t.type,
      url: t.url,
    }));
    const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    const pageReading = pages.length > 0 ? await readTargetHeap(connection, pages[0]!.id) : null;
    const workers: WorkerHeap[] = [];
    for (const target of targets.filter((t) => t.type === 'worker' || t.type === 'service_worker')) {
      const reading = await readTargetHeap(connection, target.id);
      workers.push({ ...target, ...reading });
    }
    return { at, page: pageReading?.heapBytes ?? null, targets, workers };
  } finally {
    connection.close();
  }
}

/**
 * SAMPLE ON AN INTERVAL until the returned stop function is called. Each tick is one fresh
 * connection, so a target that dies between ticks cannot poison the next sample.
 */
export async function watchHeaps(
  options: WatchHeapsOptions,
  onSample: (sample: HeapSample) => void,
): Promise<() => Promise<void>> {
  const intervalMs = options.intervalMs ?? 500;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      onSample(await sampleHeaps(options));
    } catch (error) {
      // The endpoint itself can go away (the browser closed): report it as one failed sample,
      // then stop; the caller sees the gap rather than a hung probe.
      onSample({
        at: Date.now(),
        page: null,
        targets: [],
        workers: [],
      });
      if (error instanceof Error && /ECONNREFUSED|failed|closed/.test(error.message)) {
        stopped = true;
        return;
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Group workers by the URL fragment that names them (the caller's own vocabulary). */
export function workerKind(url: string, fragments: readonly (readonly [string, string])[]): string {
  for (const [needle, kind] of fragments) if (url.includes(needle)) return kind;
  return 'other';
}
