/**
 * #756 — ACCEPTANCE: the 4-axis "fluidity & starvation" test. A sine wave round a cylinder,
 * finished by a SIMULTANEOUS spiral (A turning continuously while X advances one step-over per
 * turn and Z follows the wave), at a 0.002 mm chordal tolerance, a 0.05 mm step-over and F2000.
 *
 * WHAT SOFTWARE CAN ANSWER, AND WHAT IT CANNOT. The machine's sound and the fingernail test are a
 * bench verdict. What the program asks of the controller is not: this suite measures the line
 * count, the segment lengths, the speed the firmware will actually allow, and the block rate that
 * speed demands — and states where 2000 mm/min breaks down before any data rate does.
 *
 * THE FIRMWARE'S FEED (`/Rotary.md` §1.2, read from the Z1's own `Robot.cpp`): on a move that
 * involves A, F is held as a surface speed over a "perimeter" of 2π·r + 30 mm per turn (r the
 * target's distance from the axis), and every A move is then capped at the axis's own maximum
 * rate — 60 °/s on the shipped config (`Z1.rotary.maxRate`). The emulator does not model this yet;
 * the arithmetic is done here, from the machine profile's own numbers, and the app's missing
 * warning is pinned below.
 *
 * THE CAM. The app has no simultaneous rotary finishing strategy yet (relief on the rotary is
 * #723; a ball on the rotary column engine is R-UI-12). The spiral here is the test's own fixture
 * generator, written out in full, the way #241's fixtures drive the indexed engine — and the
 * program it writes goes through the app's real post, parser, timeline, verifier and sweep.
 * A ⌀3 BALL is refused by the rotary sweep today (pinned); a ⌀3 FLAT is the proxy that runs.
 */
import { describe, expect, it } from 'vitest';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { buildTimeline, parseGcode, stubSetup, Z1, type Setup } from '@/engine/cnc';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { verifyProgram } from '@/engine/cnc/verify';
import { columnSweep } from '@/workers/geometry/columnEngine';
import type { CamMove, CamOperation, ToolpathIR } from '@/engine/cnc/cam/ir';

// ── The part ────────────────────────────────────────────────────────────────────────────────────
const R = 15; // ⌀30 stock
const AMP = 1.5; // wave amplitude, mm (peak to trough 3 mm)
const LOBES = 6; // waves round the circumference
const LAMBDA = 40; // the wave's twist: one full phase along 40 mm of X
const LENGTH = 60;
const STICKOUT = 60;
const FROM_X = 10; // clear of the jaws (the #729 jaw keep-out)
const SPAN = 40; // the finished length, X 10 … 50
const DEG = Math.PI / 180;

/** The wave's radius at stock angle θ (degrees) and X: between R − 2·AMP and R. */
function wave(thetaDeg: number, x: number): number {
  return R - AMP * (1 + Math.sin(LOBES * thetaDeg * DEG + (2 * Math.PI * x) / LAMBDA));
}

// ── The cutting parameters the test asks for ──────────────────────────────────────────────────
/** The test asks for F2000; the Z1's own ceiling is 1200 mm/min, so it runs at the machine's max. */
const ASKED_FEED = 2000;
const FEED = Z1.maxCutFeed; // 1200
const STEP_OVER = 0.05; // mm of X per turn
const CHORD_TOL = 0.002; // mm

/**
 * The angular chord that keeps the path within CHORD_TOL of the wave: the tighter of the base
 * circle's sagitta and the wave's own curvature along θ (its second derivative, a·k² in radians).
 */
const CHORD_DEG = (() => {
  const circle = 2 * Math.acos(1 - CHORD_TOL / R);
  const waveCurv = AMP * LOBES * LOBES; // |d²r/dθ²| max, mm per rad²
  const fromWave = Math.sqrt((8 * CHORD_TOL) / waveCurv);
  return Math.min(circle, fromWave) / DEG;
})();

// ── The cutters ─────────────────────────────────────────────────────────────────────────────────
const FLAT3: Tool = flatEndMill(3, { shoulderLength: 20, fluteLength: 12, name: '3 mm flat end' });
const BALL3: Tool = flatEndMill(3, { shape: 'ball', shoulderLength: 20, fluteLength: 12, name: '3 mm ball nose' });
const TOOL_R = 1.5;

/**
 * The flat's tip Z (radius above the axis) over the point (θ, x): the highest material under its
 * disc, so it never cuts below the wave. A point of the disc at (dx, dy) meets the stock at angle
 * θ + asin(dy/ρ), where it stands ρ·cos(that offset) above the axis.
 */
function flatTipZ(thetaDeg: number, x: number): number {
  let top = -Infinity;
  const n = 6;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const dx = (i / n) * TOOL_R;
      const dy = (j / n) * TOOL_R;
      if (dx * dx + dy * dy > TOOL_R * TOOL_R + 1e-12) continue;
      const rho = wave(thetaDeg, x + dx);
      const off = Math.asin(Math.max(-1, Math.min(1, dy / rho)));
      top = Math.max(top, wave(thetaDeg + off / DEG, x + dx) * Math.cos(off));
    }
  }
  return top;
}

const SAFE = R + 5;

/** The spiral finish: A turns continuously; X advances STEP_OVER per turn; Z follows the wave. */
function spiral(fromX: number, span: number, tool: Tool): ToolpathIR {
  const turns = span / STEP_OVER;
  const totalDeg = turns * 360;
  const steps = Math.ceil(totalDeg / CHORD_DEG);
  const moves: CamMove[] = [{ kind: 'rapid', x: fromX, y: 0, z: SAFE, a: 0 }];
  moves.push({ kind: 'feed', x: fromX, y: 0, z: flatTipZ(0, fromX), f: 300, a: 0 });
  for (let s = 1; s <= steps; s++) {
    const a = (s / steps) * totalDeg;
    const x = fromX + (a / 360) * STEP_OVER;
    moves.push({ kind: 'feed', x, y: 0, z: flatTipZ(a % 360, x), f: FEED, a });
  }
  const last = moves[moves.length - 1]!;
  moves.push({ kind: 'rapid', x: last.x, y: 0, z: SAFE, a: last.a });
  const op: CamOperation = {
    number: 1,
    name: '[T1] rotary spiral finish',
    labelId: '',
    depth: 2 * AMP,
    moves,
    estimatedSeconds: 0,
  };
  return {
    frame: 'rotary',
    rotary: { radius: R },
    tool,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations: [op],
  };
}

const ctx = (): PostContext => ({
  jobName: 'fluidity test',
  stock: { length: LENGTH, width: 2 * R, thickness: 2 * R },
  materialName: 'hardwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
});
const STOCK = { kind: 'cylinder' as const, diameter: 2 * R, length: LENGTH };
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: 40, stickout: STICKOUT };
const setup = (): Setup => stubSetup(STOCK, HOLD, { startingTool: 1 }, Z1);

/**
 * The firmware's own speed on one move (`/Rotary.md` §1.2): F as surface speed over the perimeter
 * 2π·r + 30 mm per turn, then the A axis capped at its max rate. Returns degrees per second.
 */
function firmwareDegPerSec(feedMmMin: number, r: number): { asked: number; allowed: number } {
  const perimeter = r > 1 ? 2 * Math.PI * r + 30 : 2 * Math.PI + 30;
  const asked = (feedMmMin / 60 / perimeter) * 360;
  const cap = Z1.rotary!.maxRate / 60;
  return { asked, allowed: Math.min(asked, cap) };
}

/**
 * The block rate a controller must sustain to hold a speed: moves per second. PLACEHOLDER until
 * the bench measures the Z1's own (issue #756, "Bench part"): Smoothieware-class planners are
 * commonly quoted at a few hundred short blocks per second; this number is NOT the Z1's.
 */
const BLOCK_RATE_PLACEHOLDER = 300;

describe('#756 the program the test asks for — sizes and rates', () => {
  const ir = spiral(FROM_X, SPAN, FLAT3);
  const moves = ir.operations[0]!.moves;
  const posted = postZ1(ir, ctx(), Z1);

  it('F2000 is refused by the post: the Z1 cuts at 1200 mm/min at most', () => {
    const fast: ToolpathIR = {
      ...ir,
      operations: [{ ...ir.operations[0]!, moves: moves.slice(0, 50).map((m) => (m.kind === 'feed' && m.f === FEED ? { ...m, f: ASKED_FEED } : m)) }],
    };
    const out = postZ1(fast, ctx(), Z1);
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.errors[0]).toMatch(/feed 2000 mm\/min is not in \(0, 1200\]/);
  });

  it('posts at the machine maximum: hundreds of thousands of simultaneous X/Z/A lines', () => {
    if (!posted.ok) throw new Error(posted.errors.slice(0, 3).join('; '));
    const lines = posted.text.split('\n').length;
    // 800 turns at a chord of CHORD_DEG: stated, not tuned.
    expect(CHORD_DEG).toBeGreaterThan(0.9);
    expect(CHORD_DEG).toBeLessThan(1.1);
    expect(moves.length).toBeGreaterThan(250_000);
    expect(lines).toBeGreaterThan(moves.length - 10);
    // Every cutting line moves A AND X — truly simultaneous.
    const cutting = moves.filter((m) => m.kind === 'feed').slice(2);
    expect(cutting.every((m, i) => i === 0 || (m.a !== cutting[i - 1]!.a && m.x !== cutting[i - 1]!.x))).toBe(true);
  });

  it('at 1200 mm/min the firmware turns A at 58 °/s — just under its 60 °/s cap', () => {
    const { asked, allowed } = firmwareDegPerSec(FEED, R);
    // 1200 mm/min over a 2π·15 + 30 = 124.2 mm "perimeter".
    expect(asked).toBeCloseTo(57.97, 1);
    expect(allowed).toBeCloseTo(asked, 9);
    // F2000 would have asked for 96.6 °/s: the A cap would have bound first.
    expect(firmwareDegPerSec(ASKED_FEED, R).asked).toBeCloseTo(96.6, 1);
    // The surface speed the wave actually sees at its mean radius: ~820 mm/min, not 1200.
    const surface = allowed * DEG * (R - AMP) * 60;
    expect(surface).toBeGreaterThan(800);
    expect(surface).toBeLessThan(840);
  });

  it('the Z axis, following the wave, needs ~91 % of its 600 mm/min ceiling — the next limit, not the data', () => {
    const { allowed } = firmwareDegPerSec(FEED, R);
    // |dr/dθ| peaks at AMP·LOBES mm per radian; at ω = allowed °/s that is the Z speed demanded.
    const zMmMin = AMP * LOBES * allowed * DEG * 60;
    const zCap = Z1.rapidEstimate.zMmPerMin;
    expect(zCap).toBe(600);
    expect(zMmMin).toBeGreaterThan(530);
    expect(zMmMin).toBeLessThan(zCap);
  });

  it('the block rate stays far under the placeholder planner rate', () => {
    const { allowed } = firmwareDegPerSec(FEED, R);
    const blocksPerSec = allowed / CHORD_DEG;
    // About 58 blocks/s: the A axis, not the data, paces this program on a Z1.
    expect(blocksPerSec).toBeGreaterThan(50);
    expect(blocksPerSec).toBeLessThan(70);
    expect(blocksPerSec).toBeLessThan(BLOCK_RATE_PLACEHOLDER);
    // Run time at the firmware's speed: 800 turns at 6.2 s each.
    const minutes = ((SPAN / STEP_OVER) * (360 / allowed)) / 60;
    expect(minutes).toBeGreaterThan(80);
    expect(minutes).toBeLessThan(85);
  });

  // The design's `feed-at-radius` warning (`/Rotary.md`, the refusal table): when the surface speed
  // falls short of F, or the A cap binds, say so. Not implemented; flips when it is.
  it.fails('#759 — the app warns that the wave sees ~820 mm/min, not the 1200 asked', () => {
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const verified = verifyProgram(posted.text.split('\n').slice(0, 400).join('\n'), {
      setup: setup(),
      machine: Z1,
      tool: FLAT3,
      depthLimit: () => 0,
      minRapidZ: 1,
      rotary: { radius: R, stickout: STICKOUT, tailstock: false },
    });
    expect(verified.findings.some((f) => f.code === 'feed-at-radius')).toBe(true);
  });
});

describe('#756 a 2 mm band of the spiral, simulated against the wave', () => {
  // 40 turns, ~14 000 moves: the full program's own motion over a span the column engine sweeps
  // at a resolution finer than the step-over.
  const BAND_FROM = 28;
  const BAND = 2;

  function pipeline(tool: Tool) {
    const ir = spiral(BAND_FROM, BAND, tool);
    const posted = postZ1(ir, ctx(), Z1);
    if (!posted.ok) throw new Error(posted.errors.join('; '));
    const timeline = buildTimeline(parseGcode(posted.text), setup());
    return { ir, posted, timeline };
  }

  it('posts, parses as a WRAPPED program, and verifies', () => {
    const { posted, timeline, ir } = pipeline(FLAT3);
    expect(timeline.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(timeline.summary.rotaryClass).toBe('wrapped');
    const verified = verifyProgram(posted.ok ? posted.text : '', {
      setup: setup(),
      machine: Z1,
      tool: ir.tool,
      depthLimit: () => 0,
      minRapidZ: 1,
      rotary: { radius: R, stickout: STICKOUT, tailstock: false },
    });
    expect(verified.findings.filter((f) => f.severity === 'error').map((f) => `${f.line} ${f.code}: ${f.message}`)).toEqual([]);
  });

  /** The swept grid against the wave over the band's interior: the worst under- and over-cut. */
  function measure() {
    const { ir, timeline } = pipeline(FLAT3);
    const out = columnSweep(timeline, FLAT3, setup(), { resolution: { dx: 0.025, dThetaDeg: 0.25 } });
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    const g = out.grid;
    const at = (x: number, thetaDeg: number): number => {
      const i = Math.round((x - g.u0) / g.du);
      const j = ((Math.round(thetaDeg / g.dv) % g.nv) + g.nv) % g.nv;
      return g.h[j * g.nu + i] as number;
    };
    let under = 0;
    let over = 0;
    for (let x = BAND_FROM + 0.5; x <= BAND_FROM + BAND - 0.5; x += 0.1) {
      for (let t = 0; t < 360; t += 3) {
        const got = at(x, t);
        const truth = wave(t, x);
        under = Math.max(under, truth - got);
        // The flat rides on the highest point under its disc: the lift it was programmed with.
        over = Math.max(over, got - flatTipZ(t, x));
      }
    }
    // The largest Z change of any one cutting move: what the engine's constant-Z rule can cost.
    const feeds = ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    let moveDz = 0;
    for (let k = 2; k < feeds.length; k++) moveDz = Math.max(moveDz, Math.abs(feeds[k]!.z - feeds[k - 1]!.z));
    return { under, over, moveDz };
  }
  const measured = (() => {
    let cache: ReturnType<typeof measure> | null = null;
    return () => (cache ??= measure());
  })();

  it('the flat proxy follows the programmed tip, and any under-cut is within one move’s Z change', () => {
    const { under, over, moveDz } = measured();
    // One 1° move on this wave changes Z by up to ~0.16 mm.
    expect(moveDz).toBeGreaterThan(0.1);
    expect(moveDz).toBeLessThan(0.2);
    // The engine sweeps each move at min(z0, z1) (#758), so it may show the cut up to one move's
    // ΔZ below the program — never more.
    expect(under).toBeLessThanOrEqual(moveDz + 0.02);
    // And never above the programmed tip beyond the grid's own quantisation.
    expect(over).toBeLessThan(0.05);
  });

  // #758 — the simulation should follow Z along a move; today the swept wave reads ~0.15 mm under.
  it.fails('#758 — the simulated wave is within 0.02 mm of the program (Z interpolated along each move)', () => {
    expect(measured().under).toBeLessThan(0.02);
  });

  it('a ⌀3 BALL is refused by the rotary sweep today (R-UI-12)', () => {
    const { timeline } = pipeline(BALL3);
    const out = columnSweep(timeline, BALL3, setup());
    expect(out.ok).toBe(false);
    const msg = out.ok ? '' : out.diagnostics.map((d) => d.message).join(' ');
    expect(msg).toMatch(/flat end mill only/);
  });
});
