// Scratch helper (not product code): derive the male inlay job from a female job with the app's own
// inlayMaleJob, the function the "Save the male blank…" button calls.
import '/home/dave/projects/CaseMaker-bench/casemaker-app/scripts/lib/casemaker/nodeTarget';
import { readFileSync, writeFileSync } from 'node:fs';
import { inlayMaleJob } from '/home/dave/projects/CaseMaker-bench/casemaker-app/src/engine/cnc/engrave/inlay';
import { vCone } from '/home/dave/projects/CaseMaker-bench/casemaker-app/src/engine/cnc/vProfile';

const [femalePath, outPath, locPath] = process.argv.slice(2);
const job = JSON.parse(readFileSync(femalePath!, 'utf8'));
const loc = JSON.parse(readFileSync(locPath!, 'utf8'));
const key = String(job.toolKey).replace(/^inv:/, '');
const tool = loc.inventory.find((i: { id: string }) => i.id === key)?.tool;
const cone = tool ? vCone(tool) : null;
if (!cone) throw new Error('no cone for ' + job.toolKey);
const r = inlayMaleJob(job, cone);
if (!r.ok) throw new Error(r.reason);
const male = { ...r.job, name: job.name.replace(/-female$/, '') + '-male' };
writeFileSync(outPath!, JSON.stringify(male, null, 1));
console.log('wrote', outPath);
