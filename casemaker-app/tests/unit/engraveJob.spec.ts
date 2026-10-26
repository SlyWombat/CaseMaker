// The EngraveJob document (#200): types, schema, store, and the two pure derivations.
//
// Pure geometry + zod + zustand, no React, no wasm, no worker. The store reads localStorage
// at module load, so the fake below is installed BEFORE the store is dynamically imported.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSeededIds } from '@/utils/id';

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
import type { EngraveJob, EngraveLabel, JobSetup } from '@/types/engraveJob';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { dedupeFindings, jobSetups, jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultSetupAnswers, stepFindings } from '@/engine/cnc/engrave/setupFlow';
import { planRegistration, registrationSettings, type RegistrationPlan } from '@/engine/cnc/registration';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { engravedFaceWorkZ, partToWork } from '@/engine/cnc/frames';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { validateVise } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
import { Z1 } from '@/engine/cnc/machine';

const KEY = 'casemaker.engraveJob.v3';

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

  it('keeps the #572 metal-line override through a round trip, and leaves it absent by default', () => {
    // The field must be NAMED by the schema or a round trip strips it (and the override would vanish
    // on reload). Absent means the protective refusal stands — the default job invents no override.
    const job = defaultEngraveJob();
    job.metalLineOverride = true;
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.metalLineOverride).toBe(true);

    const plain = parseEngraveJob(JSON.parse(JSON.stringify(defaultEngraveJob())));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.job.metalLineOverride).toBeUndefined();
  });

  it('keeps a stated job id and mints one for a document written before the field (#419)', () => {
    // The id is what a stock reservation and `RunContext.jobId` are keyed to, so it must survive a
    // save and load. A document without one gains it on PARSE, with no `schemaVersion` bump — for
    // v1 as well as v2, since the v1 schema predates the key entirely. Seeded ids are what make
    // the minted value assertable rather than a fresh random string on every run.
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;

    setSeededIds(true);
    try {
      const kept = parseEngraveJob({ ...raw, id: 'job-stated' });
      expect(kept.ok).toBe(true);
      if (!kept.ok) return;
      expect(kept.job.id).toBe('job-stated');

      // A v2 document written before #419: the v2 field's `.default` mints one, and the migration
      // stamps v3 without changing anything else (#425).
      const v2: Record<string, unknown> = { ...raw, schemaVersion: 2 };
      delete v2.id;
      setSeededIds(true);
      const minted = parseEngraveJob(v2);
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      expect(minted.job.schemaVersion).toBe(3);
      expect(minted.job.id).toBe('job-s000001');

      // A v1 document cannot reach that default (the v1 branch has no such key), so the transform
      // mints it there. Both routes land on the same shape of id.
      const v1 = { ...raw, schemaVersion: 1 } as Record<string, unknown>;
      delete v1.sacrificial;
      delete v1.breakthrough;
      setSeededIds(true);
      const old = parseEngraveJob(v1);
      expect(old.ok).toBe(true);
      if (!old.ok) return;
      expect(old.job.schemaVersion).toBe(3);
      expect(old.job.id).toBe('job-s000001');
    } finally {
      setSeededIds(false);
    }
  });

  it('preserves an unknown TOP-LEVEL key rather than rejecting the job (#425)', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob({ ...job, bogus: 123 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // v3's root is passthrough: a key a same-version build wrote survives an open/save round trip.
    // The keys INSIDE the owned blocks are strict instead (jobFile.spec.ts).
    expect((parsed.job as unknown as Record<string, unknown>).bogus).toBe(123);
  });

  it('keeps the measured flatness pair, its provenance and the job’s margins through a round trip', () => {
    const job = defaultEngraveJob();
    job.stock.flatness = {
      xMm: 0.33,
      yMm: 0.1,
      source: 'measured',
      touchCount: 5,
      measuredAt: '2026-10-18T10:00:00.000Z',
    };
    job.sources = { stock: { flatness: 'measured' } };
    job.margins = { boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The VALUE is not enough on its own: every enumerated key zod does not name is stripped, and
    // a blank that kept its bow while losing where the number came from would read as measured.
    expect(parsed.job.stock.flatness).toEqual({
      xMm: 0.33,
      yMm: 0.1,
      source: 'measured',
      touchCount: 5,
      measuredAt: '2026-10-18T10:00:00.000Z',
    });
    expect(parsed.job.sources?.stock?.flatness).toBe('measured');
    expect(parsed.job.margins).toEqual({ boundaryMargin: 0.331, zTolerance: 0.331, source: 'recommended' });
    expect(parsed.job).toEqual(job);
  });

  it('drops a pre-#496 one-span flatness on load rather than inventing the other span', () => {
    // The old record was `{ dome, across }`, and the direction word was read in opposite senses by
    // different modules. A job carrying it loads as "not yet measured": one span cannot state the
    // pair, and the next extents-touch run writes the real one (#496).
    const before = defaultEngraveJob();
    const raw = {
      ...before,
      stock: { ...before.stock, flatness: { dome: 0.33, across: 'length' as const, source: 'badge' as const } },
    };
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.flatness).toBeUndefined();
    // Everything ELSE survives untouched: the dropped record is the only change a pre-#496 saved
    // job takes, so opening and saving one loses no other fact about the blank or the job.
    const { flatness: _dropped, ...stockWithoutFlatness } = raw.stock;
    expect(parsed.job.stock).toEqual(stockWithoutFlatness);
    expect(parsed.job).toEqual({ ...raw, stock: stockWithoutFlatness });
    void _dropped;
    // BYTE-FOR-BYTE: the store saves `JSON.stringify(job)` after the same parse that loaded it, so
    // saving a job that was just opened must write the identical bytes again — nothing rewritten,
    // no field reordered or defaulted on the way past (the one-span record is the only loss, and
    // the deep equality above is what says so).
    const saved = JSON.stringify(parsed.job);
    const reloaded = parseEngraveJob(JSON.parse(saved));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(JSON.stringify(reloaded.job)).toBe(saved);
  });

  // #464 — the fibre flag sits beside the material, so the schema has to name BOTH or a round trip
  // keeps the value while losing the record of where it came from.
  it('keeps the #464 fibre flag and its provenance through a round trip', () => {
    const job = defaultEngraveJob();
    job.stock.material = 'petg';
    job.stock.fibre = 'cf';
    job.sources = { stock: { material: 'computed', fibre: 'computed' } };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.fibre).toBe('cf');
    expect(parsed.job.sources?.stock?.fibre).toBe('computed');
    expect(parsed.job).toEqual(job);
  });

  // #492 — the stock's colour facts are the top colour's thickness from the engraved face, not the
  // old `print.split` frame from the bottom. Both kinds have to survive a round trip, with where the
  // number came from kept beside it, because the schema strips every key it does not name.
  it('keeps a printed colour cap, its layer grid and its provenance through a round trip (#492)', () => {
    const job = defaultEngraveJob();
    job.stock.colour = { kind: 'printed', capMm: 1.27, layerHeight: 0.2, firstLayerHeight: 0.3 };
    job.sources = { stock: { colour: 'assumed' } };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.colour).toEqual({
      kind: 'printed',
      capMm: 1.27,
      layerHeight: 0.2,
      firstLayerHeight: 0.3,
    });
    expect(parsed.job.sources?.stock?.colour).toBe('assumed');
    expect(parsed.job).toEqual(job);
  });

  it('keeps a laminate cap with no layer grid, which is not a print (#492)', () => {
    const job = defaultEngraveJob();
    job.stock.colour = { kind: 'laminate', capMm: 0.075 };

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.colour).toEqual({ kind: 'laminate', capMm: 0.075 });
    expect(parsed.job).toEqual(job);
  });

  it('migrates a pre-#492 stock.print to a printed colour cap measured from the face', () => {
    // The old split was the boundary's height above the BOTTOM face; `capMm` is the thickness left
    // above it, so the two are complements about `thickness` (12 − 3 = 9).
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    const stock = raw.stock as Record<string, unknown>;
    stock.print = { split: 3, layerHeight: 0.2, firstLayerHeight: 0.2 };
    raw.sources = { stock: { print: 'computed' } };

    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.stock.colour).toEqual({
      kind: 'printed',
      capMm: 9,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });
    expect('print' in parsed.job.stock).toBe(false);
    expect(parsed.job.sources?.stock?.colour).toBe('computed');
    expect('print' in (parsed.job.sources?.stock ?? {})).toBe(false);
  });

  it('refuses a colour cap that cannot fit the stock, or laminate layers, or a first layer alone (#492)', () => {
    const overThick = defaultEngraveJob();
    overThick.stock.colour = { kind: 'laminate', capMm: overThick.stock.thickness + 0.1 };
    expect(parseEngraveJob(overThick).ok).toBe(false);

    const zero = defaultEngraveJob();
    zero.stock.colour = { kind: 'laminate', capMm: 0 };
    expect(parseEngraveJob(zero).ok).toBe(false);

    const laminaLayers = defaultEngraveJob();
    laminaLayers.stock.colour = { kind: 'laminate', capMm: 0.075, layerHeight: 0.2 };
    expect(parseEngraveJob(laminaLayers).ok).toBe(false);

    const firstOnly = defaultEngraveJob();
    firstOnly.stock.colour = { kind: 'printed', capMm: 1, firstLayerHeight: 0.3 };
    expect(parseEngraveJob(firstOnly).ok).toBe(false);
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

describe('3D primitives and the target object (#435)', () => {
  const base = {
    id: 'prm-1',
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 2,
    enabled: true,
  };

  it('are OPTIONAL additions to v3: a document without them parses with the version unchanged', () => {
    const job = defaultEngraveJob();
    expect(job.schemaVersion).toBe(3);
    expect(job.primitives).toBeUndefined();
    expect(job.targetObject).toBeUndefined();

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(3);
    expect(parsed.job.primitives).toBeUndefined();
    expect(parsed.job.targetObject).toBeUndefined();
  });

  it('round-trips all four primitive kinds without a version bump', () => {
    const job = defaultEngraveJob();
    const jobWith = {
      ...job,
      primitives: [
        { ...base, kind: 'box', width: 20, height: 10 },
        { ...base, id: 'prm-2', kind: 'cylinder', diameter: 6 },
        { ...base, id: 'prm-3', kind: 'cone', diameter: 8, tipDiameter: 1 },
        { ...base, id: 'prm-4', kind: 'sphere', diameter: 8, depth: 4 },
      ],
    } as EngraveJob;

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(jobWith)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(3);
    expect(parsed.job.primitives).toEqual(jobWith.primitives);
  });

  it('refuses a cone whose tip is wider than its base, naming the field', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob({
      ...job,
      primitives: [{ ...base, kind: 'cone', diameter: 4, tipDiameter: 6 }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('primitives[0].tipDiameter'))).toBe(true);
  });

  it('refuses a sphere cap deeper than its diameter', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob({
      ...job,
      primitives: [{ ...base, kind: 'sphere', diameter: 6, depth: 7 }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('primitives[0].depth'))).toBe(true);
  });

  it('accepts a fully stated target object and refuses a malformed one', () => {
    const job = defaultEngraveJob();
    const targetObject = {
      id: 'tgt-1',
      name: 'bracket.stl',
      format: 'stl' as const,
      sha256: 'a'.repeat(64),
      data: 'AAAA',
      size: { x: 10, y: 8, z: 4 },
      position: { x: 5, y: 5, z: 0 },
      rotation: 30,
      enabled: true,
    };

    const ok = parseEngraveJob({ ...job, targetObject });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.job.schemaVersion).toBe(3);
    expect(ok.job.targetObject).toEqual(targetObject);

    for (const broken of [
      { ...targetObject, sha256: 'not-a-hash' },
      { ...targetObject, data: '' },
      { ...targetObject, format: 'obj' },
      { ...targetObject, size: { x: 0, y: 8, z: 4 } },
    ]) {
      expect(parseEngraveJob({ ...job, targetObject: broken }).ok).toBe(false);
    }
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

  it('gives a job with no cutter yet no tool finding, and a no-items job none either (#516)', () => {
    // The empty key a fresh default job starts with is the pre-recommendation state, not an error.
    expect(defaultEngraveJob().toolKey).toBe('');
    expect(validateJob(defaultEngraveJob()).some((f) => f.code === 'tool-missing')).toBe(false);
    // And a job with no work has no tool finding regardless.
    const empty = defaultEngraveJob();
    empty.labels = [];
    empty.shapes = [];
    expect(validateJob(empty).some((f) => f.code === 'tool-missing')).toBe(false);
  });

  it('errors when no enabled label has text', () => {
    const job = defaultEngraveJob();
    for (const l of job.labels) l.text = '   ';
    expect(validateJob(job).some((f) => f.code === 'no-items')).toBe(true);
  });

  it('refuses a cut whose swept extent comes inside the job’s jaw clearance, naming item, jaw and distance (#488)', () => {
    const job = defaultEngraveJob();
    job.workholding.vise.stockProud = 2.5;
    job.workholding.vise.source = 'saved';
    // The demo 'CASE' line sits 26.9 mm clear of both jaw faces when centred on this 100 mm plank;
    // moved to x = 24 its swept extent comes 0.86 mm off the fixed jaw.
    job.labels[0]!.position = { x: 24, y: 43 };
    const collision = validateJob(job).find((f) => f.code === 'vise-jaw-collision');
    expect(collision?.severity).toBe('error');
    expect(collision?.labelId).toBe(job.labels[0]!.id);
    // The sentence names the item, the jaw and the distance, and the move that clears it.
    expect(collision!.message).toContain('CASE');
    expect(collision!.message).toContain('fixed jaw face');
    expect(collision!.message).toContain('0.86 mm');
    expect(collision!.message).toContain('0.14 mm');
    // #362 — the clearance is the JOB's number: at 0.4 mm asked for, the same 0.86 mm gap clears.
    expect(validateJob({ ...job, jawClearance: 0.4 }).some((f) => f.code === 'vise-jaw-collision')).toBe(false);
    // …and at 1.5 mm the refusal quotes the number it was given.
    expect(
      validateJob({ ...job, jawClearance: 1.5 }).find((f) => f.code === 'vise-jaw-collision')!.message,
    ).toContain('1.5 mm clear');
  });

  // #488 — the rule is geometric, not a stand rule: a blank below the jaw tops is a NOTE when every
  // cut keeps its distance, and the packer advice appears only in a refusal.
  it('notes a blank below the jaw tops when the cuts stay clear, and refuses only a cut that does not', () => {
    const base = defaultEngraveJob();
    const thin: EngraveJob = {
      ...base,
      stock: { ...base.stock, thickness: 1.5 },
      workholding: { ...base.workholding, vise: { ...base.workholding.vise, stockProud: -1.6, source: 'saved' } },
      labels: [{ ...base.labels[0]!, text: 'Name', size: 8, position: { x: 50, y: 7.5 }, depth: 0.4 }],
    };
    const note = validateJob(thin).find((f) => f.code === 'vise-stock-not-proud');
    expect(note?.severity).toBe('warning');
    expect(note!.message).toContain('1.6 mm below the jaw tops');
    expect(note!.message).toContain('at least 1 mm clear of the jaws');
    expect(note!.message).toContain('needs no packer');
    expect(validateJob(thin).some((f) => f.code === 'vise-jaw-collision')).toBe(false);

    // The same blank with a pocket edge 0.3 mm from the fixed jaw's face: a refusal, and the packer
    // is offered there (#488's spec numbers).
    const near: EngraveJob = {
      ...thin,
      labels: [],
      shapes: [
        {
          id: 'pocket',
          kind: 'rect',
          width: 10,
          height: 6,
          cornerRadius: 0,
          position: { x: 5.3, y: 7.5 },
          rotation: 0,
          depth: 0.4,
          enabled: true,
        },
      ],
    };
    const collision = validateJob(near).find((f) => f.code === 'vise-jaw-collision');
    expect(collision?.severity).toBe('error');
    expect(collision!.message).toContain('0.3 mm of the fixed jaw face');
    expect(collision!.message).toContain('packer');
    expect(validateJob(near).some((f) => f.code === 'vise-stock-not-proud')).toBe(false);
  });

  // #488 review — the jaw check's first call is a PANEL RENDER, which can run before the text faces
  // are parsed (#180), and the wizard's hand-off runs before anything has fetched one. The compile
  // path must still throw on an unparsed face — a program is never cut from an estimate — but the
  // collision check reads the documented upper-bound box instead, so the panel mounts and the
  // check errs strict rather than silently skipping. Held in `partPlanUnparsedFace.spec.ts`, which
  // stubs `resolveFont` to the cold-cache case: vitest here has every bundled face parsed.

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
    job.toolKey = 'flat-1.0'; // #516 item 5 — the default job no longer seeds the cutter
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
  it('#535 — merges a goal surface patch, clears a key set to undefined, and drops an empty block', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().setTargetObject({
      id: 'tgt-1',
      name: 'goal.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: 'AAAA',
      size: { x: 10, y: 8, z: 4 },
      position: { x: 5, y: 5, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
      surface: { roughStepDownMm: 0.3, gridPitchMm: 0.2 },
    });

    // A partial patch merges, leaving the other keys alone.
    s().updateTargetObject({ surface: { finishStepOverMm: 0.4 } });
    expect(s().job.targetObject?.surface).toEqual({
      roughStepDownMm: 0.3,
      gridPitchMm: 0.2,
      finishStepOverMm: 0.4,
    });

    // `undefined` is the row's reset: the key is REMOVED, not stored as undefined.
    s().updateTargetObject({ surface: { gridPitchMm: undefined } });
    expect(s().job.targetObject?.surface).toEqual({ roughStepDownMm: 0.3, finishStepOverMm: 0.4 });
    expect(Object.keys(s().job.targetObject?.surface ?? {})).not.toContain('gridPitchMm');

    // The last key cleared drops the block entirely, so the document serialises as one that never
    // carried it — and the reload keeps that shape.
    s().updateTargetObject({ surface: { roughStepDownMm: undefined, finishStepOverMm: undefined } });
    expect(s().job.targetObject?.surface).toBeUndefined();
    const second = await freshStore();
    expect(second.useEngraveJobStore.getState().job.targetObject?.surface).toBeUndefined();
  });

  it('#667 — setRestCutter materialises the setups and writes the setup’s second tool', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().setTool('flat-3.175x12-metal');
    const id = s().job.labels[0]!.id;
    expect(s().job.setups).toBeUndefined();

    s().setRestCutter(id, 'flat-1.0');
    const setups = s().job.setups!;
    expect(setups).toHaveLength(1);
    expect(setups[0]!.tools).toEqual(['flat-3.175x12-metal', 'flat-1.0']);
    // The materialised list owns every cut item the implicit setup had, in the same order.
    expect(setups[0]!.itemIds).toEqual(jobSetups({ ...s().job, setups: undefined })[0]!.itemIds);
    expect(setups[0]!.itemIds).toContain(id);

    // Clearing returns the setup to one cutter; it does not delete the list it materialised.
    s().setRestCutter(id, null);
    expect(s().job.setups![0]!.tools).toEqual(['flat-3.175x12-metal']);

    // A rest cutter equal to the rough one is not a pair, and writes nothing.
    s().setRestCutter(id, 'flat-3.175x12-metal');
    expect(s().job.setups![0]!.tools).toEqual(['flat-3.175x12-metal']);
  });

  it('#667 — a multi-setup job writes the rest cutter on the setup that owns the row', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().setTool('flat-3.175x12-metal');
    const first = jobSetups(s().job)[0]!;
    const a = { ...first, id: 'setup-a', itemIds: [s().job.labels[0]!.id], tools: ['flat-3.175x12-metal'] };
    const b = { ...first, id: 'setup-b', itemIds: [s().job.labels[1]!.id], tools: ['flat-3.175x12-metal'] };
    s().setSetups([a, b]);
    s().setRestCutter(s().job.labels[1]!.id, 'flat-1.0');
    expect(s().job.setups![0]!.tools).toEqual(['flat-3.175x12-metal']);
    expect(s().job.setups![1]!.tools).toEqual(['flat-3.175x12-metal', 'flat-1.0']);
  });

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
  // complained about the job it had just built: the 1.905 mm stand of the day cannot carry a 2 mm cut
  // with 1 mm of clearance wanted under it.
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
    // #345 gives the `below` bound its own 0.2 mm margin, so the walk writes 1.0 mm — the reveal
    // this two-colour blank is FOR, and a depth a person can read rather than the float tail of a
    // subtraction.
    //
    // #369 is what lets it be the reveal. The seeded line sits 6.775 mm from the front edge, centred
    // under the blank's width, and even at `inkBoxOf`'s widest estimate it comes no nearer than
    // 6.9 mm to a jaw face — past the 1 mm reach the jaws are judged by (`uncertainty + radius`, 0.5
    // mm of band and a 1 mm cutter, #394) — so the jaws set no limit here. While every line was
    // charged the blank-wide jaw floor it took 1.905 − 1 = 0.905,
    // which landed inside the split's ±0.2 mm band and came back up as a 0.6 mm `surface` floor.
    // (Before #368 the badge stated no print, so the line took that 0.905 with no band to demote it;
    // before #365 it was handed the pocket's 0.51, half the depth the blank allows.)
    expect(job.labels.map((l) => l.depth)).toEqual([1.0]);
    // `layout` is the seed's own stamp (#363 review): it is what tells a later take that this line
    // is still the route's to replace, and `depth`/`depthIntent` are the walk's answer on top of it —
    // the intent only exists because the badge states a print for it to be about.
    expect(job.labels.map((l) => l.depthIntent)).toEqual(['reveal']);
    expect(job.sources?.labels).toEqual(
      Object.fromEntries(
        job.labels.map((l) => [
          l.id,
          { layout: 'computed', seed: true, depth: 'computed', depthIntent: 'computed' },
        ]),
      ),
    );

    // The bar the issue set: the wizard does not hand over a job its own findings complain about.
    const findings = stepFindings('blank', job, defaultSetupAnswers(job));
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain('vise-jaw-collision');
    // …while the warnings that are telling the truth about an unmeasured vise stay.
    expect(findings.map((f) => f.code)).toContain('vise-default');
  });

  it('leaves a depth the user typed alone — and reports the finding it causes rather than hiding it', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().job.labels[0]!.id;

    // The stand this test weighs against is stated rather than inherited: since #391 review item 1
    // the shipped badge default SEATS the blank (0.71 mm proud), which leaves the jaws no floor to
    // clear at this line's position and makes the subject here — the per-line void bound — the
    // wrong question. The seated default's own consequence has its own test below.
    s().setVise({ stockProud: 1.905 });

    // The depth AND where the line sits: the warning below is about a cut working below the jaw
    // tops, and since #369/#394 only a line the jaws can REACH is charged — 'CASE' at 14 mm
    // MEASURES 46.28 mm wide, so on the 76.2 mm badge blank it needs to sit near a jaw face (at
    // x = 24 its box comes 0.86 mm off the fixed one) for the question to be in play at all.
    s().updateLabel(id, { depth: 1.2, position: { x: 24, y: 43 } });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user', layout: 'user' });

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
    // The user's 1.2 mm cut sits 0.86 mm from the fixed jaw face, inside the job's 1 mm clearance:
    // the guard protects the user's number, it does not silence the collision finding about it.
    expect(stepFindings('blank', job, defaultSetupAnswers(job)).map((f) => f.code)).toContain(
      'vise-jaw-collision',
    );

    // The provenance survives the round trip: zod strips every key its object does not name, and a
    // `user` depth coming back unclaimed would let the NEXT blank overwrite it (#310's trap).
    const second = await freshStore();
    // Both claims, not just the depth: the `layout` stamp was typed here too, and a claim the
    // round trip dropped would let the next blank re-lay a line the user placed.
    expect(second.useEngraveJobStore.getState().job.sources?.labels?.[id]).toEqual({
      depth: 'user',
      layout: 'user',
    });
    expect(second.useEngraveJobStore.getState().job.labels[0]!.depth).toBe(1.2);
  });

  // #391 review item 1 — the shipped default no longer stands a blank at half its thickness: a
  // blank that can seat on the jaws' 3.1 mm ledges takes the SEATED value (#208's calipers), which
  // on the 3.81 mm badge blank is 0.71 mm. The jaws are what that moves: `stockProud − clearance`
  // is negative on any line the jaws can reach, so the recommendation has no floor to offer and
  // answers with nothing (`winner.depth <= 0`), and the walk leaves those lines exactly where they
  // were rather than writing a made-up floor. The warning is what carries the news.
  it('seats a badge blank on the ledge it can reach, and says the jaws leave no depth at all (#391)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().updateLabel(s().job.labels[0]!.id, { depth: 1.2, position: { x: 24, y: 43 } });

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
    const job = s().job;
    expect(job.workholding.vise.stockProud).toBeCloseTo(0.71, 9);

    // 'MAKER' and 'first chips' are the 100 × 60 job's own lines, and at 46 and 38 mm wide they run
    // off the badge blank's 76.2 mm length and come over the moving jaw — where a floor that stays
    // 1 mm clear of the jaw tops is a floor above the blank's own face. So both keep the depths they
    // arrived with, and the user's own 1.2 is untouched as always.
    expect(job.labels.map((l) => l.depth)).toEqual([1.2, 1.0, 0.5]);
    expect(stepFindings('blank', job, defaultSetupAnswers(job)).map((f) => f.code)).toContain(
      'vise-jaw-collision',
    );
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
    // As above: the blank is seated at a stand that keeps the jaws out of this line's question, so
    // this test stays about the intent and the void rather than about the seated default (#391).
    seeded.workholding.vise = { ...seeded.workholding.vise, stockProud: 1.905, source: 'saved' };
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
    // label re-depths to the magnet pocket's 0.51 mm — the 'CASE' line sits at (50, 43), and since
    // the blank is TURNED (#383) the pocket's band is y 15.6–60.6, which the line's estimated box
    // reaches (#365) — and the `surface` claim goes with it. A stale `surface` here would be a
    // claim about a blank this job has left.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
    expect(s().job.labels[0]!.depth).toBe(0.51);
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
    // The 1 mm the jaw-clearance rule carries, so no stored job changes behaviour.
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

  // #508 — the seat is a SETUP choice, not a vise edit. On a default vise, changing it re-derives
  // the seated proud and the vise stays `default`, because the numbers are still the product's.
  it('a seat change re-seats a default vise', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    expect(s().job.workholding.vise).toMatchObject({ source: 'default', seat: 'ledge', stockProud: 8.9 });
    s().setVise({ seat: 'floor' });
    // The default 12 mm blank on the 20 mm floor: 8 mm below the jaw tops, and negative is the truth.
    expect(s().job.workholding.vise).toMatchObject({ source: 'default', seat: 'floor', stockProud: -8 });
    // A later thickness change follows the new seat.
    s().setStock({ thickness: 30 }, 'user');
    expect(s().job.workholding.vise).toMatchObject({ seat: 'floor', stockProud: 10 });
  });

  it('a seat change never re-derives a saved or measured vise’s numbers', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().setVise({ stockProud: 6 });
    s().setVise({ seat: 'floor' });
    expect(s().job.workholding.vise).toMatchObject({ source: 'saved', seat: 'floor', stockProud: 6 });
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

  // #471 — the Setups section's one write. Once present the list is authoritative; clearing it
  // returns the job to the compatibility reading rather than storing an empty list.
  it('setSetups writes the saved list whole, persists it, and null deletes the key', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const job = useEngraveJobStore.getState().job;
    const setups: JobSetup[] = [
      {
        id: 'setup-1',
        orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
        mount: { kind: 'vise' },
        itemIds: [job.labels[0]!.id],
        // #516 item 5 — the default job no longer seeds a cutter, and a setup's tools must name a
        // real key, so this states `flat-1.0` rather than `job.toolKey`.
        tools: ['flat-1.0'],
      },
    ];

    useEngraveJobStore.getState().setSetups(setups);
    expect(useEngraveJobStore.getState().job.setups).toEqual(setups);
    expect(JSON.parse(localStorage.getItem(KEY)!).setups).toEqual(setups);

    // A reload keeps them: the schema names every field of a setup.
    const second = await freshStore();
    expect(second.useEngraveJobStore.getState().job.setups).toEqual(setups);

    second.useEngraveJobStore.getState().setSetups(null);
    expect(second.useEngraveJobStore.getState().job.setups).toBeUndefined();
    expect('setups' in JSON.parse(localStorage.getItem(KEY)!)).toBe(false);
  });

  // #285 review — `print` is the one stock field a patch can CLEAR. An explicit `undefined` means
  // "this blank states no print", an OMITTED key means "this patch says nothing about it", and the
  // two must not be confused or a stale layer grid outlives the blank it described.
  it('setStock clears stock.colour on an explicit undefined, and leaves it alone when omitted', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const { setStock } = useEngraveJobStore.getState();

    setStock({ colour: { kind: 'printed', capMm: 9.0, layerHeight: 0.2 } }, 'computed');
    expect(useEngraveJobStore.getState().job.stock.colour).toEqual({ kind: 'printed', capMm: 9.0, layerHeight: 0.2 });
    expect(useEngraveJobStore.getState().job.sources?.stock?.colour).toBe('computed');

    // An omitted key still means "leave it alone" — every other caller relies on that.
    setStock({ thickness: 4 });
    expect(useEngraveJobStore.getState().job.stock.colour).toEqual({ kind: 'printed', capMm: 9.0, layerHeight: 0.2 });

    // And the provenance goes with the value: a source for a value that is gone is a lie.
    setStock({ colour: undefined }, 'computed');
    const { job } = useEngraveJobStore.getState();
    expect('colour' in job.stock).toBe(false);
    expect(job.sources?.stock?.colour).toBeUndefined();
  });

  // #464 — `fibre` follows the same CLEAR rule as `print`, and the reason is the same shape: a
  // design import states the flag whenever the file states one, so re-importing a PLAIN PETG file
  // over a `PETG-CF` one must take it away — otherwise every later run is still weighed as cutting
  // an abrasive, which is a heavier number nobody asked for.
  it('setStock clears stock.fibre on an explicit undefined, and leaves it alone when omitted (#464)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const { setStock } = useEngraveJobStore.getState();

    setStock({ material: 'petg', fibre: 'cf' }, 'computed');
    expect(useEngraveJobStore.getState().job.stock.fibre).toBe('cf');
    expect(useEngraveJobStore.getState().job.sources?.stock?.fibre).toBe('computed');

    // An omitted key still says nothing about the blank.
    setStock({ thickness: 4 });
    expect(useEngraveJobStore.getState().job.stock.fibre).toBe('cf');

    // The provenance goes with the value.
    setStock({ fibre: undefined }, 'computed');
    const { job } = useEngraveJobStore.getState();
    expect('fibre' in job.stock).toBe(false);
    expect(job.sources?.stock?.fibre).toBeUndefined();
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
    expect(useEngraveJobStore.getState().job.stock.colour).toEqual({
      kind: 'printed',
      capMm: 0.81,
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
    });

    // The SAME badge, now without a print — stated explicitly, because `defaultBadgeParams` now
    // carries one (#368): the grid must go with it, or the stack limit keeps applying to a blank
    // whose print is no longer known.
    setStock(badgeBlankFor(defaultBadgeParams({ print: undefined })).stock, 'computed');
    const { job } = useEngraveJobStore.getState();
    expect(job.stock.colour).toBeUndefined();
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
      // #508 — the fresh job is SEATED: the default 12 mm plank rests on the ledge, so its proud is
      // 12 − 3.1 = 8.9 rather than the shipped placeholder 4.
      stockProud: 8.9,
    });

    // "Use the badge blank": the same patch the panel's button sends.
    setStock(badgeBlankFor(defaultBadgeParams()).stock, 'computed');
    const { stock, workholding } = useEngraveJobStore.getState().job;
    expect(stock.thickness).toBe(3.81);
    // The seated value, not half the blank — the number `viseForNewJob(…, stock)` gives.
    expect(workholding.vise.stockProud).toBeCloseTo(0.71, 9);
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
    expect(workholding.vise.stockProud).toBeCloseTo(0.71, 9);
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

// #419 J2 — `setups[]` on the job document.
//
// The saved shape is §5.4's `{ orientation, mount, itemIds, tools, registration, remount }`: the
// user's intent and the plan's provenance, never the planner's DERIVED `Setup` (rotation, stock
// states with their removals, findings) — that is recomputed from the job and goes stale.
describe('JobSetup (#419 J2)', () => {
  // The registration planner's real fixture, copied from `registrationPlanner.spec.ts`: the shop's
  // own defaults and the badge blank of Appendix C. A REAL `planRegistration` answer is the point
  // — it pins the schema mirror behaviourally, so a field the planner grows later cannot be
  // silently stripped on load (a hand-checked mirror is not evidence).
  const HERE = dirname(fileURLToPath(import.meta.url));
  const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
    defaults: unknown;
  };
  const { settings: REG } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

  const BLANK = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };

  function realPlan(mount: 'vise' | 'bracket'): RegistrationPlan {
    const result = planRegistration(
      {
        stock: BLANK,
        mount,
        expectedSurface: { machineZ: -56.172, from: 'the vise top and the blank’s proud height' },
        seekFromMachineZ: -3,
        fixtureBelowSurfaceMm: mount === 'vise' ? 0.72 : undefined,
        bracketOrigin:
          mount === 'bracket'
            ? { x: -181.55, y: -184.8, from: 'anchor 1 + (0, 0)', offsetMeasured: true }
            : undefined,
        // A clamp on the back edge, clear of the surface point: the plan carries it, so the
        // mirror's obstacle fields are exercised by the round trip too.
        mountObstacles:
          mount === 'bracket'
            ? [{ kind: 'clamp' as const, label: 'the clamp on the back edge', min: [12, 68] as [number, number], max: [27, 98] as [number, number], topZ: 12 }]
            : undefined,
      },
      REG,
    );
    if (!result.ok) throw new Error(result.reason);
    return result.plan;
  }

  /** Two setups as a job saves them: a top-up vise pass, then a flip held in the bracket. */
  function setupsFixture(): JobSetup[] {
    return [
      {
        id: 'setup-top',
        orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
        mount: { kind: 'vise', viseOpeningMm: 120 },
        itemIds: ['lbl-a', 'shp-a'],
        tools: ['flat-1.0', 'cat:cone-30'],
        registration: {
          method: 'vise',
          plan: realPlan('vise'),
          expected: 'the fixed jaw holds X and rotation, the front scan finds Y, ±0.05 mm',
        },
      },
      {
        id: 'setup-flip',
        orientation: { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' },
        mount: { kind: 'bracket', board: true },
        itemIds: ['shp-b'],
        tools: ['flat-1.0'],
        registration: {
          method: 'bracket',
          plan: realPlan('bracket'),
          expected: 'XY from the bracket ±0.1, one Z touch, ≤ 0.15 mm step',
        },
        remount: {
          instruction: [
            'Loosen both clamps.',
            'Turn it over SIDEWAYS: the left edge goes to the right.',
            'Push the SAME corner into the bracket and refit the clamps on the uncut margin.',
          ],
          confirm: {
            question: 'Which edge of the plate is against the bracket’s long arm now?',
            options: ['the edge with the four holes nearest it', 'the plain edge'],
            correct: 0,
          },
        },
      },
    ];
  }

  it('round-trips a job that carries setups, field for field', () => {
    const job = defaultEngraveJob();
    job.setups = setupsFixture();

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.setups).toEqual(job.setups);
    expect(parsed.job).toEqual(job);
  });

  it('pins the RegistrationPlan mirror against a REAL plan, reference fields included', () => {
    const plan = realPlan('vise');
    // #429's reference fields are OPTIONAL on the planner's answer; a plan that read an earlier
    // feature must come back whole too, or the registration would lose what it measured.
    const withReferences: RegistrationPlan = {
      ...plan,
      references: [
        {
          itemId: 'shp-a',
          name: 'the four holes',
          centre: { x: 19, y: 40 },
          size: { x: 6, y: 6 },
          xScans: [0, 1],
          yScans: [2],
        },
      ],
      referenceRotation: { between: ['shp-a', 'shp-b'], separation: 30, resolutionMm: 0.05 },
    };
    const [top] = setupsFixture();
    const job = defaultEngraveJob();
    job.setups = [{ ...top!, registration: { method: 'vise', plan: withReferences, expected: 'a feature cut in setup 1' } }];

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // `toEqual`, not a spot-check: this is what catches the planner adding a field the schema
    // mirror does not name — Zod would strip it and the two objects would differ.
    expect(parsed.job.setups![0]!.registration!.plan).toEqual(withReferences);
  });

  it('leaves setups ABSENT when the document has none — not [], not defaulted', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    expect('setups' in raw).toBe(false);

    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('setups' in parsed.job).toBe(false);
    expect(parsed.job.setups).toBeUndefined();
    expect(JSON.stringify(parsed.job)).not.toContain('"setups"');
  });

  it('a version-1 document parses and gains no setups key', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    const v1 = { ...raw, schemaVersion: 1 } as Record<string, unknown>;
    delete v1.sacrificial;
    delete v1.breakthrough;

    const parsed = parseEngraveJob(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(3);
    expect('setups' in parsed.job).toBe(false);
  });

  it('mints a setup id on parse exactly as the job id is minted', () => {
    const doc = JSON.parse(
      JSON.stringify({ ...defaultEngraveJob(), setups: setupsFixture() }),
    ) as { setups: { id?: string }[] };
    delete doc.setups[0]!.id;

    setSeededIds(true);
    try {
      const parsed = parseEngraveJob(doc);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      // The job itself carries its id, so the setup's is the first id this parse mints.
      expect(parsed.job.setups![0]!.id).toBe('setup-s000001');
    } finally {
      setSeededIds(false);
    }
  });

  it('jobSetups returns stored setups untouched', () => {
    const job = defaultEngraveJob();
    job.setups = setupsFixture();
    expect(jobSetups(job)).toBe(job.setups);
  });

  it('jobSetups reads a job without setups as ONE implicit top-up vise setup', () => {
    const job = defaultEngraveJob();
    const labelIds = job.labels.map((l) => l.id);
    // A disabled line, a disabled shape and a construction item are not work; nor is a keep-out.
    job.labels[1]!.enabled = false;
    job.shapes = [
      { id: 'shp-on', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true, width: 10, height: 5, cornerRadius: 0 },
      { id: 'shp-off', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: false, width: 10, height: 5, cornerRadius: 0 },
      { id: 'shp-reference', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true, construction: true, width: 10, height: 5, cornerRadius: 0 },
    ];
    job.combined = [
      { id: 'cmb', kind: 'border', position: { x: 0, y: 0 }, rotation: 0, depth: 1, enabled: true, inset: 2, width: 1 },
    ];
    job.traces = [
      { id: 'trc', kind: 'line', position: { x: 50, y: 30 }, rotation: 0, depth: 0.5, enabled: true, points: [[0, 0], [10, 0]], closed: false },
    ];
    job.vectors = [
      {
        id: 'vec',
        kind: 'vector',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 1,
        enabled: true,
        sourceName: 'mark.svg',
        contours: [[[0, 0], [1, 0], [1, 1]]],
        fillRule: 'NonZero',
        width: 1,
        height: 1,
      },
    ];
    job.drills = [
      { id: 'drl', kind: 'drill', position: { x: 10, y: 10 }, rotation: 0, depth: 2, enabled: true, through: false },
    ];
    job.keepOuts = [
      { id: 'ko', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, enabled: true, zCeiling: 2, width: 10, height: 5, cornerRadius: 0 },
    ];

    const [setup, ...rest] = jobSetups(job);
    expect(rest).toEqual([]);
    expect(setup!.id).toBe('setup-implicit');
    // A top-up mount is the identity: every stock face is at the machine face of the same name.
    expect(setup!.orientation).toEqual({
      top: 'top',
      bottom: 'bottom',
      left: 'left',
      right: 'right',
      front: 'front',
      back: 'back',
    });
    expect(setup!.mount).toEqual({ kind: 'vise' });
    // #516 item 5 — a fresh default job has no cutter, so the implicit setup names no tools.
    expect(setup!.tools).toEqual([]);
    // Enabled cutting items, in document order across the six lists.
    expect(setup!.itemIds).toEqual([labelIds[0]!, labelIds[2]!, 'shp-on', 'cmb', 'trc', 'vec', 'drl']);
    expect(setup!.registration).toBeUndefined();
    expect(setup!.remount).toBeUndefined();
    expect(setup!.itemIds).not.toContain('shp-off');
    expect(setup!.itemIds).not.toContain('shp-reference');
    expect(setup!.itemIds).not.toContain('ko');
  });
});

