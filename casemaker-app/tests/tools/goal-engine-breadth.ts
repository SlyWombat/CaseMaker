/**
 * #966 BREADTH CHECK — how much of the demo corpus the rebuilt engine already covers, per job,
 * beside what the old heightfield engine does on the same file.
 *
 * Not a spec: a tool. For every job file the Z1 demo page uses (`docs/bench/2026-10-28-z1-real-jobs/
 * jobs/*.json`) plus any committed sample job files, it runs
 *
 *   old   — `generateGoalProgram` through `engraveGenerate`, the flag OFF (today's default).
 *   new   — exactly what the flag-on seam calls: `buildModelPlanInputForGoal` + `planModelCam`
 *           (A's #966 seam, `ef0c56cd`), reported as posts / refused / throws, with the plan's own
 *           program count, cutter sequence and cycle.
 *   seam  — only when `CASEMAKER_MODEL_CAM=1`: the real `engraveGenerate` path with the flag on,
 *           i.e. what `generateGoalProgram` answers today (the seam's stated refusal, carrying
 *           its setup/program counts and notes).
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/goal-engine-breadth.ts [--out FILE] [--only NAME]
 *   CASEMAKER_MODEL_CAM=1 npx tsx --tsconfig tsconfig.scripts.json tests/tools/goal-engine-breadth.ts
 *
 * One JSON line per job is written to stdout (and to `--out` when given), so a long run can be
 * read as it goes; a failure inside one engine never stops the corpus.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrap, loadCatalogue, type LoadedCatalogue } from '../../src/platform/headless/bootstrap';
import { engraveShopOpts } from '../../src/engine/cnc/engrave/feeds';
import { readDefault } from '../../src/platform/defaultsClient';
import { resolvedFeedsTable } from '../../src/engine/cnc/feeds';
import { inventoryConditions } from '../../src/engine/cnc/toolCondition';
import { drillSettings } from '../../src/engine/cnc/cam/drillBit';
import { getTools, NO_TOOL_KEY } from '../../src/engine/cnc/toolRegistry';
import { pickForEngrave } from '../../src/workers/sim/smartPickRun';
import { supportingFloors } from '../../src/workers/sim/engraveGenerate';
import { toPartPlan } from '../../src/engine/cnc/engrave/partPlan';
import { parseEngraveJob } from '../../src/store/engraveJobSchema';
import { jobTool } from '../../src/engine/cnc/engrave/jobSetup';
import { engraveGenerate, buildModelPlanInputForGoal, type EngraveGenerated } from '../../src/workers/sim/engraveGenerate';
import { planModelCam, USE_MODEL_CAM_ENGINE } from '../../src/engine/cnc/cam/model/plan';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile: string | null = outIndex >= 0 ? (args[outIndex + 1] ?? null) : null;
const onlyIndex = args.indexOf('--only');
const only: string | null = onlyIndex >= 0 ? (args[onlyIndex + 1] ?? null) : null;

// The bench location the demo jobs were built against (its inventory holds the owned cutters the
// jobs name, and its `catalogue.json` holds Makera's rows). `--location` overrides it.
const locIndex = args.indexOf('--location');
const locationPath =
  locIndex >= 0
    ? args[locIndex + 1]!
    : (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['CASEMAKER_LOCATION'] ??
      '/home/dave/casemaker-manager/demo5/bench/location.json';
const boot = await bootstrap({ location: locationPath });
const tl = boot.manifold;
let catalogue: LoadedCatalogue | null = null;
try {
  catalogue = loadCatalogue(join(dirname(locationPath), 'catalogue.json'));
} catch {
  catalogue = null;
}
const catalogueRows = catalogue?.rows ?? [];
const shop = engraveShopOpts(boot.location?.defaults ?? null);

/** #766 — a job that names no cutter is given one by the same measured search the app runs. */
async function pickCutterFor(job: EngraveJob): Promise<EngraveJob | null> {
  const defaults = boot.location?.defaults ?? null;
  const pickShop = {
    tools: getTools(),
    lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
    toolChangeSeconds: readDefault(defaults, 'toolChange.seconds').value,
    drill: drillSettings(defaults),
    feeds: resolvedFeedsTable().table,
    defaults,
  };
  const pick = await pickForEngrave({
    tl,
    job,
    tools: getTools(),
    catalogue: catalogueRows,
    conditions: inventoryConditions(),
    shop: pickShop,
    floors: supportingFloors(tl, toPartPlan(job)),
  });
  if (pick.refused === true || pick.runnable === null) return null;
  const first = pick.runnable.plan.cutters[0];
  return first === undefined ? null : { ...job, toolKey: first.key };
}
const DOCS = join(APP, '..', 'docs');

interface Row {
  job: string;
  goal: boolean;
  old?: 'posts' | 'refused' | 'throws' | 'skipped';
  oldPrograms?: number;
  oldCutter?: string | null;
  oldCycleSeconds?: number | null;
  oldWhy?: string;
  pickedCutter?: string;
  new?: 'posts' | 'refused' | 'throws' | 'skipped';
  newPrograms?: number;
  newCutters?: string[];
  newCycleSeconds?: number;
  newWhy?: string;
  seam?: 'posts' | 'refused' | 'throws';
  seamWhy?: string;
}

/** Every job file the demo page uses, plus committed sample jobs. */
function jobFiles(): string[] {
  const jobsDir = join(DOCS, 'bench', '2026-10-28-z1-real-jobs', 'jobs');
  const files = readdirSync(jobsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(jobsDir, f));
  const bench = join(DOCS, 'bench');
  for (const f of readdirSync(bench)) {
    if (f.includes('sample') && f.endsWith('.job.json')) files.push(join(bench, f));
  }
  return only === null ? files : files.filter((f) => f.includes(only));
}

const firstLine = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 3).join(' / ') : String(e));

async function runOld(job: EngraveJob): Promise<Pick<Row, 'old' | 'oldPrograms' | 'oldCutter' | 'oldCycleSeconds' | 'oldWhy'>> {
  try {
    const generated: EngraveGenerated = await engraveGenerate(tl, job, jobTool(job), catalogueRows, null, undefined, shop);
    if (generated.ok) {
      return {
        old: 'posts',
        oldPrograms: generated.programs.length,
        oldCutter: jobTool(job)?.name ?? job.toolKey ?? null,
        oldCycleSeconds: generated.cam?.estimatedSeconds ?? null,
      };
    }
    return { old: 'refused', oldWhy: generated.errors.map((e) => e.message).join(' | ') || `stage ${generated.stage}` };
  } catch (e) {
    return { old: 'throws', oldWhy: firstLine(e) };
  }
}

async function runNew(job: EngraveJob, goal: EngraveTargetObject): Promise<Pick<Row, 'new' | 'newPrograms' | 'newCutters' | 'newCycleSeconds' | 'newWhy'>> {
  const tool = jobTool(job);
  if (tool === null) return { new: 'skipped', newWhy: 'the job names no usable cutter' };
  try {
    const input = await buildModelPlanInputForGoal(job, goal, tool, shop);
    const output = await planModelCam(input);
    const perSetup = output.perSetup;
    const programs = perSetup.reduce((n, s) => n + s.programs.length, 0);
    const cutters = [...new Set(perSetup.flatMap((s) => s.sequence.map((e) => e.cutterKey)))];
    const cycle = perSetup.reduce((n, s) => n + s.totalCostSeconds, 0);
    return programs > 0
      ? { new: 'posts', newPrograms: programs, newCutters: cutters, newCycleSeconds: Math.round(cycle) }
      : { new: 'refused', newWhy: `no program posted (${perSetup.length} setup(s), ${perSetup.flatMap((s) => s.notes).join(' | ') || 'no notes'})` };
  } catch (e) {
    return { new: 'throws', newWhy: firstLine(e) };
  }
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const file of jobFiles()) {
    const name = file.split(/[\\/]/).pop()!;
    let job: EngraveJob;
    try {
      const parsed = parseEngraveJob(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.ok) {
        const row: Row = { job: name, goal: false, old: 'skipped', oldWhy: `does not parse: ${parsed.errors.join('; ').slice(0, 200)}` };
        rows.push(row);
        process.stdout.write(JSON.stringify(row) + '\n');
        continue;
      }
      job = parsed.job;
    } catch (e) {
      const row: Row = { job: name, goal: false, old: 'throws', oldWhy: firstLine(e) };
      rows.push(row);
      process.stdout.write(JSON.stringify(row) + '\n');
      continue;
    }
    const goal = job.targetObject?.role === 'goal' ? job.targetObject : undefined;
    const row: Row = { job: name, goal: goal !== undefined };
    // A job that names no cutter (the demo page's picker fills one in) gets the measured search's
    // choice before either engine sees it, so the row is a fair comparison rather than a skip.
    if (goal !== undefined && (job.toolKey === '' || job.toolKey === NO_TOOL_KEY || jobTool(job) === null)) {
      const picked = await pickCutterFor(job).catch(() => null);
      if (picked === null) {
        row.old = 'skipped';
        row.new = 'skipped';
        row.oldWhy = 'the measured search posted no plan (no cutter named)';
        row.newWhy = row.oldWhy;
        rows.push(row);
        process.stdout.write(JSON.stringify(row) + '\n');
        continue;
      }
      job = picked;
      row.pickedCutter = job.toolKey;
    }
    if (goal === undefined) {
      // A 2.5D job: the rebuilt engine does not plan it (its scope is a goal), so there is
      // nothing to compare; the old engine's row is still recorded for the corpus census.
      if (!USE_MODEL_CAM_ENGINE) Object.assign(row, await runOld(job));
      row.new = 'skipped';
      row.newWhy = 'not a goal job';
    } else {
      if (USE_MODEL_CAM_ENGINE) {
        try {
          const generated = await engraveGenerate(tl, job, jobTool(job), catalogueRows, null, undefined, shop);
          row.seam = generated.ok ? 'posts' : 'refused';
          row.seamWhy = generated.ok ? '' : generated.errors.map((e) => e.message).join(' | ');
        } catch (e) {
          row.seam = 'throws';
          row.seamWhy = firstLine(e);
        }
      } else {
        Object.assign(row, await runOld(job));
      }
      Object.assign(row, await runNew(job, goal));
    }
    rows.push(row);
    process.stdout.write(JSON.stringify(row) + '\n');
  }
  if (outFile !== null) writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

await main();
