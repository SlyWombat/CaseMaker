// #923 — fixture and holder collision on the column engine. Before this, `columnEngine.ts` never
// read `setup.fixture`: a V-bit, drill, ball, thread or dense-flat program relied on the 2D
// plan-view `vise-jaw-collision` rule alone, while `simCoverage.ts` still claimed the modelled
// fixture was among the obstacles the sweep tested. These specs pin:
//  (1) the shared primitives extracted into `sweep.ts` (`prepareFixtureBoxes`,
//      `holderVsFixtureUnproven`, `fixtureUncheckedDiagnostic`, `columnFixtureHit`) in isolation;
//  (2) the acceptance's first fixture — a V-bit program that swings into a jaw is refused on the
//      COLUMN engine with the same code (`tool-into-fixture`) the EXACT engine raises for the
//      equivalent collision;
//  (3) the acceptance's second fixture — a program whose floor sits well above the jaw tops
//      passes both the 2D plan-view rule and this new 3D engine check, with the job's
//      `jawClearance` left at its default (not forced to 0). Originally a synthetic stand-in
//      (the real #941 job, `docs/bench/941-chamfer-slot.job.json` on branch `938-hardwood-coupon`,
//      was not on origin when this first landed — see the comment on issue #923). Kept as an
//      additional row, not replaced, once the real job landed (see (3b) below).
//  (3b) the REAL #941 job, as committed on `main` — `jawClearance: 0` and `edgeMargin: 0`, so the
//      2D plan-view rule is effectively off and this new engine check is the only jaw check the
//      job gets. Run end to end through `engraveJobMain` (generate -> post -> simulate), exactly
//      the pipeline the app and the bench CLI share.
//  (4) `simCoverage`'s coverage sentence correctly names the engine and the obstacles actually
//      tested, for both a column program and an exact-engine program.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tl } from './helpers/manifoldExec';
import { createSimSession } from '@/workers/sim/session';
import { stubSetup, type Setup, type ObstacleBox } from '@/engine/cnc/setup';
import { viseEnvelope, DEFAULT_VISE } from '@/engine/cnc/fixture';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { prepareFixtureBoxes, holderVsFixtureUnproven, fixtureUncheckedDiagnostic, columnFixtureHit } from '@/workers/geometry/sweep';
import { coverageDisclaimer, coverageSummaryLine, type SimCoverageInput } from '@/components/panels/simCoverage';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import type { Receipt, EngraveDetails } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');

/** The six fixture/holder codes #923 added or now raises from the column engine too. */
const FIXTURE_CODES = ['tool-into-fixture', 'rapid-into-fixture', 'feed-into-fixture', 'holder-into-fixture', 'holder-vs-fixture-unproven', 'fixture-unchecked'];

// ---------------------------------------------------------------------------------------
// (1) The shared primitives, in isolation — no Manifold, no timeline.
// ---------------------------------------------------------------------------------------
describe('#923 shared fixture primitives (sweep.ts)', () => {
  const jaw: ObstacleBox = { id: 'jaw', label: 'Vise fixed jaw', min: [-10, -10, -4], max: [0, 90, -4] };

  it('prepareFixtureBoxes inflates every box by the envelope uncertainty and names the tallest', () => {
    const tall: ObstacleBox = { id: 'tall', label: 'Tall clamp', min: [50, 0, 0], max: [55, 10, 8] };
    const prepared = prepareFixtureBoxes({ boxes: [jaw, tall], source: 'default', uncertainty: 1 });
    expect(prepared.boxes).toHaveLength(2);
    // Grown by 1 mm on every side.
    expect(prepared.boxes[0]).toMatchObject({ min: [-11, -11, -5], max: [1, 91, -3] });
    expect(prepared.top).toBeCloseTo(9, 6); // the tall clamp's 8, + 1 mm
    expect(prepared.tallest?.id).toBe('tall');
  });

  it('prepareFixtureBoxes is empty for an absent or empty fixture', () => {
    expect(prepareFixtureBoxes(undefined)).toEqual({ boxes: [], top: Number.NEGATIVE_INFINITY, tallest: null });
    expect(prepareFixtureBoxes({ boxes: [], source: 'default', uncertainty: 2 })).toEqual({ boxes: [], top: Number.NEGATIVE_INFINITY, tallest: null });
  });

  it('holderVsFixtureUnproven fires only when a fixture rises above the stock top and the holder is unknown', () => {
    expect(holderVsFixtureUnproven({ fixturePresent: false, fixtureTop: 10, topZ: 0, tallest: null, uncertainty: 0, holderKnown: false })).toBeNull();
    expect(holderVsFixtureUnproven({ fixturePresent: true, fixtureTop: -4, topZ: 0, tallest: jaw, uncertainty: 0, holderKnown: false })).toBeNull(); // below the top: moot
    expect(holderVsFixtureUnproven({ fixturePresent: true, fixtureTop: 10, topZ: 0, tallest: jaw, uncertainty: 0, holderKnown: true })).toBeNull(); // holder known
    const d = holderVsFixtureUnproven({ fixturePresent: true, fixtureTop: 10, topZ: 0, tallest: jaw, uncertainty: 0, holderKnown: false });
    expect(d).toMatchObject({ severity: 'warning', code: 'holder-vs-fixture-unproven' });
    expect(d?.message).toContain('Vise fixed jaw');
    expect(d?.message).toContain('cannot be proven');
  });

  it('fixtureUncheckedDiagnostic fires only when no fixture is modelled and the workholding has obstacles', () => {
    expect(fixtureUncheckedDiagnostic({ kind: 'tape-down', contact: { kind: 'p-rect', size: [10, 10] } }, false)).toBeNull(); // tape has no obstruction labels
    expect(fixtureUncheckedDiagnostic({ kind: 'vise', jawFaceXMin: 0, jawFaceXMax: 90 } as never, true)).toBeNull(); // fixture present: nothing to say
  });

  it('columnFixtureHit is a conservative (bounding-box) overlap test: never misses a true collision', () => {
    // A jaw with real height, Z −4 (top) down to the bed: unlike the zero-height box above.
    const tallJaw: ObstacleBox = { id: 'jaw', label: 'Vise fixed jaw', min: [-10, -10, -20], max: [0, 90, -4] };
    // The move's own segment plus radius reaches X = -0.5875 (0.5875 into the jaw, whose face is
    // at X = 0): a hit.
    const hit = columnFixtureHit([0.5, 10], [0.5, 50], 1.0875, -5, 10, [tallJaw]);
    expect(hit?.box.id).toBe('jaw');
    expect(hit?.volume).toBeGreaterThan(0);
    // Pulled 2 mm further right, the same radius falls short of the jaw face: no hit.
    expect(columnFixtureHit([2.5, 10], [2.5, 50], 1.0875, -5, 10, [tallJaw])).toBeNull();
    // Above the jaw's top (Z −4..10 is clear of the jaw's Z −20..−4): no hit even directly over
    // the jaw in XY.
    expect(columnFixtureHit([-5, 10], [-5, 50], 1.0875, -3, 10, [tallJaw])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// (2)+(3) The acceptance fixtures, through the real pipeline (`createSimSession` ->
// `session.load`, exactly as the Simulate panel calls it) — exercising `columnSweep`'s new
// fixture wiring and `session.ts`'s `fixtureSource` stamp, not a hand-built diagnostic.
// ---------------------------------------------------------------------------------------
describe('#923 acceptance: the column engine refuses a jaw collision, with the exact engine\'s own code', () => {
  // 100 x 60 x 12, the same blank `cncSweep.spec.ts`'s #204 suite uses, so the two engines are
  // compared on the identical vise: jaw tops at Z = -4 (stockProud 4), uncertainty 0.
  const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 12 };
  const STOCK = { length: 100, width: 60, thickness: 12 };
  const VISE = { ...DEFAULT_VISE, uncertainty: 0 };
  const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
  const fixtureSetup = (): Setup => stubSetup(SLAB, HOLD, { fixture: viseEnvelope(STOCK, VISE) });

  // A V-bit: `sweepsOnColumn` routes it to the column engine (it has no single cutting radius
  // the exact 2.5D sweeper's contract takes). 15° half-angle, so its cone widens fast enough to
  // reach the jaw within a few mm of depth.
  const HALF_DEG = 15;
  const vBit = (): Tool => flatEndMill(0.3, { name: '30° engraving bit', typeText: 'Engraving', shape: 'engraving', tipDiameter: 0.3, halfAngle: HALF_DEG, angle: 2 * HALF_DEG });
  const T3 = flatEndMill(3.175); // the exact engine's own tool, radius 1.5875 — cncSweep.spec.ts's #204 tool

  /** One stroke in Y from 10 to 50 at a constant X and depth (-Z), then clear — same shape as
   *  `cncSweep.spec.ts`'s #204 `stroke` helper. */
  const strokeGcode = (x: number, z: number) => `S1000 M3\nG0 X${x} Y10 Z1\nG1 Z${z} F100\nG1 Y50\n`;

  it('a V-bit stroke that swings into the fixed jaw is refused on the COLUMN engine, same code as the exact engine', () => {
    const session = createSimSession(tl);
    // X = 0.5, Z = -5: the cone's radius at 5 mm of depth (0.15 + 5·tan15°) is well past 0.5 mm,
    // so the cutter reaches past X = 0 into the fixed jaw (top Z = -4, face X = 0).
    const r = session.load(strokeGcode(0.5, -5), fixtureSetup(), vBit(), null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.stats.engine).toBe('column');
    const d = r.diagnostics.find((x) => x.code === 'tool-into-fixture');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('fixture');
    // The exact engine's own equivalent collision (the same vise, a flat end mill edge over the
    // jaw face) raises the identical code — `cncSweep.spec.ts`'s #204 suite already pins this for
    // the exact engine; this proves the column engine now raises the SAME one, not a look-alike.
    const exact = session.load(strokeGcode(1.0, -5), fixtureSetup(), T3, null);
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error(JSON.stringify(exact.diagnostics));
    expect(exact.stats.engine).toBe('exact');
    expect(exact.diagnostics.some((x) => x.code === 'tool-into-fixture')).toBe(true);
    session.dispose();
  });

  it('the same V-bit stroke well clear of the jaw raises no fixture code, and the golden-relevant fixtureSource stamp is present', () => {
    const session = createSimSession(tl);
    const r = session.load(strokeGcode(30, -5), fixtureSetup(), vBit(), null); // middle of the stock, far from either jaw
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.diagnostics.some((x) => x.code === 'tool-into-fixture')).toBe(false);
    expect(r.diagnostics.some((x) => x.code === 'fixture-unchecked')).toBe(false); // a fixture IS modelled
    // #923 — the stamp now means "this program's engine actually tested the fixture"; present for
    // a flat/column program (the only kind that models `setup.fixture` at all in this codebase).
    expect(r.fixtureSource).toBe('default');
    session.dispose();
  });

  it('a slot program whose floor sits well above the jaw tops passes the engine check, with jawClearance at its default (the #941 stand-in)', () => {
    // The manager's note on #923: the real #941 through-slot job posts with `jawClearance: 0`
    // because the 2D plan-view rule cannot see that the slot's floor is 6 mm above the jaw tops.
    // That branch (938-hardwood-coupon) was not on origin when this landed, so this is a
    // synthetic stand-in of the same shape: a cut to Z = -3 — 1 mm ABOVE the jaw tops at Z = -4 —
    // run the full width of the stock, well inside the vise's default clearance. Session A
    // reconciles this test against the real #941 job once #938 lands (see the comment on #923).
    const session = createSimSession(tl);
    const r = session.load(strokeGcode(1.0, -3), fixtureSetup(), vBit(), null); // X=1.0: edge over the jaw in XY, but the floor (Z-3) never reaches the jaw top (Z-4)
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.diagnostics.some((x) => x.code === 'tool-into-fixture')).toBe(false);
    // The job's own jawClearance is untouched — this test setup never set one away from the
    // vise's shipped default, exactly as the acceptance asks.
    expect(fixtureSetup().fixture?.source).toBe('default');
    session.dispose();
  });
});

// ---------------------------------------------------------------------------------------
// (3b) The REAL #941 job, run end to end through the app's own CLI pipeline — generate, post,
// simulate, exactly as `scripts/lib/casemaker/engrave.ts` and the Simulate panel do. Confirms
// #923's fix holds on the actual bench job, not only a hand-built fixture.
// ---------------------------------------------------------------------------------------
describe('#923 the REAL #941 job: chamfer + through-slot, jawClearance 0, edgeMargin 0', () => {
  it('posts clean, with zero fixture/holder codes anywhere, including on the column-engine program', async () => {
    const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-923-941-'));
    const outDir = join(SCRATCH, 'out');
    mkdirSync(outDir, { recursive: true });
    const jobPath = join(SCRATCH, 'job.json');
    writeFileSync(jobPath, readFileSync(join(REPO, 'docs', 'bench', '941-chamfer-slot.job.json'), 'utf8'));

    // The job's own tool is unnamed (`toolKey: ""`): the CAM search picks the house's real
    // chamfer bit and O-flute flat for it. Pulled from the committed house inventory fixture
    // (`fixtures/ball863/house-cutters.json`) rather than hand-built, so the dimensions are the
    // real bench tools' own — `kz-chamfer-90` (the one #941's own issue text names) and
    // `kz-o-flute-3-175-25` (the flat already owned by the fixture location's base inventory).
    const houseFx = JSON.parse(readFileSync(join(HERE, 'fixtures', 'ball863', 'house-cutters.json'), 'utf8')) as {
      inventory: { key: string; tool: unknown }[];
    };
    const house = (id: string): { key: string; tool: unknown } => houseFx.inventory.find((e) => e.key === `inv:${id}`)!;
    const baseLocation = join(HERE, 'fixtures', 'location-doc.json');
    const doc = JSON.parse(readFileSync(baseLocation, 'utf8')) as { tools: { key: string; provenance: string; origin: null; tool: unknown }[] };
    doc.tools.push(
      { key: 'inv:kz-chamfer-90', provenance: 'bench', origin: null, tool: house('kz-chamfer-90').tool },
      { key: 'inv:kz-o-flute-3-175-25', provenance: 'bench', origin: null, tool: house('kz-o-flute-3-175-25').tool },
    );
    const location = join(SCRATCH, 'location.json');
    writeFileSync(location, JSON.stringify(doc, null, 2) + '\n');

    const held: { receipt: Receipt | null } = { receipt: null };
    const options: CommandOptions = {
      json: true,
      now: new Date('2026-11-02T12:00:00.000Z'),
      sink: { progress: () => {}, receipt: (r) => { held.receipt = r; } },
    };
    const code = await engraveJobMain([jobPath, '--out', outDir, '--location', location], options);
    const receipt = held.receipt;
    expect(code, JSON.stringify(receipt?.diagnostics ?? null)).toBe(0);
    expect(receipt?.ok, JSON.stringify(receipt?.diagnostics ?? null)).toBe(true);

    // Not one of the fixture/holder-into-fixture codes anywhere in the receipt — the slot's
    // jawClearance:0 and edgeMargin:0 leave the 2D plan-view rule unable to refuse anything here,
    // so this IS the check: both engines looked at the real jaws and found no collision.
    const fixtureHits = (receipt?.diagnostics ?? []).filter((d) => FIXTURE_CODES.includes(d.code));
    expect(fixtureHits, JSON.stringify(fixtureHits)).toEqual([]);

    // Three posted programs (O-flute slot, 1mm rest, 0.1mm chamfer); every one's own sweep is
    // error-free, and at least one of them ran on the COLUMN engine — the chamfer's cone routes
    // there (`sweepsOnColumn`), so #923's new column-engine fixture check is genuinely exercised
    // by this job, not only by the exact engine's programs.
    if (receipt === null || receipt.command !== 'engrave') throw new Error(`expected an engrave receipt, got ${JSON.stringify(receipt)}`);
    const details: EngraveDetails = receipt.details;
    if (details.kind !== 'job') throw new Error(`expected a job receipt, got ${JSON.stringify(details)}`);
    const programs = details.programs;
    expect(programs.length).toBeGreaterThan(0);
    for (const p of programs) expect(p.sim?.errorCount ?? 0, `${p.ncFile}: ${JSON.stringify(p.sim)}`).toBe(0);
    expect(programs.some((p) => p.sim?.engine === 'column')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (4) simCoverage's coverage sentence, for both engines, once the input is truthful (#923's own
// fix is upstream, in `columnSweep`/`session.ts`; this pins that `simCoverage.ts`'s existing,
// unmodified logic already reports the result correctly once it is).
// ---------------------------------------------------------------------------------------
describe('#923 simCoverage names the engine and the obstacles actually tested', () => {
  const base: SimCoverageInput = {
    outcome: 'swept',
    fixtureLabels: ['Vise fixed jaw', 'Vise moving jaw'],
    fixtureSource: 'default',
    sacrificialModelled: false,
    codes: [],
  };

  it('a column program that actually tested the fixture names it as checked, and names the sampled engine', () => {
    const lines = coverageDisclaimer({ ...base, engine: 'column' });
    expect(lines[0]).toContain('the modelled fixture (Vise fixed jaw, Vise moving jaw)');
    expect(lines.some((l) => l.includes('sampled column engine'))).toBe(true);
    expect(coverageSummaryLine({ ...base, engine: 'column' })).toContain('Checked against');
  });

  it('an exact-engine program names the fixture as checked with no column-sampling caveat', () => {
    const lines = coverageDisclaimer({ ...base, engine: 'exact' });
    expect(lines[0]).toContain('the modelled fixture (Vise fixed jaw, Vise moving jaw)');
    expect(lines.some((l) => l.includes('sampled column engine'))).toBe(false);
  });

  it('a run whose nut clearance could not be proven states the blind spot even though the fixture itself was checked', () => {
    const lines = coverageDisclaimer({ ...base, engine: 'column', codes: ['holder-vs-fixture-unproven'] });
    expect(lines[0]).toContain('the modelled fixture'); // the tool-vs-fixture check DID run
    expect(lines.some((l) => l.includes('collet nut'))).toBe(true); // the holder-vs-fixture check is named as a blind spot
  });

  it('no fixture modelled at all reads as a blind spot, never a default pass (gate statement 3)', () => {
    const lines = coverageDisclaimer({ ...base, engine: 'column', fixtureLabels: [], codes: ['fixture-unchecked'] });
    expect(lines[0]).not.toContain('the modelled fixture');
    expect(lines.some((l) => l.toLowerCase().includes('not checked'))).toBe(true);
  });
});
