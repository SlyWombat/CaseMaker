// #445 (#434 phase 2) — the thread ITEM on the JOB document: the type, the schema, the store trio,
// the part plan, and the findings that refuse a bad thread before a toolpath exists.
//
// Held elsewhere: `engraveJob.spec.ts` and `benchDefaults.spec.ts` carry another workstream's hunks,
// so this file is the thread slice's own. The store reads localStorage at module load, so the fake
// below is installed BEFORE the store is dynamically imported (the same pattern as that spec).

import { describe, it, expect } from 'vitest';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveThreadItem } from '@/types/engraveJob';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { threadOperationName, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { ShopDefaults } from '@/platform/defaultsClient';

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

const THREAD: EngraveThreadItem = {
  kind: 'thread',
  id: 'thr-1',
  position: { x: 50, y: 30 },
  enabled: true,
  size: 'M5',
  standard: 'metric',
  classFit: '6H',
  depth: 5,
  through: false,
};

/** A 4 mm thread mill: inside M5's ⌀4.134 pilot and wide enough for its radial depth. */
const MILL: Tool = flatEndMill(4, {
  name: '4 mm thread mill',
  typeText: 'Thread Mill',
  shape: 'thread',
  tipDiameter: 4,
  diameter: 4,
  fluteLength: 20,
});

/** A job whose only enabled work is one thread, judged with the given tool. */
const jobWith = (thread: Partial<EngraveThreadItem> = {}, tool: Tool | null = MILL): EngraveJob => ({
  ...defaultEngraveJob(),
  labels: [],
  shapes: [],
  traces: [],
  drills: [],
  threads: [{ ...THREAD, ...thread }],
  tool: tool ?? null,
});

const codes = (job: EngraveJob) => validateJob(job).map((f) => f.code);

describe('#445 the job document', () => {
  it('a thread round-trips through the schema unchanged', () => {
    const job = jobWith();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.threads).toEqual([THREAD]);
    expect(parsed.job).toEqual(job);
  });

  it('a job without threads keeps the key ABSENT — a pre-#445 document round-trips byte-for-byte', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('threads' in parsed.job).toBe(false);
  });

  it('strips a key the thread item does not declare — a catalogue pitch cannot ride the wire', () => {
    const parsed = parseEngraveJob({ ...jobWith(), threads: [{ ...THREAD, pitch: 0.8, thread_angle: 60 }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.threads?.[0]).toEqual(THREAD);
  });

  it('refuses a non-metric standard, a non-6H fit, an unknown size and a non-positive depth', () => {
    const bad = (over: Record<string, unknown>) => parseEngraveJob({ ...jobWith(), threads: [{ ...THREAD, ...over }] });
    for (const over of [{ standard: 'unc' }, { classFit: '6G' }, { size: 'M7' }, { depth: 0 }]) {
      const parsed = bad(over);
      // The union reports its failure at the document root (`<root>: Invalid input`), not the
      // inner path; the assertion is that the THREAD's own rules are what reject it.
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.length).toBeGreaterThan(0);
    }
  });

  it('loads a v1 document with no threads key', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    raw.schemaVersion = 1;
    delete raw.sacrificial;
    delete raw.breakthrough;
    delete raw.threads;
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('threads' in parsed.job).toBe(false);
  });
});

describe('#445 the store’s thread trio', () => {
  it('adds a default M3 thread, edits it, and removes it — depth from its own shop key', async () => {
    // The `engrave.newThreadDepthMm` seed is the coordinator's; a stored value is enough for
    // `readDefault` (it checks `KNOWN_DEFAULTS` only when nothing is stored), which is how this
    // spec exercises the store without depending on the registry landing first.
    useShopDefaultsStore.setState({
      defaults: { 'engrave.newThreadDepthMm': { value: 7, source: 'seeded' } } as unknown as ShopDefaults,
    });
    const { useEngraveJobStore } = await import('@/store/engraveJobStore');
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), labels: [] } });
    const job = () => useEngraveJobStore.getState().job;

    const id = useEngraveJobStore.getState().addThread();
    expect(id).toMatch(/^thr-/);
    const added = job().threads!.find((t) => t.id === id)!;
    expect(added).toEqual({
      kind: 'thread',
      id,
      position: { x: job().stock.length / 2, y: job().stock.width / 2 },
      enabled: true,
      size: 'M3',
      standard: 'metric',
      classFit: '6H',
      depth: 7,
      through: false,
    });

    // A PARTIAL position: `ThreadPatch` types the whole point (like `DrillPatch`), and the store
    // merges it, so a row that moves X alone keeps Y.
    useEngraveJobStore.getState().updateThread(id, { depth: 3, position: { x: 12 } as EngraveThreadItem['position'] });
    const edited = job().threads!.find((t) => t.id === id)!;
    expect(edited.depth).toBe(3);
    expect(edited.position).toEqual({ x: 12, y: job().stock.width / 2 }); // the partial position MERGES

    useEngraveJobStore.getState().removeThread(id);
    expect(job().threads).toEqual([]);
    useShopDefaultsStore.setState({ defaults: null });
  });
});

describe('#445 the part plan', () => {
  it('carries the enabled threads to the plan and names the operation', () => {
    const plan = toPartPlan(jobWith());
    expect(plan.threads).toEqual([
      { id: 'thr-1', name: threadOperationName(THREAD), position: [50, 30], size: 'M5', depth: 5, through: false },
    ]);
    expect(threadOperationName(THREAD)).toBe('Thread M5×0.8');
    expect(threadOperationName({ ...THREAD, name: 'port' })).toBe('Thread "port" M5×0.8');
  });

  it('skips a disabled thread', () => {
    expect(toPartPlan(jobWith({ enabled: false })).threads).toEqual([]);
  });
});

describe('#445 the document findings', () => {
  it('a good thread: the pilot is a WARNING, never a silent assumption', () => {
    const findings = validateJob(jobWith());
    expect(findings.filter((f) => f.code.startsWith('thread-')).map((f) => f.code)).toEqual(['thread-pilot-unproven']);
    expect(findings.find((f) => f.code === 'thread-pilot-unproven')!.message).toMatch(/⌀4\.134 mm pilot.*at least 5\.8 mm deep.*ALREADY/);
  });

  it('refuses a tool that is not a thread mill', () => {
    expect(codes(jobWith({}, flatEndMill(4)))).toContain('thread-wrong-tool');
  });

  it('refuses a thread beside any other enabled cut — one program, one tool', () => {
    const job = jobWith();
    job.labels = defaultEngraveJob().labels;
    expect(codes(job)).toContain('thread-mixed-tools');
  });

  it('refuses a cutting diameter that cannot enter the pilot (M3 with a 4 mm mill)', () => {
    const findings = validateJob(jobWith({ size: 'M3' }));
    const fit = findings.find((f) => f.code === 'thread-cutter-fit')!;
    expect(fit.severity).toBe('error');
    expect(fit.message).toMatch(/cannot enter the ⌀2\.459 mm pilot/);
  });

  it('refuses a cutting diameter that cannot reach the major', () => {
    const tiny = flatEndMill(0.3, { name: '0.3 mm thread mill', shape: 'thread', tipDiameter: 0.3, diameter: 0.3, fluteLength: 20 });
    const findings = validateJob(jobWith({}, tiny));
    expect(findings.find((f) => f.code === 'thread-cutter-fit')?.message).toMatch(/radial depth/);
  });

  it('informs a thread whose MAJOR rim leaves the stock (#786 slice 1 part 2)', () => {
    const f = validateJob(jobWith({ position: { x: 1, y: 30 } })).find((x) => x.code === 'thread-off-stock');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('past the stock’s left edge');
    expect(f!.message).toContain('Generate cuts it as it is');
  });

  it('refuses a blind thread that leaves less than the minimum floor, charging one pitch', () => {
    const codes = validateJob(jobWith({ depth: 11.5 })).map((f) => f.code);
    expect(codes).toContain('thread-too-deep');
  });

  it('refuses a through thread until #213/#218 land', () => {
    expect(codes(jobWith({ through: true }))).toContain('thread-through-unavailable');
  });

  it('names an unproven flute as a WARNING', () => {
    const noFlute = flatEndMill(4, { name: '4 mm thread mill', shape: 'thread', tipDiameter: 4, diameter: 4, fluteLength: null });
    const findings = validateJob(jobWith({}, noFlute));
    expect(findings.find((f) => f.code === 'thread-flute-unproven')?.severity).toBe('warning');
  });
});
