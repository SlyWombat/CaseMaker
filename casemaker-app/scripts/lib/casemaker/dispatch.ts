/**
 * The `casemaker` command's top-level dispatcher (#477).
 *
 * Deliberately dependency-free: the handlers are passed in, so a spec can prove the routing without
 * importing the wasm-bearing engrave pipeline. `handlers.ts` supplies the real ones; the bin is the
 * only place the two meet.
 *
 * `--json` is parsed HERE, once (#478): the flag is stripped from wherever it appears and handed to
 * every handler through {@link CommandOptions}, so stdout carries the receipt document and nothing
 * else.
 */
import { HUMAN, type CommandOptions } from './output';

/** One command implementation: its own arguments (the subcommand already removed), exit code back. */
export type CommandHandler = (argv: string[], options: CommandOptions) => Promise<number>;

export interface CasemakerHandlers {
  /** `engrave`, including `--coupon` and `--from-3mf`. */
  engrave: CommandHandler;
  /** `export <project.json>`. */
  exportProject: CommandHandler;
  /** `location tools|stock|machines`. */
  location: CommandHandler;
  /** `readback feeds|run`; receives the section as its first argument. */
  readback: CommandHandler;
  /** `machine`; the read subcommands (#477). */
  machine: CommandHandler;
}

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

export const USAGE = [
  'usage: casemaker <command> [options]',
  '',
  '  casemaker engrave <job.json> [--out <dir>]',
  '  casemaker engrave --coupon <coupon-spec.json> [--out <dir>]',
  '  casemaker engrave --from-3mf <design.3mf> [--turn ccw|cw] [--tool <key>]',
  '          [--rest <key|none>] [--overlap <mm>] [--third-tool <pct>] [--out <dir>]',
  '          [--location <location.json|house.json>]',
  '  casemaker export <project.json> [--out <dir>] [--location <location.json|house.json>]',
  '  casemaker location tools|stock|machines [--location <location.json|house.json>]',
  '  casemaker readback feeds <record.json> [--feeds <feeds.ts>] [--dry-run]',
  '  casemaker readback run <record.json> [--history <runHistory.ts>] [--dry-run]',
  '  casemaker machine status|version|finished [--host <ip>] [--location <file>]',
  '  casemaker machine hashes <card-path> [<card-path> ...] [--host <ip>]',
  '',
  'Human output is the default and is rendered from the run’s receipt. With `--json`, stdout is',
  'exactly that receipt document and progress goes to stderr. The machine commands read only;',
  'nothing here switches power (#479: the plug is outside Case Maker).',
].join('\n');

/** `--json` takes no value: the receipt has one shape, so there is no format to negotiate. */
export const JSON_VALUE_REFUSED =
  '--json takes no value — it selects the receipt document, and there is only one shape; nothing was run.';

/**
 * Route one command line. Returns the exit code; never calls `process.exit`, so the bin owns that.
 *
 * `argv` is everything after the program name: `<command> [...command args]`.
 */
export async function dispatch(
  argv: string[],
  handlers: CasemakerHandlers,
  io: CliIo = console,
): Promise<number> {
  // A value on the receipt switch is refused before any handler can start work: `--json=true`
  // means the caller expected a choice the receipt does not offer.
  if (argv.some((a) => a.startsWith('--json='))) {
    io.error(`casemaker: ${JSON_VALUE_REFUSED}`);
    return 2;
  }
  const options: CommandOptions = { ...HUMAN, json: argv.includes('--json') };
  const [command, ...rest] = argv.filter((a) => a !== '--json');
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  switch (command) {
    case 'engrave':
      return handlers.engrave(rest, options);
    case 'export':
      return handlers.exportProject(rest, options);
    case 'location':
      return handlers.location(rest, options);
    case 'readback':
      return handlers.readback(rest, options);
    case 'machine':
      return handlers.machine(rest, options);
    default:
      io.error(`casemaker: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}
