/**
 * In-flight coalescing for `simFrameAt` — not a debounce timer.
 *
 * A scrub can ask for frames far faster than the worker can mesh them. So at most ONE request
 * is ever in flight, and while it is, newer requests only overwrite a single pending slot: the
 * newest k wins and the ones in between are never sent. When the in-flight one returns the
 * pending slot (if any) goes out next. There is no timer, so an idle scrubber answers at once
 * and a busy one never queues.
 *
 * A returned frame is delivered even if a newer k is already waiting — otherwise a continuous
 * drag, which always has a newer k waiting, would never show anything. What is dropped: a
 * `null` (the worker called it stale), anything returned after `reset()` (a different session),
 * and `silent` requests (a warm-up whose only job is to build the anchor chain).
 *
 * Pure of workers and wasm, so it is tested with a fake `fetch`.
 */

export interface FrameCoalescerDeps<F> {
  /** Ask the worker for k at generation `gen`; null means it judged the request stale. */
  fetch(k: number, gen: number): Promise<F | null>;
  deliver(k: number, frame: F): void;
  onError?(e: unknown): void;
}

export interface FrameCoalescer {
  /** Ask for frame k. `silent` fetches it without delivering it (warm-up). */
  request(k: number, opts?: { silent?: boolean }): void;
  /** Forget everything pending and drop whatever is in flight when it returns (a new session). */
  reset(): void;
  /** Resolves when nothing is in flight or pending. */
  idle(): Promise<void>;
  readonly inFlight: boolean;
}

export function createFrameCoalescer<F>(deps: FrameCoalescerDeps<F>): FrameCoalescer {
  let gen = 0;
  let epoch = 0;
  let flying = false;
  let pending: { k: number; silent: boolean } | null = null;
  let waiters: (() => void)[] = [];

  const pump = (): void => {
    if (flying) return;
    if (!pending) {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
      return;
    }
    const { k, silent } = pending;
    pending = null;
    flying = true;
    const myEpoch = epoch;
    const myGen = ++gen;
    deps
      .fetch(k, myGen)
      .then(
        (frame) => {
          if (myEpoch === epoch && frame !== null && !silent) deps.deliver(k, frame);
        },
        (e) => {
          if (myEpoch === epoch) deps.onError?.(e);
        },
      )
      .finally(() => {
        flying = false;
        pump();
      });
  };

  return {
    request(k, opts) {
      pending = { k, silent: opts?.silent ?? false };
      pump();
    },
    reset() {
      epoch++;
      pending = null;
    },
    idle() {
      return flying || pending ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve();
    },
    get inFlight() {
      return flying;
    },
  };
}
