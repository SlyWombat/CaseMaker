/**
 * The `casemaker` command's top-level dispatcher (#477).
 *
 * Deliberately dependency-free: the handlers are passed in, so a spec can prove the routing without
 * importing the wasm-bearing engrave pipeline. `handlers.ts` supplies the real ones; the bin is the
 * only place the two meet.
 *
 * `--json` and `machine` are refused HERE, once, rather than each command inventing an answer:
 * #478 owns the receipt schema and #479 owns the machine command. Neither is stubbed.
 */

/** One command implementation: its own arguments (the subcommand already removed), exit code back. */
export type CommandHandler = (argv: string[]) => Promise<number>;

export interface CasemakerHandlers {
  /** `engrave`, including `--coupon` and `--from-3mf`. */
  engrave: CommandHandler;
  /** `export <project.json>`. */
  exportProject: CommandHandler;
  /** `location tools|stock|machines`. */
  location: CommandHandler;
  /** `readback feeds|run`; receives the section as its first argument. */
  readback: CommandHandler;
  /** `machine`; a refusal for now. */
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
  '',
  'Human output is the default. `--json` is reserved for the receipt (#478) and is not',
  'available yet. Machine/hardware commands await #479 and are not in this build.',
].join('\n');

/** The refusal `--json` gets until #478 writes the schema. Deliberately one sentence, no schema. */
export const JSON_DEFERRED =
  '--json is not available yet — the receipt schema belongs to #478 and is not written; nothing was run.';

/** The refusal every machine/hardware command gets until #479 is decided. */
export const MACHINE_DEFERRED =
  'machine commands are not available in this build — they await the #479 decision; nothing was sent to the machine or the network.';

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
  // The deferred flag is refused wherever it appears, before any handler can start work — a
  // receipt-shaped flag that silently ran the command would be worse than no flag at all.
  if (argv.includes('--json') || argv.some((a) => a.startsWith('--json='))) {
    io.error(`casemaker: ${JSON_DEFERRED}`);
    return 2;
  }

  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  switch (command) {
    case 'engrave':
      return handlers.engrave(rest);
    case 'export':
      return handlers.exportProject(rest);
    case 'location':
      return handlers.location(rest);
    case 'readback':
      return handlers.readback(rest);
    case 'machine':
      return handlers.machine(rest);
    default:
      io.error(`casemaker: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}
