/**
 * How a command reaches its caller (#478): one channel for progress, one for the result.
 *
 * The result is ALWAYS the receipt. In human mode it is rendered through
 * `renderReceipt` — the only formatter — so a line the terminal shows is a line the JSON
 * carries. With `--json`, stdout is exactly the receipt document and nothing else; progress
 * (reach tables, seam notes, advisories) moves to stderr, where it cannot corrupt a `| jq`.
 *
 * `emitReceipt` validates before it prints: a receipt that does not parse is a programming
 * error in the command, and it fails loudly rather than emitting a shape no consumer expects.
 */
import {
  parseReceipt,
  receiptJson,
  renderReceipt,
  type Receipt,
} from '../../../src/platform/headless/receipt';

/**
 * Where a command's two channels go when it is NOT printing (#481). The MCP server runs the same
 * command functions inside a long-lived process whose stdout carries JSON-RPC, so it captures the
 * receipt instead of formatting it. A sink replaces BOTH channels: a command with a sink never
 * writes a progress line or a rendered result to stdout.
 */
export interface CommandSink {
  /** Progress and advisories; omitted lines are discarded rather than printed. */
  progress?(line: string): void;
  /** The run's receipt, already validated. Called exactly once per run. */
  receipt?(receipt: Receipt): void;
}

/** What the dispatcher learned from the command line, handed to every handler. */
export interface CommandOptions {
  /** `--json` was passed: emit the receipt document instead of human lines. */
  json: boolean;
  /** Capture the two channels instead of printing them (the MCP server, #481). */
  sink?: CommandSink;
  /**
   * The clock a run stamps into the files it writes (#484), or absent to read the wall clock.
   *
   * It exists for ONE caller: a spec that compares a committed fixture with a fresh run. The run
   * sheet carries its generation date, and the receipt carries the sheet's sha256, so without a
   * pinned clock the fixture would change at midnight. Nothing on the command line sets it.
   */
  now?: Date;
}

/** The default a direct script wrapper (`scripts/engrave-job.ts`) runs with. */
export const HUMAN: CommandOptions = { json: false };

export interface CommandOutput {
  /** A line about how the run got on. Never a result: results are rendered from the receipt. */
  progress(line: string): void;
  /** Validate and emit the run's receipt — JSON on stdout, or its rendered lines. */
  emitReceipt(receipt: Receipt): void;
}

export function commandOutput(options: CommandOptions): CommandOutput {
  const sink = options.sink;
  return {
    progress(line: string): void {
      if (sink !== undefined) {
        sink.progress?.(line);
        return;
      }
      if (options.json) console.error(line);
      else console.log(line);
    },
    emitReceipt(receipt: Receipt): void {
      const parsed = parseReceipt(receipt);
      if (sink !== undefined) {
        sink.receipt?.(parsed);
        return;
      }
      if (options.json) {
        process.stdout.write(receiptJson(parsed));
        return;
      }
      for (const line of renderReceipt(parsed)) console.log(line);
    },
  };
}
