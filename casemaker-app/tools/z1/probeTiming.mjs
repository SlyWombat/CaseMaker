// #1123 item 17 — THE PROBE COMMAND'S REPLY WINDOW, for the bench harness's `send`/`console`.
//
// At the bench on 2026-11-09 the harness's `send` default window (first reply 3 s, quiet 0.8 s,
// max 15 s) closed the reader BEFORE a probe's `[PRB]` replies landed: `M491`'s two-touch macro
// waits out a ~13 s fast gap (108 mm at F500), and `G38.x` talks only when it touches. The same
// lines captured their replies when sent with `--first-reply 15000 --quiet 3000 --max 30000`.
// The APP's own M491 calls already state the probe's window — `PROBE_TIMING` in
// `src/engine/cnc/registration/execute.ts` (`quietMs: 20_000`) — so a probe line here gets a
// window of the same length by DEFAULT, and the operator's explicit flags still override it.
//
// Plain ESM JavaScript, like the rest of `tools/z1`: runnable by plain `node` on Windows with no
// build step. `tests/unit/z1ProbeTiming1123.spec.ts` holds this restatement to the app's constant.

/**
 * TRUE for a line that PROBES: the `M491` two-touch macro, or a `G38` family move (`G38`,
 * `G38.2`, `G38.3`, `G38.4`, any trailing parameters). Leading/trailing space is ignored; a
 * different word (`M4910`, `G381`, `M491.1`) is not a probe.
 */
export function isProbeLine(line) {
  const trimmed = String(line).trim();
  if (trimmed.length === 0) return false;
  return /^G38(?:\.\d+)?(?:\s|$)/i.test(trimmed) || /^M491(?:\s|$)/i.test(trimmed);
}

/**
 * A probe's reply window: first reply 15 s, quiet 20 s (the app's `PROBE_TIMING`), max 30 s —
 * the bench-proven capture window. `quietMs` is the app's own number; the other two bound how
 * long a stalled probe may keep the reader open.
 */
export const PROBE_REPLY_TIMING = Object.freeze({
  firstReplyMs: 15_000,
  quietMs: 20_000,
  maxMs: 30_000,
});

/** Every other line's window — the harness's historical defaults, unchanged. */
export const STANDARD_REPLY_TIMING = Object.freeze({
  firstReplyMs: 3_000,
  quietMs: 800,
  maxMs: 15_000,
});

/** The timing a line gets when the operator passes no explicit flags. */
export function replyTimingFor(line) {
  return isProbeLine(line) ? PROBE_REPLY_TIMING : STANDARD_REPLY_TIMING;
}
