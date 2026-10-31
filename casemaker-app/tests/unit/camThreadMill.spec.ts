// #445 (#434 phase 2) — thread milling: the ISO 261 geometry, the pass radii, the helical path,
// the refusals, and the settings (shop defaults, then a catalogue row). One program per tool.
//
// The `thread.*` shop defaults are NOT registered yet (the coordinator lands the nine seeds), so
// every case here passes its settings EXPLICITLY. That is the shape `camDrillBit.spec.ts` uses for
// the parts it pins, and it keeps the module's own `readDefault` the only fallback owner: there is
// no duplicate constant in `threadMill.ts` for a test to accidentally agree with.

import { describe, expect, it } from 'vitest';
import {
  chordsPerTurn,
  planThreadMill,
  threadGeometry,
  threadMillIR,
  threadSettings,
  type ThreadMillInput,
  type ThreadSettings,
} from '@/engine/cnc/cam/threadMill';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1 } from '@/engine/cnc/post/z1';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { FASTENERS } from '@/engine/compiler/fasteners';

/** The eight numbers, at the plan's seeds — chosen placeholders, passed rather than read. */
const S: ThreadSettings = {
  radialStepoverMm: 0.2,
  entryRampMm: 0.5,
  bottomClearancePitches: 1,
  pilotTipClearanceMm: 0.5,
  feed: 300,
  plungeFeed: 100,
  spindleRpm: 10000,
  chordToleranceMm: 0.01,
};

/** A 4 mm thread mill: smaller than M5's ⌀4.134 pilot and wide enough for its radial depth. */
const MILL: Tool = {
  ...flatEndMill(4, { name: '4 mm thread mill', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 4, diameter: 4, fluteLength: 20 }),
};
const STOCK = { length: 40, width: 30 };

const input = (over: Partial<ThreadMillInput> = {}): ThreadMillInput => ({
  tool: MILL,
  position: [15, 12],
  size: 'M5',
  depth: 5,
  through: false,
  settings: S,
  stock: STOCK,
  ...over,
});

const plan = (over: Partial<ThreadMillInput> = {}) => {
  const r = planThreadMill(input(over));
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
};

/** The helix's feed moves: cutting at `settings.feed`, not the plunge/ramp at `plungeFeed`. */
const helix = (moves: ReturnType<typeof plan>['moves']) => moves.filter((m) => m.kind === 'feed' && m.f === S.feed);
const radiusOf = (m: { x: number; y: number }, c: readonly [number, number]) => Math.hypot(m.x - c[0], m.y - c[1]);

describe('#445 the thread geometry is ISO 261, from the one table', () => {
  it('M3 and M5: major, pitch and basic minor D1 = D − 1.0825P', () => {
    expect(threadGeometry('M3')).toEqual({ major: 3, pitch: 0.5, minor: FASTENERS.M3.minor });
    expect(threadGeometry('M5')).toEqual({ major: 5, pitch: 0.8, minor: FASTENERS.M5.minor });
    expect(threadGeometry('M5').minor).toBeCloseTo(5 - 1.0825 * 0.8, 4);
  });
});

describe('#445 the pass radii D3', () => {
  it('a 4.0 mm cutter in M5 takes three passes at 0.1 / 0.3 / 0.5 mm, innermost first', () => {
    expect(plan().passRadii.map((r) => Math.round(r * 1000) / 1000)).toEqual([0.1, 0.3, 0.5]);
  });

  it('the last pass lands the tooth on the major radius: rFinal = (D − d)/2', () => {
    const p = plan();
    expect(p.passRadii[p.passRadii.length - 1]).toBeCloseTo((p.major - p.cuttingDiameter) / 2, 9);
    expect(p.passRadii[p.passRadii.length - 1]! * 2 + p.cuttingDiameter).toBeCloseTo(p.major, 9);
  });

  it('the innermost never starts outside the pilot: rMin = (D1 − d)/2', () => {
    const p = plan();
    expect(p.passRadii[0]).toBeGreaterThanOrEqual((p.minor - p.cuttingDiameter) / 2 - 1e-9);
  });
});

describe('#445 the helical path D3, linear only', () => {
  // ONE pass, so `moves` is one entry, one helix and one exit: the path assertions do not have to
  // separate three orbits at 0.1 / 0.3 / 0.5 mm.
  const p = plan({ settings: { ...S, radialStepoverMm: 0.5 } });
  const h = helix(p.moves);
  const c = p.position;

  it('the helix orbits at the pass radius and rises exactly one pitch per revolution', () => {
    expect(h.length).toBeGreaterThan(12);
    for (const m of h) expect(radiusOf(m, c)).toBeCloseTo(0.5, 9); // the only pass, on the major
    // The angular step is `totalAngle/segments`; a turn's worth of moves rises P. Assert the LOCAL
    // slope from consecutive moves instead of hunting for a move exactly on 2π.
    const turns = p.tipDepth / p.pitch;
    const dTheta = (2 * Math.PI * turns) / h.length;
    for (let i = 1; i < h.length; i++) {
      expect((h[i]!.z - h[i - 1]!.z) / dTheta).toBeCloseTo(p.pitch / (2 * Math.PI), 9);
    }
    // ...and the whole run is `turns` revolutions, rising the tip depth back to the top face.
    expect(h[h.length - 1]!.z).toBeCloseTo(0, 9);
    expect(h[0]!.z).toBeGreaterThan(-p.tipDepth);
  });

  it('the helix starts at the bottom and rises monotonically — G1 upcuts the thread', () => {
    for (let i = 1; i < h.length; i++) expect(h[i]!.z).toBeGreaterThanOrEqual(h[i - 1]!.z - 1e-12);
  });

  it('the chord sagitta never exceeds `thread.chordToleranceMm`', () => {
    const r = 0.5;
    const turns = p.tipDepth / p.pitch;
    const dTheta = (2 * Math.PI * turns) / h.length;
    const sagitta = r * (1 - Math.cos(dTheta / 2));
    expect(sagitta).toBeLessThanOrEqual(S.chordToleranceMm);
    // Not absurdly conservative either: at least a dozen chords per turn (the floor).
    expect(h.length / turns).toBeGreaterThanOrEqual(12);
  });

  it('the OUTER edge of the orbit is never past the major radius', () => {
    for (const m of h) expect(radiusOf(m, c) + p.cuttingDiameter / 2).toBeLessThanOrEqual(p.major / 2 + 1e-9);
  });

  it('every move at the axis stays inside the pilot — the entry and the plunge never touch it', () => {
    // The cutter is smaller than the pilot's diameter, so anywhere it sits at the axis it is clear;
    // the first two moves (the hop and the top) are exactly there, and so is the plunge.
    expect(p.cuttingDiameter).toBeLessThan(p.minor);
    expect(radiusOf(p.moves[0]!, c)).toBe(0);
    expect(radiusOf(p.moves[1]!, c)).toBe(0);
    expect(p.moves.some((m) => m.kind === 'feed' && radiusOf(m, c) === 0)).toBe(true);
  });

  it('every rapid below HOP_Z moves Z alone (the verifier’s rule 9)', () => {
    for (let i = 1; i < p.moves.length; i++) {
      const m = p.moves[i]!;
      if (m.kind !== 'rapid' || m.z >= HOP_Z) continue;
      const prev = p.moves[i - 1]!;
      expect([m.x, m.y]).toEqual([prev.x, prev.y]);
    }
  });

  it('the entry ramp descends from the plunge depth to the tip depth, and `entryRampMm = 0` is flat', () => {
    const ramp = p.moves.find((m) => m.kind === 'feed' && m.f === S.plungeFeed && radiusOf(m, c) > 0)!;
    expect(ramp.z).toBeCloseTo(-p.tipDepth, 9);
    const before = p.moves[p.moves.indexOf(ramp) - 1]!;
    expect(before.z).toBeCloseTo(-(p.tipDepth - S.entryRampMm), 9);

    const flat = plan({ settings: { ...S, entryRampMm: 0 } });
    const entry = flat.moves.find((m) => m.kind === 'feed' && m.f === S.plungeFeed)!;
    expect(entry.z).toBeCloseTo(-flat.tipDepth, 9);
  });

  it('the tip runs `bottomClearancePitches` pitches below the last full thread and ends at SAFE_Z', () => {
    expect(p.runOut).toBeCloseTo(0.8, 9);
    expect(p.tipDepth).toBeCloseTo(5.8, 9);
    expect(p.moves[p.moves.length - 1]).toMatchObject({ kind: 'rapid', z: SAFE_Z });
  });

  it('chordsPerTurn: floored at 12, and smaller on a tighter tolerance', () => {
    expect(chordsPerTurn(0.5, 10)).toBe(12); // a huge tolerance still gets a dozen chords
    expect(chordsPerTurn(0.5, 0.01)).toBeGreaterThan(12);
    expect(chordsPerTurn(0.5, 0.001)).toBeGreaterThan(chordsPerTurn(0.5, 0.01));
  });
});

describe('#445 refusals name the number', () => {
  const reason = (over: Partial<ThreadMillInput>) => {
    const r = planThreadMill(input(over));
    return r.ok ? null : r.reason;
  };

  it('a cutter that is not a thread mill', () => {
    expect(reason({ tool: flatEndMill(4) })).toMatch(/not a thread mill/);
  });

  it('a thread mill with no cutting diameter', () => {
    expect(reason({ tool: { ...MILL, tipDiameter: null, diameter: null } })).toMatch(/no cutting diameter/);
  });

  it('a through thread, until the #213/#218 gate lands', () => {
    expect(reason({ through: true })).toMatch(/through thread/);
  });

  it('no depth', () => {
    expect(reason({ depth: 0 })).toMatch(/no depth/);
  });

  it('a cutter too wide for the pilot', () => {
    expect(reason({ size: 'M3' })).toMatch(/cannot enter/); // ⌀4.0 into an ⌀2.459 hole
  });

  it('a cutter too narrow to span the radial depth', () => {
    expect(reason({ tool: { ...MILL, tipDiameter: 0.3, diameter: 0.3 } })).toMatch(/radial depth/);
  });

  it('a thread whose major rim leaves the stock posts: the edge cuts air, informed (#786 slice 1 part 2)', () => {
    expect(reason({ position: [1, 12] })).toBeNull();
  });

  it('a thread deeper than the stated flute', () => {
    expect(reason({ depth: 30 })).toMatch(/flute/);
  });

  it('a non-positive radial step-over is refused rather than looping forever', () => {
    expect(reason({ settings: { ...S, radialStepoverMm: 0 } })).toMatch(/radialStepoverMm/);
  });
});

describe('#445 the settings: shop defaults, then the catalogue D6', () => {
  /** The exact eight entries a landed seed set will hold — supplied, because none is registered. */
  const DEFAULTS = {
    'thread.radialStepoverMm': { value: 0.2, source: 'seeded' },
    'thread.entryRampMm': { value: 0.5, source: 'seeded' },
    'thread.bottomClearancePitches': { value: 1, source: 'seeded' },
    'thread.pilotTipClearanceMm': { value: 0.5, source: 'seeded' },
    'thread.feed': { value: 300, source: 'seeded' },
    'thread.plungeFeed': { value: 100, source: 'seeded' },
    'thread.spindleRpm': { value: 10000, source: 'seeded' },
    'thread.chordToleranceMm': { value: 0.01, source: 'seeded' },
  } as unknown as ShopDefaults;

  it('reads all eight thread.* keys and labels their source', () => {
    const r = threadSettings(DEFAULTS, [], 'pla', MILL, Z1);
    expect(r.settings).toEqual(S);
    expect(Object.values(r.sources).every((s) => s === 'seeded')).toBe(true);
  });

  it('a catalogue row for THIS cutter and material replaces feed, plunge and spindle only', () => {
    const id = '123456';
    const tool = { ...MILL, id };
    const row: FeedCatalogueRow = { cutterId: id, material: 'ABS', rpm: 8000, feed: 250, plungeFeed: 80, stepDown: 0.5 };
    const r = threadSettings(DEFAULTS, [row], 'abs', tool, Z1);
    expect(r.settings.feed).toBe(250);
    expect(r.settings.plungeFeed).toBe(80);
    expect(r.settings.spindleRpm).toBe(8000);
    // The six geometric numbers are never in a catalogue row.
    expect(r.settings.radialStepoverMm).toBe(S.radialStepoverMm);
    expect(r.settings.entryRampMm).toBe(S.entryRampMm);
    expect(r.settings.bottomClearancePitches).toBe(S.bottomClearancePitches);
    expect(r.settings.pilotTipClearanceMm).toBe(S.pilotTipClearanceMm);
    expect(r.settings.chordToleranceMm).toBe(S.chordToleranceMm);
    expect(r.sources.feed).toBe('catalogue: ABS');
    expect(r.sources.radialStepoverMm).toBe('seeded');
  });

  it('a row the machine REFUSES is not adopted: the seeds stay and the refusal is an error', () => {
    const id = '123456';
    const tool = { ...MILL, id };
    const row: FeedCatalogueRow = { cutterId: id, material: 'ABS', rpm: 90000, feed: 90000, plungeFeed: 90000, stepDown: 0.5 };
    const r = threadSettings(DEFAULTS, [row], 'abs', tool, Z1);
    expect(r.settings.feed).toBe(S.feed);
    expect(r.settings.spindleRpm).toBe(S.spindleRpm);
    expect(r.sources.feed).toBe('seeded');
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('a catalogue that cannot vouch for the cutter leaves the labelled seeds in place', () => {
    const r = threadSettings(DEFAULTS, [], 'pla', MILL, Z1); // no vendor id: unlisted
    expect(r.settings).toEqual(S);
    expect(r.diagnostics).toEqual([]);
  });
});

describe('#445 the posted program passes the verifier', () => {
  const p = plan({ depth: 5 });
  const ir = threadMillIR({
    ...input({ depth: 5 }),
    descriptor: 'Thread "port" M5',
    labelId: 'thr-1',
    air: true,
    rapid: Z1.rapidEstimate,
  });
  if (!ir.ok) throw new Error(ir.reason);

  it('names the operation with its tool and thread, and carries the tip depth', () => {
    const op = ir.ir.operations[0]!;
    expect(op.name).toBe('[T1]Thread "port" M5 5.0mm');
    expect(op.labelId).toBe('thr-1');
    expect(op.depth).toBeCloseTo(p.tipDepth, 9);
    expect(ir.ir.frame).toBe('flat');
    expect(ir.ir.spindleRpm).toBe(S.spindleRpm);
  });

  it('posts as G1 helix moves and every check is clean', () => {
    const posted = postZ1(ir.ir, { jobName: 'threads', stock: { ...STOCK, thickness: 8 }, materialName: 'PLA', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:thread-4' }, Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    expect(posted.text).not.toMatch(/G0?2\b|G0?3\b/); // linear-only IR: no arcs on the wire
    const setup = stubSetup({ kind: 'prism', outline: rectProfile(40, 30), thickness: 8 }, { kind: 'tape-down', contact: rectProfile(40, 30) }, { startingTool: 1 }, Z1);
    const report = verifyProgram(posted.text, { setup, machine: Z1, tool: MILL, depthLimit: stockDepthLimit({ ...STOCK, thickness: 8 }, 1), minRapidZ: HOP_Z });
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-p.tipDepth, 3);
  });
});
