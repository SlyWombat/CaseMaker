/**
 * #865 — A LATER PROGRAM'S OWN FINDINGS. A rest pass whose V flank ends above the design's floor
 * is planned at the cone's height (the rest regions carry the depth the REST tool can reach), and
 * nothing said so: j20's 90° chamfer rested a 6 mm pocket at 1.5375 mm while the report carried
 * only the design's own warnings. The generator now raises that shortfall on the rest program and
 * tags every program after the first with the file it belongs to.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { probeResiduals } from '@/engine/cnc/probePlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { engravabilityFindings, type LabelEngravability } from '@/workers/sim/engraveGeometry';
import { restJobFor } from '@/engine/cnc/engrave/restPass';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm flat', fluteLength: 20 });
/** The demo's 90° chamfer: its cone is (3.175 − 0.1) / 2 = 1.5375 mm tall. */
const V: Tool = {
  ...flatEndMill(3.175, { name: 'Chamfer 90°', fluteLength: null }),
  shape: 'chamfer',
  typeText: 'Chamfer',
  tipDiameter: 0.1,
  angle: 90,
  halfAngle: null,
};
const FLAT_KEY = 'inv:flat-3.175-865';
const V_KEY = 'inv:chamfer-90-865';
/** A 1 mm flat like j20's rest: no shoulder or flute stated, so the holder cannot be proven. */
const FINE: Tool = flatEndMill(1, { name: '1 mm flat', fluteLength: null, shoulderLength: null });
const FINE_KEY = 'inv:flat-1-865';
const ENTRIES: ToolLibraryEntry[] = [
  { key: FLAT_KEY, tool: { ...FLAT, id: FLAT_KEY, number: 1 }, provenance: 'test' },
  { key: V_KEY, tool: { ...V, id: V_KEY, number: 2 }, provenance: 'test' },
  { key: FINE_KEY, tool: { ...FINE, id: FINE_KEY, number: 3 }, provenance: 'test' },
];

/** The same raised field, rested by a finer FLAT instead of the V. */
function raisedFlatRestJob(): EngraveJob {
  const job = raisedJob();
  return {
    ...job,
    setups: job.setups!.map((setup) => ({
      ...setup,
      tools: [FLAT_KEY, FINE_KEY],
      toolItems: { [FLAT_KEY]: ['clear'], [FINE_KEY]: [] },
    })),
  };
}

/** A raised M in a 6 mm cutaway — the j20 shape, small enough for a unit test. */
function raisedJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [
      {
        id: 'm',
        text: 'M',
        font: base.labels[0]?.font ?? 'serif-default',
        weight: 'bold',
        size: 18,
        position: { x: 30, y: 30 },
        rotation: 0,
        depth: 6,
        enabled: true,
        construction: true,
      },
    ],
    shapes: [
      {
        id: 'field',
        kind: 'rect',
        position: { x: 30, y: 30 },
        rotation: 0,
        depth: 6,
        enabled: true,
        width: 40,
        height: 30,
        cornerRadius: 2,
        construction: true,
      },
    ],
    combined: [
      {
        id: 'clear',
        kind: 'cutaway',
        position: { x: 30, y: 30 },
        rotation: 0,
        depth: 6,
        enabled: true,
        outer: 'field',
        islands: ['m'],
      },
    ],
    toolKey: FLAT_KEY,
    tool: { ...FLAT, id: FLAT_KEY, number: 1 },
    stock: { ...base.stock, length: 60, width: 60, thickness: 12, material: 'pla' },
    setups: [
      {
        id: 'setup-1',
        orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
        mount: { kind: 'vise' },
        itemIds: ['clear'],
        tools: [FLAT_KEY, V_KEY],
        toolItems: { [FLAT_KEY]: ['clear'], [V_KEY]: [] },
      },
    ],
  } as EngraveJob;
}

describe('#865 a later program’s own findings', () => {
  it('states the rest V’s depth shortfall, tagged with its program', async () => {
    const g = await generate(tl, raisedJob(), null, [], undefined, { tools: ENTRIES });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);
    expect(g.programs[1]!.toolKey).toBe(V_KEY);
    // The design says 6 mm; the chamfer's cone ends at 1.5375. The rest program says so, tagged as
    // program 2 — the same sentence the design-level finding uses, attributed to the file it is.
    const short = g.findings.filter((f) => f.code === 'vcarve-depth-beyond-cone');
    expect(short).toHaveLength(1);
    expect(short[0]!.message).toMatch(/^program 2 \(/);
    expect(short[0]!.message).toContain('6 mm deep');
    expect(short[0]!.message).toContain('1.538 mm');
    // The program carries its own untagged finding too, so a consumer that reads the file alone
    // (the receipt's per-program block) sees it.
    expect(g.programs[1]!.findings?.some((f) => f.code === 'vcarve-depth-beyond-cone')).toBe(true);
  }, 180_000);

  it('the panel’s preview carries the later program’s finding too', async () => {
    const job = raisedJob();
    const previewer = createEngravePreviewer(tl);
    const preview = previewer.engravePreview(job, ENTRIES, [], 1, effectiveMargins(job, MARGIN_DEFAULTS), new Map(), undefined, probeResiduals(null));
    expect(preview).not.toBeNull();
    const short = preview!.findings.find((f) => f.code === 'vcarve-depth-beyond-cone');
    expect(short?.message).toMatch(/^program 2 \(/);
    expect(short?.message).toContain('6 mm deep');
  }, 180_000);

  it('a normal rest pair carries no area-loss finding on program 2', async () => {
    // The rest regions are the first program's leftovers, named "rest of …" — their outline was
    // never the design, so "loses N % of its area" is true of every rest pass. The verifier's own
    // findings still apply.
    const g = await generate(tl, raisedFlatRestJob(), null, [], undefined, { tools: ENTRIES });
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.programs).toHaveLength(2);
    const areaLoss = new Set(['item-detail-lost', 'item-chars-lost', 'item-empty']);
    expect((g.programs[1]!.findings ?? []).some((f) => areaLoss.has(f.code))).toBe(false);
    expect(
      g.findings.some((f) => /^program 2 \(/.test(f.message) && areaLoss.has(f.code)),
      JSON.stringify(g.findings.map((f) => f.message)),
    ).toBe(false);
    // The suppression is keyed on the `restRegion` marker the rest job sets, never on the display
    // name; the sweep's holder gate (`holder-unproven`, a SIMULATION diagnostic) and the verifier's
    // findings are untouched.

    expect(g.programs[1]!.nc).toContain('rest of');
  }, 180_000);

  it('keys the suppression on the rest marker, not the name: a user’s "rest of …" is judged normally', async () => {
    const base = defaultEngraveJob();
    const userVector: NonNullable<EngraveJob['vectors']>[number] = {
      kind: 'vector',
      id: 'user-vector',
      sourceName: 'rest of the panel.svg',
      contours: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      fillRule: 'EvenOdd',
      width: 10,
      height: 10,
      position: { x: 30, y: 30 },
      rotation: 0,
      depth: 0.5,
      enabled: true,
    };
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      combined: [],
      vectors: [userVector],
      toolKey: FLAT_KEY,
      tool: { ...FLAT, id: FLAT_KEY, number: 1 },
    };
    const rows: LabelEngravability[] = [
      { labelId: 'user-vector', glyphArea: 100, openedArea: 50, ratio: 0.5, emptyChars: [], outsideArea: 0, polygons: [] },
    ];
    const findings = engravabilityFindings(job, rows, () => 0.5, FLAT);
    expect(findings.some((f) => f.code === 'item-detail-lost')).toBe(true);
    // The marker is what the rest job sets, and the document keeps it through the schema.
    const restJob = restJobFor(
      { ...job, vectors: [userVector] },
      [{ id: 'r1', depth: 2, polygons: [[[10, 10], [20, 10], [20, 20], [10, 20]]] }],
      FLAT_KEY,
    );
    expect(restJob.vectors?.[0]?.restRegion).toBe(true);
    const parsed = parseEngraveJob(restJob);
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    if (parsed.ok) expect(parsed.job.vectors?.[0]?.restRegion).toBe(true);
    // A user's vector has no marker, so the suppression cannot claim it.
    expect(userVector.restRegion).toBeUndefined();
  }, 180_000);

  it('does not repeat a design-level finding on a later program', async () => {
    const g = await generate(tl, raisedJob(), null, [], undefined, { tools: ENTRIES });
    // Every finding appears once: a later program's copy of an identical sentence is dropped, and
    // the tagged later ones are the only programme-tagged entries.
    const keys = g.findings.map((f) => `${f.code}|${f.labelId ?? ''}|${f.message}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(g.findings.some((f) => /^program 1 \(/.test(f.message))).toBe(false);
  }, 180_000);
});
