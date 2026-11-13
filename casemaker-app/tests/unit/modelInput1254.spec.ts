/**
 * #1254 — THE PLANNER'S INPUT IS PLAIN DATA, AND EVERY BUILT ONE IS STRUCTURED-CLONEABLE.
 *
 * #1234 put `stockEdgeOpen` — a closure over the job and the mount's envelope — on
 * `ModelPlanInput`. The input is structured-cloned into the rank pool (#1151
 * `--parallel-rank`: `rankPool.ts`'s `workerData`), so the app refused every tray plan through
 * that route before planning: "planModelCam refused — (side,lowestTipZ,radiusMm)=>stockEdgeOpenAt(…)
 * could not be cloned." The edge question rides as plain facts now (`ModelPlanInput.openEdges`)
 * and the planner evaluates the rule itself (`cam/model/openEdges.ts`).
 *
 * These two tests are the gate, and they are RED on the #1234 shape:
 *   1. a built input round-trips through `structuredClone` and the clone plans to the same
 *      programs as the original, byte for byte;
 *   2. a walker fails on ANY function anywhere in a built `ModelPlanInput`, naming its path —
 *      with a planted function proving the walker itself can fail, so a green run means "no
 *      function", not "the walker never looked".
 *
 * The input used is the real tray (side 2, `m1trayB-bottom.cutjob.json`) with its fixture boxes,
 * because that is the job that failed; a second, mount-less build pins that the two doors agree.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { planOwnedOnly } from '@/engine/cnc/cam/model/twoPlans';
import { jobMountObstacles } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

import { goal, job as shellJob, zOut } from './helpers/goalClearAround';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY = join(HERE, '..', 'e2e', 'fixtures', 'm1trayB', 'm1trayB-bottom.cutjob.json');

const BALL = flatEndMill(3.175, { shape: 'ball', name: '3.175 mm ball nose (test)' });

function trayJob(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(TRAY, 'utf8')) as unknown);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job.targetObject === undefined ? (() => { throw new Error('the tray fixture lost its goal'); })() : parsed.job;
}

async function builtInput(job: EngraveJob, target: EngraveTargetObject, mount: ReturnType<typeof jobMountObstacles>): Promise<ModelPlanInput> {
  const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
  return buildModelPlanInputForGoal(job, target, BALL, { mount, tools: [{ key: 'inv:test-ball', tool: BALL, provenance: 'test fixture' }] }, undefined, [BALL], []);
}

/**
 * The first function found anywhere in the value, by path — `input.stockEdgeOpen` is exactly how
 * #1234's closure reads. Typed arrays cannot hold one and are skipped whole (the tray's goal
 * field is 1.4 M cells; walking its indices would be pure waste).
 */
export function firstFunctionPath(value: unknown, path = 'input', seen = new Set<unknown>()): string | null {
  if (typeof value === 'function') return path;
  if (value === null || typeof value !== 'object') return null;
  if (ArrayBuffer.isView(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = firstFunctionPath(value[i], `${path}[${i}]`, seen);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const hit = firstFunctionPath((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
    if (hit !== null) return hit;
  }
  return null;
}

describe('#1254 the planner input carries no functions', () => {
  it('the tray with its fixture boxes, and a mount-less shell: no function anywhere', async () => {
    const tray = trayJob();
    const inputs = [
      await builtInput(tray, tray.targetObject!, jobMountObstacles(tray, null)),
      await builtInput(shellJob(goal(zOut)), shellJob(goal(zOut)).targetObject!, null),
    ];
    for (const input of inputs) expect(firstFunctionPath(input), 'a function rides ModelPlanInput').toBeNull();
  }, 300_000);

  it('the walker itself fails and names the path — a planted closure, where #1234’s read', async () => {
    const tray = trayJob();
    const input = await builtInput(tray, tray.targetObject!, jobMountObstacles(tray, null));
    expect(firstFunctionPath({ ...input, stockEdgeOpen: () => true })).toBe('input.stockEdgeOpen');
    expect(firstFunctionPath({ ...input, a: [{ b: () => true }] })).toBe('input.a[0].b');
  }, 300_000);
});

describe('#1254 a built input clones and plans to the same programs', () => {
  it('structuredClone round-trips, and the clone’s owned plan is byte-identical', async () => {
    const tray = trayJob();
    const input = await builtInput(tray, tray.targetObject!, jobMountObstacles(tray, null));
    // #1234's shape died HERE, before any planning: DataCloneError on the closure.
    const clone = structuredClone(input);
    expect(clone.openEdges).toEqual(input.openEdges);
    const original = await planOwnedOnly(input);
    const cloned = await planOwnedOnly(clone);
    // The programs, byte for byte — the rank pool plans from exactly this clone.
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(original));
    expect(cloned.perSetup.flatMap((setup) => setup.programs).length).toBeGreaterThan(0);
  }, 300_000);
});
