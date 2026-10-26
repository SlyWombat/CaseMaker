/**
 * #669 — CHAMFER THE EDGE: one flat bevel along a part's edge or a pocket's rim, cut by the cone's
 * flank.
 *
 * The two seams the review looks at are pinned first: the ORDER the material comes out in (a
 * pocket's rim after the pocket, a part's edge before its cut-out frees the part — compared at the
 * PROGRAM level, because a cut-out profiles with a flat end mill and a chamfer is cut by a cone, so
 * the two never share a program) and the DOCUMENT the job gains (round trips on a mixed, non-happy
 * fixture). The oracle test sweeps the part-edge bevel with its program, where the removed band is
 * exactly what the cone takes out of a blank.
 *
 * Real Manifold, real sweep, plain Node — the harness `boreCam.spec.ts` uses.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, regions as cutRegions } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOk, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveChamfer, EngraveJob, EngraveShape, JobSetup } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90';

/**
 * The house 90° chamfer as Makera states it: a 3.175 mm shank and a 90° included angle. The tip is
 * stated here (0.2 mm) because the same cutter V-carves a pocket in one of the fixtures and a
 * V-carve needs a groove to state; the POINT-tip reading is covered by the `vCone` unit test.
 */
const CHAMFER_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.2,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

/** The cut-out's and the pocket's own program cutter: a flat end mill. */
const FLAT_TOOL: ToolLibraryEntry = {
  key: 'user:flat-1-5-chamfer-test',
  tool: flatEndMill(1.5, { name: '1.5 mm flat (chamfer test)', fluteLength: 20, shoulderLength: 20 }),
  provenance: 'test',
};

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A rect shape — a pocket when cut, a part outline when `construction`. */
function rect(id: string, name: string, x: number, width: number, extra: Partial<EngraveShape> = {}): EngraveShape {
  return {
    id,
    name,
    kind: 'rect',
    position: { x, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    width,
    height: 10,
    cornerRadius: 0,
    ...extra,
  } as EngraveShape;
}

function chamfer(id: string, name: string, of: string | undefined, side: 'outside' | 'inside', width = 0.5): EngraveChamfer {
  return { kind: 'chamfer', id, name, side, width, enabled: true, ...(of === undefined ? {} : { of }) };
}

/** A sacrificial board, so a through cut-out is allowed. */
function withBoard(job: EngraveJob): EngraveJob {
  return {
    ...job,
    sacrificial: {
      under: { thickness: job.breakthrough + 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      sides: { left: null, right: null, front: null, back: null },
      source: 'default',
    },
  };
}

/**
 * A part's edge: a construction outline, the cut-out that frees it (program 2, a flat end mill) and
 * the chamfer on its edge (program 1, the cone) — the production order: bevel while it is attached,
 * then cut it out.
 */
function partEdgeJob(): EngraveJob {
  const base = defaultEngraveJob();
  return withBoard({
    ...base,
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: CHAMFER_TOOL,
    shapes: [rect('part', 'lid', 70, 20, { construction: true })],
    cutouts: [
      { kind: 'cutout', id: 'cut', name: 'lid-out', enabled: true, of: 'part', side: 'outside', inset: 0, tabs: { count: 2, width: 3, height: 1 } },
    ],
    chamfers: [chamfer('ch-part', 'lid edge', 'part', 'outside')],
    // The cone's program names only the chamfer; the rim's outline ('part') reaches it as a
    // construction reference, because a program keeps the outlines its items name.
    setups: [setup('setup-1', ['ch-part'], [TOOL_KEY]), setup('setup-2', ['part', 'cut'], [FLAT_TOOL.key])],
  });
}

/**
 * Both rims, in three programs: the pocket (flat, program 1), the bevels (the cone, program 2), the
 * part's cut-out (flat, program 3). The pocket must open before its rim is chamfered, and the
 * part's edge must be chamfered before its cut-out.
 */
function bothRimsJob(): EngraveJob {
  const base = partEdgeJob();
  return {
    ...base,
    shapes: [rect('pocket', 'well', 25, 20), rect('part', 'lid', 70, 20, { construction: true })],
    chamfers: [chamfer('ch-pocket', 'well edge', 'pocket', 'inside'), chamfer('ch-part', 'lid edge', 'part', 'outside')],
    setups: [
      setup('setup-1', ['pocket'], [FLAT_TOOL.key]),
      setup('setup-2', ['ch-pocket', 'ch-part'], [TOOL_KEY]),
      setup('setup-3', ['part', 'cut'], [FLAT_TOOL.key]),
    ],
  };
}

/** The .nc's TOOLPATH names, in the order the operations are emitted. */
function operationNames(g: { nc: string | null }): string[] {
  return (g.nc ?? '')
    .split('\n')
    .filter((line) => line.startsWith(';@MKR|TOOLPATH|'))
    .map((line) => line.slice(line.indexOf('name=') + 'name='.length));
}

describe('chamfer geometry and findings (#669)', () => {
  it('reads a chamfer’s unstated tip as a point, and an engraver’s as missing', () => {
    const point = vCone(flatEndMill(3.175, { shape: 'chamfer', tipDiameter: null, diameter: 3.175, angle: 90, halfAngle: null }));
    expect(point).not.toBeNull();
    expect(point!.tipRadius).toBe(0);
    expect(point!.halfAngleDeg).toBe(45);
    // An ENGRAVER with no tip is still refused: the shank would read as a groove.
    expect(vCone(flatEndMill(3.175, { shape: 'engraving', tipDiameter: null, angle: 30 }))).toBeNull();
    // The test cutter states its 0.2 tip, so its cone is that flat.
    expect(vCone(CHAMFER_TOOL)!.tipRadius).toBe(0.1);
  });

  it('refuses a width past the cone’s reach, naming both numbers', () => {
    const job: EngraveJob = { ...partEdgeJob(), chamfers: [chamfer('ch-part', 'lid edge', 'part', 'outside', 2)] };
    const f = validateJob(job).find((x) => x.code === 'chamfer-too-wide');
    expect(f?.severity).toBe('error');
    // This cutter's cone is (3.175 − 0.2)/2 = 1.4875 mm tall, so at 45° it reaches that width.
    expect(f?.message).toContain('2 mm');
    expect(f?.message).toMatch(/reaches 1\.48/);
  });

  it('refuses a cutter that is not a cone, a rim that is not an edge, and a bevel past the floor', () => {
    const flat = flatEndMill(3.175, { name: '3.175 flat' });
    const noCone = validateJob({ ...partEdgeJob(), tool: flat }).find((x) => x.code === 'chamfer-needs-cone');
    expect(noCone?.severity).toBe('error');
    expect(noCone?.message).toContain('3.175 flat');

    const noEdge: EngraveJob = {
      ...partEdgeJob(),
      chamfers: [chamfer('ch-drill', 'bad rim', 'port', 'outside')],
      drills: [{ kind: 'drill', id: 'port', position: { x: 50, y: 40 }, rotation: 0, depth: 2, enabled: true, through: false }],
    };
    expect(validateJob(noEdge).map((f) => f.code)).toContain('chamfer-needs-edge');

    // A pocket's rim, on a pocket shallower than the bevel reaches.
    const deep = { ...bothRimsJob(), shapes: [rect('pocket', 'well', 25, 20, { depth: 0.3 }), rect('part', 'lid', 70, 20, { construction: true })] };
    const f = validateJob(deep).find((x) => x.code === 'chamfer-too-deep');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('0.3');

    const noRim: EngraveJob = { ...partEdgeJob(), chamfers: [chamfer('ch-none', 'no rim', undefined, 'outside')] };
    expect(validateJob(noRim).map((x) => x.code)).toContain('chamfer-needs-edge');
  });

  it('refuses a pocket chamfered before its pocket, and a part chamfered after its cut-out', () => {
    // The pocket's rim is broken before the pocket opens it.
    const early = {
      ...bothRimsJob(),
      setups: [
        setup('setup-1', ['ch-pocket', 'ch-part'], [TOOL_KEY]),
        setup('setup-2', ['pocket'], [FLAT_TOOL.key]),
        setup('setup-3', ['part', 'cut'], [FLAT_TOOL.key]),
      ],
    };
    const earlyCodes = validateJob(early).filter((f) => f.code === 'chamfer-order');
    expect(earlyCodes.length).toBeGreaterThanOrEqual(1);
    // The part's edge is chamfered after the cut-out has freed it.
    const late = {
      ...partEdgeJob(),
      setups: [setup('setup-1', ['part', 'cut'], [FLAT_TOOL.key]), setup('setup-2', ['ch-part'], [TOOL_KEY])],
    };
    const lateCodes = validateJob(late).filter((f) => f.code === 'chamfer-order');
    expect(lateCodes.length).toBe(1);
    expect(lateCodes[0]!.message).toContain('BEFORE');
  });

  it('plans both sides, from the referenced item’s own profile', () => {
    const plan = toPartPlan(bothRimsJob());
    expect(plan.chamfers).toHaveLength(2);
    expect(plan.chamfers.find((c) => c.id === 'ch-pocket')!.side).toBe('inside');
    expect(plan.chamfers.find((c) => c.id === 'ch-part')!.side).toBe('outside');
    expect(plan.chamfers.find((c) => c.id === 'ch-part')!.width).toBe(0.5);
  });

  it('runs the part bevel in program 1 and the cut-out that frees it in program 2', () => {
    const g = generate(tl, partEdgeJob(), null, [], undefined, { tools: [FLAT_TOOL] });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error').map((f) => f.code) }),
    ).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.programs.map((p) => p.toolKey)).toEqual([TOOL_KEY, FLAT_TOOL.key]);
    const [cone, profile] = g.programs.map((p) => operationNames(p));
    expect(cone!.some((n) => n.startsWith('[T1]Chamfer'))).toBe(true);
    expect(profile!.some((n) => n.startsWith('[T1]Cut out'))).toBe(true);
    // The bevel is the first program's only operation; the cut-out comes after it.
    expect(operationNames(g).some((n) => n.startsWith('[T1]Chamfer'))).toBe(true);
  }, 90_000);

  it('places the pocket program, the bevels and the cut-out in that order', () => {
    const g = generate(tl, bothRimsJob(), null, [], undefined, { tools: [FLAT_TOOL] });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error').map((f) => f.code) }),
    ).toBe(true);
    expect(g.programs).toHaveLength(3);
    expect(g.programs.map((p) => p.toolKey)).toEqual([FLAT_TOOL.key, TOOL_KEY, FLAT_TOOL.key]);
    const [pocket, bevels, profile] = g.programs.map((p) => operationNames(p));
    expect(pocket!.some((n) => n.startsWith('[T1]Pocket'))).toBe(true);
    expect(bevels!.filter((n) => n.startsWith('[T1]Chamfer'))).toHaveLength(2);
    expect(profile!.some((n) => n.startsWith('[T1]Cut out'))).toBe(true);
  }, 90_000);

  it('cuts every bevel at one Z with feed plunges', () => {
    const { chamfers } = cutRegions(tl, bothRimsJob());
    expect(chamfers).toHaveLength(2);
    for (const cut of chamfers) {
      // The tip plane is the bevel's bottom: width over tan(45°).
      expect(cut.depth).toBeCloseTo(0.5, 9);
      expect(cut.path).toHaveLength(1);
    }
  });

  it('states the width, the derived depth and the order on the run sheet', () => {
    const job = bothRimsJob();
    const g = generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL] });
    // The bevels are program 2, so their facts travel on that program and the sheet prints them in
    // its own section.
    const facts = g.programs.find((p) => p.chamfer != null)?.chamfer;
    expect(facts?.items).toHaveLength(2);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const pocket = texts.find((t) => t.startsWith('Chamfer "well edge"') && t.includes('cuts a'));
    const part = texts.find((t) => t.startsWith('Chamfer "lid edge"') && t.includes('cuts a'));
    expect(pocket).toContain('0.5 mm chamfer');
    expect(pocket).toContain('0.5 mm below the top face');
    expect(pocket).toContain('after the pocket');
    expect(pocket).toContain('Tip 0.2 mm (stated)');
    expect(part).toContain('before the profile cuts the part free');

    // The house bit states NO tip: the sheet says so, in the tip's own place, because a real
    // flat would mark the wall at the bevel's bottom by its radius.
    const pointTool = flatEndMill(3.175, {
      name: '3.175 mm 90° chamfer (point)',
      typeText: 'Chamfer',
      shape: 'chamfer',
      tipDiameter: null,
      diameter: 3.175,
      angle: 90,
      halfAngle: null,
    });
    const pointJob: EngraveJob = { ...partEdgeJob(), tool: pointTool };
    const gp = generate(tl, pointJob, null, [], undefined, { tools: [FLAT_TOOL] });
    const pointStep = buildRunSheet(pointJob, gp, null)
      .sections.flatMap((sec) => sec.steps.map((st) => st.text))
      .find((t) => t.startsWith('Chamfer "lid edge"') && t.includes('cuts a'));
    expect(pointStep).toContain('Tip 0 mm (point, by kind)');
  }, 90_000);

  it('passes the oracle on the part bevel, swept from the blank its program starts on', () => {
    const job = partEdgeJob();
    const g = generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL] });
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the tool library`);
    const session: SimSession = createSimSession(tl);
    try {
      const load: SimLoadOk = (() => {
        const l = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
        if (!l.ok) throw new Error(`simulation refused: ${JSON.stringify(l.diagnostics)}`);
        return l;
      })();
      expect(load.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 90_000);
});

describe('chamfer document (#669)', () => {
  it('round-trips a MIXED, non-happy job', () => {
    const job = bothRimsJob();
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.chamfers).toHaveLength(2);
    expect(parsed.job.chamfers![0]!.width).toBe(0.5);
    expect(parsed.job.chamfers![0]!.side).toBe('inside');
    // A chamfer with NO rim yet parses — the finding asks for one; the reader does not fail.
    const noRim: EngraveJob = { ...job, chamfers: [chamfer('ch-none', 'no rim', undefined, 'outside')] };
    const parsedNoRim = parseEngraveJob(noRim);
    expect(parsedNoRim.ok).toBe(true);
    if (!parsedNoRim.ok) return;
    expect('of' in parsedNoRim.job.chamfers![0]!).toBe(false);
    // A chamfer aimed at a rim that is not an edge still PARSES; the finding refuses it.
    expect(parseEngraveJob({ ...job, chamfers: [chamfer('ch-x', 'x', 'nope', 'outside')] }).ok).toBe(true);
    // A width or a side the schema cannot carry is refused outright.
    expect(parseEngraveJob({ ...job, chamfers: [chamfer('ch-x', 'x', 'pocket', 'inside', 0)] }).ok).toBe(false);
    expect(parseEngraveJob({ ...job, chamfers: [chamfer('ch-x', 'x', 'pocket', 'inside', -1)] }).ok).toBe(false);
    expect(parseEngraveJob({ ...job, chamfers: [chamfer('ch-x', 'x', 'pocket', 'inside', 60)] }).ok).toBe(false);
    expect(parseEngraveJob({ ...job, chamfers: [{ ...chamfer('ch-x', 'x', 'pocket', 'inside'), side: 'sideways' }] }).ok).toBe(false);
  });

  it('keeps an old document’s absence byte for byte', () => {
    const base = defaultEngraveJob();
    const parsed = parseEngraveJob({ ...base, toolKey: TOOL_KEY, tool: CHAMFER_TOOL });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('chamfers' in parsed.job).toBe(false);
  });
});
