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

/** What the dispatcher learned from the command line, handed to every handler. */
export interface CommandOptions {
  /** `--json` was passed: emit the receipt document instead of human lines. */
  json: boolean;
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
  return {
    progress(line: string): void {
      if (options.json) console.error(line);
      else console.log(line);
    },
    emitReceipt(receipt: Receipt): void {
      const parsed = parseReceipt(receipt);
      if (options.json) {
        process.stdout.write(receiptJson(parsed));
        return;
      }
      for (const line of renderReceipt(parsed)) console.log(line);
    },
  };
}
