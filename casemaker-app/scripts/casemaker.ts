// The `casemaker` entry point (#477): one command in front of the headless scripts.
//
// Invoked by the package `bin` (`scripts/casemaker.mjs`, which runs this file through tsx) and by
// `npm run casemaker -- <command>`. Every documented script path still works; the old entry points
// are thin wrappers around the same command functions.

import { dispatch } from './lib/casemaker/dispatch';
import { defaultHandlers } from './lib/casemaker/handlers';

process.exitCode = await dispatch(process.argv.slice(2), defaultHandlers);
