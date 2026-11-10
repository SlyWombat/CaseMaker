/**
 * #1180 — the #858 pick harness, shared by the two split files (`pickTray858` demo tray and
 * `pickTrayBin858` tight corners) so the two full searches run in parallel workers. Moved from
 * `pickTray858.spec.ts` unchanged.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tl } from './manifoldExec';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { smartPick, type ScoredPlan } from '@/engine/cnc/engrave/smartPick';
import { clearPlanEvaluations, evaluatePlan, type CandidatePlan } from '@/workers/sim/planEvaluate';
import { ShopDefaultsSchema, readDefault } from '@/platform/defaultsClient';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import { picked } from './picked';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures', 'pick857');

export function tray(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(DIR, 'j13-tool-tray.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}

export const CLEAR = 'inv:kz-o-flute-3-175-25';
export const FINE = 'flat-1.0';
const FIXTURE_TOOLS = JSON.parse(readFileSync(join(DIR, 'tools.json'), 'utf8')) as ToolLibraryEntry[];
/**
 * #1149 T2 — the built-in 1 mm flat counts as OWNED only when the shop holds the same cutter; this
 * fixture's inventory piece is the twin that makes it so (#454's correspondence). The cost case
 * below needs both contesting plans all-owned, so it passes this twin beside the built-in.
 */
export const OWNED_1MM = FIXTURE_TOOLS.find((t) => t.key === 'inv:kz-corn-1-7')!;
export const TOOLS: ToolLibraryEntry[] = [
  ...FIXTURE_TOOLS.filter((t) => t.key === CLEAR),
  OWNED_1MM,
  TOOL_LIBRARY.find((t) => t.key === FINE)!,
];
export const SEED = readDefault(
  ShopDefaultsSchema.parse(
    (JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown })
      .defaults,
  ),
  'toolChange.seconds',
);

export const keys = (s: ScoredPlan): string => s.plan.cutters.map((c) => c.key).join('+');

export async function pickFor(job: EngraveJob) {
  clearPlanEvaluations();
  const ctx = { tl, tools: TOOLS, catalogue: [], shop: { tools: TOOLS }, calibration: null };
  return picked(
    await smartPick(job, TOOLS, [], async (p: CandidatePlan, level) => await evaluatePlan(job, p, ctx, { level }), {
      toolChangeSeconds: SEED.value,
    }),
  );
}
