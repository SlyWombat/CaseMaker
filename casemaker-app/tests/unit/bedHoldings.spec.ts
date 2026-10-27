// #709 (BM-1 of #707) — the bed mounts in the JOB: tape and the bracket with its clamps, through
// the document schema, the mount readers and the obstacle path. Design: `docs/design/bed-mounts-flow.md`
// §3.2 (what each option writes), §3.4 (tape), §3.6 (the bracket and its clamps) and §5 (defaults).
//
// THE SAFETY FIX this spec exists for is the bracket's clamps: before BM-1 `bracketMount` checked
// the shop's two DEFAULT clamps whatever was fitted, so a clamp dragged clear of the cut still
// refused it and a clamp dragged INTO the cut was never seen. The §6 fixture 3 is reproduced at the
// engine seam the verifier calls (`bracketMount` → `mountInPath`, exactly the objects `verify.ts`
// hands it): the Tray pocket is refused against the default pair and clear against the right-edge
// pair the job states.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import {
  bracketMount,
  bracketObstacles,
  bracketSettings,
  clampObstacles,
  defaultClampPlacements,
  mountInPath,
  type ClampPlacement,
  type PathSegment,
} from '@/engine/cnc/mounts';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  TAPE_DEFAULTS,
  clampPlacementsFor,
  defaultBracketHold,
  defaultTapeHold,
  jobMount,
  jobSetups,
  toSetup,
  workholdingFor,
} from '@/engine/cnc/engrave/jobSetup';
import { applyAnswers, applyHoldAnswers, defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { labelJawReach } from '@/engine/cnc/engrave/partPlan';
import { Z1 } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { BracketHold, EngraveJob, JobBedBinding, TapeHold } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const B = bracketSettings(DEFAULTS);

const TAPE: TapeHold = { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' };
const BED: JobBedBinding = { profileId: 'bed-1', profileVersion: '2026-10-26T09:20:00.000Z' };

/** The design's plate: 100 × 60 × 6, in the thin bracket at anchor 1. */
function plate(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, stock: { ...base.stock, length: 100, width: 60, thickness: 6 } };
}

function tapedJob(over: Partial<EngraveJob> = {}): EngraveJob {
  return { ...plate(), workholding: { kind: 'tape', tape: { ...TAPE } }, bed: BED, ...over };
}

function bracketJob(clamps?: ClampPlacement[], over: Partial<EngraveJob> = {}): EngraveJob {
  const hold: BracketHold = {
    anchor: 1,
    variant: 'thin',
    clamps: clamps ?? defaultClampPlacements({ x: 100, y: 60, z: 6 }, B.settings),
    source: 'default',
  };
  return { ...plate(), workholding: { kind: 'bracket', bracket: hold }, bed: BED, ...over };
}

const parse = (job: EngraveJob) => parseEngraveJob(JSON.parse(JSON.stringify(job)));

// ---------------------------------------------------------------------------------------------------
// The document.

describe('#709 BM-1 the bed arms in the document', () => {
  it('a taped job parses and round-trips field for field, bed binding included', () => {
    const job = tapedJob();
    const parsed = parse(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.job).toEqual(job);
    expect(parsed.job.workholding).toEqual({ kind: 'tape', tape: TAPE });
    expect(parsed.job.bed).toEqual(BED);
    // Saving is `JSON.stringify(job)`: opening and saving must write identical bytes.
    const again = parseEngraveJob(JSON.parse(JSON.stringify(parsed.job)));
    expect(again.ok).toBe(true);
    if (again.ok) expect(JSON.stringify(again.job)).toBe(JSON.stringify(parsed.job));
  });

  it("a bracket job carries ITS clamp places, not the default pair", () => {
    const right: ClampPlacement[] = [
      { edge: 'right', at: 22.5 },
      { edge: 'right', at: 37.5 },
    ];
    const job = bracketJob(right);
    const parsed = parse(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.job).toEqual(job);
    expect(parsed.job.workholding.kind).toBe('bracket');
    if (parsed.job.workholding.kind !== 'bracket') return;
    expect(parsed.job.workholding.bracket.clamps).toEqual(right);
  });

  it('a pre-#707 (vise) job has no bed key and no bed arm', () => {
    const job = defaultEngraveJob();
    const parsed = parse(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('bed' in parsed.job).toBe(false);
    expect(parsed.job.workholding.kind).toBe('vise');
  });

  it('the schema refuses a bad tape: no roll width, no negative inset, another square-to', () => {
    const errors = (tape: Partial<TapeHold>): string[] => {
      const parsed = parse(tapedJob({ workholding: { kind: 'tape', tape: { ...TAPE, ...tape } } }));
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errors({ width: 0 }).length).toBeGreaterThan(0);
    expect(errors({ thickness: -0.1 }).length).toBeGreaterThan(0);
    expect(errors({ inset: -2 }).length).toBeGreaterThan(0);
    expect(errors({ squareTo: 'left' as TapeHold['squareTo'] }).length).toBeGreaterThan(0);
    expect(errors({ where: { x: 1 } as unknown as TapeHold['where'] }).length).toBeGreaterThan(0);
  });

  it('the schema refuses the clamp shapes the machine cannot hold: none, five, or a left edge', () => {
    const errors = (clamps: unknown): string[] => {
      const parsed = parse(bracketJob(undefined, { workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: clamps as ClampPlacement[], source: 'default' } } }));
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errors([]).length).toBeGreaterThan(0);
    expect(errors([1, 2, 3, 4, 5].map((at) => ({ edge: 'back', at }))).length).toBeGreaterThan(0);
    expect(errors([{ edge: 'left', at: 10 }]).length).toBeGreaterThan(0);
    expect(errors([{ edge: 'right', at: -1 }]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// The mount readers.

describe('#709 BM-1 the mount readers read the JOB', () => {
  it('jobMount answers the bed arms with the setups engine’s own words; a stored setup still wins', () => {
    expect(jobMount(tapedJob())).toBe('tape');
    expect(jobMount(bracketJob())).toBe('bracket');
    // #240's compatibility answer is untouched: a rotary job still reads as the flat vise here.
    const rotary = { ...plate(), workholding: { kind: 'rotary-chuck' as const, rotary: { stickout: 30, gripDiameter: null, jawMode: 'reverse' as const, tailstock: true, source: 'wiki' } } };
    expect(jobMount(rotary)).toBe('vise');
    // A stored setup's mount is the document's own (#419).
    const stored = {
      ...tapedJob(),
      setups: [{ ...jobSetups(tapedJob())[0]!, mount: { kind: 'vise' as const } }],
    };
    expect(jobMount(stored)).toBe('vise');
  });

  it('the derived setup carries the bed mount and its board flag', () => {
    // The board flag is stated on a bed mount either way: `false` is "nothing under it", which is
    // the fact the setups engine reads (a board carries a cut face; no board means no `rests-on-cut`).
    expect(jobSetups(tapedJob())[0]?.mount).toEqual({ kind: 'tape', board: false });
    const withBoard = tapedJob({
      sacrificial: { under: { thickness: 2, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' }, sides: { left: null, right: null, front: null, back: null }, source: 'default' },
    });
    expect(jobSetups(withBoard)[0]?.mount).toEqual({ kind: 'tape', board: true });
  });

  it('workholdingFor gives the planner the tape and bracket hold it already knows', () => {
    const tape = workholdingFor(tapedJob());
    expect(tape.kind).toBe('tape-down');
    if (tape.kind !== 'tape-down') return;
    expect(tape.contact).toMatchObject({ kind: 'p-rect', size: [100, 60] });
    const bracket = workholdingFor(bracketJob());
    expect(bracket).toEqual({ kind: 'anchor-bracket', anchor: 1, offset: [0, 0] });
  });

  it('toSetup hands a bed job NO vise envelope, and the bracket its own when one is passed', () => {
    expect(toSetup(tapedJob(), Z1).fixture).toBeUndefined();
    expect(toSetup(bracketJob(), Z1).fixture).toBeUndefined();
    // The vise keeps its jaws (#203): the default is the vise arm's.
    expect(toSetup(defaultEngraveJob(), Z1).fixture?.boxes.length).toBeGreaterThan(0);
    // The bracket's own envelope — the one the run store builds — replaces it when passed.
    const mount = bracketMount({ x: 100, y: 60, z: 6 }, 'bracket', DEFAULTS, 0, clampPlacementsFor(bracketJob()));
    expect(mount).not.toBeNull();
    expect(toSetup(bracketJob(), Z1, mount!.fixture).fixture).toEqual(mount!.fixture);
  });

  it('the setup writes KEEP a bed holding — the answers describe the vise, not this job', () => {
    const job = tapedJob();
    const answers = defaultSetupAnswers(job);
    expect(applyHoldAnswers(job, answers).workholding).toEqual(job.workholding);
    expect(applyAnswers(job, answers).workholding).toEqual(job.workholding);
    // Everything else still comes from the answers.
    expect(applyHoldAnswers(job, answers).sacrificial).toEqual(answers.sacrificial);
    // A vise job is untouched by the guard: the answers still write its vise.
    const vise = defaultEngraveJob();
    if (vise.workholding.kind !== 'vise') throw new Error('the default job is a vise job');
    const changed = applyHoldAnswers(vise, {
      ...defaultSetupAnswers(vise),
      vise: { ...vise.workholding.vise, stockProud: 2 },
    });
    expect(changed.workholding).toMatchObject({ kind: 'vise', vise: { stockProud: 2 } });
  });

  it('a bed job is recommended no jaw floor: there are no jaws on the bed', () => {
    const job = tapedJob();
    const reach = labelJawReach(job, job.labels[0]!);
    expect(reach).toEqual({ jaw: 'fixed', gap: Infinity, reaches: false, overJaw: false });
    const vise = defaultEngraveJob();
    expect(Number.isFinite(labelJawReach(vise, vise.labels[0]!).gap)).toBe(true);
  });

  it('the defaults are the design’s, each with its source', () => {
    const tape = defaultTapeHold();
    expect(tape).toEqual({ width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' });
    expect(TAPE_DEFAULTS.provenance).toMatch(/20 mm/);
    expect(TAPE_DEFAULTS.provenance).toMatch(/not measured/);
    expect(TAPE_DEFAULTS.provenance).toMatch(/2 mm/);

    const bracket = defaultBracketHold({ x: 100, y: 60, z: 6 }, DEFAULTS);
    expect(bracket).toEqual({
      anchor: 1,
      variant: 'thin',
      clamps: [
        { edge: 'back', at: 22.5 },
        { edge: 'back', at: 77.5 },
      ],
      source: 'default',
    });
    // The places are the QuickStart's two on the back edge, 15 mm in from each corner; a location
    // with no defaults still answers the labelled fallbacks rather than refusing a new job.
    expect(defaultBracketHold({ x: 100, y: 60, z: 6 }, null).clamps).toEqual(bracket.clamps);
  });
});

// ---------------------------------------------------------------------------------------------------
// Design §6 fixture 3, at the seam `verify.ts` uses.

/**
 * The Tray pocket's boundary as path segments at its floor: 70 × 30 mm at X 15–85, Y 25–55, cut by
 * a ⌀3.175 flat end. The top edge (Y 55) is the move the design quotes: the cutter's centre
 * reaches Y 55 − 1.5875 = 53.4125.
 */
function trayPocketSegments(): PathSegment[] {
  const z = -2;
  const corners: [number, number][] = [
    [15, 25],
    [85, 25],
    [85, 55],
    [15, 55],
  ];
  return corners.map((from, i) => {
    const to = corners[(i + 1) % corners.length]!;
    return { line: 10 + i, mode: 'cut' as const, from: [from[0], from[1], z] as [number, number, number], to: [to[0], to[1], z] as [number, number, number] };
  });
}

/** Exactly what the verifier hands `mountInPath`: `bracketMount`'s obstacles and its fit. */
function obstaclesFor(job: EngraveJob) {
  const mount = bracketMount({ x: job.stock.length, y: job.stock.width, z: job.stock.thickness }, jobMount(job), DEFAULTS, 0, clampPlacementsFor(job));
  if (mount === null) throw new Error('a bracket job must model its mount');
  return mount;
}

describe('#709 BM-1 the Tray pocket is checked against the JOB’s clamps (design §6 fixture 3)', () => {
  const TOOL_R = 3.175 / 2;
  const FIT = B.settings.fitMm;

  it('the default pair refuses it, one finding per clamp, each naming its own place', () => {
    const job = bracketJob();
    const { obstacles, uncertainty } = obstaclesFor(job);
    const findings = mountInPath(trayPocketSegments(), obstacles, { radius: TOOL_R, uncertainty });
    expect(findings.map((f) => f.code)).toEqual(['clamp-in-path', 'clamp-in-path']);
    expect(findings.map((f) => f.obstacleId)).toEqual(['clamp-1', 'clamp-2']);
    expect(findings[0]!.message).toMatch(/the clamp on the back edge, 15 mm in from the left-hand corner/);
    expect(findings[1]!.message).toMatch(/the clamp on the back edge, 15 mm in from the right-hand corner/);
    // The geometry the design quotes: the cutter's centre reaches Y 53.4125 (the pocket's top
    // edge 55 less the radius) and the grown clamp starts at Y 52 − (1.5875 + 0.1) = 50.3125, so
    // the centre line is inside it by 3.1 mm.
    expect(55 - TOOL_R).toBeCloseTo(53.4125, 4);
    expect(60 - 8 - (TOOL_R + FIT)).toBeCloseTo(50.3125, 4);
  });

  it('the same pocket DRAGGED to the right edge clears — the job’s clamps are what is checked', () => {
    const right: ClampPlacement[] = [
      { edge: 'right', at: 22.5 },
      { edge: 'right', at: 37.5 },
    ];
    const job = bracketJob(right);
    const { obstacles, uncertainty } = obstaclesFor(job);
    // The places are genuinely different obstacles: the right edge, reaching in from X 92.
    const clamps = clampObstacles({ x: 100, y: 60, z: 6 }, right, B.settings);
    expect(clamps.map((c) => c.min[0])).toEqual([92, 92]);
    expect(clamps[0]!.label).toMatch(/the clamp on the right edge/);
    const findings = mountInPath(trayPocketSegments(), obstacles, { radius: TOOL_R, uncertainty });
    expect(findings).toEqual([]);
    // The pocket's rightmost cutter centre is 85 − 1.5875 = 83.4125; the grown clamp starts at
    // 92 − (1.5875 + 0.1) = 90.3125 — 6.9 mm clear.
    expect(85 - TOOL_R).toBeCloseTo(83.4125, 4);
    expect(92 - (TOOL_R + FIT)).toBeCloseTo(90.3125, 4);
  });

  it('a job that states no clamp places checks none — the default pair is a STARTING place, not a fallback', () => {
    const job = bracketJob(undefined, {
      workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'saved' } },
    });
    // The schema refuses an empty list, so a document cannot arrive this way; a hand-built job can,
    // and `bracketMount` then checks no clamps rather than inventing two.
    const parsed = parse(job);
    expect(parsed.ok).toBe(false);
    const { obstacles } = obstaclesFor(job);
    expect(obstacles.filter((o) => o.kind === 'clamp')).toEqual([]);
    expect(obstacles.filter((o) => o.kind === 'bracket').length).toBe(2);
  });

  it('a caller with no job in hand still gets the QuickStart pair (the pre-BM-1 behaviour, kept)', () => {
    const mount = bracketMount({ x: 100, y: 60, z: 6 }, 'bracket', DEFAULTS);
    expect(mount?.obstacles.filter((o) => o.kind === 'clamp').map((o) => o.label)).toEqual(
      clampObstacles({ x: 100, y: 60, z: 6 }, defaultClampPlacements({ x: 100, y: 60, z: 6 }, B.settings), B.settings).map((o) => o.label),
    );
    // The arms are the same statement in both readings.
    expect(mount?.obstacles.filter((o) => o.kind === 'bracket')).toEqual(bracketObstacles({ x: 100, y: 60, z: 6 }, B.settings));
  });
});
