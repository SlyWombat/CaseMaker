// Types for `probeTiming.mjs`, which `tests/unit/z1ProbeTiming1123.spec.ts` imports directly.
// Same reason as `transport.node.d.mts`: the harness is plain ESM JavaScript and a TypeScript
// importer would otherwise see an implicit `any` (TS7016). Written from the module's own exports.

/** The reply window `console.send` takes. */
export interface ReplyTiming {
  firstReplyMs: number;
  quietMs: number;
  maxMs: number;
}

/** TRUE for `M491` (the two-touch macro) and the `G38` family; false for everything else. */
export function isProbeLine(line: string): boolean;

/** A probe line's window: first reply 15 s, quiet 20 s (the app's `PROBE_TIMING`), max 30 s. */
export const PROBE_REPLY_TIMING: Readonly<ReplyTiming>;

/** Every other line's window: first reply 3 s, quiet 0.8 s, max 15 s. */
export const STANDARD_REPLY_TIMING: Readonly<ReplyTiming>;

/** The timing a line gets when the operator passes no explicit flags. */
export function replyTimingFor(line: string): Readonly<ReplyTiming>;
