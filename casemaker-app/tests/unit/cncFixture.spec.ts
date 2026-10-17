// The fixture as an obstacle envelope (#203, decision 28): the vise's two boxes, their
// provenance, and the saved-measurement round-trip through settings.
//
// Pure geometry + zustand + localStorage. The settings store reads localStorage (and its
// `window` guard) at module load, so both are faked BEFORE the store is dynamically imported.

import { describe, it, expect, vi } from 'vitest';

// A minimal in-memory Storage, installed before any store import. The unit suite runs on node,
// where neither localStorage nor window exists and the settings store deliberately no-ops.
const backing = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = globalThis;
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

import {
  DEFAULT_VISE,
  GRIP_MIN,
  VISE_BODY_DEPTH,
  boxesOverlap,
  defaultStockProud,
  inflate,
  todayISODate,
  uncertaintyFor,
  validateVise,
  viseEnvelope,
  viseForNewJob,
} from '@/engine/cnc/fixture';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { noneSacrificial, presetJawStrips } from '@/engine/cnc/sacrificial';
import { Z1 } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { ObstacleBox } from '@/engine/cnc/setup';
import type { Sacrificial, ViseParams } from '@/types/engraveJob';
import type { Vec3 } from '@/types/units';

const STOCK = { length: 100, width: 60, thickness: 12 };
const STOCK_BOX: ObstacleBox = {
  id: 'stock',
  label: 'stock',
  min: [0, 0, -STOCK.thickness] as Vec3,
  max: [STOCK.length, STOCK.width, 0] as Vec3,
};

async function freshSettings() {
  vi.resetModules();
  return await import('@/store/settingsStore');
}

describe('viseEnvelope (#203)', () => {
  it('puts the fixed jaw on x = 0 and the moving jaw on x = length, tops at -stockProud', () => {
    const env = viseEnvelope(STOCK, DEFAULT_VISE);
    expect(env.boxes.map((b) => b.id)).toEqual(['vise-fixed-jaw', 'vise-moving-jaw']);

    const fixed = env.boxes[0]!;
    const moving = env.boxes[1]!;
    expect(fixed.max[0]).toBe(0);
    expect(moving.min[0]).toBe(STOCK.length);
    expect(fixed.max[2]).toBe(-DEFAULT_VISE.stockProud);
    expect(moving.max[2]).toBe(-DEFAULT_VISE.stockProud);
  });

  it('neither jaw box overlaps the stock volume by more than a shared face', () => {
    const env = viseEnvelope(STOCK, DEFAULT_VISE);
    const fixed = env.boxes[0]!;
    // They share the plane x = 0, and the jaws' Y and Z ranges do overlap there — but only on
    // that face, so the interiors never intersect.
    expect(fixed.max[0]).toBe(STOCK_BOX.min[0]);
    for (const box of env.boxes) {
      expect(boxesOverlap(box, STOCK_BOX)).toBe(false);
      expect(boxesOverlap(STOCK_BOX, box)).toBe(false);
    }
  });

  it('carries source and uncertainty through, un-inflated', () => {
    const env = viseEnvelope(STOCK, { ...DEFAULT_VISE, source: 'saved', uncertainty: 0.5 });
    expect(env.source).toBe('saved');
    expect(env.uncertainty).toBe(0.5);
    // The box min Z is thickness + body depth below the top — the raw, un-inflated value.
    expect(env.boxes[0]!.min[2]).toBe(-(STOCK.thickness + VISE_BODY_DEPTH));
  });
});

describe('inflate / boxesOverlap (#203)', () => {
  const box: ObstacleBox = { id: 'b', label: 'b', min: [-1, -2, -3], max: [4, 5, 6] };

  it('grows every bound by the given amount', () => {
    const grown = inflate(box, 2);
    expect(grown.min).toEqual([-3, -4, -5]);
    expect(grown.max).toEqual([6, 7, 8]);
  });

  it('is symmetric and false for boxes that only touch', () => {
    const left: ObstacleBox = { id: 'l', label: 'l', min: [0, 0, 0], max: [10, 10, 10] };
    const right: ObstacleBox = { id: 'r', label: 'r', min: [10, 0, 0], max: [20, 10, 10] };
    expect(boxesOverlap(left, right)).toBe(false);
    expect(boxesOverlap(right, left)).toBe(false);

    const overlapping: ObstacleBox = { id: 'o', label: 'o', min: [9, 0, 0], max: [20, 10, 10] };
    expect(boxesOverlap(left, overlapping)).toBe(true);
    expect(boxesOverlap(overlapping, left)).toBe(true);
  });
});

describe('validateVise (#203)', () => {
  it('does not refuse a blank at or below the jaw tops by itself (#488)', () => {
    // The blank's height says nothing about whether its cuts reach a jaw; `validateJob` measures the
    // cuts and notes the height (`vise-stock-not-proud`) or refuses a cut (`vise-jaw-collision`).
    const findings = validateVise(STOCK, { ...DEFAULT_VISE, stockProud: 0 });
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(findings.map((f) => f.code)).not.toContain('vise-stock-not-proud');
  });

  it('errors when the stock stands proud by its whole thickness', () => {
    const findings = validateVise(STOCK, { ...DEFAULT_VISE, stockProud: STOCK.thickness });
    expect(
      findings.some((f) => f.code === 'vise-stock-proud-exceeds-thickness' && f.severity === 'error'),
    ).toBe(true);
  });

  it('warns below the (provisional) grip threshold', () => {
    const findings = validateVise(STOCK, { ...DEFAULT_VISE, stockProud: STOCK.thickness - GRIP_MIN + 0.5 });
    expect(findings.some((f) => f.code === 'vise-grip-shallow')).toBe(true);
  });

  it('warns when the jaws cover less than half the stock width', () => {
    const findings = validateVise(STOCK, { ...DEFAULT_VISE, jawStartY: 40, jawLength: 10 });
    expect(findings.some((f) => f.code === 'vise-jaw-short')).toBe(true);
  });

  it('the shipped default produces exactly one warning: vise-default', () => {
    const findings = validateVise(STOCK, DEFAULT_VISE);
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    const warnings = findings.filter((f) => f.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('vise-default');
  });
});

describe('toSetup fills the fixture (#203)', () => {
  it('gives the setup two boxes with source default', () => {
    const setup = toSetup(defaultEngraveJob(), Z1);
    expect(setup.fixture).toBeDefined();
    expect(setup.fixture!.boxes).toHaveLength(2);
    expect(setup.fixture!.source).toBe('default');
    expect(setup.fixture!.uncertainty).toBe(DEFAULT_VISE.uncertainty);
  });
});

describe('viseEnvelope with sacrificial material (#213)', () => {
  /** A 6 mm flush left strip, clamped between the fixed jaw and the part. */
  const leftStrip = (): Sacrificial => ({
    ...noneSacrificial(),
    sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
  });

  it('moves the fixed jaw face out to x = −6 for a 6 mm left strip, keeping its thickness', () => {
    const env = viseEnvelope(STOCK, DEFAULT_VISE, leftStrip());
    const fixed = env.boxes[0]!;
    expect(fixed.max[0]).toBe(-6);
    // The whole box translates: the body keeps `fixedJawThickness`.
    expect(fixed.min[0]).toBe(-6 - DEFAULT_VISE.fixedJawThickness);
    // No right material: the moving jaw stays on the part's far edge.
    expect(env.boxes[1]!.min[0]).toBe(STOCK.length);
  });

  it('takes the larger of the strip and the board overhang on each side', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      under: { thickness: 5, overhang: { left: 10, right: 2, front: 0, back: 0 }, attach: 'tape' },
    };
    const env = viseEnvelope(STOCK, DEFAULT_VISE, s);
    expect(env.boxes[0]!.max[0]).toBe(-10);
    expect(env.boxes[1]!.min[0]).toBe(STOCK.length + 2);
  });

  it('no sacrificial material is the pre-#213 envelope exactly (shift 0, no -0 bounds)', () => {
    const env = viseEnvelope(STOCK, DEFAULT_VISE, noneSacrificial());
    expect(env).toEqual(viseEnvelope(STOCK, DEFAULT_VISE));
    expect(Object.is(env.boxes[0]!.max[0], -0)).toBe(false);
    expect(Object.is(env.boxes[1]!.min[0], -0)).toBe(false);
  });

  it("toSetup moves the jaw faces and the fixture boxes with the shift", () => {
    const job = { ...defaultEngraveJob(), sacrificial: presetJawStrips() };
    const setup = toSetup(job, Z1);
    if (setup.workholding.kind !== 'vise') throw new Error('expected a vise');
    expect(setup.workholding.jawFaces[0]!.origin[0]).toBe(-6);
    expect(setup.workholding.jawFaces[1]!.origin[0]).toBe(job.stock.length + 6);
    expect(setup.fixture!.boxes[0]!.max[0]).toBe(-6);
    expect(setup.fixture!.boxes[1]!.min[0]).toBe(job.stock.length + 6);
    // The model rides onto the Setup so the sweep can model the second body.
    expect(setup.sacrificial).toEqual(presetJawStrips());
  });
});

describe('the shipped default, and its provenance (#203)', () => {
  it('uses the shipped default when no saved vise is passed', () => {
    // `defaults.ts` now imports DEFAULT_VISE instead of keeping a second copy of its numbers.
    expect(defaultEngraveJob().workholding.vise).toEqual(DEFAULT_VISE);
  });

  it('takes a saved vise passed in, as a copy the caller keeps', () => {
    const saved: ViseParams = {
      ...DEFAULT_VISE,
      source: 'saved',
      uncertainty: uncertaintyFor('saved'),
      measuredAt: '2026-09-01',
    };
    const job = defaultEngraveJob(saved);
    expect(job.workholding.vise).toEqual(saved);
    expect(job.workholding.vise).not.toBe(saved);
    // A copy: patching the job cannot mutate the caller's object (or DEFAULT_VISE).
    job.workholding.vise.stockProud = 99;
    expect(saved.stockProud).toBe(DEFAULT_VISE.stockProud);
    expect(DEFAULT_VISE.stockProud).toBe(4);
  });

  it('the calipered band is 0.5 for every source: the shipped set is measured on the reference unit', () => {
    // Both bands were 0.5 by 2026-10-15 (§11.8's widths were the 2 mm: the shipped numbers were
    // nobody's reading). `uncertaintyFor` stays because a source that is NOT a reading would need
    // its own band — a `saved` vise whose user typed numbers off a datasheet, say — but today the
    // caliper is what every source's figures rest on.
    expect(uncertaintyFor('default')).toBe(0.5);
    expect(uncertaintyFor('saved')).toBe(0.5);
    expect(uncertaintyFor('measured')).toBe(0.5);
  });

  it('viseForNewJob falls back to the shipped default, or copies a saved vise', () => {
    expect(viseForNewJob()).toEqual(DEFAULT_VISE);
    const saved: ViseParams = { ...DEFAULT_VISE, source: 'saved', uncertainty: 0.5 };
    const picked = viseForNewJob(saved);
    expect(picked).toEqual(saved);
    expect(picked).not.toBe(saved); // a copy, so patching it cannot mutate settings
  });
});

describe('the saved vise round-trips through settings (#203)', () => {
  it('save a vise, reload, and the next job picks it up as saved, with its date', async () => {
    backing.clear();
    const saved: ViseParams = {
      ...DEFAULT_VISE,
      source: 'saved',
      uncertainty: uncertaintyFor('saved'),
      measuredAt: '2026-09-01',
    };

    const first = await freshSettings();
    first.useSettingsStore.getState().setVise(saved);
    expect(first.useSettingsStore.getState().fixtures.vise).toEqual(saved);

    const second = await freshSettings();
    const restored = second.useSettingsStore.getState().fixtures.vise;
    expect(restored).toEqual(saved);

    // A new job resolves its vise from the saved measurement, so its source is 'saved'.
    expect(viseForNewJob(restored).source).toBe('saved');
    // ...and the envelope copies the measurement date through (#203 review).
    expect(viseEnvelope(STOCK, restored!).measuredAt).toBe('2026-09-01');
  });

  it('stamps today when a saved vise is persisted without a date', async () => {
    backing.clear();
    const { useSettingsStore } = await freshSettings();
    useSettingsStore.getState().setVise({ ...DEFAULT_VISE, source: 'saved', uncertainty: 0.5 });
    expect(useSettingsStore.getState().fixtures.vise!.measuredAt).toBe(todayISODate());
  });

  it('persists a shipped default with no date (a default is not a measurement)', async () => {
    backing.clear();
    const { useSettingsStore } = await freshSettings();
    useSettingsStore.getState().setVise(DEFAULT_VISE);
    expect(useSettingsStore.getState().fixtures.vise!.measuredAt).toBeUndefined();
  });

  it('drops a half-written vise rather than honouring part of it', async () => {
    backing.clear();
    const first = await freshSettings();
    first.useSettingsStore.getState().setVise(DEFAULT_VISE);

    // Corrupt the persisted slice: a partial vise must not be loaded.
    localStorage.setItem(
      'casemaker.settings.v1',
      JSON.stringify({ ...first.useSettingsStore.getState(), fixtures: { vise: { stockProud: 4 } } }),
    );
    const second = await freshSettings();
    expect(second.useSettingsStore.getState().fixtures.vise).toBeUndefined();
  });

  it('clearVise forgets the saved measurement', async () => {
    backing.clear();
    const { useSettingsStore } = await freshSettings();
    useSettingsStore.getState().setVise(DEFAULT_VISE);
    expect(useSettingsStore.getState().fixtures.vise).toBeDefined();
    useSettingsStore.getState().clearVise();
    expect(useSettingsStore.getState().fixtures.vise).toBeUndefined();
  });
});

describe('measuredAt: the day a measurement was taken (#203 review)', () => {
  it('todayISODate renders a plain ISO YYYY-MM-DD date', () => {
    expect(todayISODate(new Date('2026-09-01T23:30:00Z'))).toBe('2026-09-01');
  });

  it('copies measuredAt from the vise onto the envelope, and leaves a default dateless', () => {
    const measured: ViseParams = { ...DEFAULT_VISE, source: 'measured', uncertainty: 0.5, measuredAt: '2026-09-01' };
    expect(viseEnvelope(STOCK, measured).measuredAt).toBe('2026-09-01');
    expect(viseEnvelope(STOCK, DEFAULT_VISE).measuredAt).toBeUndefined();
  });

  it('round-trips measuredAt through the job schema', () => {
    const job = defaultEngraveJob({ ...DEFAULT_VISE, source: 'saved', uncertainty: 0.5, measuredAt: '2026-09-01' });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding.vise.measuredAt).toBe('2026-09-01');
  });

  it('rejects a non-string measuredAt rather than stripping it', () => {
    const job = defaultEngraveJob();
    (job.workholding.vise as { measuredAt?: unknown }).measuredAt = 123;
    expect(parseEngraveJob(job).ok).toBe(false);
  });

  it('"I just measured these" marks the source measured and stamps the date', async () => {
    backing.clear();
    vi.resetModules();
    const { useEngraveJobStore } = await import('@/store/engraveJobStore');
    useEngraveJobStore.getState().setVise({ source: 'measured', uncertainty: 0.5, jawLength: 75 });
    const vise = useEngraveJobStore.getState().job.workholding.vise;
    expect(vise.source).toBe('measured');
    expect(vise.jawLength).toBe(75);
    expect(vise.measuredAt).toBe(todayISODate());
  });

  it('a new job in a fresh store takes the saved vise and its date', async () => {
    backing.clear();
    const saved: ViseParams = {
      ...DEFAULT_VISE,
      source: 'saved',
      uncertainty: uncertaintyFor('saved'),
      measuredAt: '2026-09-01',
    };
    const settings = await freshSettings();
    settings.useSettingsStore.getState().setVise(saved);

    // A fresh generation: settings reloads the saved vise, then the job store builds its
    // default job from it (the reading happens in the store, not in `defaultEngraveJob`).
    vi.resetModules();
    await import('@/store/settingsStore');
    const engrave = await import('@/store/engraveJobStore');
    const vise = engrave.useEngraveJobStore.getState().job.workholding.vise;
    expect(vise.source).toBe('saved');
    expect(vise.measuredAt).toBe('2026-09-01');
    expect(vise.stockProud).toBe(saved.stockProud);
  });
});

// #231 item 2 — `stockProud` is a job input (`ViseParams.stockProud`), and a NEW job resolves
// its default from the stock instead of the flat 4 mm that exceeds a thin blank and refuses it.
describe('stockProud: a job input with an honest default (#231 item 2)', () => {
  // The 3.81 mm badge blank #165 cuts: a flat 4 mm lies above the whole blank.
  const BADGE = { length: 76.2, width: 38.1, thickness: 3.81 };

  it('derives the default proud from the stock: the seated value, else half the thickness capped at 4 mm', () => {
    expect(defaultStockProud(12)).toBe(4); // the default blank: unchanged, the shipped 4 mm
    expect(defaultStockProud(8)).toBe(4);
    // 6 mm is past the seated rule (6 − 3.1 = 2.9) and under the 7.1 mm where the 4 mm cap starts to
    // decide, so the ledge is what the default takes.
    expect(defaultStockProud(6)).toBeCloseTo(2.9, 9);
    // The badge blank: seated on the 3.1 mm ledges it stands 0.71 mm proud (#208), which is BELOW
    // half the blank and so is the number the default carries (#391 review item 1).
    expect(defaultStockProud(3.81)).toBeCloseTo(0.71, 9);
    // A blank no taller than the ledge step gets the seated value too (#406): on the ledges its top
    // is at or below the jaw tops, so the proud is ≤ 0. It used to fall back to t/2 (1.5 on a 3 mm
    // blank), which put the modelled jaw top BELOW the real one. Since #488 the ≤ 0 value is not a
    // refusal: the job's cuts decide, and a cut that keeps the jaw clearance gets a note instead.
    expect(defaultStockProud(3.1)).toBe(0);
    expect(defaultStockProud(3)).toBeCloseTo(-0.1, 9);
    expect(defaultStockProud(2)).toBeCloseTo(-1.1, 9);
  });

  it('the shipped DEFAULT_VISE still refuses the badge blank — the gap this closes', () => {
    const findings = validateVise(BADGE, DEFAULT_VISE);
    expect(findings.some((f) => f.code === 'vise-stock-proud-exceeds-thickness')).toBe(true);
  });

  it('a new job on the badge blank gets an honest proud and is not refused', () => {
    const vise = viseForNewJob(undefined, BADGE);
    // The seated value, not half the blank: 0.71 mm is what the calipers say a badge blank on the
    // ledges stands proud of the jaw tops (#208/#391 review item 1).
    expect(vise.stockProud).toBeCloseTo(0.71, 9);
    // Still the SHIPPED set: the source, and so the `vise-default` warning, are unchanged — the
    // numbers are the product's, measured once on the reference unit, not this machine's vise.
    expect(vise.source).toBe('default');
    const codes = validateVise(BADGE, vise).map((f) => f.code);
    expect(codes).not.toContain('vise-stock-proud-exceeds-thickness');
  });

  it('never re-derives a saved or measured vise, even one that would refuse the stock', () => {
    const saved: ViseParams = { ...DEFAULT_VISE, source: 'saved', uncertainty: 0.5, stockProud: 5 };
    expect(viseForNewJob(saved, BADGE).stockProud).toBe(5);
    expect(viseForNewJob(saved, BADGE)).not.toBe(saved); // still a copy
  });

  it('no stock given keeps the shipped working height, so every caller before #231 is unchanged', () => {
    expect(viseForNewJob()).toEqual(DEFAULT_VISE);
    expect(viseForNewJob()).not.toBe(DEFAULT_VISE);
  });
});

// #406 — a blank no taller than the 3.1 mm ledge step. The default must never model the jaw tops
// LOWER than they really are, and on the ledges they are at or above this blank's top. So the
// default states the seated value rather than inventing a plane. Since #488 that value is not a
// refusal on its own: the job's cuts are measured against the jaw faces.
describe('a blank no taller than the ledge step (#406)', () => {
  const thin = (thickness: number) => ({ length: 40, width: 30, thickness });

  it('never models the jaw tops below the seated ones, for any blank', () => {
    // Seated on the ledges the real jaw top is at Z = LEDGE_STEP − t, relative to the stock top. The
    // modelled one, −stockProud, must be at or above it.
    for (let t = 0.5; t <= 14; t += 0.05) {
      const modelledJawTop = -defaultStockProud(t);
      expect(modelledJawTop).toBeGreaterThanOrEqual(3.1 - t - 1e-9);
    }
  });

  it('a new job on a 3 mm blank gets the seated value and is not refused', () => {
    const vise = viseForNewJob(undefined, thin(3));
    expect(vise.stockProud).toBeCloseTo(-0.1, 9);
    expect(validateVise(thin(3), vise).filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('the envelope puts the jaw tops at or above the thin blank’s top face', () => {
    const env = viseEnvelope(thin(3), viseForNewJob(undefined, thin(3)));
    for (const b of env.boxes) expect(b.max[2]).toBeGreaterThanOrEqual(0);
  });

  it('a stock below the jaw tops is gripped over its own height, never more — the shallow warning stays', () => {
    // 2 mm blank, 1.1 mm below the jaw tops: thickness − proud would read 3.1 mm gripped and pass.
    const findings = validateVise(thin(2), viseForNewJob(undefined, thin(2)));
    const grip = findings.find((f) => f.code === 'vise-grip-shallow');
    expect(grip).toBeDefined();
    expect(grip!.message).toContain('Only 2 mm');
  });

  it('a stated packer answers it: a proud the user gives is kept and not refused', () => {
    const packed: ViseParams = { ...DEFAULT_VISE, stockProud: 1, source: 'saved', uncertainty: 0.5 };
    expect(viseForNewJob(packed, thin(3)).stockProud).toBe(1);
    const codes = validateVise(thin(3), packed).map((f) => f.code);
    expect(codes).not.toContain('vise-stock-proud-exceeds-thickness');
  });
});

// #213 §2 — `vise-grip-shallow` judges what the jaws ACTUALLY grip: a strip between the jaw and
// the part, or an under-board whose overhang carries the jaw face out past the part. The
// threshold (`GRIP_MIN`) is left alone; only the height it is compared against changes.
describe('validateVise grip on the sacrificial stack (#213 §2)', () => {
  const THIN = { length: 76.2, width: 38.1, thickness: 3.81 };
  // A hand-set proud on the thin blank: grip 0.81 mm, so shallow with nothing else in the vise.
  const thinVise: ViseParams = { ...DEFAULT_VISE, stockProud: 3.0, source: 'saved', uncertainty: 0.5 };
  const underBoard = (
    thickness: number,
    overhang = { left: 10, right: 10, front: 0, back: 0 },
  ): Sacrificial => ({ ...noneSacrificial(), under: { thickness, overhang, attach: 'tape' } });
  const sideStrips = (thickness: number, height: 'flush' | number): Sacrificial => ({
    ...noneSacrificial(),
    sides: { left: { thickness, height }, right: { thickness, height }, front: null, back: null },
  });

  it('judges the raw stock when there is no sacrificial material', () => {
    const finding = validateVise(THIN, thinVise, noneSacrificial()).find(
      (f) => f.code === 'vise-grip-shallow',
    );
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('of the stock'); // the pre-#213 wording, kept
    expect(finding!.message).toContain('0.81 mm');
  });

  it('a BOARD under the part carries the jaws: grip becomes the board thickness', () => {
    const codes = validateVise(THIN, thinVise, underBoard(12)).map((f) => f.code);
    expect(codes).not.toContain('vise-grip-shallow'); // 12 mm gripped, not 0.81
  });

  it('a thin board is what is gripped, and the warning names its thickness', () => {
    const finding = validateVise(THIN, thinVise, underBoard(2)).find(
      (f) => f.code === 'vise-grip-shallow',
    );
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('2 mm');
    expect(finding!.message).toContain('the material between the jaws');
  });

  it('an overhang on one side only leaves the other jaw on the thin part: the weaker side governs', () => {
    const s = underBoard(12, { left: 10, right: 0, front: 0, back: 0 });
    expect(validateVise(THIN, thinVise, s).some((f) => f.code === 'vise-grip-shallow')).toBe(true);
  });

  it('a flush strip cannot deepen the grip: the jaw top still caps it at thickness − proud', () => {
    const codes = validateVise(THIN, thinVise, sideStrips(6, 'flush')).map((f) => f.code);
    expect(codes).toContain('vise-grip-shallow'); // same 0.81 mm as the bare part
  });

  it('a short strip is gripped over its own height, not the part’s', () => {
    const finding = validateVise(STOCK, DEFAULT_VISE, sideStrips(6, 2)).find(
      (f) => f.code === 'vise-grip-shallow',
    );
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('2 mm'); // not the part's 8 mm (12 − 4)
  });
});
