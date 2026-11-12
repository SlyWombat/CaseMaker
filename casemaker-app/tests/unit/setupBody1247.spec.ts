/**
 * #1247 — THE SETUP'S OWN STOCK REACHES THE VERIFIER'S BODY AND THE PROGRAM'S LIMIT, RED FIRST.
 *
 * Three doors, in the analyst's order:
 *   (b) the item pipeline's depth limit (generateOneProgram takes it from the job blank);
 *   (1) the verifier's `Setup` body, on both a READ machine (Z1, where nothing may move) and a
 *       STATED one (Shapeoko 4, where the 3 mm reaches the work origin);
 *   (d) the mount's `topLift` (own commit, last).
 *
 * Fixture: `perSetupStock1082.spec.ts:34-48` — blank 120 × 160 × 28, setup 2 states 106 × 136 × 25.
 */

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobForSetup, setupPrograms } from '@/engine/cnc/engrave/programs';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import { buildTimeline, parseGcode } from '@/engine/cnc';
import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import { Z1, MILL_MODELS, type Mill } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { verifyProgram, type VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const TOOL_KEY = 'flat-3';
const TOOL: Tool = flatEndMill(3, { number: 1, id: TOOL_KEY, name: 'flat-3' });

const ORIENTATION = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

/** The #1082 fixture, twice over: setup 1 (index 0) cuts the top, setup 2 (index 1) the flip. */
function flipJob(): EngraveJob {
  const base = defaultEngraveJob();
  const top = { id: 'setup-top', orientation: ORIENTATION, mount: { kind: 'tape' }, itemIds: ['part'], tools: [TOOL_KEY] } as unknown as JobSetup;
  const flip = {
    id: 'setup-flip',
    orientation: ORIENTATION,
    mount: { kind: 'tape' },
    itemIds: ['part'],
    tools: [TOOL_KEY],
    flip: { method: 'free-then-flip', axis: 'left-right' },
    stock: { length: 106, width: 136, thickness: 25, provenance: 'stated' },
  } as unknown as JobSetup;
  return {
    ...base,
    stock: { ...base.stock, length: 120, width: 160, thickness: 28 },
    toolKey: TOOL_KEY,
    labels: [],
    shapes: [
      { id: 'part', name: 'Part', kind: 'rect', position: { x: 60, y: 80 }, rotation: 0, width: 106, height: 136, depth: 6, cornerRadius: 3, enabled: true },
    ],
    setups: [top, flip],
  } as unknown as EngraveJob;
}

/** The minimal Z1 program that reaches work Z −27 at the middle of the part. */
const CUT_TO_MINUS_27 = ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'S12000 M3', 'G0 X60 Y80', 'G1 Z-27 F100', 'G0 Z5', 'M332', 'M5'].join('\n');

function codesFor(job: EngraveJob): string[] {
  const setup = toSetup(job, Z1);
  return verifyProgram(CUT_TO_MINUS_27, {
    setup,
    machine: Z1,
    tool: TOOL,
    depthLimit: jobDepthLimit(job),
    minRapidZ: 1,
  }).findings.map((f) => f.code);
}

const SHAPEOKO = MILL_MODELS['grbl:shapeoko-4']!;
/** The runner's own diagnostic rides the verifier as `runner-error`, wording intact. */
const envelopeMove = (findings: readonly { code: string; message: string }[]): boolean =>
  findings.some((f) => f.code === 'runner-error' && f.message.includes('outside-envelope'));
/** A stored program for SETUP 2 that reaches work Z −26 (or Z 75) in one move. */
const storedProgram = (move: string, setupIndex = 2): EngraveProgram =>
  ({
    setupIndex,
    setupId: 'setup-flip',
    toolKey: 'flat-1.0',
    nc: ['G90 G21', 'G0 Z0', move, 'G0 Z10', 'M5', 'M02'].join('\n'),
    verify: null as unknown as VerifyReport,
    frameNc: null,
    frameVerify: null,
    programHash: 'h-1247',
    cam: null,
  }) as unknown as EngraveProgram;

function generatedWith(program: EngraveProgram): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    threadMachining: null,
    cam: null,
    nc: program.nc,
    verify: null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [program],
    errors: [],
  } as unknown as EngraveGenerated;
}

/** The verifier's findings for a stored setup-2 program, through the RUN-STORE path (#1191). */
function recheckFindings(job: EngraveJob, machine: Mill, move: string): readonly { code: string; message: string }[] {
  const out = recheckStoredPrograms({
    job,
    generated: generatedWith(storedProgram(move)),
    machine,
    mount: null,
    setup: toSetup(job, machine, undefined, null),
  });
  return out.generated.programs[0]!.verify!.findings;
}

describe('#1247 (body) — the verifier’s Setup is the setup’s own stock', () => {
  it('Z1 (READ): nothing moves — the WCS origin and every verdict are identical', () => {
    const job = flipJob();
    job.toolKey = 'flat-1.0';
    const own = stockForSetup(job, 1)!;
    const today = toSetup(job, Z1);
    const fixed = toSetup(job, Z1, undefined, null, own);
    // The placement follows the part; the field the timeline reads does not.
    expect(fixed.placement.origin[2] - today.placement.origin[2]).toBeCloseTo(3, 9);
    // The Z is the field the envelope check reads and it does not move; the X/Y placement follows
    // the smaller part (a correct consequence of the setup's own box), so only Z is compared.
    expect(fixed.wcs.origin[2]).toBe(today.wcs.origin[2]);
    const nc = storedProgram('G1 Z-26 F100').nc;
    const diag = (setup: typeof today): string[] =>
      buildTimeline(parseGcode(nc), setup, Z1).diagnostics.map((d) => d.code);
    expect(diag(fixed)).toEqual(diag(today));
    expect(envelopeMove(recheckFindings(job, Z1, 'G1 Z-26 F100'))).toBe(false);
  });

  it('Shapeoko 4 (STATED): both directions — −26 is refused, 75 passes', () => {
    const job = flipJob();
    job.toolKey = 'flat-1.0';
    const own = stockForSetup(job, 1)!;
    const today = toSetup(job, SHAPEOKO);
    const fixed = toSetup(job, SHAPEOKO, undefined, null, own);
    expect(fixed.wcs.origin[2] - today.wcs.origin[2]).toBeCloseTo(-3, 9);
    // The unsafe direction: 1 mm below the machine floor under the real stock.
    expect(envelopeMove(recheckFindings(job, SHAPEOKO, 'G1 Z-26 F100'))).toBe(true);
    // The mirror: a move the real stock allows and the job-blank body refuses.
    expect(envelopeMove(recheckFindings(job, SHAPEOKO, 'G0 Z75'))).toBe(false);
  });
});

describe('#1247 (b) — the item sub-job cuts its own setup’s stock', () => {
  it('setup 2’s sub-job states the 25 mm stock, and a cut to Z −27 is refused', () => {
    const job = flipJob();
    const ref = setupPrograms(job).find((r) => r.setupIndex === 2);
    expect(ref, 'setup 2 has a program').toBeDefined();
    const sub = jobForSetup(job, ref!, TOOL);

    // THE CURE: the sub-job is the job as ONE setup sees it, and the stock is a setup fact
    // (#1082). Today the sub-job keeps the blank, so all three of these fail before the fix.
    expect(stockForSetup(sub, 0)).toEqual({ length: 106, width: 136, thickness: 25 });
    expect(jobDepthLimit(sub)(60, 80)).toBe(25);
    expect(codesFor(sub), 'a cut 2 mm past the setup’s stock is refused').toContain('cut-too-deep');
  });
});
