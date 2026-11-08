/**
 * #1059 — A SQUARE BAR IN THE CHUCK IS THE STOCK THE SWEEPER MODELS, not its ⌀ envelope.
 *
 * The indexed route (faces, corner removal) sweeps on the EXACT engine. `PartSpec` has modelled a
 * block in the chuck since #777 — `{kind:'cylinder', diameter: <envelope>, length,
 * section: {kind:'rect', width, height}}` — and the job path passes the section
 * (`jobSetup.ts` `toSetup`), but `stockFromSetup` read only `diameter`: a 44.5 mm square swept as
 * a ⌀62.93 rod. The volume read the envelope (πR²L instead of W·H·L), the top read 31.47 instead
 * of the block's 22.25, and a face cut at Z 22.25 started in air — the "wrong but green" the
 * issue's item 2 warns about.
 *
 * RED at m1-land8 7b7665265: the solid is the round envelope (stock volume ≈ 311,000 mm³ against
 * the block's 198,025; result top 31.47 against 22.25).
 *
 * The panther's stock (maintainer, 2026-11-07): hardwood **44.5 mm square**, envelope ⌀62.93, and
 * the first rotary op is the indexed corner removal, so this stock is the one that must sweep.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stockFromSetup, sweepTimeline, type SweepResult } from '@/workers/geometry/sweep';
import { generateIndexed, type IndexedSpec } from '@/engine/cnc/cam/indexed';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { buildTimeline, parseGcode, stubSetup, Z1, type Setup } from '@/engine/cnc';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';

const SIDE = 44.5;
const LENGTH = 100;
/** The block's flat, as a radius at A 0 — NOT the envelope (31.47). */
const HALF = SIDE / 2;
const SECTION = { kind: 'rect' as const, width: SIDE, height: SIDE };
/** The turned envelope a four-jaw scroll turns on: the section's diagonal. */
const ENVELOPE_D = Math.hypot(SIDE, SIDE);
const STOCK = { kind: 'cylinder' as const, diameter: ENVELOPE_D, length: LENGTH, section: SECTION };
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: SIDE, stickout: LENGTH };
const setup = (): Setup => stubSetup(STOCK, HOLD);

const WIDE: Tool = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
const PARAMS: CutParams = { rpm: 12000, feed: 800, plungeFeed: 200, stepDown: 1, stepOver: 1, peck: 1, air: true };
const ctx = (): PostContext => ({
  jobName: 'block fixture',
  stock: { length: LENGTH, width: SIDE, thickness: SIDE },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
});

function dispose(s: SweepResult): void {
  s.stock.delete();
  s.result.delete();
  s.removal?.delete();
  for (const cp of s.perCheckpoint) cp?.delete();
  for (const g of s.gouges) g.solid.delete();
}

describe('#1059 a square bar sweeps as the block it is', () => {
  it('stockFromSetup builds the section’s box about the axis: 44.5 × 44.5, top at 22.25', () => {
    const st = stockFromSetup(tl, setup());
    if ('severity' in st) throw new Error(st.message);
    const bb = st.stock.boundingBox();
    st.stock.delete();
    // The rotary work origin is ON THE AXIS (`stubSetup`): X 0 is the stock's start, Y/Z are the
    // section about the axis.
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(LENGTH, 6);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(SIDE, 6);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(SIDE, 6);
    // The block's top face is its half-height; the envelope radius (31.47) is air above it.
    expect(st.topZ).toBeCloseTo(HALF, 6);
  }, 120_000);

  it('an indexed face cut on the block sweeps the square stock, not a ⌀62.9 rod', () => {
    // The flat's own surface radius drives the CAM here (the square face at A 0 is at 22.25);
    // the CAM's chord math for a block is the next slice — this fixture only needs a program that
    // cuts the block's top face at the depth it states.
    const spec: IndexedSpec = {
      radius: HALF,
      faces: [{ a: 0, fromX: 8, toX: LENGTH - 5, depth: 1 }],
      tool: WIDE,
      params: PARAMS,
      rapid: Z1.rapidEstimate,
    };
    const ir = generateIndexed(spec);
    expect(ir.frame).toBe('rotary');
    const posted = postZ1(ir, ctx(), Z1);
    if (!posted.ok) throw new Error(`the post refused the indexed program: ${posted.errors.join('; ')}`);
    const timeline = buildTimeline(parseGcode(posted.text), setup());
    expect(timeline.summary.rotary).toBe(true);
    expect(timeline.summary.rotaryClass).toBe('indexed');
    expect(timeline.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const out = sweepTimeline(tl, timeline, spec.tool, setup());
    if (!out.ok) throw new Error(`the sweep refused the indexed program: ${JSON.stringify(out.diagnostics)}`);
    const s = out.value;
    // THE STOCK THE SWEEP ACTUALLY SWEPT IS THE BLOCK. 44.5 × 44.5 × 100 = 198,025 mm³ exactly;
    // at the base this read the ⌀62.93 envelope (≈311,000 mm³) and the result's top stood at
    // 31.47 — a round solid under a square job.
    expect(s.stats.stockVolume).toBeCloseTo(SIDE * SIDE * LENGTH, 3);
    expect(s.stats.resultVolume).toBeCloseTo(s.stats.stockVolume - s.stats.removedVolume, 6);
    // The shallow face cut left the block's top standing at its half-height all round.
    expect(s.result.boundingBox().max[2]).toBeCloseTo(HALF, 3);
    dispose(s);
  }, 240_000);

  it('a section with no width or height is refused by name, not swept', () => {
    const bad = stubSetup({ ...STOCK, section: { kind: 'rect', width: 0, height: SIDE } }, HOLD);
    const st = stockFromSetup(tl, bad);
    if (!('severity' in st)) {
      st.stock.delete();
      throw new Error('a zero-width section was accepted');
    }
    expect(st.severity).toBe('error');
    expect(st.code).toBe('stock-invalid');
    expect(st.message).toContain('section');
  }, 120_000);
});
