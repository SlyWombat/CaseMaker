// #427 — the anchor bracket + top clamps as a modelled mount: sizes from the shop defaults with their
// provenance (none measured), the datum from this machine's anchor, the clamps' and arms' footprints,
// and `clamp-in-path` / `bracket-in-path` on the segment, in the verifier too.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import {
  BRACKET_CALIPER_LIST,
  anchorFrom,
  bracketDatum,
  bracketExpectedSurface,
  bracketMount,
  bracketObstacles,
  bracketSettings,
  clampObstacles,
  clipToRect,
  defaultClampPlacements,
  mountEnvelope,
  mountInPath,
  unfacedBands,
  validateBracketMount,
  type MountObstacle,
  type PathSegment,
} from '@/engine/cnc/mounts';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobMount, jobSetups, toSetup } from '@/engine/cnc/engrave/jobSetup';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import { stockDepthLimit, verifyProgram, type VerifyContext } from '@/engine/cnc/verify';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);
const B = bracketSettings(DEFAULTS);
const PLATE = { x: 100, y: 100, z: 5 };

const CAL: MachineCalibration = {
  machineId: 'Z1',
  frame: { anchor1: [-190.89, -193.83], anchor2Offset: [88.5, 45], toolrackOffset: [48.8, 181], clearanceXY: [-5, -21], clearanceZ: -3, toolrackZ: -60 },
  softEndstop: {} as MachineCalibration['softEndstop'],
  source: 'config-get sd on 192.168.10.43',
  measuredAt: '2026-10-07T18:00:00.000Z',
};

describe('#427 the sizes are the location’s, labelled as defaults', () => {
  it('reads every bracket and clamp size from the shop defaults, none of them measured, each with a note saying so', () => {
    expect(B.read.map((r) => r.source)).toEqual(Array(12).fill('seeded'));
    expect(B.unmeasured).toHaveLength(12);
    for (const r of B.read) expect(r.note, r.key).toMatch(/not (measured|a measurement)/);
    expect(B.settings).toMatchObject({ originOffset: { x: 0, y: 0 }, fitMm: 0.1, armWidth: 10, clamp: { height: 12, reach: 8 } });
    // Every stored size has a line on the caliper list, and the seat (touched, never seeded) too; the
    // clamps' placement in from the corner is a choice, not a size.
    const sizes = B.read.map((r) => r.key).filter((k) => k !== 'clamps.topInFromCornerMm');
    expect(BRACKET_CALIPER_LIST.map((c) => c.key).sort()).toEqual([...sizes, 'bracket.seatMachineZ'].sort());
  });

  it('a measured size replaces the default, and says so', () => {
    const measured = { ...DEFAULTS, 'bracket.armWidthMm': { value: 8.4, source: 'measured' as const, setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: 'calipered' } };
    const b = bracketSettings(measured);
    expect(b.settings.armWidth).toBe(8.4);
    expect(b.unmeasured).not.toContain('bracket.armWidthMm');
    // With no location at all, the labelled fallback — never presented as a measurement.
    expect(bracketSettings(null).read.every((r) => r.source === 'fallback')).toBe(true);
  });
});

describe('#427 the datum: G54 XY from the bracket, Z from the probed top', () => {
  it('takes the anchor from THIS machine’s calibration read, never the vendor default', () => {
    expect(anchorFrom(null, 'Z1')).toMatchObject({ ok: false, reason: expect.stringContaining('calibration has not been read') });
    expect(anchorFrom({ ...CAL, machineId: 'Z1Pro' }, 'Z1')).toMatchObject({ ok: false });
    const a = anchorFrom(CAL, 'Z1');
    if (!a.ok) throw new Error(a.reason);
    expect(a.anchor).toMatchObject({ x: -190.89, y: -193.83 });
    expect(a.anchor.from).toContain('2026-10-07');
    const two = anchorFrom(CAL, 'Z1', 2);
    expect(two.ok && two.anchor).toMatchObject({ x: -102.39, y: -148.83 });
  });

  it('the origin is the anchor plus the bracket’s offset, and says the offset is not measured', () => {
    const a = anchorFrom(CAL, 'Z1');
    if (!a.ok) throw new Error(a.reason);
    const d = bracketDatum(a.anchor, B);
    expect(d).toMatchObject({ x: -190.89, y: -193.83, uncertainty: 0.1 });
    expect(d.from).toContain('a default, not measured');
    const offset = { ...DEFAULTS, 'bracket.originOffsetXMm': { value: 1.2, source: 'measured' as const, setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: null } };
    expect(bracketDatum(a.anchor, bracketSettings(offset))).toMatchObject({ x: -189.69, y: -193.83 });
  });

  it('the surface touch expects the stock on the measured seat — and is refused without one', () => {
    expect(bracketExpectedSurface(DEFAULTS, 5)).toMatchObject({ ok: false, reason: expect.stringContaining('bracket.seatMachineZ') });
    const seated = { ...DEFAULTS, 'bracket.seatMachineZ': { value: -70.2, source: 'measured' as const, setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: 'one touch' } };
    const e = bracketExpectedSurface(seated, 5, 2);
    expect(e).toMatchObject({ ok: true, expectedSurface: { machineZ: -63.2 } });
    // An out-of-bounds seat is not a seat.
    expect(ShopDefaultsSchema.safeParse({ ...seated, 'bracket.seatMachineZ': { ...seated['bracket.seatMachineZ'], value: 3 } }).success).toBe(false);
  });
});

describe('#427 the clamps and the arms', () => {
  const placements = defaultClampPlacements(PLATE, B.settings);
  const clamps = clampObstacles(PLATE, placements, B.settings);

  it('defaults to two clamps on the back edge, named by landmarks', () => {
    expect(placements).toEqual([
      { edge: 'back', at: 22.5 },
      { edge: 'back', at: 77.5 },
    ]);
    expect(clamps.map((c) => c.label)).toEqual([
      'the clamp on the back edge, 15 mm in from the left-hand corner',
      'the clamp on the back edge, 15 mm in from the right-hand corner',
    ]);
    // 8 mm reach onto the plate, 30 mm long, its top 12 above the plate's.
    expect(clamps[0]).toMatchObject({ min: [15, 92], max: [30, 122], topZ: 12 });
    const right = clampObstacles(PLATE, [{ edge: 'right', at: 80 }], B.settings)[0]!;
    expect(right).toMatchObject({ min: [92, 72.5], max: [122, 87.5], label: 'the clamp on the right edge, 12.5 mm in from the back corner' });
  });

  it('the arms are outside the front and left edges, their tops from the bracket’s height', () => {
    const arms = bracketObstacles(PLATE, B.settings);
    expect(arms).toEqual([
      expect.objectContaining({ id: 'bracket-front-arm', min: [-10, -10], max: [100, 0], topZ: 5 }),
      expect.objectContaining({ id: 'bracket-left-arm', min: [-10, -10], max: [0, 100], topZ: 5 }),
    ]);
    // A board under the stock lifts the stock, not the bracket.
    expect(bracketObstacles(PLATE, B.settings, 2)[0]!.topZ).toBe(3);
    const env = mountEnvelope([...arms, ...clamps], B, -PLATE.z);
    expect(env).toMatchObject({ source: 'default', uncertainty: 0.1 });
    expect(env.boxes[2]).toMatchObject({ min: [15, 92, -5], max: [30, 122, 12] });
  });

  it('a clean mount raises only the “not measured” note; bad placements and a long plate are named', () => {
    expect(validateBracketMount(PLATE, placements, B).map((f) => f.code)).toEqual(['mount-unmeasured']);
    const codes = (p: Parameters<typeof validateBracketMount>[1], stock = PLATE) => validateBracketMount(stock, p, B).map((f) => f.code);
    expect(codes([{ edge: 'back', at: 5 }])).toContain('clamp-off-stock');
    expect(codes([{ edge: 'back', at: 40 }, { edge: 'back', at: 50 }])).toContain('clamps-overlap');
    const long = validateBracketMount({ x: 160, y: 100, z: 5 }, defaultClampPlacements({ x: 160, y: 100, z: 5 }, B.settings), B);
    expect(long.find((f) => f.code === 'stock-past-arm')?.text).toContain('front arm 100 mm');
  });
});

describe('#427 clamp-in-path, on the segment', () => {
  const clamps = clampObstacles(PLATE, defaultClampPlacements(PLATE, B.settings), B.settings);
  const arms = bracketObstacles(PLATE, B.settings);
  const opts = { radius: 1.5875, uncertainty: 0.1 };
  const seg = (from: [number, number, number], to: [number, number, number], mode: 'cut' | 'rapid' = 'cut', line = 7): PathSegment => ({ line, mode, from, to });

  it('clips a segment to a rectangle', () => {
    expect(clipToRect([0, 0, 0], [10, 0, 0], [2, -1], [4, 1])).toEqual([0.2, 0.4]);
    expect(clipToRect([0, 5, 0], [10, 5, 0], [2, -1], [4, 1])).toBeNull();
    expect(clipToRect([3, 0, 0], [3, 0, -1], [2, -1], [4, 1])).toEqual([0, 1]); // a plunge inside
  });

  it('a cut that crosses a clamp with no endpoint or midpoint inside it is found', () => {
    const f = mountInPath([seg([0, 96, -0.5], [60, 96, -0.5])], clamps, opts);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ code: 'clamp-in-path', line: 7, obstacleId: 'clamp-1' });
    expect(f[0]!.message).toContain('the clamp on the back edge, 15 mm in from the left-hand corner');
    expect(f[0]!.message).toContain('slide it along the back edge');
  });

  it('a rapid below a clamp’s top is found; one above it, and a path that misses, are not', () => {
    expect(mountInPath([seg([0, 100, 5], [100, 100, 5], 'rapid')], clamps, opts).map((f) => f.obstacleId)).toEqual(['clamp-1', 'clamp-2']);
    expect(mountInPath([seg([0, 100, 12.2], [100, 100, 12.2], 'rapid')], clamps, opts)).toEqual([]);
    // 90 + the tool's radius and the fit stays short of the clamp's nose at 92; 90.5 does not.
    expect(mountInPath([seg([0, 90, -1], [100, 90, -1])], clamps, opts)).toEqual([]);
    expect(mountInPath([seg([0, 90.5, -1], [100, 90.5, -1])], clamps, opts)).toHaveLength(2);
  });

  it('counts the further moves under one finding per obstacle', () => {
    const f = mountInPath([seg([20, 50, -1], [20, 99, -1], 'cut', 3), seg([22, 99, -1], [22, 50, -1], 'cut', 4), seg([24, 50, -1], [24, 99, -1], 'cut', 5)], clamps, opts);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(3);
    expect(f[0]!.message).toContain('(and 2 more moves)');
  });

  it('the bracket’s arms: a move past the left edge below the arm’s top', () => {
    expect(mountInPath([seg([-2, 50, 2], [-2, 60, 2], 'rapid')], arms, opts)[0]).toMatchObject({ code: 'bracket-in-path', obstacleId: 'bracket-left-arm' });
    expect(mountInPath([seg([-2, 50, 6], [-2, 60, 6], 'rapid')], arms, opts)).toEqual([]);
    expect(mountInPath([seg([10, 10, -1], [90, 90, -1])], arms, opts)).toEqual([]);
  });
});

describe('#427 the verifier runs it on the file', () => {
  const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
    setup: stubSetup({ kind: 'prism', outline: rectProfile(100, 100), thickness: 5 }, { kind: 'anchor-bracket', anchor: 1, offset: [0, 0] }, { startingTool: 1 }, Z1),
    machine: Z1,
    tool: flatEndMill(3),
    depthLimit: stockDepthLimit({ length: 100, width: 100, thickness: 5 }, 1),
    minRapidZ: 1,
    mountObstacles: {
      obstacles: [...bracketObstacles(PLATE, B.settings), ...clampObstacles(PLATE, defaultClampPlacements(PLATE, B.settings), B.settings)],
      uncertainty: B.settings.fitMm,
    },
    ...over,
  });
  const prog = (body: string[]) => ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'S12000 M3', ...body, 'G0 Z5', 'M5', 'M332', 'M2'].join('\n');
  const codes = (text: string, c = ctx()) => verifyProgram(text, c).findings.map((f) => f.code);

  it('a clean path past no clamp passes', () => {
    expect(codes(prog(['G0 X10 Y50', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X90 Y50']))).not.toContain('clamp-in-path');
    expect(codes(prog(['G0 X10 Y50', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X90 Y50']))).not.toContain('bracket-in-path');
  });

  it('a cut under a clamp is refused, on its line', () => {
    const text = prog(['G0 X10 Y96', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X60 Y96']);
    const f = verifyProgram(text, ctx()).findings.find((x) => x.code === 'clamp-in-path');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toContain('back edge');
    // Without the mount's obstacles, nothing changes.
    expect(codes(text, ctx({ mountObstacles: undefined }))).not.toContain('clamp-in-path');
  });

  it('a move from a position the program never placed, below the clamps, is reported — never silently left out', () => {
    const clean = verifyProgram(prog(['G0 X10 Y50', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X90 Y50']), ctx()).findings;
    expect(clean.map((f) => f.code)).not.toContain('clamp-unchecked');
    const f = verifyProgram(prog(['G0 Z5', 'G0 X10 Y50', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X90 Y50']), ctx()).findings.find((x) => x.code === 'clamp-unchecked');
    // Line 6 drops to Z 5 straight down (no sideways travel); line 7 then crosses from an XY nobody placed.
    expect(f?.line).toBe(7);
    expect(f?.message).toContain('never placed');
  });

  it('the collet nut: checked against the clamps when its size is known, said plainly when not', () => {
    const body = ['G0 X10 Y85', 'G0 Z1', 'G1 Z-0.5 F300', 'G1 X60 Y85'];
    const long = flatEndMill(3, { stickout: 10 });
    // The tool itself passes 85 + 1.69 short of the clamp's nose at 92 …
    expect(codes(prog(body), ctx({ tool: flatEndMill(3) }))).not.toContain('clamp-in-path');
    // … but its nut, 10 mm up at Z 9.5, is below the clamp's top at 12.
    const blind = verifyProgram(prog(body), ctx({ tool: long })).findings.filter((x) => x.code === 'clamp-unchecked');
    expect(blind.map((x) => x.message).join(' ')).toContain('collet nut comes down to Z 9.500');
    const nut = { ...Z1, holder: { nutDiameter: 16, nutLength: 8, source: 'test' } };
    const hit = verifyProgram(prog(body), ctx({ tool: long, machine: nut })).findings.find((x) => x.code === 'clamp-in-path');
    expect(hit?.message).toContain('the collet nut (10.000 mm above the tip)');
    // A short stick-out keeps the nut above the clamps: nothing to say.
    expect(codes(prog(body), ctx({ tool: flatEndMill(3, { stickout: 20 }), machine: nut }))).not.toContain('clamp-in-path');
  });

  it('a tool with no stated diameter cannot be checked, and says so', () => {
    const blind = flatEndMill(3, { handleDiameter: null, tipDiameter: null, diameter: null });
    expect(codes(prog(['G0 X10 Y50']), ctx({ tool: blind }))).toContain('clamp-unchecked');
  });
});

// #442's #427 item — the boxes above, assembled on the caller's side and carried to the verifier as
// plain data. The worker cannot read the location (it must not import `defaultsClient`), so this is
// the #451 pattern: resolve here, send the answer.
describe('#442 the mount, assembled for a job', () => {
  const STOCK = { x: 100, y: 100, z: 5 };

  it('bracketMount answers only for the bracket — the vise and the tape are held elsewhere', () => {
    // Not an omission: handing a vise job the bracket's arms would refuse every cut near the front
    // and left edges, and a false refusal teaches an operator to ignore the verifier.
    expect(bracketMount(STOCK, 'vise', DEFAULTS)).toBeNull();
    expect(bracketMount(STOCK, 'tape', DEFAULTS)).toBeNull();
  });

  it('bracketMount carries both arms and both clamps, the fit as their uncertainty, and the same boxes as solids', () => {
    const m = bracketMount(STOCK, 'bracket', DEFAULTS)!;
    expect(m.obstacles.map((o) => o.id)).toEqual(['bracket-front-arm', 'bracket-left-arm', 'clamp-1', 'clamp-2']);
    expect(m.uncertainty).toBe(B.settings.fitMm);
    // `Setup.fixture` and `verifyProgram`'s `mountObstacles` read ONE statement of the mount.
    expect(m.fixture.boxes.map((b) => b.id)).toEqual(m.obstacles.map((o) => o.id));
    expect(m.fixture.boxes.map((b) => b.max[2])).toEqual(m.obstacles.map((o) => o.topZ));
    expect(m.fixture.source).toBe('default'); // no bracket size is measured yet
  });

  it('a board under the stock lowers the bracket and the fixture floor, never the clamps', () => {
    const on = bracketMount(STOCK, 'bracket', DEFAULTS, 2)!;
    const off = bracketMount(STOCK, 'bracket', DEFAULTS, 0)!;
    const top = (m: typeof on, id: string) => m.obstacles.find((o) => o.id === id)!.topZ;
    expect(top(on, 'bracket-front-arm')).toBe(top(off, 'bracket-front-arm') - 2);
    expect(top(on, 'clamp-1')).toBe(top(off, 'clamp-1'));
    // The boxes run from the bed — the board is between the bracket and the stock, not under both.
    expect(on.fixture.boxes[0]).toMatchObject({ min: [-10, -10, -7], max: [100, 0, 3] });
  });

  it('jobMount reads the stored first setup, and a job with no setups is the vise', () => {
    const job = defaultEngraveJob();
    expect(jobMount(job)).toBe('vise');
    const [implicit] = jobSetups(job);
    const stored = { ...implicit!, id: 'setup-bracket', mount: { kind: 'bracket' as const, board: false } };
    expect(jobMount({ ...job, setups: [stored] })).toBe('bracket');
  });

  it('toSetup carries the mount’s boxes as the fixture, and the vise’s envelope without one', () => {
    const job = defaultEngraveJob();
    const mount = bracketMount({ x: job.stock.length, y: job.stock.width, z: job.stock.thickness }, 'bracket', DEFAULTS)!;
    expect(toSetup(job, Z1, mount.fixture).fixture).toBe(mount.fixture);
    // ONE mount is in the machine: with no bracket the vise envelope is derived exactly as before.
    const vise = toSetup(job, Z1).fixture!;
    expect(vise.boxes.map((b) => b.id)).toEqual(['vise-fixed-jaw', 'vise-moving-jaw']);
  });
});

// #432 decision 5 — the raster covers the whole top and the verifier is its guard, so a refused skim
// reports the strip it could not face rather than silently shrinking the pass.
describe('#432 the strips a refused skim could not face', () => {
  const clamp: MountObstacle = {
    id: 'clamp-1',
    kind: 'clamp',
    label: 'the clamp on the back edge',
    fix: 'move it clear of the cut',
    min: [0, 54],
    max: [100, 60],
    topZ: 0.5,
  };
  const opts = { radius: 2, uncertainty: 0.5 };

  it('names each strip, grown by the cutter and the fit and clipped to the stock', () => {
    // 54 − (2 + 0.5) = 51.5 to the stock’s edge at 60: an 8.5 mm band, the whole width.
    expect(unfacedBands([clamp], { x: 100, y: 60 }, opts)).toEqual([
      'a 100 mm × 8.5 mm band of the top (the clamp on the back edge stands over it) could not be faced',
    ]);
  });

  it('an obstacle that stands clear of the stock says nothing', () => {
    expect(unfacedBands([{ ...clamp, min: [0, 70], max: [100, 80] }], { x: 100, y: 60 }, { radius: 2, uncertainty: 0.5 })).toEqual([]);
  });
});
