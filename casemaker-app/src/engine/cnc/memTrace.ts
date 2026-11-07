/**
 * #1052 — THE MEMORY TRACE. Flag-gated, measure-only: a per-boundary sample of the process's own
 * memory counters, written as JSONL so a run's abort (exit 134) leaves the last rows behind.
 *
 * The sink is installed by the headless CLI (`--mem-trace <file>` or `CASEMAKER_MEM_TRACE`); with
 * no sink every call is one null check, so the app, the worker and every spec pay nothing and the
 * plan and program bytes cannot move. A row is `{t, stage, ...extra, rss, heapUsed, heapTotal,
 * external, arrayBuffers}` — the last two are where wasm/typed-array allocations show when the JS
 * heap still looks small.
 *
 * `process.memoryUsage()` is not O(1): it walks the process's memory on some platforms (~µs on
 * Linux, tens of µs under load). Rows are taken at STAGE boundaries — per op and per field
 * builder — never per cell; the cost line is on #1052.
 */

type Sink = (line: string) => void;
/** Reads the manifold wasm memory's byte size; null when the module does not expose it. */
type WasmHeapReader = () => number | null;

let sink: Sink | null = null;
let startedAt = 0;
let wasmHeap: WasmHeapReader | null = null;

/** The row's clock: milliseconds since the trace was enabled. */
const nowMs = (): number => Date.now() - startedAt;

interface MemCounters {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

/** Node's counters; zeroed where `process.memoryUsage` does not exist (the browser worker). */
function counters(): MemCounters | null {
  const proc = (globalThis as { process?: { memoryUsage?: () => MemCounters } }).process;
  if (proc === undefined || proc.memoryUsage === undefined) return null;
  try {
    const m = proc.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
  } catch {
    return null;
  }
}

/** Enable the trace with a writer (the CLI opens the file). Rows already buffered are not kept. */
export function setMemTraceSink(write: Sink | null): void {
  sink = write;
  startedAt = Date.now();
}

/**
 * The manifold wasm module's own heap (HEAP8's buffer), read by the caller that holds the module.
 * Emitted as `wasmBytes` beside Node's counters: exit 134 has two sources — V8's heap cap AND
 * wasm's 4,096 MB cap (#1024's class) — and `process.memoryUsage()` alone cannot tell them apart.
 * When the module exposes no heap view, the row falls back to `arrayBuffers` (which DOES count the
 * wasm memory) and says so in `wasmSource`.
 */
export function setWasmHeapReader(read: WasmHeapReader | null): void {
  wasmHeap = read;
}

export const memTraceEnabled = (): boolean => sink !== null;

/**
 * One boundary row. `stage` names the pipeline step (`plan:start`, `op`, `goal-field`, …) and
 * `extra` carries the facts that make the row actionable (the op kind, the cutter, a builder's
 * cell count and byte size). Never throws: a trace that can fail a run is worse than no trace.
 */
export function memTrace(stage: string, extra?: Record<string, number | string | boolean>): void {
  if (sink === null) return;
  const m = counters();
  if (m === null) return;
  let wasmBytes: number | null = null;
  let wasmSource = 'arrayBuffers';
  if (wasmHeap !== null) {
    try {
      wasmBytes = wasmHeap();
      if (wasmBytes !== null) wasmSource = 'HEAP8';
    } catch {
      wasmBytes = null;
    }
  }
  const row = {
    t: nowMs(),
    stage,
    ...extra,
    wasmBytes: wasmBytes ?? m.arrayBuffers,
    wasmSource,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
  try {
    sink(JSON.stringify(row) + '\n');
  } catch {
    /* a closed or full file must not take the run with it */
  }
}
