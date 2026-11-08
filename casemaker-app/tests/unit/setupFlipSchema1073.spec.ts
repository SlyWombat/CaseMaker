// #1073 — THE FLIP CHOICE'S DATA MODEL. A flipped setup stores exactly what the operator chose —
// `flip: { method, axis }` — and the blank states which of its corners are square in the Holding
// step (`stock.squareCorners`). Everything derived (which corner lands in the fence, whether it is
// square) is computed where it is printed, never stored.
//
// Both fields are OPTIONAL and never defaulted: a document written before them parses and
// re-serialises with its exact shape (no key gained), which is what keeps stored jobs
// byte-identical.
//
// RED at m1-land8: the schema strips unknown keys, so a stated `flip` and `squareCorners` are
// silently lost on load.
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

function setup(over: Partial<JobSetup> = {}): JobSetup {
  return {
    id: 'setup-2',
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'tape', board: true },
    itemIds: ['item-1'],
    tools: ['inv:flat-6'],
    ...over,
  };
}

function jobWithout(extra: (j: EngraveJob) => EngraveJob): unknown {
  return extra(defaultEngraveJob());
}

describe('#1073 the flip choice parses and round-trips', () => {
  it('a flipped setup keeps its method and axis', () => {
    const job = jobWithout((j) => ({
      ...j,
      setups: [setup({ id: 'setup-1' }), setup({ flip: { method: 'tabs-in-blank', axis: 'left-right' } })],
    }));
    const parsed = parseEngraveJob(job);
    expect(parsed.ok, JSON.stringify(parsed.ok ? '' : parsed.errors)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.setups?.[1]?.flip).toEqual({ method: 'tabs-in-blank', axis: 'left-right' });
    // Both methods and both axes are expressible.
    for (const method of ['free-then-flip', 'tabs-in-blank'] as const) {
      for (const axis of ['left-right', 'front-back'] as const) {
        const again = parseEngraveJob({ ...(job as EngraveJob), setups: [setup({ id: 'setup-1' }), setup({ flip: { method, axis } })] });
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.job.setups?.[1]?.flip).toEqual({ method, axis });
      }
    }
  });

  it('the blank states its square corners, and they survive the load', () => {
    const job = jobWithout((j) => ({ ...j, stock: { ...j.stock, squareCorners: ['FL'] } }));
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.squareCorners).toEqual(['FL']);
  });

  it('absent stays absent: a stored job re-serialises with no new keys', () => {
    const job = jobWithout((j) => ({ ...j, setups: [setup()] }));
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = JSON.stringify(parsed.job);
    expect(text).not.toContain('squareCorners');
    expect(text).not.toContain('"flip"');
    expect(parsed.job.setups?.[0]?.flip).toBeUndefined();
    expect(parsed.job.stock.squareCorners).toBeUndefined();
  });

  it('a round trip through JSON keeps both records exactly', () => {
    const job = jobWithout((j) => ({
      ...j,
      stock: { ...j.stock, squareCorners: ['FL'] },
      setups: [setup({ flip: { method: 'free-then-flip', axis: 'front-back' } })],
    }));
    const first = parseEngraveJob(job);
    if (!first.ok) throw new Error(JSON.stringify(first.errors));
    const second = parseEngraveJob(JSON.parse(JSON.stringify(first.job)));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.job.stock.squareCorners).toEqual(['FL']);
    expect(second.job.setups?.[0]?.flip).toEqual({ method: 'free-then-flip', axis: 'front-back' });
  });

  it('a flip missing its axis is refused by name', () => {
    const job = jobWithout((j) => ({ ...j, setups: [setup({ flip: { method: 'tabs-in-blank' } as never })] }));
    expect(parseEngraveJob(job).ok).toBe(false);
  });
});
