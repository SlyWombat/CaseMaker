import { readFileSync } from 'node:fs';
import { goalSides, jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
for (const f of ['m1trayF-banded.cutjob.json', 'm1trayF-banded2.cutjob.json']) {
  const job = JSON.parse(readFileSync('/home/dave/projects/cm-wt/m1-land11/' + f, 'utf8')) as EngraveJob;
  console.log('===', f);
  console.log('setups', jobSetups(job).map((s) => `${s.id}:${s.orientation.top}`).join(', '));
  for (const s of goalSides(job)) console.log(' side', s.setupIndex, s.setup.id, s.setup.orientation.top, '→ goal', s.goal.id, 'pos', JSON.stringify(s.goal.position), 'setupId', s.goal.setupId);
}
