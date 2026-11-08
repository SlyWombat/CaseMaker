import { readFileSync, writeFileSync } from 'node:fs';
import { planFlipSetups } from '@/engine/cnc/engrave/goalFlipSetups';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

// The re-authored LEFT-RIGHT twin (maintainer's 2026-11-08 ruling): goal 1 centred in the window
// the hold leaves — minX 9.344 (arms 2.688 … hole line 156 − 4 − 136 = 16), y 63 — and the
// hole-band-left box removed: it is a leftover of set B's job, not a reserve the program keeps.
const SRC = '/home/dave/projects/cm-wt/m1-land11/m1trayF.cutjob.json';
const OUT = '/home/dave/projects/cm-wt/m1-land11/m1trayF-banded2.cutjob.json';
const job = JSON.parse(readFileSync(SRC, 'utf8')) as EngraveJob;
const source = job.targetObjects![0]!;
const goal: EngraveTargetObject = { ...source, position: { x: 77.344, y: 63, z: 0 } };
// The job carries the base job's name ('m1trayB-top') — a stale carry-over the sheet's file names
// would repeat. Name the twin after itself.
const NAME = 'm1trayF-banded2';
if (job.workholding.kind === 'bracket') (job.workholding.bracket as { obstacles?: unknown[] }).obstacles = [];
const base: EngraveJob = { ...job, setups: undefined, targetObjects: undefined, targetObject: goal };
const bore = { key: 'inv:kz-o-flute-3-175-42', tool: flatEndMill(3.175, { name: 'Spiral O 3.175 x 42', fluteLength: 42 }) };
const plan = planFlipSetups(base, goal, ['top', 'bottom'], [bore], { method: 'tabs-in-blank', axis: 'left-right' });
if (!plan.ok) throw new Error(plan.reason);
const out: EngraveJob = { ...job, name: NAME, setups: plan.setups, targetObjects: plan.goals, targetObject: undefined };
writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', OUT);
console.log('hold', JSON.stringify(plan.hold));
for (const s of plan.setups) console.log('setup', s.id, s.orientation.top, JSON.stringify(s.flip ?? null), JSON.stringify(s.pins ?? null), JSON.stringify(s.tools ?? null));
for (const g of plan.goals) console.log('goal', g.id, g.setupId, 'pos', JSON.stringify(g.position), 'rot', g.rotation, 'band', g.bandMm, 'under', JSON.stringify(g.underside ?? null));
