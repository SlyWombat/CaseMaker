/**
 * The real handlers for `casemaker` (#477) — the one place the dispatcher meets the command
 * modules. Kept apart from `dispatch.ts` so the routing spec can run without importing the
 * Manifold-bearing pipelines.
 */
import type { CasemakerHandlers } from './dispatch';
import { engraveJobMain } from './engrave';
import { exportMain } from './exportCommand';
import { locationMain } from './locationCommand';
import { machineMain } from './machineCommand';
import { readbackMain } from './readbackCommand';

export const defaultHandlers: CasemakerHandlers = {
  engrave: engraveJobMain,
  exportProject: exportMain,
  location: locationMain,
  readback: readbackMain,
  machine: machineMain,
};
