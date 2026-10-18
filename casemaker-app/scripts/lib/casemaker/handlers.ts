/**
 * The real handlers for `casemaker` (#477) — the one place the dispatcher meets the command
 * modules. Kept apart from `dispatch.ts` so the routing spec can run without importing the
 * Manifold-bearing pipelines.
 */
import { MACHINE_DEFERRED, type CasemakerHandlers } from './dispatch';
import { engraveJobMain } from './engrave';
import { exportMain } from './exportCommand';
import { locationMain } from './locationCommand';
import { readbackMain } from './readbackCommand';
import type { CommandOptions } from './output';

/**
 * Machine/hardware commands are refused explicitly rather than omitted silently: the user types
 * `casemaker machine status` and is told why nothing ran and where the decision lives (#479).
 */
async function machineMain(_argv: string[], _options: CommandOptions): Promise<number> {
  console.error(`casemaker machine: ${MACHINE_DEFERRED}`);
  return 2;
}

export const defaultHandlers: CasemakerHandlers = {
  engrave: engraveJobMain,
  exportProject: exportMain,
  location: locationMain,
  readback: readbackMain,
  machine: machineMain,
};
