/**
 * #964 — GOLDEN PINS FOR THE REBUILT ENGINE'S PROGRAMS.
 *
 * Empty until the CAM rebuild posts its first accepted programs (#957–#966). The list is
 * deliberately empty rather than absent: the contract is stated now so every engine slice lands
 * with its own pin in the same reviewed act, and the spec that compares a pin against a fresh
 * generation is written with the engine, not this scaffold.
 *
 * Each case, when it exists, lives under `fixtures/golden/model/<id>/` with:
 *   - `program.nc.sha256` and `verifier.json` — the same artefacts as the 10-24 badge pins;
 *   - `plan.json` — B's `ModelPlanOutput` (`{ perSetup: SetupPlan[] }`, #956 §3.0), the engine's
 *     own plan as it produced it. The validator below pins the amended interface's NAMES and
 *     OPTIONALITY, so a rename (`clSurface` → `clGrid`) or a reshaped op fails here, not in a
 *     consumer: `setupIndex`, `features`, `clGrid` (cutterKey/toleranceMm/minSpacingMm/
 *     maxSpacingMm), `ops` (`kind` ∈ pocket|contour|rough|rest|finish|pencil|chamfer, `region`,
 *     `outcome`), `sequence` (`cutterKey`, `cost` = #927's CycleTerms, `pinned`, `house`),
 *     `linking` (`rapidsCount`, `hopsCount`, `airFractionPct`), `programs` (ToolpathIR[]),
 *     `totalCostSeconds`. The three shapes the manager ruled on #956 are asserted as ruled:
 *     `sequence[].cost` is a `CycleCost` (`{ terms: CycleTerms, toolChangeSeconds, totalSeconds }`,
 *     `toolChanges` checked when present), `RegionRef.regionClearanceZ` is the per-region clearance
 *     (`ToolpathIR.safeZ` is the program-wide one), and `OpOutcome.passes[]` carries `PassRef`
 *     (`{ z, boundary, cleared, entry, exit }`). `OpOutcome.cleared` is the only optional field the
 *     note leaves optional; `OpOutcome.ir` and `OpOutcome.cutter` are required.
 *   - `estimate.json` — #927's cycle terms and the program facts the seven-line scorer reads;
 *   - `card.json` — the seven lines as `tests/tools/seven-lines.ts` prints them.
 * The manifest names the job, the goal mesh's sha256 (the mesh is a local input, injected like
 * `samples/3d`) and the setup the case pins (`setupIndex`, default 0).
 *
 * Regeneration is a deliberate act: `CASEMAKER_UPDATE_GOLDEN=1 npx vitest run
 * tests/unit/modelGolden.spec.ts`, with a landing note naming which artefact moved and why.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'golden', 'model');
const MANIFEST = join(GOLDEN, 'manifest.json');

interface ModelGoldenCase {
  /** The pin directory's name. */
  id: string;
  /** The job the pin was generated from, relative to the repository root. */
  job: string;
  /** The goal mesh's sha256 (the mesh is a local input, never committed). */
  meshSha256: string;
  /** Which entry of `ModelPlanOutput.perSetup` this case pins (default 0). */
  setupIndex?: number;
  /** What the program is, in words. */
  note?: string;
}

interface ModelGoldenManifest {
  version: number;
  note: string;
  cases: ModelGoldenCase[];
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ModelGoldenManifest;

/** B's #956 §3.0: the op kinds and region kinds, verbatim. */
const OP_KINDS = ['pocket', 'contour', 'rough', 'rest', 'finish', 'pencil', 'chamfer'] as const;
const REGION_KINDS = ['pocket', 'island-top', 'curved', 'contour', 'rim'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every(isNumber);

/**
 * Validate one `SetupPlan` against B's amended interface (#956 §3.0/§3.0.1).
 *
 * This is a SERIALISABLE surface: the run sheet, D's op list and the parity harness all read it,
 * so a field rename is a consumer break. The validator names the amended field in the failure, so
 * the fix is obvious (the one rename already ruled: `clSurface` → `clGrid`).
 */
function expectSetupPlan(plan: unknown, where: string): void {
  expect(isObject(plan), `${where}: a SetupPlan object`).toBe(true);
  if (!isObject(plan)) return;
  expect(isNumber(plan['setupIndex']), `${where}.setupIndex: number`).toBe(true);
  expect(isObject(plan['features']), `${where}.features: FeatureTree`).toBe(true);

  const clGrid = plan['clGrid'];
  expect(Array.isArray(clGrid), `${where}.clGrid (renamed from clSurface): array`).toBe(true);
  for (const [i, grid] of (Array.isArray(clGrid) ? clGrid : []).entries()) {
    expect(isObject(grid), `${where}.clGrid[${i}]: object`).toBe(true);
    if (!isObject(grid)) continue;
    expect(isString(grid['cutterKey']), `${where}.clGrid[${i}].cutterKey: string`).toBe(true);
    expect(isNumber(grid['toleranceMm']), `${where}.clGrid[${i}].toleranceMm: number`).toBe(true);
    expect(isNumber(grid['minSpacingMm']), `${where}.clGrid[${i}].minSpacingMm: number`).toBe(true);
    expect(isNumber(grid['maxSpacingMm']), `${where}.clGrid[${i}].maxSpacingMm: number`).toBe(true);
  }

  const ops = plan['ops'];
  expect(Array.isArray(ops), `${where}.ops: PlannedOp[]`).toBe(true);
  for (const [i, op] of (Array.isArray(ops) ? ops : []).entries()) {
    expect(isObject(op), `${where}.ops[${i}]: object`).toBe(true);
    if (!isObject(op)) continue;
    expect(OP_KINDS.includes(op['kind'] as (typeof OP_KINDS)[number]), `${where}.ops[${i}].kind: one of ${OP_KINDS.join('|')}`).toBe(true);
    const region = op['region'];
    expect(isObject(region), `${where}.ops[${i}].region: RegionRef`).toBe(true);
    if (isObject(region)) {
      expect(isString(region['id']), `${where}.ops[${i}].region.id: string`).toBe(true);
      expect(
        REGION_KINDS.includes(region['kind'] as (typeof REGION_KINDS)[number]),
        `${where}.ops[${i}].region.kind: one of ${REGION_KINDS.join('|')}`,
      ).toBe(true);
      expect(isObject(region['bounds']), `${where}.ops[${i}].region.bounds: Box2`).toBe(true);
      expect(isNumber(region['topZ']), `${where}.ops[${i}].region.topZ: number`).toBe(true);
      expect(isNumber(region['bottomZ']), `${where}.ops[${i}].region.bottomZ: number`).toBe(true);
      expect(Array.isArray(region['obstacles']), `${where}.ops[${i}].region.obstacles: ObstacleBox[]`).toBe(true);
      expect(isNumber(region['regionClearanceZ']), `${where}.ops[${i}].region.regionClearanceZ: number`).toBe(true);
    }
    const outcome = op['outcome'];
    expect(isObject(outcome), `${where}.ops[${i}].outcome: OpOutcome`).toBe(true);
    if (isObject(outcome)) {
      expect(isObject(outcome['ir']), `${where}.ops[${i}].outcome.ir: ToolpathIR`).toBe(true);
      expect(isString(outcome['cutter']), `${where}.ops[${i}].outcome.cutter: string`).toBe(true);
      // The only optional field the note leaves optional.
      if ('cleared' in outcome) {
        expect(Array.isArray(outcome['cleared']), `${where}.ops[${i}].outcome.cleared?: RegionAtZ[]`).toBe(true);
      }
      const passes = outcome['passes'];
      expect(Array.isArray(passes), `${where}.ops[${i}].outcome.passes: PassRef[]`).toBe(true);
      for (const [j, pass] of (Array.isArray(passes) ? passes : []).entries()) {
        const at = `${where}.ops[${i}].outcome.passes[${j}]`;
        expect(isObject(pass), `${at}: object`).toBe(true);
        if (!isObject(pass)) continue;
        expect(isNumber(pass['z']), `${at}.z: number`).toBe(true);
        expect(Array.isArray(pass['boundary']), `${at}.boundary: Polygon[]`).toBe(true);
        expect(isObject(pass['cleared']), `${at}.cleared: RegionAtZ`).toBe(true);
        expect(isVec3(pass['entry']), `${at}.entry: Vec3`).toBe(true);
        expect(isVec3(pass['exit']), `${at}.exit: Vec3`).toBe(true);
      }
    }
  }

  const sequence = plan['sequence'];
  expect(Array.isArray(sequence), `${where}.sequence: array`).toBe(true);
  for (const [i, entry] of (Array.isArray(sequence) ? sequence : []).entries()) {
    expect(isObject(entry), `${where}.sequence[${i}]: object`).toBe(true);
    if (!isObject(entry)) continue;
    expect(isString(entry['cutterKey']), `${where}.sequence[${i}].cutterKey: string`).toBe(true);
    expect(isObject(entry['cost']), `${where}.sequence[${i}].cost: CycleCost`).toBe(true);
    if (isObject(entry['cost'])) {
      const cost = entry['cost'];
      expect(isObject(cost['terms']), `${where}.sequence[${i}].cost.terms: CycleTerms`).toBe(true);
      if (isObject(cost['terms'])) {
        for (const term of ['movesSeconds', 'entrySeconds', 'spinUpSeconds', 'totalSeconds']) {
          expect(isNumber(cost['terms'][term]), `${where}.sequence[${i}].cost.terms.${term}: number`).toBe(true);
        }
      }
      expect(isNumber(cost['toolChangeSeconds']), `${where}.sequence[${i}].cost.toolChangeSeconds: number`).toBe(true);
      expect(isNumber(cost['totalSeconds']), `${where}.sequence[${i}].cost.totalSeconds: number`).toBe(true);
      // C's shape also carries the COUNT of changes; the ruling names the wrapper, so check it
      // when the skeleton states it rather than requiring a field the ruling did not list.
      if ('toolChanges' in cost) {
        expect(isNumber(cost['toolChanges']), `${where}.sequence[${i}].cost.toolChanges?: number`).toBe(true);
      }
    }
    expect(typeof entry['pinned'], `${where}.sequence[${i}].pinned: boolean`).toBe('boolean');
    expect(typeof entry['house'], `${where}.sequence[${i}].house: boolean`).toBe('boolean');
  }

  const linking = plan['linking'];
  expect(isObject(linking), `${where}.linking: object`).toBe(true);
  if (isObject(linking)) {
    expect(isNumber(linking['rapidsCount']), `${where}.linking.rapidsCount: number`).toBe(true);
    expect(isNumber(linking['hopsCount']), `${where}.linking.hopsCount: number`).toBe(true);
    expect(isNumber(linking['airFractionPct']), `${where}.linking.airFractionPct: number`).toBe(true);
  }

  const programs = plan['programs'];
  expect(Array.isArray(programs), `${where}.programs: ToolpathIR[]`).toBe(true);
  for (const [i, program] of (Array.isArray(programs) ? programs : []).entries()) {
    expect(isObject(program), `${where}.programs[${i}]: ToolpathIR`).toBe(true);
    if (isObject(program)) {
      expect(Array.isArray(program['operations']), `${where}.programs[${i}].operations: array`).toBe(true);
      // The program-wide clearance height: ToolpathIR's own `safeZ` (the per-region one is
      // `RegionRef.regionClearanceZ`); `stayDownClearanceMm` does not exist in the design.
      expect(isNumber(program['safeZ']), `${where}.programs[${i}].safeZ: number`).toBe(true);
    }
  }

  expect(isNumber(plan['totalCostSeconds']), `${where}.totalCostSeconds: number`).toBe(true);
}

describe('#964 golden pins for the rebuilt engine’s programs', () => {
  it('the pin list parses, and every case names the job and the mesh it was cut from', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.note).toContain('rebuilt engine');
    for (const c of manifest.cases) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.job.length).toBeGreaterThan(0);
      expect(c.meshSha256).toMatch(/^[0-9a-f]{64}$/);
      if (c.setupIndex !== undefined) expect(Number.isInteger(c.setupIndex)).toBe(true);
    }
  });

  it.skipIf(manifest.cases.length === 0)(
    'every pinned program carries the five artefacts the contract names',
    () => {
      for (const c of manifest.cases) {
        const dir = join(GOLDEN, c.id);
        expect(existsSync(dir)).toBe(true);
        // The hash pin, in the engrave-golden format: `sha256 <hash> (<bytes> bytes)`.
        const pin = readFileSync(join(dir, 'program.nc.sha256'), 'utf8').trim();
        expect(pin).toMatch(/^sha256 [0-9a-f]{64} \(\d+ bytes\)$/);
        // The verifier's own report on that text.
        expect(existsSync(join(dir, 'verifier.json'))).toBe(true);
        // #927's terms and the program facts, as the seven-line scorer reads them.
        const estimate = JSON.parse(readFileSync(join(dir, 'estimate.json'), 'utf8')) as {
          cycleSeconds: number;
          rapidsPer1000FeedLines: number;
          cutters: number;
        };
        expect(estimate.cycleSeconds).toBeGreaterThan(0);
        expect(estimate.rapidsPer1000FeedLines).toBeGreaterThanOrEqual(0);
        expect(estimate.cutters).toBeGreaterThan(0);
        // The card's seven lines, as the page prints them.
        const card = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')) as { lines: unknown[] };
        expect(card.lines).toHaveLength(7);
        // The engine's plan, in B's amended SetupPlan shape (validated above).
        const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { perSetup?: unknown[] };
        expect(Array.isArray(plan.perSetup), `${c.id}: ModelPlanOutput.perSetup`).toBe(true);
        const setup = (plan.perSetup ?? []).find(
          (entry) => isObject(entry) && entry['setupIndex'] === (c.setupIndex ?? 0),
        );
        expect(setup, `${c.id}: a SetupPlan with setupIndex ${c.setupIndex ?? 0}`).toBeDefined();
        expectSetupPlan(setup, `${c.id}.plan`);
      }
    },
  );

  it.skipIf(manifest.cases.length === 0)('no case directory is unlisted', () => {
    const listed = new Set(manifest.cases.map((c) => c.id));
    const dirs = readdirSync(GOLDEN, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.filter((d) => !listed.has(d))).toEqual([]);
  });

  it.skipIf(manifest.cases.length > 0)('states why the list is empty (the engine has not posted)', () => {
    expect(manifest.cases).toEqual([]);
    expect(manifest.note).toContain('Empty until');
  });
});
