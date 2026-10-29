/**
 * #677 — THE CORE CLEARANCE: the middle a variable-depth V-carve cannot reach is pocketed flat by
 * the setup's second cutter, in its own program AFTER the V-carve.
 *
 * The two review seams first. ORDER: the V program posts first and the core program second, and
 * the pocket's wall is the V's sloped flank's own line at the floor — eroded by
 * `coreOffsetRadius`, not less — so the two files meet without a step. DOCUMENT: a mixed, non-happy
 * round trip proving nothing derived is ever saved.
 *
 * Real Manifold, real sweep, plain Node — the harness the #665 spec uses.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobForSetup } from '@/engine/cnc/engrave/programs';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { coreOffsetRadius } from '@/engine/cnc/vCarveGeometry';
import { vCone } from '@/engine/cnc/vProfile';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveCutout, EngraveJob, EngraveShape, EngraveTraceItem, JobSetup } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/** A 90° cone, point tip — the same cutter the #665 spec carves with. */
const V_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

/** The clearance cutter: a 1.5 mm flat end mill, in the run's registry snapshot. */
const FLAT_TOOL: ToolLibraryEntry = {
  key: 'user:flat-1-5-vcarve-core-test',
  tool: flatEndMill(1.5, { name: '1.5 mm flat (v-carve core test)', fluteLength: 20, shoulderLength: 20 }),
  provenance: 'test',
};

/** A second flat: the rest-only cutter #472's pair tests put after the first. */
const FLAT2_TOOL: ToolLibraryEntry = {
  key: 'user:flat-2-vcarve-rest-test',
  tool: flatEndMill(2, { name: '2 mm flat (v-carve rest test)', fluteLength: 20, shoulderLength: 20 }),
  provenance: 'test',
};

/** A plain line trace — an item with no region for a rest cutter to measure. */
function lineTrace(id: string): EngraveTraceItem {
  return {
    kind: 'line',
    id,
    position: { x: 50, y: 30 },
    rotation: 0,
    points: [
      [-10, 0],
      [10, 0],
    ],
    closed: false,
    depth: 0.3,
    enabled: true,
  };
}

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A variable-depth rect, centred at (50, 30). */
function rect(id: string, width: number, height: number, variable = true): EngraveShape {
  return {
    id,
    name: 'plate',
    kind: 'rect',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
    width,
    height,
    cornerRadius: 0,
    ...(variable ? { vCarveDepth: 'variable' as const } : {}),
  } as EngraveShape;
}

/** A 90° cone with a stated 0.2 mm tip — the everyday V-bit, and the case with a real cap ring. */
const TIP_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V (0.2 tip)',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.2,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

/** The pair job: the V first, the flat end mill after it, no item map (#677's clearance pair). */
function pairJob(shape: EngraveShape = rect('plate', 20, 10), vTool: Tool = V_TOOL): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: vTool,
    cutOverride: { stepDown: 0.25, stepOver: 0.25 },
    shapes: [shape],
    setups: [setup('setup-1', [shape.id], [TOOL_KEY, FLAT_TOOL.key])],
  };
}

function coreJob(job: EngraveJob): EngraveJob {
  const ref = { setupIndex: 1, setupId: 'setup-1', toolKey: FLAT_TOOL.key, itemIds: [] as string[] };
  return jobForSetup(job, ref, FLAT_TOOL.tool);
}

/** Run `generate` with the flat cutter on the bench, as the panel hands it over. */
function run(job: EngraveJob) {
  return generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL] });
}

/** Signed-area sum: outer contours add, holes subtract. */
function area(polygons: readonly (readonly (readonly [number, number])[])[]): number {
  let total = 0;
  for (const ring of polygons) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      sum += a[0] * b[1] - b[0] * a[1];
    }
    total += sum / 2;
  }
  return Math.abs(total);
}

/** The area two polygon sets share, mm². An empty set shares nothing (`ofPolygons([])` throws). */
function shared(a: readonly (readonly (readonly [number, number])[])[], b: typeof a): number {
  if (a.length === 0 || b.length === 0) return 0;
  const CS = tl.CrossSection;
  const ca = CS.ofPolygons(a as [number, number][][]);
  const cb = CS.ofPolygons(b as [number, number][][]);
  const out = ca.intersect(cb);
  const value = out.area();
  out.delete();
  ca.delete();
  cb.delete();
  return value;
}

describe('the clearance pair (#677)', () => {
  it('posts the V program first and the core program second, with the core on its own facts', () => {
    const job = pairJob();
    const g = run(job);
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    const programs = g.programs.filter((p) => (p.kind ?? 'engrave') === 'engrave');
    expect(programs).toHaveLength(2);
    // ORDER: the ladder opens the sloped wall; the pocket clears the middle after it.
    expect(programs[0]!.toolKey).toBe(TOOL_KEY);
    expect(programs[1]!.toolKey).toBe(FLAT_TOOL.key);
    expect(programs[0]!.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(programs[1]!.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The core program carries its own facts, and the operation says what it is.
    expect(programs[1]!.core?.cores).toHaveLength(1);
    const core = programs[1]!.core!.cores[0]!;
    expect(core.of).toBe('plate');
    expect(core.depthMm).toBeCloseTo(0.5, 9);
    expect(core.areaMm2).toBeCloseTo(19 * 9, 1);
    expect(programs[1]!.nc).toContain('Core clearance');
    // And no warning: the engine cleared the core.
    expect(g.findings.filter((f) => f.code === 'vcarve-variable-core')).toEqual([]);
  }, 90_000);

  it('erodes the core by coreOffsetRadius exactly — the pocket wall is the V flank at the floor', () => {
    // A point tip and a stated 0.2 mm tip: the first leaves an EMPTY cap ring (the deepest pass is
    // a line at the wall), the second leaves a real annulus. Both must meet the core on the same
    // line, with no gap and no overlap.
    for (const tool of [V_TOOL, TIP_TOOL]) {
      const job = pairJob(rect('plate', 20, 10), tool);
      const cone = vCone(tool);
      if (cone === null) throw new Error(`${tool.name} has no cone`);
      const vRegions = engraveRegions(tl, job, tool);
      expect(vRegions.cores).toHaveLength(1);
      const core = vRegions.cores[0]!;

      const offset = makeClipperOffset(tl);
      const design = vRegions.regions[0]!.polygons;
      expect(design.length).toBeGreaterThan(0);
      // EXACTLY coreOffsetRadius: the far edge of the deepest tip flat.
      const expected = offset(design, -coreOffsetRadius(cone, 0.5));
      expect(shared(core.polygons, expected), tool.name).toBeCloseTo(core.areaMm2, 1);
      expect(area(expected), tool.name).toBeCloseTo(core.areaMm2, 1);

      // The V's cap-level ring and the core are DISJOINT and together cover the floor at the cap
      // (`offset(design, −cap·tanHalf)`): no gap, no overlap, no step at the seam.
      const capRing = vRegions.predicted.find((p) => p.itemId === 'plate' && Math.abs(p.depth - 0.5) < 1e-9);
      expect(capRing).toBeDefined();
      expect(shared(capRing!.polygons, core.polygons), tool.name).toBeCloseTo(0, 1);
      const floorAtCap = offset(design, -0.5 * cone.tanHalf);
      const together = [...capRing!.polygons, ...core.polygons];
      const both = tl.CrossSection.ofPolygons(together as [number, number][][]);
      expect(both.area(), tool.name).toBeCloseTo(area(floorAtCap), 1);
      both.delete();
    }
  }, 60_000);

  it('sweeps the core program and the oracle passes on its own prediction', () => {
    // The V program is a CONE load: the column engine records no removal mesh for it, so the two
    // files cannot be chained through `priorRemoval` here. The seam between them is the geometry
    // the test above pins (ring ∪ core = the floor at the cap); this one proves the pocket the
    // core program posts cuts exactly the region it predicts.
    const job = pairJob();
    const g = run(job);
    expect(g.ok).toBe(true);
    const programs = g.programs.filter((p) => (p.kind ?? 'engrave') === 'engrave');
    const coreNc = programs[1]!.nc;
    const vTool = jobTool(job);
    if (vTool === null) throw new Error('the V tool is not in the library');

    const session: SimSession = createSimSession(tl);
    try {
      const coreLoad = session.load(coreNc, toSetup(job, Z1), FLAT_TOOL.tool, Z1.id);
      if (!coreLoad.ok) throw new Error(`the core program was refused: ${JSON.stringify(coreLoad.diagnostics)}`);
      expect(coreLoad.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
      // The core program's prediction, from the same regions path the run uses.
      const coreRegions = engraveRegions(
        tl,
        coreJob(job),
        FLAT_TOOL.tool,
        undefined,
        {},
        null,
        [],
        engraveRegions(tl, job, vTool).cores,
      );
      const report = session.oracle(coreRegions.predicted);
      expect(report.ok, JSON.stringify(report.worst)).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('warns when the flat cutter is wider than the core at every point, and cuts nothing', () => {
    // A core ~11 × 0.9 mm: above the 1 mm² bar, but nowhere wider than the 1.5 mm cutter.
    const g = run(pairJob(rect('plate', 12, 1.9)));
    expect(g.ok).toBe(true);
    const programs = g.programs.filter((p) => (p.kind ?? 'engrave') === 'engrave');
    expect(programs).toHaveLength(1);
    const f = g.findings.find((x) => x.code === 'vcarve-variable-core');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain('is wider than it at every point');
    expect(f?.message).toContain('Use a smaller flat end mill');
  }, 90_000);

  it('states the core program on the run sheet, after the V-carve', () => {
    const job = pairJob();
    const g = run(job);
    const sheet = buildRunSheet(job, g, null);
    const texts = sheet.sections.flatMap((s) => s.steps.map((st) => st.text));
    const vStep = texts.find((t) => t.includes('VARIABLE depth'));
    expect(vStep).toBeDefined();
    expect(vStep).toContain('pockets it flat at that depth in its own program');
    // #690b — the sheet names the cutter in the operator's words, never by its internal key. This
    // entry is not in the library this bare spec loads, so the sentence falls back to the kind;
    // a real job resolves the display name (the specs that register their cutters assert that).
    expect(vStep).not.toContain(FLAT_TOOL.key);
    const coreStep = texts.find((t) => t.includes('is pocketed flat at 0.5 mm'));
    expect(coreStep).toBeDefined();
    expect(coreStep).toContain('after the V-carve');
  }, 90_000);
});

describe('the unchanged document (#677)', () => {
  it('round-trips a MIXED, non-happy job and stores nothing derived', () => {
    // Two variable regions of different sizes (two cores, one program), a two-cutter setup, and a
    // schema value no build knows — the document is the job's, the cores are the run's.
    const second = rect('plate2', 12, 8);
    second.position = { x: 50, y: 45 };
    const job: EngraveJob = {
      ...pairJob(),
      shapes: [rect('plate', 20, 10), second],
      setups: [setup('setup-1', ['plate', 'plate2'], [TOOL_KEY, FLAT_TOOL.key])],
    };
    // Generate first: the derived core exists only in the run, never in the document.
    const runResult = run(job);
    expect(
      runResult.ok,
      JSON.stringify({
        stage: runResult.stage,
        errors: runResult.errors,
        findings: runResult.findings.filter((f) => f.severity === 'error'),
      }),
    ).toBe(true);
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.shapes).toHaveLength(2);
    expect(parsed.job.shapes.map((s) => s.id)).toEqual(['plate', 'plate2']);
    expect(parsed.job.setups?.[0]?.tools).toEqual([TOOL_KEY, FLAT_TOOL.key]);
    // No derived item leaked into any list, and the derived id is not a document id.
    const ids = [
      ...parsed.job.shapes.map((s) => s.id),
      ...(parsed.job.chamfers ?? []).map((c) => c.id),
      ...(parsed.job.drills ?? []).map((d) => d.id),
    ];
    expect(ids.some((id) => id.startsWith('core:'))).toBe(false);
    // A value the schema does not know is still refused outright.
    expect(
      parseEngraveJob({
        ...job,
        shapes: [{ ...rect('plate', 20, 10), vCarveDepth: 'medial' }] as unknown as EngraveShape[],
      }).ok,
    ).toBe(false);
  }, 90_000);
});

// #746 — A V-BIT FOLLOWED BY A FLAT THAT OWNS ITS OWN ITEMS. The bench's sign (V-carved artwork,
// outline cut with a flat) is licensed and not committed, so the substitution is the same SHAPE in
// committed items: a variable-depth rect carved by the V, and a cut-out of a simple construction
// rect owned by the flat. Before the fix this job was refused `setup-rest-unavailable` — "a V-bit
// is not a rest cutter here ... remove the later cutter from the setup, or name a flat cutter
// first" — because every later cutter was treated as a rest pass and a cone cannot be measured.
describe('a V-bit followed by a flat that owns its own items (#746)', () => {
  /** The V owns the V-carved plate; the flat owns a cut-out of a construction rect. */
  function signJob(): EngraveJob {
    const base = defaultEngraveJob();
    const plate = rect('plate', 20, 10);
    const outline = {
      id: 'outline',
      name: 'outline',
      kind: 'rect',
      position: { x: 50, y: 30 },
      rotation: 0,
      depth: base.stock.thickness,
      enabled: true,
      width: 60,
      height: 30,
      cornerRadius: 0,
      construction: true,
    } as EngraveShape;
    const trim: EngraveCutout = {
      kind: 'cutout',
      id: 'trim',
      name: 'Outline cut',
      enabled: true,
      of: 'outline',
      side: 'outside',
      inset: 0,
      tabs: { count: 4, width: 3, height: 0.8 },
    };
    return {
      ...base,
      labels: [],
      traces: [],
      toolKey: TOOL_KEY,
      tool: V_TOOL,
      cutOverride: { stepDown: 0.25, stepOver: 0.25 },
      sacrificial: presetPartOnBoard(),
      shapes: [plate, outline],
      cutouts: [trim],
      setups: [
        {
          ...setup('setup-1', ['plate', 'trim'], [TOOL_KEY, FLAT_TOOL.key]),
          toolItems: { [TOOL_KEY]: ['plate'], [FLAT_TOOL.key]: ['trim'] },
        },
      ],
    };
  }

  it('cuts the flat’s cut-out as a cut-out, after the V-carve, and the V’s core in the same file', () => {
    const job = signJob();
    const g = run(job);
    expect(
      g.ok,
      JSON.stringify({
        stage: g.stage,
        errors: g.errors,
        findings: g.findings.filter((f) => f.severity === 'error'),
      }),
    ).toBe(true);
    // The refusal the signed artwork hit must not come back.
    expect(g.findings.filter((f) => f.code === 'setup-rest-unavailable')).toEqual([]);
    const programs = g.programs.filter((p) => (p.kind ?? 'engrave') === 'engrave');
    expect(programs).toHaveLength(2);
    expect(programs[0]!.toolKey).toBe(TOOL_KEY);
    expect(programs[1]!.toolKey).toBe(FLAT_TOOL.key);
    // THE CUT-OUT KEEPS ITS OUTLINE: the flat's file carries the through profile, and the V's file
    // does not. A rest re-planning would have dropped the cut-out (and with it, `through`).
    expect(programs[1]!.through?.cutouts.map((c) => c.id)).toEqual(['trim']);
    expect(programs[0]!.through ?? null).toBeNull();
    // …and the flat still pockets the V-carve's core in the same file, as #677 wrote it.
    expect(programs[1]!.core?.cores.length ?? 0).toBeGreaterThan(0);
    // No rest pass was invented for either cutter.
    expect(g.restPass ?? null).toBeNull();
  }, 120_000);
});

// #472/#746 (bounced) — A REST-ONLY CUTTER AFTER A V-BIT. #486's refusal is about a V-BIT taking
// a rest pass on a region job, not about every later cutter after one. A flat with nothing to
// clean up is skipped with the same `setup-rest-nothing` sentence the flat-first branch uses; it
// is never refused, and the sentence can never read "but null".
describe('a rest-only cutter after a V-bit (#472)', () => {
  const base = (parts: Partial<EngraveJob>): EngraveJob => ({
    ...defaultEngraveJob(),
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: V_TOOL,
    cutOverride: { stepDown: 0.25, stepOver: 0.25 },
    ...parts,
  });

  const engravePrograms = (g: ReturnType<typeof generate>) =>
    g.programs.filter((p) => (p.kind ?? 'engrave') === 'engrave');

  const expectNoRefusal = (g: ReturnType<typeof generate>): void => {
    expect(
      g.ok,
      JSON.stringify({
        stage: g.stage,
        errors: g.errors,
        findings: g.findings.filter((f) => f.severity === 'error'),
      }),
    ).toBe(true);
    expect(g.findings.filter((f) => f.code === 'setup-rest-unavailable')).toEqual([]);
    expect(g.findings.filter((f) => f.message.includes('but null'))).toEqual([]);
  };

  it('lets a flat follow a V that owns only a trace and has no core to clear (#472)', () => {
    const line = lineTrace('line');
    const job = base({
      traces: [line],
      setups: [
        {
          ...setup('setup-1', ['line'], [TOOL_KEY, FLAT_TOOL.key]),
          toolItems: { [TOOL_KEY]: ['line'], [FLAT_TOOL.key]: [] },
        },
      ],
    });
    const g = generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL] });
    expectNoRefusal(g);
    // The V program is the whole job; the flat has nothing to add, so no empty file is posted.
    expect(engravePrograms(g)).toHaveLength(1);
  }, 120_000);

  it('does not refuse a third, rest-only flat after a V and a flat that owns its items (#472)', () => {
    const plate = rect('plate', 20, 10);
    const pocket = { ...rect('pocket', 30, 15, false), name: 'pocket' };
    const job = base({
      shapes: [plate, pocket],
      setups: [
        {
          ...setup('setup-1', ['plate', 'pocket'], [TOOL_KEY, FLAT_TOOL.key, FLAT2_TOOL.key]),
          toolItems: {
            [TOOL_KEY]: ['plate'],
            [FLAT_TOOL.key]: ['pocket'],
            [FLAT2_TOOL.key]: [],
          },
        },
      ],
    });
    const g = generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL, FLAT2_TOOL] });
    expectNoRefusal(g);
    const programs = engravePrograms(g);
    // The V posts first and the owning flat second; the rest-only flat has nothing to clean.
    expect(programs[0]!.toolKey).toBe(TOOL_KEY);
    expect(programs[1]!.toolKey).toBe(FLAT_TOOL.key);
  }, 120_000);

  it('does not refuse a third, rest-only flat after a V trace and an owning flat (#472)', () => {
    const line = lineTrace('line');
    const pocket = { ...rect('pocket', 30, 15, false), name: 'pocket' };
    const job = base({
      traces: [line],
      shapes: [pocket],
      setups: [
        {
          ...setup('setup-1', ['line', 'pocket'], [TOOL_KEY, FLAT_TOOL.key, FLAT2_TOOL.key]),
          toolItems: {
            [TOOL_KEY]: ['line'],
            [FLAT_TOOL.key]: ['pocket'],
            [FLAT2_TOOL.key]: [],
          },
        },
      ],
    });
    const g = generate(tl, job, null, [], undefined, { tools: [FLAT_TOOL, FLAT2_TOOL] });
    expectNoRefusal(g);
    expect(engravePrograms(g).map((p) => p.toolKey)).toEqual([TOOL_KEY, FLAT_TOOL.key]);
  }, 120_000);
});
