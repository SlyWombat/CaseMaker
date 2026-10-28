// Bench helper: run one job through engraveGenerate the way `casemaker cut` does and print every
// verifier finding of the program AND of its frame file (the CLI receipt counts frame errors but
// does not list them).  npx tsx --tsconfig tsconfig.scripts.json scripts/bench-probe.mts <job.json> <location.json>
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { bootstrap, loadCatalogue } from '../src/platform/headless/bootstrap';
import { engraveGenerate } from '../src/workers/sim/engraveGenerate';
import { parseEngraveJob } from '../src/store/engraveJobSchema';
import { entryFor, getTools } from '../src/engine/cnc/toolRegistry';
import { drillSettings } from '../src/engine/cnc/cam/drillBit';
const [jobPath, locPath] = process.argv.slice(2);
const boot = await bootstrap({ location: locPath });
const cat = loadCatalogue(join(dirname(locPath!), 'catalogue.json'));
const parsed: any = parseEngraveJob(JSON.parse(readFileSync(jobPath!, 'utf8')));
if (!parsed.ok) { console.log(parsed.errors); process.exit(1); }
const job = parsed.job;
const tool = entryFor(job.toolKey)?.tool ?? null;
const g: any = engraveGenerate(boot.manifold, job, tool, cat?.rows ?? [], null, undefined,
  { tools: getTools(), drill: drillSettings(boot.location?.defaults ?? null) } as any);
console.log('ok', g.ok, 'stage', g.stage, 'errors', JSON.stringify(g.errors));
for (const f of g.verify?.findings ?? []) console.log('PROGRAM', f.severity, f.code, f.message);
for (const f of g.frameVerify?.findings ?? []) console.log('FRAME', f.severity, f.code, f.message);
