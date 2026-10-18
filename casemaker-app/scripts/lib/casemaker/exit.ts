/**
 * The one way a headless command stops with a non-zero exit without taking the process down.
 *
 * The scripts this CLI wraps used to call `process.exit(1)` from deep inside their pipelines. That
 * is fine for a one-shot script and hostile to a dispatcher: `casemaker engrave` has to leave the
 * process alive long enough to return a code, and the tests have to exercise the refusal without
 * losing the test runner. `fail()` in each command prints its message first, then throws this; the
 * command's own wrapper and the dispatcher turn it into an exit code.
 */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}

/** True for a refusal a command already reported on stderr. */
export function isCliExit(error: unknown): error is CliExit {
  return error instanceof CliExit;
}
