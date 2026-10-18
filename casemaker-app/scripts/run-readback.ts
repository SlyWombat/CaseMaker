// The original run-record readback entry point (#277), kept so every documented invocation still
// works. The command now lives in `scripts/lib/casemaker/readbackRun.ts` (#477), where
// `casemaker readback run` calls the same function; this is the argument-list adapter only.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/run-readback.ts <record.json> [--history <path>] [--dry-run]
//   (or `npm run casemaker -- readback run <record.json>`)

import { readbackRunMain } from './lib/casemaker/readbackRun';

process.exitCode = await readbackRunMain(process.argv.slice(2));
