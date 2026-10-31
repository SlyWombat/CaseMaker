/**
 * #743 P-8 — A BOARD WITH COPPER ON BOTH FACES.
 *
 * The set's top copper, bottom copper, outline and drills become TWO setups: setup 1 cuts the top
 * isolation and drills the holes; setup 2 turns the stock over (`orient`'s turn for the mount),
 * registers on the drilled holes, isolates the bottom copper and cuts the board out. The bottom
 * design is built in setup 2's own work frame, so it is mirrored exactly as the operator sees it
 * with that face up — and every pad still sits on its hole, which is what makes the registration
 * on the holes meaningful.
 *
 * The acceptance (design §10 P-8): with synthetic probe readings of a board that landed shifted,
 * setup 2's program lands on the hole centres within the plan's own resolution.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { planFromSetups } from '@/engine/cnc/setups/authoring';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { referenceOpenings, referenceRegistrationFor } from '@/engine/cnc/setups/registration';
import { setupsSettings } from '@/engine/cnc/setups/settings';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { pcbAlignmentOffer, withAlignmentHoles } from '@/engine/import/pcbAlignment';
import {
  applyCorrection,
  registrationSettings,
  runRegistration,
  type ProbeSpec,
  type ReferenceOpening,
} from '@/engine/cnc/registration';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { buildPcbJob, type PcbJobFile } from '../../scripts/lib/casemaker/pcbJob';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { EngraveVectorShape } from '@/types/engraveJob';

const HERE = join(process.cwd(), 'tests/unit');
const FIXTURES = join(HERE, 'fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));
const file = (name: string): PcbJobFile => ({ name, bytes: bytes(name) });
const BLANK = { length: 60, width: 40, thickness: 1.6 };
const TABS = { count: 3, width: 3, height: 1 };
const DEFAULTS = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

const engraver: ToolLibraryEntry = {
  key: 'inv:engrave-60',
  provenance: 'test',
  tool: flatEndMill(3.175, {
    id: 'pcb-engrave-0-1-60',
    name: '60° 0.1 mm engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.1,
    diameter: 3.175,
    halfAngle: 30,
    angle: 60,
    fluteLength: 12,
  }),
};
const corn: ToolLibraryEntry = {
  key: 'inv:corn-0-8',
  provenance: 'test',
  tool: flatEndMill(0.8, { id: 'pcb-corn-0-8', name: '0.8 mm corn bit', fluteLength: 20 }),
};
const bit = (key: string, id: string, d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { id, shape: 'drill', tipDiameter: d, diameter: d, fluteLength: 12 }),
});
const TOOLS = [engraver, bit('inv:d08', 'pcb-drill-0-8', 0.8), bit('inv:d10', 'pcb-drill-1-0', 1.0), corn];
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
  { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
  { cutterId: 'pcb-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
  { cutterId: 'pcb-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
];

const SET = (): PcbJobFile[] => [
  file('tiny-F_Cu.gbr'),
  file('tiny-B_Cu.gbr'),
  file('tiny-Edge_Cuts.gbr'),
  file('tiny-inside.drl'),
];

async function twoSided() {
  const built = await buildPcbJob(tl, SET(), { blank: BLANK, tabs: TABS, tools: TOOLS, catalogue: ROWS });
  if (!built.ok) throw new Error(built.error);
  const job = built.job;
  job.tool = engraver.tool;
  return { built, job };
}

describe('a two-sided board (#743 P-8)', () => {
  it('cuts both faces: setup 1 the top and the holes, setup 2 the flipped bottom and the cut-out', async () => {
    const { built, job } = await twoSided();
    expect(built.plan.twoSided).toBe(true);
    expect(job.setups).toHaveLength(2);
    const [one, two] = job.setups!;

    // Setup 1: the stock as supplied. Its items are the top isolation and the eight holes; its
    // cutters are the engraver and one drill per hole size.
    expect(one!.orientation.top).toBe('top');
    expect(one!.mount.kind).toBe('tape');
    const topFrame = (job.combined ?? []).find((c) => c.id === one!.itemIds[0]);
    expect(topFrame?.kind === 'frame' && topFrame.name).toBe('Isolate the top copper');
    expect(job.drills).toHaveLength(8);
    expect(one!.tools).toEqual([engraver.key, 'inv:d08', 'inv:d10']);
    // The cut-out is NOT setup 1's: the board is freed last, from the second side.
    expect((job.cutouts ?? []).every((c) => !one!.itemIds.includes(c.id))).toBe(true);

    // Setup 2: the board turned over the way the tape mount's flip says (a half turn about
    // machine Y), with its own bottom isolation and the cut-out.
    expect(two!.orientation).toEqual({
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
      front: 'front',
      back: 'back',
    });
    expect(two!.mount.kind).toBe('tape');
    expect(two!.tools).toEqual([engraver.key, corn.key]);
    expect(job.cutouts).toHaveLength(1);
    expect(two!.itemIds).toContain(job.cutouts![0]!.id);
    const bottomFrame = (job.combined ?? []).find((c) => c.id === two!.itemIds[0]);
    expect(bottomFrame?.kind === 'frame' && bottomFrame.name).toBe('Isolate the bottom copper');
    // The job's own cutter is the first program's.
    expect(job.toolKey).toBe(engraver.key);
  });

  it('puts the bottom copper on the holes, mirrored into setup 2’s work frame', async () => {
    const { built, job } = await twoSided();
    const plan = built.plan;
    expect(plan.second).not.toBeNull();
    const bottomCopper = plan.second!.items.vectors.find((v) => v.id === plan.second!.copperId)!;
    // The holes in setup 2's work frame are the setups engine's own reading of the flip.
    const read = planFromSetups(job, setupsSettings(DEFAULTS));
    expect(read.setups).toHaveLength(2);
    const { openings } = referenceOpenings(read.setups[1]!);
    expect(openings).toHaveLength(8);
    const rings = (bottomCopper as EngraveVectorShape).contours.map((r) =>
      r.map(([x, y]): [number, number] => [x + bottomCopper.position.x, y + bottomCopper.position.y]),
    );
    // The five pads are on drills (5,5), (10,7.5), (15,5), (25,5) and (30,10) in the file frame;
    // a file point on the board maps to setup 2's X = 48 − x, Y = y + 13.
    const pads: [number, number][] = [[5, 5], [10, 7.5], [15, 5], [25, 5], [30, 10]];
    let checked = 0;
    for (const [px, py] of pads) {
      const cx = 48 - px;
      const cy = py + 13;
      const opening = openings.find(
        (o) => Math.abs((o.min[0] + o.max[0]) / 2 - cx) < 1e-6 && Math.abs((o.min[1] + o.max[1]) / 2 - cy) < 1e-6,
      );
      expect(opening, `a hole at ${px}, ${py}`).toBeDefined();
      expect(pointInPolygons(rings, cx, cy)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it('posts one program per setup and cutter: the top, the drills, then the bottom and the cut-out', async () => {
    const { job } = await twoSided();
    const programs = setupPrograms(job);
    expect(programs.map((p) => [p.setupIndex, p.toolKey, p.itemIds.length])).toEqual([
      [1, engraver.key, 1],
      [1, 'inv:d08', 6],
      [1, 'inv:d10', 2],
      [2, engraver.key, 1],
      [2, corn.key, 1],
    ]);
    const gen = engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: TOOLS });
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs.map((p) => p.setupIndex)).toEqual([1, 1, 1, 2, 2]);
    expect(gen.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

function fakeBoard(holes: ReferenceOpening[], shift: { x: number; y: number }, rim = 0.15) {
  // The probe the plan carries: a touch reads the stock until its centre is this far inside an
  // opening (the measured effective rim offset, `registration.tipRadiusMm`).
  const RIM = rim;
  const SURFACE = -30;
  const G54 = { x: -150, y: -150 };
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: 0, y: 0, z: -3 };
  let alarmed = false;
  const lines: string[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const zAt = (wx: number, wy: number): number | null => {
    const x = wx - shift.x;
    const y = wy - shift.y;
    const onStock = x >= -RIM && x <= 60 + RIM && y >= -RIM && y <= 40 + RIM;
    const inHole = holes.some((h) => x > h.min[0] + RIM && x < h.max[0] - RIM && y > h.min[1] + RIM && y < h.max[1] - RIM);
    return onStock && !inHole ? SURFACE : null;
  };
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply(alarmed ? '<Alarm|MPos:0,0,0>' : '<Idle|MPos:0,0,0>');
      if (line === '$X') return (alarmed = false), reply('ok');
      if (alarmed) return reply('error:Alarm lock');
      if (['$H', 'G54', 'G92.1'].includes(line) || /^G10 L2 P1 /.test(line)) return reply('ok');
      if (line === 'M119') return reply('X_min:0 Y_min:0 Z_min:0 X_max:0 Y_max:0 Z_max:0 Probe:0');
      if (line === 'M491') return reply('[PRB:-9.890,-12.830,-76.063:1]\nok');
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        pos.x = Number(m[1]) + G54.x;
        pos.y = Number(m[2]) + G54.y;
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z += Number(m[1])), reply('ok');
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('probed in absolute mode');
        const target = pos.z - Number(m[1]);
        const hit = zAt(pos.x - G54.x, pos.y - G54.y);
        if (hit !== null && hit >= target && hit <= pos.z) {
          pos.z = hit;
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      return reply(`error:unexpected line ${line}`);
    },
  };
  return { console, lines };
}

describe('registering setup 2 on the drilled holes (#429)', () => {
  /**
   * A fake Z1 holding the board at its nominal place plus `shift` (design §10: synthetic readings,
   * no machine). The board is the blank's 60 × 40 rectangle at the surface; each drilled hole —
   * the plan's own opening, in setup 2's work frame — reads as a MISS once the probe's centre is
   * the rim offset inside it. #429's fake, with a fine probe's rim.
   */
  it('finds the flip on the drilled holes, and the bottom copper lands on them within the plan’s tolerance', async () => {
    const { job } = await twoSided();
    const read = planFromSetups(job, setupsSettings(DEFAULTS));
    const two = read.setups[1]!;
    const { openings } = referenceOpenings(two);
    expect(openings).toHaveLength(8);

    // A bench set up for board work: a fine stylus, a fine step, and little corner clearance.
    // (The measured 3D probe's ⌀2 mm ball cannot enter a ⌀0.8 mm hole at all; and #429's seeded
    // 2 mm corner clearance is written for pockets, where a scan's mid-line must clear real
    // corners — a round hole has none, so a board's shop keeps it small.)
    const probe: ProbeSpec = {
      id: 'probe-fine',
      variant: null,
      tip: { diameterMm: 0.3, rimOffsetMm: 0.15, rimOffsetUncertaintyMm: 0.05 },
    };
    const { settings: base } = registrationSettings(DEFAULTS, probe);
    const settings = { ...base, fineStepMm: 0.1, cornerClearanceMm: 0.1 };
    const planned = referenceRegistrationFor(
      two,
      { kind: 'tape' },
      { seatMachineZ: -31.6, seekFromMachineZ: -3, cornerRadius: 0 },
      settings,
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.references!.length).toBeGreaterThanOrEqual(2);
    expect(planned.plan.referenceRotation?.resolutionMm).toBeLessThan(settings.edgeMarginMm);

    // The board landed 0.2 mm right and 0.15 mm forward of where setup 2 expects it — more than
    // the plan's own resolution, and still enough of each hole left for the probe to read a miss.
    const shift = { x: 0.2, y: -0.15 };
    const fake = fakeBoard(openings, shift);
    const run = await runRegistration(planned.plan, { console: fake.console, operator: async () => true });
    if (!run.ok) throw new Error(run.reason);
    expect(run.outcome.usable, run.outcome.problems.join(' | ')).toBe(true);
    const applied = await applyCorrection(run.outcome, { console: fake.console, operator: async () => true }, { confirmed: true });
    expect(applied.ok).toBe(true);

    // THE ACCEPTANCE: each bottom pad, cut by setup 2's program at its nominal point, lands on its
    // hole within the plan's own turn resolution once the measured correction is in.
    const resolution = planned.plan.referenceRotation!.resolutionMm;
    const pads: [number, number][] = [[5, 5], [10, 7.5], [15, 5], [25, 5], [30, 10]];
    for (const [px, py] of pads) {
      const work = { x: 48 - px, y: py + 13 };
      const actual = { x: work.x + shift.x, y: work.y + shift.y };
      const landed = { x: work.x + run.outcome.offset.x, y: work.y + run.outcome.offset.y };
      expect(Math.hypot(landed.x - actual.x, landed.y - actual.y)).toBeLessThanOrEqual(resolution);
    }
    // And the correction is written only through the operator's confirmation (#429/Q12).
    expect(fake.lines.some((l) => l.startsWith('G10 L2 P1 X'))).toBe(true);
  });
});

describe('a two-sided board’s checks and sheet (#743 P-8)', () => {
  it('reads the holes in the outline’s setup: no hole is “off the board” just because it was flipped', async () => {
    const { job } = await twoSided();
    const { validateJob } = await import('@/engine/cnc/engrave/jobSetup');
    const findings = validateJob(job, null, { tools: TOOLS });
    expect(findings.some((f) => f.code === 'item-off-board')).toBe(false);
    expect(findings.some((f) => f.code === 'hole-no-cutter')).toBe(false);
    expect(findings.some((f) => f.code === 'setup-items-unassigned')).toBe(false);
  });

  it('names both faces and the turn between the setups on the run sheet', async () => {
    const { job } = await twoSided();
    const { buildRunSheet } = await import('@/engine/cnc/engrave/runSheet');
    const gen = engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: TOOLS });
    expect(gen.ok).toBe(true);
    const sheet = buildRunSheet(job, gen, null, new Date('2026-10-31T00:00:00Z'));
    const board = sheet.sections.find((s) => s.title.endsWith('· The board'))!;
    expect(board).toBeDefined();
    const text = board.steps.map((s) => `${s.text} ${s.value ?? ''}`).join('\n');
    expect(text).toContain('copper 0.035 mm on both faces');
    expect(text).toContain('setup 1 — 1 Isolate the top copper');
    expect(text).toContain('2 8 holes (⌀0.8 mm, ⌀1 mm)');
    expect(text).toContain('setup 2 — 3 Isolate the bottom copper');
    expect(text).toContain('4 Cut out the board · 3 tabs');
    expect(text).toContain('turn the board over');
    expect(text).toContain('the face now up goes DOWN');
    expect(text).toContain('Setup 2 is registered on the drilled holes');
  });
});

describe('the copper oracle on both faces (#743 P-8)', () => {
  it('judges each side on its own isolation program, in that setup’s work frame', async () => {
    const { job } = await twoSided();
    const { pcbCopperTopologyInputs } = await import('@/engine/cnc/engrave/pcbTopology');
    const { createSimSession } = await import('@/workers/sim/session');
    const { toSetup } = await import('@/engine/cnc/engrave/jobSetup');
    const { Z1 } = await import('@/engine/cnc/machine');
    const sides = pcbCopperTopologyInputs(job);
    expect(sides.map((s) => [s.setupIndex, s.faceUp])).toEqual([
      [1, 'top'],
      [2, 'bottom'],
    ]);
    const gen = engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: TOOLS });
    expect(gen.ok).toBe(true);
    const isolationOf = (setupIndex: number): number =>
      gen.programs.findIndex((p) => p.setupIndex === setupIndex && p.toolKey === engraver.key);
    const session = createSimSession(tl);
    try {
      for (const [i, side] of sides.entries()) {
        const at = isolationOf(side.setupIndex);
        expect(at).toBeGreaterThanOrEqual(0);
        const load = session.load(gen.programs[at]!.nc, toSetup(job, Z1), engraver.tool, Z1.id);
        expect(load.ok).toBe(true);
        const report = session.oracle([], side.input);
        expect(report.copper?.ok, `the ${side.faceUp} face`).toBe(true);
        expect(report.copper?.matched).toBe(report.copper?.designPieces);
        expect(report.copper?.shorts).toBe(0);
        expect(i).toBe(sides.indexOf(side));
      }
    } finally {
      session.dispose();
    }
  });
});

describe('a fix on the bottom face stays on the bottom face (#743 P-8)', () => {
  it('rewrites only the setup whose frame it is, and leaves the job’s own cutter alone', async () => {
    const { job } = await twoSided();
    const { applyCutterPlanToJob } = await import('@/engine/cnc/engrave/measuredPick');
    const { setupTools, toolItemsFor } = await import('@/engine/cnc/engrave/jobSetup');
    const bottom = jobSetups(job)[1]!;
    const frameId = bottom.itemIds[0]!;
    const tools = setupTools(bottom, job);
    const cutters = tools.map((key, i) => ({ key, items: [...toolItemsFor(bottom, key, i)] }));
    // The isolation moves to another engraver the library holds.
    const owner = cutters.find((c) => c.items.includes(frameId))!;
    owner.key = 'inv:engrave-30';
    const next = applyCutterPlanToJob(job, { cutters, setupIndex: 1 });
    expect(next.setups).toHaveLength(2);
    expect(next.setups![0]).toEqual(job.setups![0]);
    expect(next.setups![1]!.tools[0]).toBe('inv:engrave-30');
    expect(next.setups![1]!.toolItems?.['inv:engrave-30']).toEqual([frameId]);
    expect(next.toolKey).toBe(job.toolKey);
  });
});

describe('alignment holes for a board the probe cannot read (#743 P-8)', () => {
  const alignTools = [...TOOLS, bit('inv:d40', 'pcb-drill-4-0', 4)];
  /** The bench's own numbers, as the panel resolves them with the fitted ⌀2 mm 3D probe. */
  const seededProbe = () => {
    const { settings } = registrationSettings(DEFAULTS);
    return {
      tipDiameterMm: settings.tipDiameterMm,
      tipRadiusMm: settings.tipRadiusMm,
      fineStepMm: settings.fineStepMm,
      cornerClearanceMm: settings.cornerClearanceMm,
      edgeMarginMm: settings.edgeMarginMm,
      scanInsideMm: settings.scanInsideMm,
    };
  };
  const offerFor = (probe = seededProbe()) =>
    pcbAlignmentOffer({
      blank: BLANK,
      board: { left: 14, top: 15, width: 32, height: 10 },
      mount: { kind: 'tape' },
      probe,
      largestBoardHoleMm: 1.0,
    });
  /** A bench set for board work: the seeded ⌀2 mm 3D probe, a fine step and a tight corner. */
  const fineBench = () => ({ ...seededProbe(), fineStepMm: 0.1, cornerClearanceMm: 0.1 });

  it('states the hole size the probe needs, and offers two on the turn’s fixed line', () => {
    // The seeded corner clearance (2 mm) is written for pockets: on this 40 mm blank the flip line
    // has no scrap left beside the board that the scan rules would accept, so the offer says so
    // rather than promising a hole the plan then refuses.
    const coarse = offerFor();
    expect(coarse).not.toBeNull();
    expect(coarse!.minProbeableMm).toBe(5.4);
    expect(coarse!.holes).toEqual([]);
    expect(coarse!.message).toContain('needs holes of at least 5.4 mm');
    expect(coarse!.message).toContain("the board's largest is 1 mm");
    expect(coarse!.message).toContain('no room beside the board on the flip line');

    // A bench set for board work — the same ⌀2 mm probe, a fine step and a tight corner — has the
    // scrap for a 4 mm pair. The tape flip is a half turn about Y, so x = 30 is the fixed line and
    // each hole sits in the scrap beyond an end of the board (15..25), clear of both edges.
    const offer = offerFor(fineBench())!;
    expect(offer.minProbeableMm).toBe(2.2);
    expect(offer.diameterMm).toBe(4);
    expect(offer.holes).toEqual([
      { x: 30, y: 6.8 },
      { x: 30, y: 33.2 },
    ]);
    expect(offer.message).toContain('two 4 mm alignment holes');
    expect(offer.message).toContain('26.4 mm apart');
  });

  it('offers nothing when a board hole is already readable', () => {
    const fineProbe = { ...seededProbe(), tipDiameterMm: 0.3, tipRadiusMm: 0.15, fineStepMm: 0.1, cornerClearanceMm: 0.1 };
    expect(offerFor(fineProbe)).toBeNull();
  });

  it('with the holes added, setup 2 registers on them and finds a misplaced flip', async () => {
    const { job } = await twoSided();
    const bench = fineBench();
    const offer = offerFor(bench)!;
    const withHoles = withAlignmentHoles(job, offer.holes, offer.diameterMm, alignTools, ROWS);
    const added = withHoles.drills!.slice(8);
    expect(added.map((d) => [d.position.x, d.position.y, d.diameter, d.through])).toEqual([
      [30, 6.8, 4, true],
      [30, 33.2, 4, true],
    ]);
    expect(withHoles.setups![0]!.tools).toContain('inv:d40');

    const read = planFromSetups(withHoles, setupsSettings(DEFAULTS));
    const two = read.setups[1]!;
    const { openings } = referenceOpenings(two);
    expect(openings.filter((o) => o.max[0] - o.min[0] > 3)).toHaveLength(2);
    // The bench plans now: the alignment holes are the references, and the turn is judged across
    // the WORK (the 32 mm board), not the 60 mm blank.
    const { settings } = registrationSettings(DEFAULTS, null);
    const planned = referenceRegistrationFor(
      two,
      { kind: 'tape' },
      { seatMachineZ: -31.6, seekFromMachineZ: -3, cornerRadius: 0 },
      { ...settings, fineStepMm: bench.fineStepMm, cornerClearanceMm: bench.cornerClearanceMm },
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.references).toHaveLength(2);
    expect(planned.plan.notes.join(' ')).toContain('across the work');

    const shift = { x: 0.2, y: -0.15 };
    const fake = fakeBoard(openings, shift, bench.tipRadiusMm);
    const run = await runRegistration(planned.plan, { console: fake.console, operator: async () => true });
    if (!run.ok) throw new Error(run.reason);
    expect(run.outcome.usable, run.outcome.problems.join(' | ')).toBe(true);
    const resolution = planned.plan.referenceRotation!.resolutionMm;
    expect(Math.abs(run.outcome.offset.x - shift.x)).toBeLessThanOrEqual(resolution);
    expect(Math.abs(run.outcome.offset.y - shift.y)).toBeLessThanOrEqual(resolution);
  });

});
