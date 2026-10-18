// The original engrave entry point (#248, #410), kept so every documented invocation and npm path
// still works. The command itself now lives in `scripts/lib/casemaker/engrave.ts` (#477), where the
// CLI calls the same function; this is the argument-list adapter only.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/engrave-job.ts <job.json> [--out <dir>]
//   (or `npm run casemaker -- engrave <job.json>`)

import { engraveJobMain } from './lib/casemaker/engrave';

process.exitCode = await engraveJobMain(process.argv.slice(2));
