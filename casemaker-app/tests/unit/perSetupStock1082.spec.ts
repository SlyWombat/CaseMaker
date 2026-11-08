/**
 * #1082 — PER-SETUP STOCK, RED-FIRST (the manager's ruling: derived, operator-confirmed).
 *
 * The vendor flip's side 2 cuts the freed part. The document gains an OPTIONAL stock on a setup;
 * absent is the job's blank (every earlier document byte-identical). A flipped setup without one
 * derives the box from side 1's freed extents — the design silhouette the plan cut — with the
 * measured thickness when the house has it; a stated box wins, and `provenance` says which.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { derivedSetupStock, measuredBlankThickness, setupStockFor, stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { setupStockOf } from '@/engine/cnc/cam/model/plan';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

/** A blank 120×160×28 whose side 1 frees a 106×136 part; setup 2 is the vendor flip. */
function flipJob(): EngraveJob {
  const base = defaultEngraveJob();
  const setup2 = {
    id: 'setup-flip',
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'tape' as const },
    itemIds: ['part'],
    tools: [],
    flip: { method: 'free-then-flip' as const, axis: 'left-right' as const },
  } as unknown as JobSetup;
  return {
    ...base,
    stock: { ...base.stock, length: 120, width: 160, thickness: 28 },
    labels: [],
    shapes: [
      { id: 'part', name: 'Part', kind: 'rect', position: { x: 60, y: 80 }, rotation: 0, width: 106, height: 136, depth: 6, cornerRadius: 3, enabled: true },
    ],
    setups: [setup2],
  } as unknown as EngraveJob;
}

describe('#1082 a setup’s own stock', () => {
  it('a setup-stated box round-trips, and a document without one keeps every key it had', () => {
    const job = flipJob();
    const withStock = {
      ...job,
      setups: [{ ...job.setups![0]!, stock: { length: 106, width: 136, thickness: 25, provenance: 'stated' as const } }],
    };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(withStock)));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.job.setups![0]!.stock).toEqual({ length: 106, width: 136, thickness: 25, provenance: 'stated' });
    const plain = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    if (!plain.ok) throw new Error(plain.errors.join('\n'));
    expect(plain.job.setups![0]!.stock).toBeUndefined();
    // Byte-identical: a document with no setup stock serialises without the key.
    expect(JSON.stringify(plain.job.setups)).not.toContain('"stock"');
  });

  it('a flipped setup DERIVES the freed part’s box — extents from side 1, measured thickness when known', () => {
    // RED at the parent: no resolver existed and the schema stripped the field.
    expect(derivedSetupStock(flipJob(), 25)).toEqual({ length: 106, width: 136, thickness: 25, provenance: 'derived' });
    // No house measurement → the blank's stated thickness.
    expect(derivedSetupStock(flipJob(), null)).toMatchObject({ length: 106, width: 136, thickness: 28, provenance: 'derived' });
  });

  it('#1082 stage 2 — toSetup builds the part from the SETUP’s stock, not the blank', () => {
    const job = flipJob();
    // The resolver hands a caller the setup's box; the engine part must be that box.
    const box = stockForSetup(job, 0, 25);
    expect(box).toEqual({ length: 106, width: 136, thickness: 25 });
    const setup = toSetup(job, Z1, undefined, null, box);
    expect(setup.part.kind).toBe('prism');
    if (setup.part.kind !== 'prism') return;
    expect(setup.part.thickness).toBe(25);
    const bb = aabbOfProfile(setup.part.outline);
    if (bb === null) throw new Error('the part outline has bounds');
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(106, 6);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(136, 6);
    // A caller with no setup stock gets the blank, exactly as before.
    const blank = toSetup(job, Z1);
    if (blank.part.kind !== 'prism') return;
    expect(blank.part.thickness).toBe(28);
    const bbb = aabbOfProfile(blank.part.outline);
    if (bbb === null) throw new Error('the blank outline has bounds');
    expect(bbb.max[0] - bbb.min[0]).toBeCloseTo(120, 6);
    expect(bbb.max[1] - bbb.min[1]).toBeCloseTo(160, 6);
    // No setups at all → the blank.
    expect(stockForSetup({ ...job, setups: undefined } as EngraveJob, 0, 25)).toEqual({ length: 120, width: 160, thickness: 28 });
  });

  it('#1082 stage 2 — the model plan reads a setup’s own stock box', () => {
    const input = { stock: { length: 120, width: 160, thickness: 28, material: 'hardwood' } };
    const own = { frame: {} as never, underside: 'flatOnStockBottom' as const, stock: { length: 106, width: 136, thickness: 25 } };
    expect(setupStockOf(input, own)).toEqual({ length: 106, width: 136, thickness: 25 });
    const blank = { frame: {} as never, underside: 'flatOnStockBottom' as const };
    expect(setupStockOf(input, blank)).toEqual({ length: 120, width: 160, thickness: 28 });
  });

  it('#1082 stage 2 — the depth limit follows the setup’s own thickness', () => {
    const job = flipJob(); // blank 120×160×28
    const at = (t?: number) => jobDepthLimit(job, undefined, undefined, undefined, t)(60, 80);
    const blank = at();
    const part = at(25);
    if (blank === null || part === null) throw new Error('the fixture has a depth limit');
    // The limit is the depth available below the top: a thinner setup stock bounds it shallower.
    expect(part).toBeLessThan(blank);
    expect(part).toBe(25);
    expect(blank).toBe(28);
  });

  it('#1082 stage 2 — THE VENDOR-FLIP FIXTURE: every seam reads setup 2 as the freed part', () => {
    // Setup 1 cuts a 106×136 part from a 120×160×28 blank; setup 2 is the flip, its stock the part.
    const base = flipJob();
    const setup1 = { ...base.setups![0]!, flip: undefined } as unknown as JobSetup;
    const setup2 = {
      ...base.setups![0]!,
      stock: { length: 106, width: 136, thickness: 25, provenance: 'stated' as const },
    } as unknown as JobSetup;
    const job = { ...base, setups: [setup1, setup2] } as unknown as EngraveJob;

    // 1. the engine part (toSetup) is the part's box on setup 2, the blank on setup 1;
    for (const [index, want] of [[0, { length: 120, width: 160, thickness: 28 }], [1, { length: 106, width: 136, thickness: 25 }]] as const) {
      const box = stockForSetup(job, index, null);
      expect(box).toEqual(want);
      const setup = toSetup(job, Z1, undefined, null, box);
      if (setup.part.kind !== 'prism') throw new Error('the fixture is a prism job');
      expect(setup.part.thickness).toBe(want.thickness);
      const bb = aabbOfProfile(setup.part.outline);
      if (bb === null) throw new Error('the part outline has bounds');
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(want.length, 6);
      expect(bb.max[1] - bb.min[1]).toBeCloseTo(want.width, 6);
    }
    // 2. the model plan's per-setup box;
    expect(setupStockOf({ stock: { ...job.stock } }, { frame: {} as never, underside: 'flatOnStockBottom', stock: { length: 106, width: 136, thickness: 25 } })).toEqual({
      length: 106,
      width: 136,
      thickness: 25,
    });
    // 3. the depth limit follows setup 2's 25 mm;
    const limitAt = (t: number) => jobDepthLimit(job, undefined, undefined, undefined, t)(60, 80);
    expect(limitAt(25)).toBe(25);
    expect(limitAt(28)).toBe(28);
  });

  it('#1082 stage 2 — the measured thickness is the surface touch less the bracket seat', () => {
    // The SAME two datums #1073's side-2 Z0 reads; the difference is the blank's measured thickness.
    expect(measuredBlankThickness({ datums: { surfaceTopZ: { value: -48.2 }, bracketSeatZ: { value: -72.4 } } })).toBeCloseTo(24.2, 6);
    // Either datum missing, or a non-positive difference, is no measurement at all.
    expect(measuredBlankThickness({ datums: { surfaceTopZ: { value: -48.2 }, bracketSeatZ: null } })).toBeNull();
    expect(measuredBlankThickness({ datums: { surfaceTopZ: null, bracketSeatZ: { value: -72.4 } } })).toBeNull();
    expect(measuredBlankThickness(null)).toBeNull();
    // And the derived box takes it when the caller has it.
    expect(derivedSetupStock(flipJob(), 24.2)).toMatchObject({ thickness: 24.2, provenance: 'derived' });
  });

  it('the resolver: the STATED box wins; a non-flip setup has none', () => {
    const job = flipJob();
    const stated = { length: 100, width: 130, thickness: 24, provenance: 'stated' as const };
    expect(setupStockFor(job, { stock: stated, flip: job.setups![0]!.flip }, 25)).toEqual(stated);
    expect(setupStockFor(job, { stock: undefined, flip: job.setups![0]!.flip }, 25)).toMatchObject({ length: 106, width: 136, provenance: 'derived' });
    expect(setupStockFor(job, { stock: undefined, flip: undefined }, 25)).toBeNull();
  });
});
