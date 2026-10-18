// #434 phase 1 — peck drilling with a drill bit: the point length, the tip depth for blind and through
// holes, the pecks (pure Z, full retracts), the angle's source, the refusals — and the posted program
// passes the verifier. The numbers come from the location's shop defaults (chosen, or placeholders).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { drillBitIR, drillSettings, planDrillBit, pointLength, type DrillBitInput } from '@/engine/cnc/cam/drillBit';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1 } from '@/engine/cnc/post/z1';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = ShopDefaultsSchema.parse((JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults);
const { settings: S, sources } = drillSettings(DEFAULTS);

const DRILL: Tool = { ...flatEndMill(2), name: '2 mm drill', typeText: 'Drill', shape: 'drill', angle: null, tipDiameter: 2, diameter: 2, cornerRadius: null };
const STOCK = { length: 40, width: 30, thickness: 6 };
const input = (over: Partial<DrillBitInput> = {}): DrillBitInput => ({
  tool: DRILL,
  holes: [
    [30, 20],
    [10, 10],
    [30, 10],
  ],
  depth: { kind: 'blind', fullDiameterDepth: 3 },
  settings: S,
  pointAngleSource: sources.pointAngleDeg,
  stock: STOCK,
  ...over,
});

describe('#434 the settings are the location’s', () => {
  it('reads every drill.* key, seeded and labelled — the feeds as placeholders', () => {
    expect(S).toEqual({ peckDiameters: 1, peckClearanceMm: 0.5, pointAngleDeg: 118, plungeFeed: 100, spindleRpm: 10000 });
    expect(Object.values(sources).every((v) => v === 'seeded')).toBe(true);
    expect(DEFAULTS['drill.plungeFeed']?.note).toContain('placeholder, not measured; not a vendor number');
    expect(DEFAULTS['drill.pointAngleDeg']?.note).toContain('chosen, not measured');
  });
});

describe('#434 the point and the depth', () => {
  it('the tip is a point length below the full diameter: (d/2) / tan(angle/2)', () => {
    expect(pointLength(2, 118)).toBeCloseTo(1 / Math.tan((59 * Math.PI) / 180), 9);
    expect(pointLength(3, 90)).toBeCloseTo(1.5, 9);
  });

  it('blind: the tip goes a point length past the full-diameter depth; the angle says where it came from', () => {
    const r = planDrillBit(input());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.pointLength).toBe(0.601);
    expect(r.plan.tipDepth).toBe(3.601);
    expect(r.plan.angle.from).toContain('drill.pointAngleDeg');
    const stated = planDrillBit(input({ tool: { ...DRILL, angle: 135 } }));
    expect(stated.ok && stated.plan.angle).toEqual({ deg: 135, from: '2 mm drill\'s own record' });
  });

  it('through: the full diameter clears the underside by the breakthrough', () => {
    const r = planDrillBit(input({ depth: { kind: 'through', thickness: 6, breakthroughMm: 0.5 } }));
    expect(r.ok && r.plan.tipDepth).toBe(7.101);
  });
});

describe('#434 the pecks', () => {
  it('pecks one diameter at a time, retracting fully to clear chips, back to just above the last floor; every cut pure Z', () => {
    const r = planDrillBit(input({ holes: [[10, 10]] }));
    if (!r.ok) throw new Error(r.reason);
    const zs = r.plan.moves.map((m) => `${m.kind[0]}${m.z}`);
    // 3.601 deep in 2 mm pecks: −2, then −3.601.
    expect(zs).toEqual(['r1', 'r0', 'f-2', `r${HOP_Z}`, 'r-1.5', 'f-3.601', 'r1', 'r5']);
    for (const m of r.plan.moves) if (m.kind === 'feed') expect([m.x, m.y, m.f]).toEqual([10, 10, 100]);
  });

  it('drills the holes nearest first, from the origin', () => {
    const r = planDrillBit(input());
    expect(r.ok && r.plan.holes).toEqual([
      [10, 10],
      [30, 10],
      [30, 20],
    ]);
  });
});

describe('#434 refusals', () => {
  it('a flat end mill, no diameter, a strange point angle, no holes, a hole off the stock', () => {
    expect(planDrillBit(input({ tool: flatEndMill(2) }))).toMatchObject({ ok: false, reason: expect.stringContaining('flat end mill is not the cutter for a drilled hole') });
    expect(planDrillBit(input({ tool: { ...DRILL, tipDiameter: null, diameter: null } }))).toMatchObject({ ok: false, reason: expect.stringContaining('no diameter') });
    expect(planDrillBit(input({ tool: { ...DRILL, angle: 30 } }))).toMatchObject({ ok: false, reason: expect.stringContaining('not a drill') });
    expect(planDrillBit(input({ holes: [] }))).toMatchObject({ ok: false });
    expect(planDrillBit(input({ holes: [[0.5, 10]] }))).toMatchObject({ ok: false, reason: expect.stringContaining('runs off') });
  });
});

describe('#434 posted and verified', () => {
  const post = (r: ReturnType<typeof drillBitIR>) => {
    if (!r.ok) throw new Error(r.reason);
    const p = postZ1(r.ir, { jobName: 'holes', stock: STOCK, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:kz-drill-2' }, Z1);
    if (!p.ok) throw new Error(p.errors.join('; '));
    return p.text;
  };
  const setup = stubSetup({ kind: 'prism', outline: rectProfile(40, 30), thickness: 6 }, { kind: 'tape-down', contact: rectProfile(40, 30) }, { startingTool: 1 }, Z1);
  const ir = (over: Partial<DrillBitInput> = {}) => drillBitIR({ ...input(over), name: '[T1]Holes', labelId: 'holes', air: true, rapid: Z1.rapidEstimate });

  it('a blind job posts with no canned cycle and passes every check', () => {
    const text = post(ir());
    expect(text).not.toMatch(/G8[13]/);
    const report = verifyProgram(text, { setup, machine: Z1, tool: DRILL, depthLimit: stockDepthLimit(STOCK, 1), minRapidZ: HOP_Z });
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-3.601, 3);
  });

  it('a through job passes onto a board below, and is refused by the verifier where there is none', () => {
    const text = post(ir({ depth: { kind: 'through', thickness: 6, breakthroughMm: 0.5 } }));
    const onBoard = verifyProgram(text, { setup, machine: Z1, tool: DRILL, depthLimit: () => 8, minRapidZ: HOP_Z });
    expect(onBoard.findings).toEqual([]);
    const bare = verifyProgram(text, { setup, machine: Z1, tool: DRILL, depthLimit: stockDepthLimit(STOCK, 1), minRapidZ: HOP_Z });
    expect(bare.findings.map((f) => f.code)).toContain('cut-too-deep');
  });
});
