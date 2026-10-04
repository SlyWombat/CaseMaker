// The EngraveJob document (#200): types, schema, store, and the two pure derivations.
//
// Pure geometry + zod + zustand, no React, no wasm, no worker. The store reads localStorage
// at module load, so the fake below is installed BEFORE the store is dynamically imported.

import { describe, it, expect, vi } from 'vitest';

// A minimal in-memory Storage, installed before any store import. The unit suite runs on
// node, where localStorage does not exist and the store deliberately no-ops.
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

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveLabel } from '@/types/engraveJob';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { engravedFaceWorkZ, partToWork } from '@/engine/cnc/frames';
import { Z1 } from '@/engine/cnc/machine';

const KEY = 'casemaker.engraveJob.v1';

async function freshStore() {
  vi.resetModules();
  return await import('@/store/engraveJobStore');
}

function makeLabel(over: Partial<EngraveLabel> = {}): EngraveLabel {
  return {
    id: 'l',
    text: 'H',
    font: 'sans-default',
    weight: 'bold',
    size: 10,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    ...over,
  };
}

describe('EngraveJob schema (#200)', () => {
  it('the default job parses through its own schema and round-trips through JSON unchanged', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(job);
  });

  it('strips an unknown extra key rather than rejecting the job', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob({ ...job, bogus: 123 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('bogus' in parsed.job).toBe(false);
  });

  it('rejects depth: -1 with a message naming labels[0].depth', () => {
    const job = defaultEngraveJob();
    job.labels[0]!.depth = -1;
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('labels[0].depth'))).toBe(true);
  });

  it('uses the Z1 envelope read from the machine profile, not a retyped 200/200/100', () => {
    const job = defaultEngraveJob();
    job.stock.length = Z1.envelope.x.max - Z1.envelope.x.min + 1;
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('stock.length'))).toBe(true);
  });
});

describe('labelProfile (#200)', () => {
  it('centres "H" on its position and keeps cap height at size', () => {
    const box = aabbOfProfile(labelProfile(makeLabel(), []))!;
    expect(box).not.toBeNull();
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const h = box.max[1] - box.min[1];
    expect(Math.abs(cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(cy - 30)).toBeLessThan(0.01);
    expect(Math.abs(h - 10)).toBeLessThan(0.05);
  });

  it('rotating 90 degrees swaps the bounding box width and height', () => {
    const b0 = aabbOfProfile(labelProfile(makeLabel({ rotation: 0 }), []))!;
    const b90 = aabbOfProfile(labelProfile(makeLabel({ rotation: 90 }), []))!;
    const w0 = b0.max[0] - b0.min[0];
    const h0 = b0.max[1] - b0.min[1];
    const w90 = b90.max[0] - b90.min[0];
    const h90 = b90.max[1] - b90.min[1];
    expect(Math.abs(w90 - h0)).toBeLessThan(0.01);
    expect(Math.abs(h90 - w0)).toBeLessThan(0.01);
    // still centred on the position
    expect(Math.abs((b90.min[0] + b90.max[0]) / 2 - 50)).toBeLessThan(0.01);
    expect(Math.abs((b90.min[1] + b90.max[1]) / 2 - 30)).toBeLessThan(0.01);
  });

  it('keeps a whitespace-only label as an empty profile', () => {
    const p = labelProfile(makeLabel({ text: '   ' }), []);
    expect(p).toMatchObject({ kind: 'p-poly' });
    expect(aabbOfProfile(p)).toBeNull();
  });
});

describe('toPartPlan (#200)', () => {
  it('drops disabled labels and preserves label order', () => {
    const job = defaultEngraveJob();
    job.labels[1]!.enabled = false;
    const plan = toPartPlan(job);
    expect(plan.engraves.map((e) => e.id)).toEqual([job.labels[0]!.id, job.labels[2]!.id]);
  });

  it('puts the stock outline front-left corner at the origin (not centred)', () => {
    const plan = toPartPlan(defaultEngraveJob());
    const box = aabbOfProfile(plan.stock.outline)!;
    expect(box.min).toEqual([0, 0]);
    expect(box.max).toEqual([100, 60]);
    expect(plan.stock.keepOuts).toEqual([]);
  });
});

describe('validateJob (#200)', () => {
  it('errors when depth exceeds thickness - minFloor, not at the boundary', () => {
    const job = defaultEngraveJob(); // 12 mm stock, minFloor 1 -> 11 mm allowed
    job.labels[0]!.depth = 11.5;
    const deep = validateJob(job).find((f) => f.code === 'depth-exceeds-stock');
    expect(deep).toBeTruthy();
    expect(deep!.severity).toBe('error');
    expect(deep!.labelId).toBe(job.labels[0]!.id);
    expect(deep!.message).toContain('CASE');

    job.labels[0]!.depth = 11.0;
    expect(validateJob(job).some((f) => f.code === 'depth-exceeds-stock')).toBe(false);
  });

  it('warns that the vise is an unmeasured default', () => {
    expect(validateJob(defaultEngraveJob()).some((f) => f.code === 'vise-default')).toBe(true);
  });

  it('errors when the named tool is not in the library', () => {
    const job = defaultEngraveJob();
    job.toolKey = 'no-such-tool';
    expect(jobTool(job)).toBeNull();
    expect(validateJob(job).some((f) => f.code === 'tool-missing')).toBe(true);
  });

  it('errors when no enabled label has text', () => {
    const job = defaultEngraveJob();
    for (const l of job.labels) l.text = '   ';
    expect(validateJob(job).some((f) => f.code === 'no-labels')).toBe(true);
  });

  it('warns when the stock stands too little above the jaw tops for the deepest cut', () => {
    const job = defaultEngraveJob(); // deepest 2.0 -> needs stockProud >= 3
    job.workholding.vise.stockProud = 2.5;
    job.workholding.vise.source = 'saved';
    expect(validateJob(job).some((f) => f.code === 'stock-proud-too-small')).toBe(true);
  });
});

describe('toSetup (#200)', () => {
  it('anchors the work origin on the top-front-left corner (work Z 0 on the top face)', () => {
    const job = defaultEngraveJob();
    const setup = toSetup(job, Z1);
    expect(engravedFaceWorkZ(setup)).toBe(0);
    expect(partToWork(setup, [0, 0, job.stock.thickness])).toEqual([0, 0, 0]);
  });

  it('builds the vise jaw faces in the part frame with jawHeight = thickness - stockProud', () => {
    const setup = toSetup(defaultEngraveJob(), Z1);
    expect(setup.workholding.kind).toBe('vise');
    if (setup.workholding.kind !== 'vise') return;
    expect(setup.workholding.jawFaces[0]!.origin).toEqual([0, 0, 0]);
    expect(setup.workholding.jawFaces[0]!.normal).toEqual([1, 0, 0]);
    expect(setup.workholding.jawFaces[1]!.origin).toEqual([100, 0, 0]);
    expect(setup.workholding.jawFaces[1]!.normal).toEqual([-1, 0, 0]);
    expect(setup.workholding.jawHeight).toBe(8); // 12 - 4
  });
});

describe('engraveJobStore (#200)', () => {
  it('updateLabel then a reload from localStorage restores the edit', async () => {
    backing.clear();
    const first = await freshStore();
    const id = first.useEngraveJobStore.getState().job.labels[0]!.id;
    first.useEngraveJobStore.getState().updateLabel(id, { depth: 3.3 });

    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw!);
    expect(stored.labels.find((l: { id: string }) => l.id === id).depth).toBe(3.3);

    const second = await freshStore();
    expect(second.useEngraveJobStore.getState().job.labels.find((l) => l.id === id)!.depth).toBe(3.3);
  });

  it('setVise marks the vise as saved unless the patch states its own source', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    useEngraveJobStore.getState().setVise({ stockProud: 6 });
    expect(useEngraveJobStore.getState().job.workholding.vise.source).toBe('saved');
    expect(useEngraveJobStore.getState().job.workholding.vise.stockProud).toBe(6);

    useEngraveJobStore.getState().setVise({ uncertainty: 1, source: 'measured' });
    expect(useEngraveJobStore.getState().job.workholding.vise.source).toBe('measured');
  });

  it('a corrupt payload falls back to the default and is preserved under .rejected', async () => {
    backing.clear();
    localStorage.setItem(KEY, '{not valid json');
    const { useEngraveJobStore } = await freshStore();
    expect(useEngraveJobStore.getState().job.stock.length).toBe(100); // default
    expect(localStorage.getItem(`${KEY}.rejected`)).toBe('{not valid json');
  });
});
