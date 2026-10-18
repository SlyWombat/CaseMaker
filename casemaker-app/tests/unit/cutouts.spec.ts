// Profile cut-outs (#218): the document shape, the schema's refusals, the job's through-cut
// gates and the store's add/update/remove. No geometry kernel and no worker here — the CAM is
// camProfile.spec.ts and the verifier mask is throughMask.spec.ts.

import { describe, it, expect, vi } from 'vitest';

// The store reads localStorage at module load; install the fake BEFORE the dynamic import.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import type { EngraveCutout, EngraveJob, Sacrificial } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { itemKindWord, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { noneSacrificial } from '@/engine/cnc/sacrificial';

async function freshStore() {
  vi.resetModules();
  return await import('@/store/engraveJobStore');
}

function cutout(over: Partial<EngraveCutout> = {}): EngraveCutout {
  return {
    kind: 'cutout',
    id: 'cut-1',
    enabled: true,
    of: 'stock-inset',
    side: 'outside',
    inset: 2,
    tabs: { count: 4, width: 4, height: 1 },
    ...over,
  };
}

/** A board whose thickness is exactly `breakthrough + 1`: the boundary that must pass. */
function boardAtBoundary(job: EngraveJob): Sacrificial {
  return {
    under: { thickness: job.breakthrough + 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
    sides: { left: null, right: null, front: null, back: null },
    source: 'saved',
  };
}

function withCutout(over: Partial<EngraveCutout> = {}, jobOver: Partial<EngraveJob> = {}): EngraveJob {
  return { ...defaultEngraveJob(), cutouts: [cutout(over)], ...jobOver };
}

describe('cut-out document (#218)', () => {
  it('round-trips through the schema, and an old job without cut-outs parses unchanged', () => {
    const bare = defaultEngraveJob();
    const parsedBare = parseEngraveJob(JSON.parse(JSON.stringify(bare)));
    expect(parsedBare.ok).toBe(true);
    if (parsedBare.ok) expect(parsedBare.job.cutouts).toBeUndefined();

    const job = withCutout();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.cutouts).toEqual([cutout()]);
  });

  it('refuses a fractional or absurd tab count and a zero tab dimension', () => {
    for (const tabs of [
      { count: 2.5, width: 4, height: 1 },
      { count: 65, width: 4, height: 1 },
      { count: 4, width: 0, height: 1 },
      { count: 4, width: 4, height: 0 },
    ]) {
      const parsed = parseEngraveJob(JSON.parse(JSON.stringify(withCutout({ tabs }))));
      expect(parsed.ok).toBe(false);
    }
  });

  it('names the item kind in the panel vocabulary', () => {
    expect(itemKindWord(cutout())).toBe('Cut-out');
  });
});

describe('cut-out findings (#218)', () => {
  it('refuses a through cut with no board under it', () => {
    const f = validateJob(withCutout()).find((x) => x.code === 'through-needs-board');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('cut-1');
    expect(f!.message).toMatch(/board/i);
  });

  it('passes at the boundary, under.thickness = breakthrough + 1', () => {
    const job = withCutout({}, {});
    const withBoard: EngraveJob = { ...job, sacrificial: boardAtBoundary(job) };
    expect(validateJob(withBoard).some((f) => f.code === 'through-needs-board')).toBe(false);
  });

  it('still refuses when the board is a hair too thin', () => {
    const job = withCutout();
    const thin: EngraveJob = {
      ...job,
      sacrificial: {
        ...boardAtBoundary(job),
        under: { ...boardAtBoundary(job).under!, thickness: job.breakthrough + 1 - 1e-3 },
      },
    };
    expect(validateJob(thin).some((f) => f.code === 'through-needs-board')).toBe(true);
  });

  it('warns, but does not refuse, when no tabs hold the part', () => {
    const f = validateJob(withCutout({ tabs: { count: 0, width: 4, height: 1 } })).find(
      (x) => x.code === 'released-onto-board',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
  });

  it('refuses a cut-out on a cutter that cannot profile', () => {
    const vBit = { ...flatEndMill(1), shape: 'engraving' as const };
    const f = validateJob(withCutout({}, { tool: vBit })).find((x) => x.code === 'cutout-needs-flat');
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/flat end mill/i);
  });

  it('reports a missing or disabled outline target, and ignores a disabled cut-out', () => {
    const missing = validateJob(withCutout({ of: 'nope' })).filter((f) => f.code === 'item-reference');
    expect(missing.length).toBe(1);

    const disabled = validateJob(withCutout({ of: 'nope', enabled: false }));
    expect(disabled.some((f) => f.code === 'item-reference')).toBe(false);
    expect(disabled.some((f) => f.code === 'through-needs-board')).toBe(false);
  });

  it('judges a through SHAPE by the same board gate', () => {
    const job = defaultEngraveJob();
    const shape = {
      kind: 'rect' as const,
      id: 'shape-1',
      enabled: true,
      construction: undefined,
      position: { x: 50, y: 30 },
      rotation: 0,
      width: 20,
      height: 10,
      cornerRadius: 0,
      depth: 1,
      through: true,
    };
    const throughJob: EngraveJob = { ...job, shapes: [shape], sacrificial: noneSacrificial() };
    expect(validateJob(throughJob).some((f) => f.code === 'through-needs-board')).toBe(true);
  });
});

describe('cut-out store (#218)', () => {
  it('adds a cut-out with the shop tab seeds, patches only the named tab field, and removes it', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().addCutout();
    const added = (s().job.cutouts ?? []).find((c) => c.id === id);
    expect(added).toBeDefined();
    expect(added!.of).toBe('stock-inset');
    expect(added!.side).toBe('outside');
    // The labelled fallback pair: 4 tabs, 4 mm wide, 1 mm high (PROVISIONAL, #218 §4).
    expect(added!.tabs).toEqual({ count: 4, width: 4, height: 1 });

    s().updateCutout(id, { tabs: { width: 6 } });
    expect((s().job.cutouts ?? []).find((c) => c.id === id)!.tabs).toEqual({ count: 4, width: 6, height: 1 });

    s().removeCutout(id);
    expect((s().job.cutouts ?? []).some((c) => c.id === id)).toBe(false);
  });
});
