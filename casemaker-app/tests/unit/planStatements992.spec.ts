/**
 * #992 — THE PLAN'S STATEMENTS REACH THE OPERATOR. Before this, every "stated on the card"
 * ruling was a string in `perSetup[].notes` that only a spec could read: the panel's findings and
 * the run sheet never saw it. The planner now emits typed statements beside its notes, the seam
 * maps `warning`/`info` to JobFindings on the success path, and the run sheet prints the `sheet`
 * ones through its own `sentence()` route.
 *
 * The cases pinned here: the #962 grouping (ONE statement per cause with a count — 40 covered
 * rims are ONE finding with count 40, never 40), the #987 relief statement, and the seam's
 * success-path mapping including the run sheet's own section.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { planCurvedForTree, planPocketsForTree, type PlanCurvedOptions } from '@/engine/cnc/cam/model/plan';
import type { FeatureTree, Rim } from '@/engine/cnc/cam/model/features';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { stlBase64 } from './helpers/meshes';

const tl = await import('@/workers/geometry/ManifoldRuntime').then((m) => m.getToplevel());

const FLAT: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const BALL: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2', fluteLength: 30 }), shape: 'ball', typeText: 'Ball Nose' };
const VBIT: Tool = { ...flatEndMill(3.175, { number: 3, id: 'v90', name: 'V 90', shape: 'chamfer', typeText: 'V-Bit', angle: 90, halfAngle: 45, tipDiameter: 0.1, fluteLength: 30 }), cornerRadius: null };

/** A flat slab at z = 0: its top is one plane, so every fabricated rim on it reads COVERED. */
function slabTree(rims: Rim[]): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const X0 = -10, X1 = 130, Y0 = -10, Y1 = 60;
  const positions = Float32Array.from([
    X0, Y0, 0, X1, Y0, 0, X1, Y1, 0,
    X0, Y0, 0, X1, Y1, 0, X0, Y1, 0,
  ]);
  const geometry = { triangles: { positions, indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), triangleCount: 2, bbox: { min: [X0, Y0, 0] as [number, number, number], max: [X1, Y1, 0] as [number, number, number] } } };
  const footprint: [number, number][][] = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]]];
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -5 },
    levels: [-5],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: -5, frees: true, shoulders: [] },
    pockets: [],
    rims,
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 0, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

function curved(geometry: Parameters<typeof planCurvedForTree>[1]['geometry'], over: Partial<PlanCurvedOptions> = {}): PlanCurvedOptions {
  return {
    geometry,
    offset: makeClipperOffset(tl),
    flat: FLAT,
    ball: BALL,
    vbit: VBIT,
    stepDownMm: 1.5,
    bandMm: 0.3,
    feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
    rapid: Z1.rapidEstimate,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0.5 },
    toolNumberFor: (t) => t.number ?? 1,
    ...over,
  };
}

describe('#992 — the plan states one thing per cause, typed', () => {
  it('40 rims the V stage declines for the same reason are ONE goal-rim-unbroken statement with count 40', async () => {
    const rims: Rim[] = Array.from({ length: 40 }, (_, i) => ({
      id: `rim-${i}`,
      // 1 × 1 mm squares on the flat top: every sample on the air side reads the same surface,
      // so every rim is covered from above.
      polyline: [[i * 3, 0], [i * 3 + 1, 0], [i * 3 + 1, 1], [i * 3, 1], [i * 3, 0]] as [number, number][],
      z: 0,
      of: 'contour' as const,
      kind: 'sharp' as const,
    }));
    const { tree, geometry } = slabTree(rims);
    const result = await planCurvedForTree(tree, curved(geometry));
    const broken = result.statements.filter((s) => s.code === 'goal-rim-unbroken');
    expect(broken).toHaveLength(1);
    const statement = broken[0]!;
    expect(statement.severity).toBe('warning');
    expect(statement.count).toBe(40);
    expect(statement.ids).toHaveLength(40);
    expect(statement.text).toContain('40 rims not broken: covered from above');
    // The dump keeps a line per rim — the detail, never the operator's statement.
    expect(result.notes.filter((n) => n.includes('not broken: covered from above'))).toHaveLength(40);
  }, 120_000);

  // #1192 rule 3 — THE PROPOSAL SCREEN'S COUNT LINE. The receipt prints it as a sheet statement
  // and the same text goes to the run's Log; the numbers are the picker's own (a chain priced is
  // a chain priced, not a sentence reconstructed from the panel).
  it('#1192 — the screen states its counts once, on the sheet and to the Log', () => {
    const { tree } = slabTree([]);
    const mid4 = flatEndMill(4, { number: 2, id: 'flat-4', name: 'flat-4', fluteLength: 30 });
    const small3 = flatEndMill(3.175, { number: 3, id: 'flat-3', name: 'flat-3', fluteLength: 30 });
    const params = (feed: number, stepDown: number): CutParams => ({
      rpm: 12000, feed, plungeFeed: 250, stepDown, stepOver: 1, peck: 0, air: true,
    });
    const byId: Record<string, CutParams> = {
      'flat-6': params(300, 0.5),
      'flat-4': params(1000, 1),
      'flat-3': params(200, 0.5),
    };
    const seen: string[] = [];
    const result = planPocketsForTree(tree, {
      offset: makeClipperOffset(tl),
      houseFlats: [FLAT, mid4, small3],
      paramsFor: (tool) => byId[tool.id ?? ''] ?? params(900, 1.5),
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: Z1.rapidEstimate,
      toolChangeSeconds: 5,
      spindleRpm: 12000,
      air: true,
      proposalTopK: 1,
      proposalMarginPct: 25,
      onScreen: (text) => seen.push(text),
    });
    const lines = result.statements.filter((s) => s.code === 'plan-run' && s.text.startsWith('proposal screen:'));
    expect(lines).toHaveLength(1);
    const text = lines[0]!.text;
    expect(text).toContain('3 chains estimated');
    expect(text).toContain('2 priced');
    expect(text).toContain('incumbent');
    // One text, two readers: the Log gets exactly the sheet's sentence.
    expect(seen).toEqual([text]);
  }, 120_000);

  // #1160 — the badge blank is 0.81 mm thick and the shop's release tab is 1 mm: the contour op
  // clamps the tab to the part's own height (a taller one would put its top above the stock top).
  // A changed number is never silent — the plan says both numbers once.
  it('#1160 — a release tab clamped to a shallow part is stated once, with both numbers', () => {
    const { tree } = slabTree([]);
    tree.frame = { ...tree.frame, partBottom: -0.81 };
    tree.levels = [-0.81];
    tree.contour = { ...tree.contour, zTo: -0.81 };
    const result = planPocketsForTree(tree, {
      offset: makeClipperOffset(tl),
      houseFlats: [FLAT],
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: Z1.rapidEstimate,
      toolChangeSeconds: 5,
      spindleRpm: 12000,
      air: true,
    });
    const lines = result.notes.filter((n) => n.includes("release tabs set to the part's full"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("release tabs set to the part's full 0.81 mm height; the shop's 1 mm tab is taller than the part");
  }, 120_000);

  it('a skirt-closed relief is a goal-relief-edge info, once', () => {    const { tree } = slabTree([]);
    tree.contour = { ...tree.contour, synthetic: true };
    // The relief note lives in the POCKET planner (the synthetic outline is why no contour op is
    // demanded), not the curved pipeline.
    const result = planPocketsForTree(tree, {
      offset: makeClipperOffset(tl),
      houseFlats: [FLAT],
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: Z1.rapidEstimate,
      toolChangeSeconds: 5,
      spindleRpm: 12000,
      air: true,
    });
    const relief = result.statements.filter((s) => s.code === 'goal-relief-edge');
    expect(relief).toHaveLength(1);
    expect(relief[0]!.severity).toBe('info');
    expect(relief[0]!.text).toContain('nothing is freed');
  }, 120_000);
});

/** The goal-path box from goalChamfer3d's fixture: a solid on the stock with sharp top rims. */
function boxStl(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string {
  // The exact winding goalChamfer3d's box fixture uses (consistently outward), so the same
  // `closeOpenSheet`/kernel path reads it as a closed solid.
  const v: [number, number, number][] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  return stlBase64([
    [v[0]!, v[2]!, v[1]!],
    [v[0]!, v[3]!, v[2]!],
    [v[4]!, v[5]!, v[6]!],
    [v[4]!, v[6]!, v[7]!],
    [v[0]!, v[1]!, v[5]!],
    [v[0]!, v[5]!, v[4]!],
    [v[1]!, v[2]!, v[6]!],
    [v[1]!, v[6]!, v[5]!],
    [v[2]!, v[3]!, v[7]!],
    [v[2]!, v[7]!, v[6]!],
    [v[3]!, v[0]!, v[4]!],
    [v[3]!, v[4]!, v[7]!],
  ]);
}

const ENTRIES: ToolLibraryEntry[] = [
  { key: 'inv:flat-6', tool: FLAT, provenance: 'test' },
  { key: 'inv:ball-2', tool: BALL, provenance: 'test' },
  { key: 'inv:v90', tool: VBIT, provenance: 'test' },
];
const SHOP = { tools: ENTRIES, feeds: null };

function goalTarget(): EngraveTargetObject {
  const data = boxStl(0, 0, 0, 10, 10, 5);
  return {
    id: 'g'.repeat(16),
    name: 'statement-box',
    format: 'stl',
    sha256: 'g'.repeat(64),
    data,
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    size: { x: 10, y: 10, z: 5 },
    enabled: true,
    role: 'goal',
  };
}

/** A UV sphere (bottom at z 0), the #982 no-ball fixture: its remainder is curved, so a flat-only
 *  shop must finish it with a flat-raster — the note the acceptance turns on. */
function sphereTarget(r = 8, rings = 10, segs = 20): EngraveTargetObject {
  const at = (i: number, j: number): [number, number, number] => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  const tris: [[number, number, number], [number, number, number], [number, number, number]][] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      tris.push([a, c, b], [a, d, c]); // outward winding, the same convention the sphere fixtures use
    }
  }
  return {
    id: 's'.repeat(16),
    name: 'statement-sphere',
    format: 'stl',
    sha256: 's'.repeat(64),
    data: stlBase64(tris),
    position: { x: 20, y: 20, z: 0 },
    rotation: 0,
    size: { x: 2 * r, y: 2 * r, z: 2 * r },
    enabled: true,
    role: 'goal',
    // A single top setup (no flip plan): the test is about the finish cutter, not the turn-over.
    underside: { kind: 'flat' },
  };
}

/** `stock` lets a case that is not about the blank's size sit clear of the vise jaws (#1117):
 *  these #992 cases are about the plan's statements, not holding, and a near-full blank on the
 *  default vise now — rightly — refuses a freeing contour whose rim is inside the 6 mm shank. */
function goalJob(
  target: EngraveTargetObject,
  tool: Tool = BALL,
  toolKey = 'inv:ball-2',
  stock: Partial<EngraveJob['stock']> = {},
): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    name: 'statements',
    targetObject: target,
    toolKey,
    tool,
    stock: { ...base.stock, length: 40, width: 40, thickness: 20, material: 'hardwood', ...stock },
  };
}

describe('#992 — the seam routes the plan statements', () => {
  it('on the success path: warning/info statements become findings, sheet statements ride the run sheet', async () => {
    try {
      const target = goalTarget();
      // Room from the stock's edge (#1117): the statement seam is what this case pins; on the
      // 40 mm blank the freeing contour's rim sat inside the default vise's 6 mm shank.
      const job = goalJob(target, BALL, 'inv:ball-2', { length: 80, width: 80 });
      const out = await generateGoalProgram(job, target, BALL, null, { shop: SHOP });
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      // A job that asks for no bevel states it as an INFO finding (the planner's own sentence).
      const noEdge = out.findings.find((f) => f.code === 'goal-no-edge-break');
      expect(noEdge, `findings: ${out.findings.map((f) => f.code).join(', ')}`).toBeDefined();
      expect(noEdge!.severity).toBe('info');
      expect(noEdge!.count).toBeGreaterThan(0);
      // This house answers a ⌀6 flat from the largest covered row: the substitution is a WARNING
      // finding now, not a string only the acceptance could see.
      const subst = out.findings.find((f) => f.code === 'goal-cutter-substituted');
      expect(subst, `findings: ${out.findings.map((f) => f.code).join(', ')}`).toBeDefined();
      expect(subst!.severity).toBe('warning');
      // The sheet-class statements are NOT findings; they ride planStatements. (The type system
      // agrees: sheet codes are not members of JobFindingCode — the cast is only to read them.)
      expect(out.planStatements?.some((s) => s.severity === 'sheet')).toBe(true);
      expect(out.findings.some((f) => (f.code as string).startsWith('plan-'))).toBe(false);
      // …and the run sheet prints them in its own section, through `sentence()`.
      const sheet = buildRunSheet(job, out, null);
      const section = sheet.sections.find((s) => s.id === 'plan');
      expect(section, `sections: ${sheet.sections.map((s) => s.id).join(', ')}`).toBeDefined();
      const text = section!.steps.map((s) => s.text).join(' ');
      expect(text).toContain('The curved pipeline follows the ruling');
      // `sentence()` upper-cases the planner's clauses: every sheet line reads as a sentence.
      for (const step of section!.steps) expect(step.text.charAt(0)).toBe(step.text.charAt(0).toUpperCase());
    } finally {
      clearTargetObjectMeshCache();
    }
  }, 180_000);

  it('a stated chamfer with no V chosen: the plan\'s "no edge break" reaches the findings as an info', async () => {
    try {
      // #989's no-toolKey case: the seam hands the rim stage legMm 0 ("the type's own no chamfer
      // program case"), the plan states the rims stay sharp — and #992 makes that statement the
      // operator's info finding, beside #989's own goal-chamfer-no-cutter warning.
      const target = { ...goalTarget(), chamfer: { widthMm: 0.5 } };
      // Room from the stock's edge (#1117), as the success-path case above.
      const job = goalJob(target, BALL, 'inv:ball-2', { length: 80, width: 80 });
      const out = await generateGoalProgram(job, target, BALL, null, { shop: SHOP });
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      const noEdge = out.findings.find((f) => f.code === 'goal-no-edge-break');
      expect(noEdge, `findings: ${out.findings.map((f) => f.code).join(', ')}`).toBeDefined();
      expect(noEdge!.severity).toBe('info');
      const cant = out.findings.find((f) => f.code === 'goal-chamfer-no-cutter');
      expect(cant, `findings: ${out.findings.map((f) => f.code).join(', ')}`).toBeDefined();
    } finally {
      clearTargetObjectMeshCache();
    }
  }, 180_000);

  it('no flat in the shop: the run warns that the part is not freed (count 1)', async () => {
    try {
      // A curved solid (the sphere) with a house that holds no flat end mill at all: #982's
      // ball-as-primary dispatch plans the surface but no freeing contour either — "no flat, so
      // the part isn't freed" is a WARNING, on a run that still posts.
      const target = sphereTarget();
      const job = goalJob(target);
      const shop = { tools: [{ key: 'inv:ball-2', tool: BALL, provenance: 'test' as const }, { key: 'inv:v90', tool: VBIT, provenance: 'test' as const }], feeds: null };
      const out = await generateGoalProgram(job, target, BALL, null, { shop });
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      const freed = out.findings.find((f) => f.code === 'goal-not-freed');
      expect(freed, `findings: ${out.findings.map((f) => f.code).join(', ')}`).toBeDefined();
      expect(freed!.severity).toBe('warning');
      expect(freed!.count).toBe(1);
      expect(freed!.message).toContain('not freed');
    } finally {
      clearTargetObjectMeshCache();
    }
  }, 180_000);

  it('no ball in the shop: the flat finishes the curved remainder — a warning finding, and the run sheet names it', async () => {
    try {
      const target = sphereTarget();
      const job = goalJob(target, FLAT, 'inv:flat-6');
      const shop = { tools: [{ key: 'inv:flat-6', tool: FLAT, provenance: 'test' as const }], feeds: null };
      const out = await generateGoalProgram(job, target, FLAT, null, { shop });
      expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
      const subst = out.findings.find((f) => f.code === 'goal-cutter-substituted' && f.message.includes('no ball nose'));
      expect(subst, `findings: ${out.findings.map((f) => `${f.code}: ${f.message}`).join(' | ')}`).toBeDefined();
      expect(subst!.severity).toBe('warning');
      expect(subst!.message).toContain('finished by the flat-6 as a flat-raster');
      // The run sheet's §8 prints warning findings — this is where the operator reads which
      // cutter actually finishes the curved surface.
      const sheet = buildRunSheet(job, out, null);
      const warnings = sheet.sections.find((s) => s.id === 'warnings');
      expect(warnings, `sections: ${sheet.sections.map((s) => s.id).join(', ')}`).toBeDefined();
      const text = warnings!.steps.map((s) => s.text).join(' ');
      expect(text).toContain('finished by the flat-6 as a flat-raster');
    } finally {
      clearTargetObjectMeshCache();
    }
  }, 180_000);
});
