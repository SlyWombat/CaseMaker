import { readFileSync } from 'node:fs';
import { bootstrap, loadCatalogue } from '@/platform/headless/bootstrap';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { jobMountObstacles, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

const LOCATION = '/home/dave/projects/cm-wt/setb-house/location.json';
const CATALOGUE = '/home/dave/projects/cm-wt/setb-house/catalogue.json';
const JOB = '/home/dave/projects/cm-wt/m1-land11/m1trayF-banded2.cutjob.json';

const job = JSON.parse(readFileSync(JOB, 'utf8')) as EngraveJob;
const g1 = job.targetObjects![0]!;
const g2 = job.targetObjects![1]!;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function placedBbox(goal: typeof g1): { min: [number, number]; max: [number, number] } {
  const mesh = targetObjectMesh(goal);
  const { place } = placeTarget(goal, mesh);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y] = place(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { min: [r3(minX), r3(minY)], max: [r3(maxX), r3(maxY)] };
}

console.log('=== (a) placed bboxes (side-1 document/work XY) ===');
const b1 = placedBbox(g1);
const b2 = placedBbox(g2);
console.log('goal1 (setup 1):', JSON.stringify(b1), 'size field', JSON.stringify(g1.size), 'pos', JSON.stringify(g1.position), 'rot', g1.rotation);
console.log('goal2 (setup 2):', JSON.stringify(b2), 'size field', JSON.stringify(g2.size), 'pos', JSON.stringify(g2.position), 'rot', g2.rotation, 'rotX', (g2 as { rotationX?: number }).rotationX);

const boot = await bootstrap({ location: LOCATION });
const defaults = boot.location?.defaults ?? null;

console.log('=== (c) mount obstacles (work XY) ===');
const mount = jobMountObstacles(job, defaults);
for (const o of mount?.obstacles ?? []) console.log(' ', o.id, '|', o.label, '| min', JSON.stringify(o.min), 'max', JSON.stringify(o.max), 'topZ?', JSON.stringify((o as unknown as { topZ?: number }).topZ ?? null));
console.log('  job boxes:', JSON.stringify(job.workholding.bracket?.obstacles ?? []));
console.log('  uncertainty', mount?.uncertainty, 'jawClearance', job.jawClearance);

console.log('=== (d) hold ===');
const bore = { key: 'inv:kz-o-flute-3-175-42', tool: flatEndMill(3.175, { name: 'diag', fluteLength: 42 }) };
const base: EngraveJob = { ...job, setups: undefined, targetObjects: undefined, targetObject: g1 };
// The hold is a NAMED REFUSAL on this job now (the part leaves 2 mm): report it and carry on
// with the hard-coded centres that the pre-fix code used, to reproduce the run's frame finding.
const plan = planFlipSetups(base, g1, ['top', 'bottom'], [bore], { method: 'tabs-in-blank', axis: 'left-right' });
const holdAt = plan.ok ? plan.hold!.at : [{ x: 156, y: 37.8 }, { x: 156, y: 88.2 }];
console.log('  hold', plan.ok ? JSON.stringify(plan.hold) : `REFUSED — ${plan.reason}`);
for (const p of holdAt) {
  const dx = Math.max(b1.min[0] - p.x, 0, p.x - b1.max[0]);
  const dy = Math.max(b1.min[1] - p.y, 0, p.y - b1.max[1]);
  console.log(`  hole (${p.x}, ${p.y}) → part bbox clearance ${r3(Math.hypot(dx, dy))} mm`, 'inside?', p.x >= b1.min[0] && p.x <= b1.max[0] && p.y >= b1.min[1] && p.y <= b1.max[1]);
}

console.log('=== (b) side 1: plan + post (the failing run reproduced) ===');
const catalogue = loadCatalogue(CATALOGUE);
const shop = { ...engraveShopOpts(defaults), mount };
const result = await engraveGenerate(boot.manifold, job, jobTool(job), (catalogue?.rows ?? []) as never, null, undefined, shop as never);
console.log('  run', result.ok, result.stage, result.errors.map((e) => e.message));
const vf = result.verify?.findings ?? [];
for (const f of vf.filter((f) => f.severity === 'error').slice(0, 5)) console.log('  verify:', f.code, 'line', f.line, '|', f.message);

  // The PLAN's own geometry for each setup-0 program, beside what was posted.
  const plan0 = result.plan?.perSetup?.[0];
  if (plan0 !== undefined) {
    for (const [i, prog] of plan0.programs.entries()) {
      const ms = prog.operations.flatMap((o) => o.moves).filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y));
      if (ms.length === 0) continue;
      const bx = ms.map((m) => m.x), by = ms.map((m) => m.y);
      console.log(`  plan program ${i + 1}/${plan0.programs.length}`, 'ops', prog.operations.length, 'X', Number(Math.min(...bx).toFixed(3)), '..', Number(Math.max(...bx).toFixed(3)), 'Y', Number(Math.min(...by).toFixed(3)), '..', Number(Math.max(...by).toFixed(3)));
    }
  }

if (result.nc !== null) {
  const nc = result.nc;
  const g1moves = nc.split('\n').filter((l) => l.startsWith('G1'));
  const xs: number[] = [], ys: number[] = [];
  for (const l of g1moves) {
    const mx = /X(-?\d+(?:\.\d+)?)/.exec(l); const my = /Y(-?\d+(?:\.\d+)?)/.exec(l);
    if (mx) xs.push(Number(mx[1])); if (my) ys.push(Number(my[1]));
  }
  if (xs.length > 0) console.log('  posted contour bbox: X', r3(Math.min(...xs)), '..', r3(Math.max(...xs)), 'Y', r3(Math.min(...ys)), '..', r3(Math.max(...ys)));
  const err = vf.find((f) => f.severity === 'error');
  console.log('  posted op names:', [...nc.matchAll(/name=\[T1\]([^|\n]*)/g)].map((m) => m[1]).slice(0, 12));
  if (err?.line !== undefined) {
    const lines = nc.split('\n');
    const at = lines[err.line - 1] ?? '';
    console.log('  offending move (NC line', err.line, '):', at.trim());
    for (let i = Math.max(0, err.line - 3); i < Math.min(lines.length, err.line + 2); i++) console.log('    ', i + 1, lines[i]!.trim());
  }
  // A contour path, listed as X/Y pairs near the left arm, to measure the hole clearance.
  console.log('=== (d) hold vs the posted contour path ===');
  const pts: [number, number][] = [];
  for (const l of g1moves) {
    const mx = /X(-?\d+(?:\.\d+)?)/.exec(l); const my = /Y(-?\d+(?:\.\d+)?)/.exec(l);
    if (mx && my) pts.push([Number(mx[1]), Number(my[1])]);
  }
  for (const p of holdAt) {
    let best = Infinity;
    for (const [x, y] of pts) best = Math.min(best, Math.hypot(x - p.x, y - p.y));
    console.log(`  hole (${p.x}, ${p.y}) → nearest posted path point ${r3(best)} mm`);
  }
}
