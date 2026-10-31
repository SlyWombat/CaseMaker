/**
 * #786 slice 4c-2 — THE CATALOGUE'S RECORD OF THE SAME CUTTER FILLS A BLANK TIP OR REACH, AND THE
 * TOOLPATH USES IT.
 *
 * A cutter carrying Makera's `g_ID` is the same physical bit the catalogue row describes. When the
 * operator's own record leaves the tip or the flute blank, the catalogue's number is filled in —
 * and `engraveRegions`/`engraveGenerate` cut with the filled tool, so the V-width in the program is
 * the tip the sentence names (not the sharp point the blank would otherwise assume). The info
 * `tool-geometry-from-catalogue` says which record supplied which number.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { withCatalogueValues } from '@/engine/cnc/engrave/catalogueTool';
import { engraveGenerate, engraveRegions } from '@/workers/sim/engraveGenerate';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { Z1 } from '@/engine/cnc/machine';
import type { CutParams } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

/** The house's own 30° engraver: its tip and flute are NOT recorded, but it carries Makera's id. */
const ID = '9000000000001001';
const USER_ENGRAVER: Tool = flatEndMill(3.175, {
  id: ID,
  name: '30° engraver',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: null,
  diameter: 3.175,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  cornerRadius: null,
});

/** Makera's catalogue row for that same id: a 0.2 mm tip and a 12 mm flute. */
const CAT_ENGRAVER: Tool = flatEndMill(3.175, {
  id: ID,
  name: 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.2mm',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.2,
  diameter: 3.175,
  angle: 30,
  halfAngle: 15,
  fluteLength: 12,
  cornerRadius: null,
});

const USER_ENTRY: ToolLibraryEntry = { key: 'user:engraver-30', tool: USER_ENGRAVER, provenance: 'test' };
const CAT_ENTRY: ToolLibraryEntry = { key: 'cat:engraver-30', tool: CAT_ENGRAVER, provenance: 'test' };

function vJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    shapes: [
      {
        id: 'plate',
        name: 'plate',
        kind: 'rect',
        position: { x: 20, y: 15 },
        rotation: 0,
        depth: 1,
        enabled: true,
        width: 20,
        height: 10,
        cornerRadius: 0,
      },
    ],
    toolKey: USER_ENTRY.key,
    tool: USER_ENGRAVER,
    cutOverride: { stepDown: 0.2, stepOver: 1.42875 },
  };
}

/** The feeds the V-carve CAM reads; the geometry, not the numbers, is this spec's subject. */
const CAM_PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2, stepOver: 0.2, peck: 1, air: false };

/** The 20 × 10 plate as a CAM region with the variable ladder (`variable: true`). */
function vRegion(tool: Tool): EngraveRegion {
  const design: [number, number][][] = [[[10, 15], [30, 15], [30, 25], [10, 25]]];
  return {
    id: 'plate',
    text: '',
    name: 'plate',
    depth: 1,
    polygons: design,
    vCarve: {
      plane: design,
      floor: design,
      surface: design,
      planeDepth: 1,
      planeRadius: (tool.tipDiameter ?? 0) / 2,
      floorInset: 0,
      surfaceOutset: 0,
      variable: true,
    },
  };
}

describe('#786 4c-2 the catalogue fills a blank record', () => {
  it('fills the tip and the flute from the catalogue row for the same g_ID', () => {
    const out = withCatalogueValues(USER_ENGRAVER, [USER_ENTRY, CAT_ENTRY]);
    expect(out.tool.tipDiameter).toBe(0.2);
    expect(out.tool.fluteLength).toBe(12);
    expect(out.filled.map((f) => [f.field, f.mm])).toEqual([
      ['tip', 0.2],
      ['reach', 12],
    ]);
    // The caller's snapshot is untouched.
    expect(USER_ENGRAVER.tipDiameter).toBeNull();
    expect(USER_ENGRAVER.fluteLength).toBeNull();
  });

  it('fills nothing a stated record states, and nothing without a g_ID', () => {
    // A stated 0 tip is a POINT the operator recorded, not a blank.
    const pointed: Tool = { ...USER_ENGRAVER, tipDiameter: 0 };
    expect(withCatalogueValues(pointed, [USER_ENTRY, CAT_ENTRY]).filled.map((f) => f.field)).toEqual(['reach']);

    // A clone with no vendor id cannot be matched to a catalogue row.
    const anonymous: Tool = { ...USER_ENGRAVER, id: null };
    expect(withCatalogueValues(anonymous, [USER_ENTRY, CAT_ENTRY]).filled).toEqual([]);
  });
});

describe('#786 4c-2 the engine cuts with the catalogue value', () => {
  const regions = (tools: readonly ToolLibraryEntry[] | null) =>
    engraveRegions(tl, vJob(), USER_ENGRAVER, undefined, { tools }, null, []);

  it('engraveRegions uses the catalogue tip, and says where it came from', () => {
    const gen = regions([USER_ENTRY, CAT_ENTRY]);
    expect(gen.tool!.tipDiameter).toBe(0.2);
    expect(gen.tool!.fluteLength).toBe(12);
    const finding = gen.findings.find((f) => f.code === 'tool-geometry-from-catalogue');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('0.2 mm');
    expect(finding?.message).toContain('12 mm');
    expect(finding?.message).toContain(CAT_ENGRAVER.name);
  });

  it('the posted V-carve floor ring is inset by the catalogue tip', () => {
    // The variable ladder traces `design − (tipRadius + level·tanHalf)` at each level (`vCarveLevels`),
    // so the deepest pass's ring is 2·tipRadius narrower than the sharp-point ring. Generate the
    // post's own toolpath with the enriched 0.2 mm tool and with the same tool at 0.5 mm: the
    // floor span must move by exactly 0.3 mm per side pair.
    const enriched = withCatalogueValues(USER_ENGRAVER, [USER_ENTRY, CAT_ENTRY]).tool;
    const bigger: Tool = { ...enriched, tipDiameter: 0.5 };
    const span = (tool: Tool): { dx: number; dy: number } => {
      const ir = generateEngrave(tl, [vRegion(tool)], tool, CAM_PARAMS, Z1.rapidEstimate);
      const feeds = ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
      const minZ = Math.min(...feeds.map((m) => m.z));
      const atFloor = feeds.filter((m) => Math.abs(m.z - minZ) < 1e-6);
      const xs = atFloor.map((m) => m.x);
      const ys = atFloor.map((m) => m.y);
      return { dx: Math.max(...xs) - Math.min(...xs), dy: Math.max(...ys) - Math.min(...ys) };
    };
    const smallSpan = span(enriched);
    const bigSpan = span(bigger);
    expect(smallSpan.dx - bigSpan.dx).toBeCloseTo(0.3, 2);
    expect(smallSpan.dy - bigSpan.dy).toBeCloseTo(0.3, 2);
    // And the span is the closed form: the 20 × 10 design inset by tipRadius + 1 mm·tan 15°.
    const inset = 0.2 / 2 + Math.tan(Math.PI / 12);
    expect(smallSpan.dx).toBeCloseTo(20 - 2 * inset, 1);
    expect(smallSpan.dy).toBeCloseTo(10 - 2 * inset, 1);
  }, 60_000);
});

/** A 90° chamfer whose record states its tip and angle but NOT the body its cone flares to. */
const USER_CHAMFER: Tool = flatEndMill(3.175, {
  id: ID,
  name: '90° chamfer (no base)',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.2,
  diameter: null,
  angle: 90,
  halfAngle: null,
  fluteLength: null,
});

/** Makera's row for the same g_ID: the 3.175 mm body the cone runs into (no tip, no flute). */
const CAT_CHAMFER: Tool = flatEndMill(3.175, {
  id: ID,
  name: 'C1-BIT-CHAMFER-90',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.2,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
  fluteLength: null,
});

const USER_CHAMFER_ENTRY: ToolLibraryEntry = { key: 'user:chamfer-90', tool: USER_CHAMFER, provenance: 'test' };
const CAT_CHAMFER_ENTRY: ToolLibraryEntry = { key: 'cat:chamfer-90', tool: CAT_CHAMFER, provenance: 'test' };
const FLAT_ENTRY: ToolLibraryEntry = {
  key: 'user:flat-1-5-786',
  tool: flatEndMill(1.5, { name: '1.5 mm flat (786)', fluteLength: 20, shoulderLength: 20 }),
  provenance: 'test',
};

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A part's edge: a construction outline, the cut-out that frees it, the chamfer on its edge. */
function chamferJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    shapes: [
      {
        id: 'part',
        name: 'lid',
        kind: 'rect',
        position: { x: 20, y: 15 },
        rotation: 0,
        depth: 1,
        enabled: true,
        width: 20,
        height: 10,
        cornerRadius: 0,
        construction: true,
      },
    ],
    cutouts: [
      { kind: 'cutout', id: 'cut', name: 'lid-out', enabled: true, of: 'part', side: 'outside', inset: 0, tabs: { count: 2, width: 3, height: 1 } },
    ],
    chamfers: [{ kind: 'chamfer', id: 'ch', name: 'lid edge', side: 'outside', width: 0.5, enabled: true, of: 'part' }],
    sacrificial: {
      under: { thickness: base.breakthrough + 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
      sides: { left: null, right: null, front: null, back: null },
      source: 'default',
    },
    toolKey: USER_CHAMFER_ENTRY.key,
    tool: USER_CHAMFER,
    setups: [setup('setup-1', ['ch'], [USER_CHAMFER_ENTRY.key]), setup('setup-2', ['part', 'cut'], [FLAT_ENTRY.key])],
  };
}

describe('#786 slice 6 the catalogue states the cone’s body', () => {
  it('fills a chamfer’s blank diameter from the row for the same g_ID, and nothing else', () => {
    const out = withCatalogueValues(USER_CHAMFER, [USER_CHAMFER_ENTRY, CAT_CHAMFER_ENTRY]);
    expect(out.tool.diameter).toBe(3.175);
    // The tip is the operator's own claim (0.2) and the flute has no catalogue value to take.
    expect(out.filled.map((f) => [f.field, f.mm])).toEqual([['diameter', 3.175]]);
    expect(USER_CHAMFER.diameter).toBeNull();
  });

  it('engraveRegions proves the chamfer’s reach from it, so the finding clears and the sentence names the source', () => {
    const entries = [USER_CHAMFER_ENTRY, CAT_CHAMFER_ENTRY, FLAT_ENTRY];
    const gen = engraveRegions(tl, chamferJob(), USER_CHAMFER, undefined, { tools: entries }, null, []);
    const codes = gen.findings.map((f) => f.code);
    expect(codes).not.toContain('chamfer-reach-unproven');
    const note = gen.findings.find((f) => f.code === 'tool-geometry-from-catalogue');
    expect(note?.severity).toBe('info');
    expect(note?.message).toContain('cutting diameter (3.175 mm)');
    expect(note?.message).toContain(CAT_CHAMFER.name);
  });

  it('Generate posts the chamfer program with the catalogue’s body', () => {
    const entries = [USER_CHAMFER_ENTRY, CAT_CHAMFER_ENTRY, FLAT_ENTRY];
    const job = chamferJob();
    const generated = engraveGenerate(tl, job, USER_CHAMFER, [], null, undefined, { tools: entries });
    const codes = generated.findings.map((f) => f.code);
    expect(codes).not.toContain('chamfer-reach-unproven');
    expect(generated.ok, JSON.stringify(generated.errors ?? [])).toBe(true);
    expect(generated.programs.length).toBeGreaterThan(0);
    // The chamfer's own operation is in the posted toolpath.
    const names = (generated.nc ?? '')
      .split('\n')
      .filter((line) => line.startsWith(';@MKR|TOOLPATH|'))
      .map((line) => line.slice(line.indexOf('name=') + 'name='.length));
    expect(names.some((n) => n.includes('lid edge'))).toBe(true);
  }, 60_000);

  it('without a catalogue row the same record still asks for the diameter', () => {
    const entries = [USER_CHAMFER_ENTRY, FLAT_ENTRY];
    const gen = engraveRegions(tl, chamferJob(), USER_CHAMFER, undefined, { tools: entries }, null, []);
    const ask = gen.findings.find((f) => f.code === 'chamfer-reach-unproven');
    expect(ask?.severity).toBe('error');
    expect(ask?.message).toContain('cutting diameter');
    expect(gen.findings.map((f) => f.code)).not.toContain('tool-geometry-from-catalogue');
  });
});
