// The program verifier (#174): parse the emitted `.nc` and refuse unsafe output.
//
// NO WASM here. Hand-written programs cover each check, and two committed fixtures cover the
// real thing: `tests/unit/fixtures/default-job.nc` (the default engrave job, posted by #173,
// snapshotted by #213) and `tests/e2e/fixtures/three-strokes.nc` (#199's authored file). Both
// are skipped rather than failed when absent, so a checkout that lacks them stays green.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyProgram, stockDepthLimit, sacrificialDepthLimit, type VerifyContext } from '@/engine/cnc/verify';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile, aabbOfProfile } from '@/engine/compiler/profile';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import {
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
  sacrificialBoxes,
  supportedFootprint,
} from '@/engine/cnc/sacrificial';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NC = join(HERE, 'fixtures', 'default-job.nc');
const THREE_STROKES = join(HERE, '..', 'e2e', 'fixtures', 'three-strokes.nc');

/** The 20 × 10 × 5 test stock; the block's top face is the work Z = 0 datum. */
function ctxFor(over: Partial<VerifyContext> = {}, stock = { length: 20, width: 10, thickness: 5 }): VerifyContext {
  const setup = stubSetup(
    { kind: 'prism', outline: rectProfile(stock.length, stock.width), thickness: stock.thickness },
    { kind: 'tape-down', contact: rectProfile(stock.length, stock.width) },
    { startingTool: 1 },
    Z1,
  );
  return { setup, machine: Z1, tool: flatEndMill(1), depthLimit: stockDepthLimit(stock, 1), minRapidZ: 1, ...over };
}

const codes = (ctx: VerifyContext, text: string): string[] => verifyProgram(text, ctx).findings.map((f) => f.code);
const lineOf = (ctx: VerifyContext, text: string, code: string): (number | null) | undefined =>
  verifyProgram(text, ctx).findings.find((f) => f.code === code)?.line;

/** A minimal valid program: preamble, one tool, spindle on, an opening XY rapid, a plunge. */
function program(body: string[], over: Partial<VerifyContext> = {}): { text: string; ctx: VerifyContext } {
  const text = ['G90 G21', 'T1 M6', 'M7', 'S12000 M3', ...body].join('\n');
  return { text, ctx: ctxFor(over) };
}

describe('cncVerify (#174): the default job and the authored fixture', () => {
  it.skipIf(!existsSync(DEFAULT_NC))('the default engrave job, posted (#173), passes every check', () => {
    const job = defaultEngraveJob();
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (!tool) return;
    const report = verifyProgram(readFileSync(DEFAULT_NC, 'utf8'), {
      setup: toSetup(job, Z1),
      machine: Z1,
      tool,
      depthLimit: stockDepthLimit(job.stock, job.minFloor),
      minRapidZ: HOP_Z,
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats.cuttingMoves).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(THREE_STROKES))('three-strokes.nc (#199) passes on a 60 × 30 × 6 stock', () => {
    const stock = { length: 60, width: 30, thickness: 6 };
    const setup = stubSetup(
      { kind: 'prism', outline: rectProfile(60, 30), thickness: 6 },
      { kind: 'tape-down', contact: rectProfile(60, 30) },
      { startingTool: 1 },
      Z1,
    );
    const report = verifyProgram(readFileSync(THREE_STROKES, 'utf8'), {
      setup,
      machine: Z1,
      tool: flatEndMill(3.175),
      depthLimit: stockDepthLimit(stock, 1),
      minRapidZ: 1,
    });
    expect(report.findings).toEqual([]);
  });
});

describe('cncVerify (#174): the checks', () => {
  it('cut-too-deep: the primary check names the line and the coordinates', () => {
    const { text, ctx } = program(['G0 X5 Y5', 'G1 Z-11.5 F200', 'G1 X10', 'M5', 'M02'], {
      depthLimit: stockDepthLimit({ length: 20, width: 10, thickness: 12 }, 1),
    });
    const report = verifyProgram(text, ctx);
    const f = report.findings.find((x) => x.code === 'cut-too-deep' && x.line === 6);
    expect(f).toBeDefined();
    expect(f?.message).toContain('-11.500');
    expect(f?.message).toContain('5.000');
    expect(report.ok).toBe(false);
  });

  it('cut-outside-stock: a stroke centre at X = 0.3 with a 1 mm cutter is refused at the edge', () => {
    const { text, ctx } = program(['G0 X0.3 Y5', 'G1 Z-1 F200', 'G1 X10', 'M5', 'M02']);
    const findings = verifyProgram(text, ctx).findings.filter((x) => x.code === 'cut-outside-stock');
    expect(findings.length).toBeGreaterThan(0);
    // The edge sits at 0.3 − 0.5 = −0.2, which depthLimit reports as 0 (no cutting allowed).
    expect(findings[0]?.message).toContain('-0.200');
  });

  it('sticky coordinates: G1 X10 after G1 X5 Y5 Z-1 is (10, 5, −1), not (10, 0, 0)', () => {
    const { text, ctx } = program(['G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10', 'M5', 'M02']);
    const report = verifyProgram(text, ctx);
    expect(report.ok).toBe(true);
    // Only the cutting endpoints are fully known (the opening rapid has no Z), so the bbox is
    // exactly the two cuts. A parser that reset the omitted words would read the second as
    // (10, 0, 0) and the box would be min [5, 0, −1], max [10, 5, 0].
    expect(report.stats.bbox).toEqual({ min: [5, 5, -1], max: [10, 5, -1] });
  });

  it('rapid-too-low: G0 X50 at Z = −1 is refused; a pure-Z retract is not', () => {
    const bad = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G0 X50', 'M5', 'M02']);
    expect(lineOf(bad.ctx, bad.text, 'rapid-too-low')).toBe(7);

    const good = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G0 Z5', 'M5', 'M02']);
    expect(codes(good.ctx, good.text)).not.toContain('rapid-too-low');
  });

  it('spindle-off-cut: a G1 Z-1 before M3 is refused', () => {
    const text = ['G90 G21', 'T1 M6', 'M7', 'G0 X5 Y5 Z5', 'G1 Z-1 F200', 'M5', 'M02'].join('\n');
    const ctx = ctxFor();
    expect(codes(ctx, text)).toContain('spindle-off-cut');
  });

  it('not-our-dialect: an arc, a G53, a G91/G92 and an I/J word are all refused', () => {
    const arc = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G2 X10 Y5 I2.5 J0', 'M5', 'M02']);
    expect(codes(arc.ctx, arc.text)).toContain('not-our-dialect');

    const g53 = program(['G53 G0 Z-5', 'M5', 'M02']);
    expect(codes(g53.ctx, g53.text)).toContain('not-our-dialect');

    // The post never writes these; their presence means the file is not ours or the post is broken.
    const g91 = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G91', 'M5', 'M02']);
    expect(codes(g91.ctx, g91.text)).toContain('not-our-dialect');

    const g92 = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G92 X0', 'M5', 'M02']);
    expect(codes(g92.ctx, g92.text)).toContain('not-our-dialect');
  });

  it('not-our-dialect: a ; comment containing G2 raises nothing', () => {
    const { text, ctx } = program(['; G2 is an arc word, but this is a comment', 'G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10', 'M5', 'M02']);
    const report = verifyProgram(text, ctx);
    expect(report.findings.filter((f) => f.code === 'not-our-dialect')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('feed-too-high and feed-missing', () => {
    const high = program(['G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10 F1500', 'M5', 'M02']);
    expect(codes(high.ctx, high.text)).toContain('feed-too-high');

    const missing = program(['G0 X5 Y5', 'G1 Z-1', 'M5', 'M02']);
    expect(codes(missing.ctx, missing.text)).toContain('feed-missing');
  });

  it('rpm-too-high: an S above the machine ceiling', () => {
    const text = ['G90 G21', 'T1 M6', 'M7', 'S20000 M3', 'G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G1 X10', 'G0 Z5', 'M5', 'M02'].join('\n');
    expect(codes(ctxFor(), text)).toContain('rpm-too-high');
  });

  it('bad-preamble: a first motion without G90 and G21', () => {
    const text = ['T1 M6', 'M7', 'S12000 M3', 'G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G1 X10', 'G0 Z5', 'M5', 'M02'].join('\n');
    expect(codes(ctxFor(), text)).toContain('bad-preamble');
  });

  it('bad-ending: dropping M02, or dropping M05, is an error', () => {
    const noEnd = program(['G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10', 'M5']);
    expect(codes(noEnd.ctx, noEnd.text)).toContain('bad-ending');

    const noOff = program(['G0 X5 Y5', 'G1 Z-1 F200', 'G1 X10', 'M02']);
    expect(codes(noOff.ctx, noOff.text)).toContain('bad-ending');
  });

  it('multi-tool: a T2 M6 mid-file is refused', () => {
    const { text, ctx } = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G1 X10', 'G0 Z5', 'T2 M6', 'M5', 'M02']);
    expect(codes(ctx, text)).toContain('multi-tool');
  });

  it('parse-error: a line of garbage fails the whole program', () => {
    const { text, ctx } = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G1 X1e5', 'M5', 'M02']);
    const report = verifyProgram(text, ctx);
    expect(report.ok).toBe(false);
    expect(codes(ctx, text)).toContain('parse-error');
  });

  it('runner-error: a move outside the machine envelope is carried through', () => {
    const { text, ctx } = program(['G0 X5 Y5 Z5', 'G1 Z-1 F200', 'G1 X150', 'G0 Z5', 'M5', 'M02']);
    const f = verifyProgram(text, ctx).findings.find((x) => x.code === 'runner-error');
    expect(f).toBeDefined();
    expect(f?.message).toContain('outside-envelope');
  });

  it('the depth limit is actually consulted: 0 everywhere rejects every cut', () => {
    const { text } = program(['G0 X5 Y5', 'G1 Z-0.5 F200', 'G1 X10', 'M5', 'M02']);
    const report = verifyProgram(text, ctxFor({ depthLimit: () => 0 }));
    expect(report.findings.some((f) => f.code === 'cut-too-deep')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('verifies a 10 000-move program well under 500 ms', () => {
    // PROVISIONAL: five sessions share this machine, so the wall figure is measured under
    // load. The bound is the spec's; the printed number is the observation.
    const body: string[] = ['G0 X5 Y5', 'G0 Z1', 'G1 Z-0.5 F500'];
    for (let i = 0; i < 10000; i++) body.push(`G1 X${1 + (i % 18)} Y${1 + (i % 8)}`);
    const { text } = program([...body, 'G0 Z5', 'M5', 'M02']);
    const ctx = ctxFor({ depthLimit: () => 100 });
    const t0 = performance.now();
    const report = verifyProgram(text, ctx);
    const ms = performance.now() - t0;
    console.log(`[#174] verifyProgram on 10 000 moves: ${ms.toFixed(1)} ms (under load)`);
    expect(report.stats.cuttingMoves).toBeGreaterThanOrEqual(10000);
    expect(ms).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------------------------
// #213: the depth limit over sacrificial material, and the cut-outside-stock rule that reads it.
// ---------------------------------------------------------------------------------------------

describe('sacrificialDepthLimit (#213 §3): the depth table', () => {
  const STOCK = { length: 20, width: 10, thickness: 5 };
  const OPTS = { minFloor: 1, breakthrough: 0.3 };

  it('with no sacrificial material is exactly stockDepthLimit', () => {
    const a = sacrificialDepthLimit(STOCK, noneSacrificial(), OPTS);
    const b = stockDepthLimit(STOCK, OPTS.minFloor);
    for (const [x, y] of [[-1, 5], [0, 0], [10, 5], [19.99, 9.99], [20, 5], [10, 10], [10, 11], [30, -3]] as [number, number][]) {
      expect(a(x, y)).toBe(b(x, y));
    }
  });

  it('over the part is thickness − minFloor; over a flush strip its height; over air 0', () => {
    const limit = sacrificialDepthLimit(STOCK, presetJawStrips(), OPTS); // left+right 6 mm, flush, no board
    expect(limit(10, 5)).toBe(4); // T − minFloor
    expect(limit(-3, 5)).toBe(5); // flush strip height = T
    expect(limit(23, 5)).toBe(5); // right strip
    expect(limit(-7, 5)).toBe(0); // beyond the left strip
    expect(limit(10, 12)).toBe(0); // beyond the part in Y
  });

  it('over board overhang is thickness + breakthrough; the part stays thickness − minFloor without a through-cut', () => {
    const limit = sacrificialDepthLimit(STOCK, presetPartOnBoard(), OPTS); // 12 mm board, 10 mm overhang all round
    expect(limit(10, 5)).toBe(4); // part
    expect(limit(-5, 5)).toBe(5.3); // board overhang
    expect(limit(-5, -5)).toBe(5.3); // board corner
    expect(limit(-11, 5)).toBe(0); // beyond the board
  });

  it('a through-cut makes the part limit thickness + breakthrough, but only with a board', () => {
    const withBoard = sacrificialDepthLimit(STOCK, presetPartOnBoard(), { ...OPTS, through: true });
    expect(withBoard(10, 5)).toBe(5.3);
    const noBoard = sacrificialDepthLimit(STOCK, noneSacrificial(), { ...OPTS, through: true });
    expect(noBoard(10, 5)).toBe(4);
  });

  it('the positive region is exactly supportedFootprint (#213 §3)', () => {
    const s = presetPartOnBoard();
    const limit = sacrificialDepthLimit(STOCK, s, OPTS);
    const { length: L, width: W } = STOCK;
    const boxes = sacrificialBoxes(STOCK, s);
    const inFootprint = (x: number, y: number): boolean =>
      (x >= 0 && x <= L && y >= 0 && y <= W) ||
      boxes.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]);
    for (let x = -12; x <= 32; x += 0.5) {
      for (let y = -12; y <= 22; y += 1) {
        expect(limit(x, y) > 0).toBe(inFootprint(x, y));
      }
    }
    const bb = aabbOfProfile(supportedFootprint(STOCK, s))!;
    expect(bb.min).toEqual([-10, -10]);
    expect(bb.max).toEqual([30, 20]);
  });
});

describe('cut-outside-stock against supportedFootprint (#213 §3)', () => {
  const STOCK = { length: 20, width: 10, thickness: 5 };
  // A stroke from X = 17 to X = 23: it runs 3 mm past the part's right edge at X = 20.
  const PAST_EDGE = ['G90 G21', 'T1 M6', 'M7', 'S12000 M3', 'G0 X17 Y5', 'G1 Z-1 F200', 'G1 X23', 'M5', 'M02'].join('\n');

  it('with no sacrificial material, 3 mm past the edge is refused at the tool edge', () => {
    expect(codes(ctxFor(), PAST_EDGE)).toContain('cut-outside-stock');
  });

  it('with a 6 mm right strip the same stroke passes: the cutter is on sacrificial material, not air', () => {
    const depthLimit = sacrificialDepthLimit(STOCK, presetJawStrips(), { minFloor: 1, breakthrough: 0.3 });
    const report = verifyProgram(PAST_EDGE, ctxFor({ depthLimit }));
    expect(report.findings.filter((f) => f.code === 'cut-outside-stock')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a stroke that leaves the strip too is still cut-outside-stock', () => {
    const depthLimit = sacrificialDepthLimit(STOCK, presetJawStrips(), { minFloor: 1, breakthrough: 0.3 });
    const pastStrip = ['G90 G21', 'T1 M6', 'M7', 'S12000 M3', 'G0 X23 Y5', 'G1 Z-1 F200', 'G1 X30', 'M5', 'M02'].join('\n');
    expect(codes(ctxFor({ depthLimit }), pastStrip)).toContain('cut-outside-stock');
  });
});
