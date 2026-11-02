// The app's own goal heightfield for a job, dumped as float32 + a JSON header (QA, not product code).
// usage: cd <repo>/casemaker-app && npx tsx --tsconfig tsconfig.app.json <this> <appDir> <job.json> <out-prefix>
import { readFileSync, writeFileSync } from 'node:fs';

const [appDir, jobPath, out] = process.argv.slice(2);
if (!appDir || !jobPath || !out) {
  console.error('usage: goal-hf.mts <appDir> <job.json> <out-prefix>');
  process.exit(2);
}
await import(appDir + '/scripts/lib/casemaker/nodeTarget.ts');
const { sampleGoalHeightfield } = await import(appDir + '/src/engine/cnc/cam/surface3d.ts');

const job = JSON.parse(readFileSync(jobPath, 'utf8'));
const t = job.targetObject ?? (job.targetObjects ?? [])[0];
if (!t) throw new Error(`${jobPath}: no target object`);
const hf = sampleGoalHeightfield(t, { pitchMm: 0.1, maxCells: 20_000_000 });
writeFileSync(out + '.bin', Buffer.from(hf.z.buffer, hf.z.byteOffset, hf.z.byteLength));
writeFileSync(out + '.cov', Buffer.from(hf.covered));
const { z: _z, covered: _c, ...head } = hf as Record<string, unknown>;
writeFileSync(out + '.json', JSON.stringify(head));
console.log(JSON.stringify(head));
