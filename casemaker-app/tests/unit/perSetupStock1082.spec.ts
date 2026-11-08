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
import { derivedSetupStock, setupStockFor, stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { aabbOfProfile } from '@/engine/compiler/profile';
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
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(106, 6);
    expect(bb.max[1] - bb.min[1]).toBeCloseTo(136, 6);
    // A caller with no setup stock gets the blank, exactly as before.
    const blank = toSetup(job, Z1);
    if (blank.part.kind !== 'prism') return;
    expect(blank.part.thickness).toBe(28);
    const bbb = aabbOfProfile(blank.part.outline);
    expect(bbb.max[0] - bbb.min[0]).toBeCloseTo(120, 6);
    expect(bbb.max[1] - bbb.min[1]).toBeCloseTo(160, 6);
    // No setups at all → the blank.
    expect(stockForSetup({ ...job, setups: undefined } as EngraveJob, 0, 25)).toEqual({ length: 120, width: 160, thickness: 28 });
  });

  it('the resolver: the STATED box wins; a non-flip setup has none', () => {
    const job = flipJob();
    const stated = { length: 100, width: 130, thickness: 24, provenance: 'stated' as const };
    expect(setupStockFor(job, { stock: stated, flip: job.setups![0]!.flip }, 25)).toEqual(stated);
    expect(setupStockFor(job, { stock: undefined, flip: job.setups![0]!.flip }, 25)).toMatchObject({ length: 106, width: 136, provenance: 'derived' });
    expect(setupStockFor(job, { stock: undefined, flip: undefined }, 25)).toBeNull();
  });
});
