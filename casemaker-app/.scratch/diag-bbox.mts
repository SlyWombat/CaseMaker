import { readFileSync } from 'node:fs';
import { bootstrap } from '@/platform/headless/bootstrap';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { jobMountObstacles, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { goalSides } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';

const LOCATION = '/home/dave/projects/cm-wt/setb-house/location.json';
const JOB = '/home/dave/projects/cm-wt/m1-land11/m1trayF-banded.cutjob.json';
const job = JSON.parse(readFileSync(JOB, 'utf8')) as EngraveJob;
const boot = await bootstrap({ location: LOCATION });
const defaults = boot.location?.defaults ?? null;
const sides = goalSides(job);
for (const s of sides) console.log('side', s.setupIndex, s.setup.id, s.setup.orientation.top, 'goal', s.goal.id, 'band', s.goal.bandMm, 'pos', JSON.stringify(s.goal.position), 'rot', s.goal.rotation);
const first = sides[0]!;
const shop = { ...engraveShopOpts(defaults), mount: jobMountObstacles(job, defaults) };
const input = await buildModelPlanInputForGoal(job, first.goal, jobTool(job), shop as never, 'top');
const b = input.geometry.triangles.bbox;
console.log('geometry bbox', JSON.stringify(b));
console.log('input.setups', JSON.stringify(input.setups.map((s) => ({ up: s.frame.up, stockTop: s.frame.stockTop, stockBottom: s.frame.stockBottom, band: s.bandMm }))));
const out = await planModelCam(input);
for (const p of out.perSetup) console.log('plan setup', p.setupIndex, 'programs', p.programs.length, 'ops', p.ops.map((o) => o.kind).join(','));
const last = out.perSetup[0]!.programs.at(-1)!;
const moves = last.operations.flatMap((o) => o.moves);
const xs = moves.filter((m) => Number.isFinite(m.x)).map((m) => m.x);
const ys = moves.filter((m) => Number.isFinite(m.y)).map((m) => m.y);
console.log('last program X', Math.min(...xs), Math.max(...xs), 'Y', Math.min(...ys), Math.max(...ys));
for (const [i, prog] of out.perSetup[0]!.programs.entries()) {
  const ms = prog.operations.flatMap((o) => o.moves).filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y));
  const bxs = ms.map((m) => m.x), bys = ms.map((m) => m.y);
  console.log(`program ${i + 1}/${out.perSetup[0]!.programs.length}`, prog.operations.map((o) => o.kind).join(','), 'tool', prog.operations[0]?.ir?.tool?.name ?? '?', 'X', Number(Math.min(...bxs).toFixed(3)), '..', Number(Math.max(...bxs).toFixed(3)), 'Y', Number(Math.min(...bys).toFixed(3)), '..', Number(Math.max(...bys).toFixed(3)));
}
