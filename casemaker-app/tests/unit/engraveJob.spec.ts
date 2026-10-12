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
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { dedupeFindings, jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultSetupAnswers, stepFindings } from '@/engine/cnc/engrave/setupFlow';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { engravedFaceWorkZ, partToWork } from '@/engine/cnc/frames';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { validateVise } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
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

  it('keeps the #345 flatness, its provenance and the job’s margins through a round trip', () => {
    const job = defaultEngraveJob();
    job.stock.flatness = { dome: 0.33, across: 'width', source: 'badge' };
    job.sources = { stock: { flatness: 'computed' } };
    job.margins = { boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The VALUE is not enough on its own: every enumerated key zod does not name is stripped, and
    // a blank that kept its dome while losing where the number came from would read as measured.
    expect(parsed.job.stock.flatness).toEqual({ dome: 0.33, across: 'width', source: 'badge' });
    expect(parsed.job.sources?.stock?.flatness).toBe('computed');
    expect(parsed.job.margins).toEqual({ boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' });
    expect(parsed.job).toEqual(job);
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

  it('carries the job’s machine and a profile-declared material through a round trip (#347)', () => {
    const job = defaultEngraveJob();
    expect(job.machineId).toBe(Z1.id);
    job.stock.material = 'aluminium-6061';

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // BOTH fields have to survive in both directions: this schema STRIPS every key it does not name
    // (#310's trap), so a material the enum does not carry would come back as the default and the
    // job would be cut as if it were wood, with the machine's numbers silently replaced.
    expect(parsed.job.stock.material).toBe('aluminium-6061');
    expect(parsed.job.machineId).toBe('Z1');
    expect(parsed.job).toEqual(job);
  });

  it('coerces an unknown machine id to the one mill this app models, rather than dropping the job', () => {
    // A job written by a build that offered a second machine, opened by this one: the id is not a
    // `MACHINES` key here, and the alternative to coercing is refusing a document that is otherwise
    // perfectly readable. `jobMachine` falls back to the same profile, so the two agree.
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob({ ...job, machineId: 'Carvera-Air' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.machineId).toBe(Z1.id);
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

  it('leaves the unmeasured-vise warning to `validateVise`, and the merged list carries it once (#353)', () => {
    const job = defaultEngraveJob();
    // One owner: the vise validator says it, `validateJob` does not repeat it.
    expect(validateJob(job).some((f) => f.code === 'vise-default')).toBe(false);
    const vise = validateVise(job.stock, job.workholding.vise, job.sacrificial);
    expect(vise.filter((f) => f.code === 'vise-default')).toHaveLength(1);
    // The safety net: the two passes merged as every consumer merges them, still one.
    const merged = dedupeFindings([...validateJob(job), ...vise]);
    expect(merged.filter((f) => f.code === 'vise-default')).toHaveLength(1);
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
    expect(validateJob(job).some((f) => f.code === 'no-items')).toBe(true);
  });

  it('warns when the stock stands too little above the jaw tops for the deepest cut', () => {
    const job = defaultEngraveJob(); // deepest 2.0 -> needs stockProud >= 3
    job.workholding.vise.stockProud = 2.5;
    job.workholding.vise.source = 'saved';
    expect(validateJob(job).some((f) => f.code === 'stock-proud-too-small')).toBe(true);
    // #362 — the clearance is the JOB's number, not a constant in the check: at 0.4 mm asked for,
    // a 2.5 mm stand clears a 2 mm cut.
    const tight: EngraveJob = { ...job, jawClearance: 0.4 };
    expect(validateJob(tight).some((f) => f.code === 'stock-proud-too-small')).toBe(false);
    // …and the message quotes the number it was given, so a job that asks for more says so.
    job.jawClearance = 1.5;
    const msg = validateJob(job).find((f) => f.code === 'stock-proud-too-small')!.message;
    expect(msg).toContain('at least 1.5 mm of clearance is wanted');
    expect(msg).toContain('stockProud ≥ 3.5 mm');
  });

  // #219: a trace is work too, so a job of traces alone is not "no items"; its own findings
  // (a stroke that merges under the cutter, a depth past the floor) are raised here.
  it('treats an enabled trace as work, so a trace-only job is not “no items” (#219)', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.traces = [
      { id: 'tr', kind: 'line', position: { x: 50, y: 30 }, rotation: 0, depth: 0.5, enabled: true, points: [[0, 0], [10, 0]], closed: false },
    ];
    expect(validateJob(job).some((f) => f.code === 'no-items')).toBe(false);
  });

  it('warns when a trace’s strokes merge under the cutter (#219)', () => {
    const job = defaultEngraveJob(); // flat-1.0 -> r = 0.5, so strokes closer than 1.0 mm merge
    job.traces = [
      { id: 'tr', kind: 'line', position: { x: 50, y: 30 }, rotation: 0, depth: 0.5, enabled: true, points: [[-5, 0], [5, 0], [5, 0.8], [-5, 0.8]], closed: false },
    ];
    const f = validateJob(job).find((x) => x.code === 'trace-self-overlap');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('warning');
    expect(f!.labelId).toBe('tr');
  });

  it('errors when a trace is deeper than the floor allows (#219)', () => {
    const job = defaultEngraveJob(); // 12 mm stock, minFloor 1 -> 11 mm allowed
    job.traces = [
      { id: 'tr', kind: 'line', position: { x: 50, y: 30 }, rotation: 0, depth: 11.5, enabled: true, points: [[0, 0], [10, 0]], closed: false },
    ];
    const f = validateJob(job).find((x) => x.code === 'depth-exceeds-stock' && x.labelId === 'tr');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('error');
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

  // #362 — the hand-off the issue was opened for. Before this, taking a 3.81 mm badge blank left
  // the 12 mm softwood job's 2.0 / 1.0 / 0.5 mm depths on it, and the wizard's own blank step
  // complained about the job it had just built: 1.905 mm proud cannot carry a 2 mm cut with 1 mm
  // of clearance wanted under it.
  //
  // #363 then replaced the LINES too: the three demo labels were laid out for the 100 × 60 mm plank
  // and ran off the 76.2 mm badge, so the route seeds one `Name` line (see `blankLabelSeed.spec.ts`
  // for the layout) and this walk re-depths it.
  it('re-depths the seeded badge line to what the blank allows, and opens with no jaw finding', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const job = s().job;
    expect(job.stock.thickness).toBe(3.81);
    expect(job.labels).toHaveLength(1);
    // The badge the template makes states its print (#368), so the blank carries a colour boundary
    // and that boundary is what binds the seeded line: the split lands on the 0.8 mm layer line and
    // #345 gives the `above` bound its own 0.2 mm margin, so the walk writes 0.6 mm — a depth a
    // person can read rather than the float tail of a subtraction. (Before #368 the badge stated no
    // print, so the void bound decided and the line took the jaws' 1.905 − 1 = 0.905; before #365
    // made that bound per-line it was handed the pocket's 0.51, half the depth the blank allows.)
    expect(job.labels.map((l) => l.depth)).toEqual([0.6]);
    // `layout` is the seed's own stamp (#363 review): it is what tells a later take that this line
    // is still the route's to replace, and `depth`/`depthIntent` are the walk's answer on top of it —
    // the intent only exists because the badge states a print for it to be about.
    expect(job.labels.map((l) => l.depthIntent)).toEqual(['surface']);
    expect(job.sources?.labels).toEqual(
      Object.fromEntries(
        job.labels.map((l) => [
          l.id,
          { layout: 'computed', depth: 'computed', depthIntent: 'computed' },
        ]),
      ),
    );

    // The bar the issue set: the wizard does not hand over a job its own findings complain about.
    const findings = stepFindings('blank', job, defaultSetupAnswers(job));
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain('stock-proud-too-small');
    // …while the warnings that are telling the truth about an unmeasured vise stay.
    expect(findings.map((f) => f.code)).toContain('vise-default');
  });

  it('leaves a depth the user typed alone — and reports the finding it causes rather than hiding it', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().job.labels[0]!.id;

    s().updateLabel(id, { depth: 1.2 });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user' });

    // A badge stating NO print (#368): the evidence this test wants is the PER-LINE void answer, and
    // on a printed blank the colour band is tighter than either line's void, so all three would come
    // back as the one band depth and the pocket distinction would be untested here.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
    const job = s().job;
    // The user's 1.2 mm survives the blank being applied, and the other two are re-depth-ed — each
    // against its own line's extent since #365: 'MAKER' at (50, 26) and 'first chips' at (50, 10)
    // both reach the magnet pocket's band (y 12.55–25.55), so both take its 0.51 mm.
    expect(job.labels[0]!.depth).toBe(1.2);
    expect(job.labels[1]!.depth).toBe(0.51);
    expect(job.labels[2]!.depth).toBe(0.51);
    // 1.2 + 1 mm of clearance is past the 1.905 mm stand, and the check says so: the guard protects
    // the user's number, it does not silence the warning about it.
    expect(stepFindings('blank', job, defaultSetupAnswers(job)).map((f) => f.code)).toContain(
      'stock-proud-too-small',
    );

    // The provenance survives the round trip: zod strips every key its object does not name, and a
    // `user` depth coming back unclaimed would let the NEXT blank overwrite it (#310's trap).
    const second = await freshStore();
    expect(second.useEngraveJobStore.getState().job.sources?.labels?.[id]).toEqual({ depth: 'user' });
    expect(second.useEngraveJobStore.getState().job.labels[0]!.depth).toBe(1.2);
  });

  // #362 review — the recommendation writes a `depthIntent` of its OWN (`'reveal'`, or the
  // `'surface'` a band demotion stamps), and the guard in `recommendLabelDepth` declines any item
  // that states one. Without a provenance on that intent, the app's own statement would lock the
  // label out of every later re-depth: frozen onto the blank it was first measured against.
  it('clears the intent it wrote when the next blank no longer produces one (#362 review)', async () => {
    backing.clear();
    const seeded = defaultEngraveJob();
    const id = seeded.labels[0]!.id;
    seeded.labels[0] = { ...seeded.labels[0]!, depth: 0.6, depthIntent: 'surface' };
    // The `layout` claim is what stands the badge route aside here, and it is the only thing that
    // can: an app-computed `depth`/`depthIntent` is a past answer of the app's own and no longer
    // keeps a job out of the seed (#363 review follow-up — `demoShape` stopped comparing the intent
    // by value, or a pre-#363 split-badge job would never re-seed). A person's own claim does, which
    // is what this job has.
    seeded.sources = {
      labels: { [id]: { layout: 'user', depth: 'computed', depthIntent: 'computed' } },
    };
    backing.set(KEY, JSON.stringify(seeded));

    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    // The document came back with the app's own claim on the intent — zod keeps the key (#310's trap).
    expect(s().job.labels[0]!.depthIntent).toBe('surface');
    expect(s().job.sources?.labels?.[id]).toEqual({
      layout: 'user',
      depth: 'computed',
      depthIntent: 'computed',
    });

    // The badge blank states no print, so there is no colour split for any intent to be about: the
    // label re-depths to the jaws' 0.905 mm — the 'CASE' line sits at (50, 43), clear of the magnet
    // pocket whose band is y 12.55–25.55 (#365) — and the `surface` claim goes with it. A stale
    // `surface` here would be a claim about a blank this job has left.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
    expect(s().job.labels[0]!.depth).toBe(0.905);
    expect(s().job.labels[0]!.depthIntent).toBeUndefined();
    // The walk wrote the whole depth entry and carried the `layout` claim across it (#363 review), so
    // the person's own claim — and the line it protects — is still theirs afterwards.
    expect(s().job.sources?.labels?.[id]).toEqual({ layout: 'user', depth: 'computed' });
  });

  it('stamps a stated intent as the user’s own, and drops the claim when it is cleared (#362 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().job.labels[0]!.id;

    s().updateLabel(id, { depthIntent: 'surface' });
    expect(s().job.sources?.labels?.[id]).toEqual({ depthIntent: 'user' });
    // Clearing the intent clears its provenance with it — a source for a value that is gone is a
    // lie — and the label goes back to claiming nothing at all, so the map carries no empty entry.
    s().updateLabel(id, { depthIntent: undefined });
    expect(s().job.sources?.labels?.[id]).toBeUndefined();

    // Both claims stamp together, and a patch that claims NEITHER leaves them standing: changing
    // the text is not a statement about the depth or the colour — it is a statement about the LINE
    // itself, which is the `layout` claim, so the two depth claims are untouched by it (#363
    // review).
    s().updateLabel(id, { depthIntent: 'reveal', depth: 1.4 });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user', depthIntent: 'user' });
    s().updateLabel(id, { text: 'HELLO' });
    expect(s().job.sources?.labels?.[id]).toEqual({
      layout: 'user',
      depth: 'user',
      depthIntent: 'user',
    });

    // And the user's intent survives the blank being applied, the way the user's depth does.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    expect(s().job.labels[0]!.depth).toBe(1.4);
    expect(s().job.labels[0]!.depthIntent).toBe('reveal');
  });

  it('keeps a label’s `layout` claim through a save and load (#363 review)', () => {
    // The schema mirror names every key a source record may carry (zod STRIPS an unnamed one, #254's
    // trap), and `layout` is the claim a route reads back to tell its own line from a person's. If it
    // did not survive the round-trip, every reloaded job would look untouched and the route would
    // re-lay a line the person had placed.
    const job = defaultEngraveJob();
    const id = job.labels[0]!.id;
    job.sources = { labels: { [id]: { layout: 'computed', depth: 'computed' } } };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.sources?.labels?.[id]).toEqual({ layout: 'computed', depth: 'computed' });
  });

  it('gives a document written before #362 the clearance its check used, and keeps a stated one', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    delete raw.jawClearance;
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The 1 mm the `stock-proud-too-small` check hard-coded, so no stored job changes behaviour.
    expect(parsed.job.jawClearance).toBe(1.0);

    const stated = parseEngraveJob({ ...JSON.parse(JSON.stringify(defaultEngraveJob())), jawClearance: 2.5, schemaVersion: 2 });
    expect(stated.ok).toBe(true);
    if (!stated.ok) return;
    expect(stated.job.jawClearance).toBe(2.5);

    // A v1 document — which never carried the field — loads with the same default.
    const v1 = { ...raw, schemaVersion: 1 } as Record<string, unknown>;
    delete v1.sacrificial;
    delete v1.breakthrough;
    const old = parseEngraveJob(v1);
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.job.jawClearance).toBe(1.0);
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

  // #345 — the job's own depth margins, and the two states the panel's row moves between.
  it('setJobMargins writes the job’s own margins, and null puts it back on the house setting', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    // A fresh job has none: absent is the switch, so it follows the house setting.
    expect(s().job.margins).toBeUndefined();

    s().setJobMargins({ boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' });
    expect(s().job.margins).toEqual({ boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' });
    expect(JSON.parse(localStorage.getItem(KEY)!).margins.boundaryMargin).toBe(0.331);

    // Clearing DELETES the key rather than writing the house numbers into the document, so the
    // job goes back to following the setting.
    s().setJobMargins(null);
    expect(s().job.margins).toBeUndefined();
    expect('margins' in JSON.parse(localStorage.getItem(KEY)!)).toBe(false);
  });

  // #285 review — `print` is the one stock field a patch can CLEAR. An explicit `undefined` means
  // "this blank states no print", an OMITTED key means "this patch says nothing about it", and the
  // two must not be confused or a stale layer grid outlives the blank it described.
  it('setStock clears stock.print on an explicit undefined, and leaves it alone when omitted', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const { setStock } = useEngraveJobStore.getState();

    setStock({ print: { split: 3.0, layerHeight: 0.2 } }, 'computed');
    expect(useEngraveJobStore.getState().job.stock.print).toEqual({ split: 3.0, layerHeight: 0.2 });
    expect(useEngraveJobStore.getState().job.sources?.stock?.print).toBe('computed');

    // An omitted key still means "leave it alone" — every other caller relies on that.
    setStock({ thickness: 4 });
    expect(useEngraveJobStore.getState().job.stock.print).toEqual({ split: 3.0, layerHeight: 0.2 });

    // And the provenance goes with the value: a source for a value that is gone is a lie.
    setStock({ print: undefined }, 'computed');
    const { job } = useEngraveJobStore.getState();
    expect('print' in job.stock).toBe(false);
    expect(job.sources?.stock?.print).toBeUndefined();
  });

  it('"Use the badge blank" takes a stale print away when the badge loses it (#285 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const { setStock } = useEngraveJobStore.getState();

    // The badge states a print: the blank arrives with the layer grid.
    setStock(
      badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } })).stock,
      'computed',
    );
    expect(useEngraveJobStore.getState().job.stock.print).toEqual({
      split: 3.0,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });

    // The SAME badge, now without a print — stated explicitly, because `defaultBadgeParams` now
    // carries one (#368): the grid must go with it, or the stack limit keeps applying to a blank
    // whose print is no longer known.
    setStock(badgeBlankFor(defaultBadgeParams({ print: undefined })).stock, 'computed');
    const { job } = useEngraveJobStore.getState();
    expect(job.stock.print).toBeUndefined();
    // The rest of the blank still came through, so this is a CLEAR of the print, not a wipe.
    expect(job.stock.thickness).toBe(3.81);
    expect(job.stock.material).toBe('pla');
  });

  // #344 — the shipped 4 mm `stockProud` is taller than a 3.81 mm badge blank, so `validateVise`
  // refused it outright. `viseForNewJob` derives the default from the stock, but it runs when a
  // job is CREATED; every path that puts a blank into an EXISTING job goes through `setStock`.
  it('a thickness change carries the shipped-default vise with it, so the badge blank is not refused (#344)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const { setStock } = useEngraveJobStore.getState();
    expect(useEngraveJobStore.getState().job.workholding.vise).toMatchObject({
      source: 'default',
      stockProud: 4,
    });

    // "Use the badge blank": the same patch the panel's button sends.
    setStock(badgeBlankFor(defaultBadgeParams()).stock, 'computed');
    const { stock, workholding } = useEngraveJobStore.getState().job;
    expect(stock.thickness).toBe(3.81);
    // Half the blank, capped at the shipped 4 mm — the number `viseForNewJob(…, stock)` gives.
    expect(workholding.vise.stockProud).toBeCloseTo(1.905, 9);
    // A derived number is still NOT a measurement (decision 28), so the source stays `default`
    // and the vise still warns that the jaws are unmeasured.
    expect(workholding.vise.source).toBe('default');
    expect(validateVise(stock, workholding.vise).some((f) => f.severity === 'error')).toBe(false);
  });

  it('never touches a saved vise, even when the user’s own number refuses the new blank (#344)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    useEngraveJobStore.getState().setVise({ stockProud: 6 });
    useEngraveJobStore.getState().setStock({ thickness: 3.81 }, 'computed');

    const { stock, workholding } = useEngraveJobStore.getState().job;
    // The #231/#203 rule: the user's number is kept exactly, and the panel shows why it refuses.
    expect(workholding.vise.stockProud).toBe(6);
    expect(workholding.vise.source).toBe('saved');
    expect(
      validateVise(stock, workholding.vise).some(
        (f) => f.code === 'vise-stock-proud-exceeds-thickness',
      ),
    ).toBe(true);
  });

  it('heals a job saved in the stuck state when the same blank is taken again (#344 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    // A job persisted by a build before the re-derivation existed: the blank is already the badge's
    // 3.81 mm, but the vise is still the shipped 4 mm — `vise-stock-proud-exceeds-thickness`, with
    // no way out, because re-taking the blank sends the thickness the stock already has. Written
    // straight onto the store, since every `setStock` call now heals it.
    const job = useEngraveJobStore.getState().job;
    useEngraveJobStore.setState({
      job: { ...job, stock: { ...job.stock, thickness: 3.81 } },
    });

    // "Use the badge blank" again — the same thickness the stock already has.
    useEngraveJobStore.getState().setStock(badgeBlankFor(defaultBadgeParams()).stock, 'computed');

    const { stock, workholding } = useEngraveJobStore.getState().job;
    expect(workholding.vise.stockProud).toBeCloseTo(1.905, 9);
    expect(validateVise(stock, workholding.vise).some((f) => f.severity === 'error')).toBe(false);
  });

  it('leaves the vise alone when the patch does not move the thickness (#344)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const before = useEngraveJobStore.getState().job.workholding.vise;

    useEngraveJobStore.getState().setStock({ width: 50, material: 'pla' });

    // Identity, not merely equality: a width or a material says nothing about how tall the blank
    // stands, so nothing that reads the vise is disturbed by an unrelated stock edit.
    expect(useEngraveJobStore.getState().job.workholding.vise).toBe(before);
  });

  it('a corrupt payload falls back to the default and is preserved under .rejected', async () => {
    backing.clear();
    localStorage.setItem(KEY, '{not valid json');
    const { useEngraveJobStore } = await freshStore();
    expect(useEngraveJobStore.getState().job.stock.length).toBe(100); // default
    expect(localStorage.getItem(`${KEY}.rejected`)).toBe('{not valid json');
  });

  // #215 gap 2: combined items get their own add/update/remove actions rather than the panel
  // rebuilding the whole job and going through `replace()`.
  it('adds, updates and removes a combined item through the store (#215)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().addCombined('border');
    expect(id).toBeTruthy();
    expect(s().job.combined).toHaveLength(1);
    const border = s().job.combined![0]!;
    expect(border.kind).toBe('border');

    s().updateCombined(id!, { depth: 1.5, inset: 4 });
    expect(s().job.combined![0]).toMatchObject({ depth: 1.5, inset: 4 });

    // The edit is persisted, so a reload keeps it.
    expect(JSON.parse(localStorage.getItem(KEY)!).combined[0].inset).toBe(4);

    s().removeCombined(id!);
    expect(s().job.combined).toEqual([]);
  });

  it('addCombined returns null for a frame or cut-away with nothing to reference (#215)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().replace({ ...s().job, labels: [], shapes: [], combined: [] });

    expect(s().addCombined('frame')).toBeNull();
    expect(s().addCombined('cutaway')).toBeNull();
    expect(s().job.combined).toEqual([]);
    // A border follows the stock, so it needs no reference and is always addable.
    expect(s().addCombined('border')).toBeTruthy();
  });

  it('a frame defaults to the first item as its target (#215)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().addCombined('frame');
    const frame = s().job.combined![0]!;
    expect(frame.kind === 'frame' && frame.around).toBe(s().job.labels[0]!.id);
    expect(id).toBe(frame.id);
  });

  // #219: traces get their own add/update/remove actions, like combined items and shapes.
  it('adds, updates and removes a trace through the store (#219)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().addTrace('line');
    expect(id).toBeTruthy();
    expect(s().job.traces).toHaveLength(1);
    expect(s().job.traces![0]!.kind).toBe('line');

    s().updateTrace(id, { depth: 1.2, points: [[0, 0], [10, 0], [10, 10]] });
    const updated = s().job.traces![0]!;
    expect(updated).toMatchObject({ depth: 1.2 });
    expect(updated.kind === 'line' && updated.points.length).toBe(3);

    // The edit is persisted, so a reload keeps it.
    expect(JSON.parse(localStorage.getItem(KEY)!).traces[0].depth).toBe(1.2);

    s().removeTrace(id);
    expect(s().job.traces).toEqual([]);
  });

  it('adds a single-line text trace with the bundled stroke font (#219)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().addTrace('stroke-label');
    const t = s().job.traces![0]!;
    expect(t.kind).toBe('stroke-label');
    expect(id).toBe(t.id);
    // A single-stroke face, not an outline font (#219's "Do not trace outline fonts").
    expect(t.kind === 'stroke-label' && t.font.length > 0).toBe(true);
  });
});
