// The original coupon readback entry point (#248 item 3), kept so every documented invocation still
// works. The command now lives in `scripts/lib/casemaker/readbackFeeds.ts` (#477), where
// `casemaker readback feeds` calls the same function; this is the argument-list adapter only.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/feeds-readback.ts <record.json> [--feeds <path>] [--dry-run]
//   (or `npm run casemaker -- readback feeds <record.json>`)

import { readbackFeedsMain } from './lib/casemaker/readbackFeeds';

process.exitCode = await readbackFeedsMain(process.argv.slice(2));
