// The app's real verifier on #959's posted programs (E, dave-1). The acceptance spec posts each
// cutter's program in memory but writes only the IR; this re-posts the same IR with the spec's own
// PostContext and runs verifyProgram on the text, so the findings are the app's, not a re-derivation.
// usage: cd <repo>/casemaker-app && npx tsx --tsconfig tsconfig.app.json <this> \
//          <appDir> <plan.json> <posted-facts.json> <LxWxT> <material> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [appDir, planPath, factsPath, stockArg, material, outDir] = process.argv.slice(2);
if (!appDir || !planPath || !factsPath || !stockArg || !material || !outDir) {
  console.error('usage: verify-959-posted.mts <appDir> <plan.json> <posted-facts.json> <LxWxT> <material> <outDir>');
  process.exit(2);
}
await import(appDir + '/scripts/lib/casemaker/nodeTarget.ts');
const { postZ1 } = await import(appDir + '/src/engine/cnc/post/z1.ts');
const { verifyProgram, stockDepthLimit } = await import(appDir + '/src/engine/cnc/verify.ts');
const { Z1 } = await import(appDir + '/src/engine/cnc/machine.ts');
const { flatEndMill } = await import(appDir + '/src/engine/cnc/tool.ts');
const { HOP_Z } = await import(appDir + '/src/engine/cnc/cam/ir.ts');
const { toSetup } = await import(appDir + '/src/engine/cnc/engrave/jobSetup.ts');
// The same measurement the spec uses for its combined facts, per program.
const { measurePostedProgram } = await import(appDir + '/tests/tools/postedFacts.ts');

const [L, W, T] = stockArg.split('x').map(Number);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
const programs = plan.perSetup[0].programs as unknown[];
const cutterKeys: string[] = facts.cutterKeys;
const job = {
  schemaVersion: 3, name: 'verify-959', machineId: 'Z1',
  stock: { length: L, width: W, thickness: T, material },
  labels: [], toolKey: '', minFloor: 1, edgeMargin: 1, customFonts: [],
  sacrificial: { under: null, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
  breakthrough: 0.3, jawClearance: 1, shapes: [],
  workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin',
    clamps: [{ edge: 'back', at: W / 2 }, { edge: 'right', at: L / 2 }], source: 'default' } },
};
const setup = toSetup(job as never, Z1);
const depthLimit = stockDepthLimit(job.stock, job.minFloor);
mkdirSync(outDir, { recursive: true });
let worst = 0;
for (let i = 0; i < programs.length; i++) {
  const key = cutterKeys[i] ?? `program-${i + 1}`;
  const d = key.includes('3.175') ? 3.175 : 6;
  const tool = flatEndMill(d, { number: i + 1, id: key, name: key });
  const ctx = {
    jobName: `verify-959-${key}`, stock: { length: L, width: W, thickness: T },
    materialName: material, zDatum: 'probed-top-face', origin: 'topFrontLeft',
    camVersion: 'verify-959', toolKey: key,
  };
  const posted = postZ1(programs[i] as never, ctx as never, Z1);
  if (!posted.ok) {
    console.log(`${key}: post refused — ${posted.errors.join('; ')}`);
    worst = 1;
    continue;
  }
  const nc = join(outDir, `959-${key}.nc`);
  writeFileSync(nc, posted.text);
  const r = verifyProgram(posted.text, { setup, machine: Z1, tool, depthLimit, minRapidZ: HOP_Z });
  const errs = r.findings.filter((f) => f.severity === 'error').length;
  const warns = r.findings.length - errs;
  console.log(`${key}: ${nc}`);
  const f = measurePostedProgram(posted.text);
  console.log(`  cycle ${f.cycleSeconds.toFixed(1)} s (header ${f.headerTimeSeconds}), air ${(f.airFraction * 100).toFixed(2)} %, rapids/1k ${f.rapidsPer1000FeedLines.toFixed(2)} (${f.rapidMoves}/${f.feedMoves})`);
  console.log(`  verify ok=${r.ok} — ${errs} error, ${warns} warning; ${r.stats.cuttingMoves} cutting moves, deepest Z ${r.stats.deepestZ.toFixed(2)}`);
  for (const f of r.findings) {
    console.log(`  ${f.severity === 'error' ? 'ERR ' : 'warn'} ${f.code}${f.line === null ? '' : ` (line ${f.line})`}: ${f.message}`);
  }
  if (!r.ok) worst = 1;
}
process.exit(worst);
