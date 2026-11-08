/**
 * #1084 — A DOOR MUST NOT POST SILENTLY. Three silences the #1059 readiness run found:
 *
 * 1. The CLI writes a rotary job's `.nc` while the app's Save .nc is disabled by
 *    `ROTARY_UNMEASURED_REFUSAL`, and says nothing about it. The CLI still posts (it is the
 *    generation door), but the sentence must ride the output and the receipt once.
 * 2. `goal-object-oversize` fires falsely on an axis-centred rotary goal: the check reads the
 *    stock's corner-anchored box (`y` from 0), and a rotary goal's section is centred on the
 *    chuck's axis, so half of it reads as "past the front edge" — with a sentence that claims a
 *    refusal the rotary relief path does not perform.
 * 3. A job carrying faces AND a goal posts the faces program and drops the goal with no sentence.
 *    The real fix is #1085's mixed dispatch; until it exists the job refuses by name.
 *
 * These cases drive the real CLI entry point (`engraveJobMain`). The rotary cases stop at the CAM
 * stage on purpose — the target carries no mesh bytes, so the generate fails fast AFTER the gate
 * statement — keeping the facts under test small.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { Receipt } from '../../src/platform/headless/receipt';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { ROTARY_UNMEASURED_REFUSAL } from '../../src/store/engraveRunGate';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { validateGoalObject } from '../../src/engine/cnc/engrave/jobSetup';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cli-1084-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.resetModules());

const LOCATION = JSON.stringify({ tools: [], inventory: [] }, null, 2) + '\n';
const TOOL_KEY = 'flat-3.175x12-metal'; // a built-in: resolves with no service

/** A goal target with its identity only — no bytes, so the CAM stops fast at "mesh not loaded". */
function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-fixture-1084',
    name: 'fixture.stl',
    format: 'stl',
    sha256: '0'.repeat(64),
    size: { x: 20, y: 20, z: 20 },
    position: { x: 41.5, y: 0, z: 0 },
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    enabled: true,
    role: 'goal',
  };
}

function rotaryJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'rotary door fixture',
    stock: { length: 120, width: 44.5, thickness: 44.5, material: 'hardwood' },
    stockEntry: { kind: 'made', shelfId: null, file: null, form: 'block', finish: 'unknown', conductive: false },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 90, gripDiameter: 44.5, jawMode: 'reverse-outer', tailstock: true, source: 'test' },
    },
    labels: [],
    shapes: [],
    toolKey: TOOL_KEY,
    targetObject: goalTarget(),
  };
}

function viseJob(): EngraveJob {
  const job = rotaryJob();
  return { ...job, workholding: defaultEngraveJob().workholding, stock: { ...job.stock, length: 120, width: 60, thickness: 44.5 } };
}

function facesGoalJob(): EngraveJob {
  const job = rotaryJob();
  return { ...job, faces: [{ id: 'face-corners', kind: 'faces-all-round', a: 45, count: 8, acrossFlats: 44.5 }] };
}

interface CliRun {
  code: number;
  receipt: Receipt | null;
  progress: string[];
}

async function cliCut(job: EngraveJob, name: string): Promise<CliRun> {
  const { engraveJobMain } = await import('../../scripts/lib/casemaker/engrave');
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  const locationPath = join(dir, 'location.json');
  writeFileSync(locationPath, LOCATION);
  const progress: string[] = [];
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    json: true,
    sink: { progress: (line) => progress.push(line), receipt: (r) => { receipt = r; } },
  };
  const code = await engraveJobMain([jobPath, '--out', join(dir, 'out'), '--location', locationPath], options);
  return { code, receipt, progress };
}

describe('#1084 the rotary door states the Save gate', () => {
  it('a rotary job: the gate sentence once in the output and in the receipt, and the run still generates', async () => {
    const { code, receipt, progress } = await cliCut(rotaryJob(), 'rotary');
    // The fixture's target has no bytes, so the run stops at the CAM — receipted. What this case
    // holds is everything before it: the sentence rode both channels exactly once.
    expect(code).toBe(1);
    expect(progress.filter((l) => l === ROTARY_UNMEASURED_REFUSAL)).toHaveLength(1);
    expect(receipt).not.toBeNull();
    const rows = receipt!.diagnostics.filter((d) => d.code === 'rotary-unmeasured');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'rotary-unmeasured', guideRow: 'rotary-unmeasured', severity: 'info', message: ROTARY_UNMEASURED_REFUSAL, program: null });
  });

  it('a vise job carries no rotary row and no sentence', async () => {
    const { receipt, progress } = await cliCut(viseJob(), 'vise');
    expect(progress.filter((l) => l === ROTARY_UNMEASURED_REFUSAL)).toHaveLength(0);
    expect(receipt!.diagnostics.filter((d) => d.code === 'rotary-unmeasured')).toHaveLength(0);
  });

  it('faces and a goal together refuse by name — never post the faces and drop the goal', async () => {
    const { code, receipt } = await cliCut(facesGoalJob(), 'faces-goal');
    expect(code).toBe(1);
    expect(receipt).not.toBeNull();
    const refusals = receipt!.diagnostics.filter((d) => d.code === 'faces-with-goal');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.severity).toBe('error');
    expect(refusals[0]!.message).toContain('this job has faces and a goal');
    const programs = (receipt!.details as { programs?: unknown[] }).programs ?? [];
    expect(programs).toHaveLength(0);
  });
});

describe('#1084 goal-object-oversize leaves an axis-centred rotary goal to the rod check', () => {
  const stock = { length: 120, width: 44.5, thickness: 44.5 };
  it('the rotary flag suppresses the box-frame test; the vise path is unchanged', () => {
    const target = goalTarget();
    const vise = validateGoalObject(target, stock, {});
    expect(vise.filter((f) => f.code === 'goal-object-oversize')).toHaveLength(1);
    expect(vise.find((f) => f.code === 'goal-object-oversize')!.message).toContain('past the front edge');
    const rotary = validateGoalObject(target, stock, { rotary: true });
    expect(rotary.filter((f) => f.code === 'goal-object-oversize')).toHaveLength(0);
  });
});
