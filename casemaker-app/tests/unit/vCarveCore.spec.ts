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
import type { EngraveJob, EngraveShape, JobSetup } from '@/types/engraveJob';

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
