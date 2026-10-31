/**
 * #743 P-5 — the PCB topology oracle: the simulated copper, at its underside, grouped into pieces
 * and compared with the design's own pieces.
 *
 * The unit case drives `computeCopperTopology` with the exact slice the isolation cut would leave
 * (the opened band) and with none at all (a program that never reached the copper — the shallow
 * file the design names). The integration case runs the REAL tiny board through Generate and the
 * sim session, so the seam between the sweep and the check is exercised too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { vCone } from '@/engine/cnc/vProfile';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { itemProfile, flatStockOutline } from '@/engine/cnc/engrave/partPlan';
import { planPcbImport, PCB_ISOLATION_DEPTH_MM } from '@/engine/import/pcbImport';
import { computeCopperTopology, pcbCopperTopologyInput } from '@/engine/cnc/engrave/pcbTopology';
import { buildPcbJob, type PcbJobFile } from '../../scripts/lib/casemaker/pcbJob';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import type { EngraveFrameShape, EngraveVectorShape } from '@/types/engraveJob';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));
const file = (name: string): PcbJobFile => ({ name, bytes: bytes(name) });
const BLANK = { length: 60, width: 40, thickness: 1.6 };
const TABS = { count: 3, width: 3, height: 1 };

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
  tool: flatEndMill(0.8, { id: 'pcb-corn-0-8', name: '0.8 mm corn bit', fluteLength: 12 }),
};
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
  { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
];

/** The `gaps-pass` board's band, copper and stock, placed by the real import. */
function gapsInput() {
  let n = 0;
  const plan = planPcbImport(tl, [{ name: 'gaps-pass.gbr', bytes: bytes('gaps-pass.gbr') }], {
    blank: BLANK,
    tabs: TABS,
    idFor: (what) => `${what}-${n++}`,
  });
  if (!plan.ok) throw new Error(plan.error);
  const copperItem = plan.items.vectors.find((v) => v.id === plan.copperId) as EngraveVectorShape;
  const frame = plan.items.frames[0] as EngraveFrameShape;
  const stock = flatStockOutline({ length: BLANK.length, width: BLANK.width });
  const copper = itemProfile(copperItem, []);
  const band = itemProfile(frame, [], { stockOutline: stock, profileOf: (id) => (id === plan.copperId ? copper : null) });
  return { capMm: 0.035, stock, copper, band };
}

/** The slice the isolation leaves at the copper's underside: the band, opened by the plane radius. */
function cutSlice(input: ReturnType<typeof gapsInput>) {
  const cone = vCone(engraver.tool)!;
  const planeRadius = cone.tipRadius + (PCB_ISOLATION_DEPTH_MM - input.capMm) * cone.tanHalf;
  const opened = executeProfile(tl, engravableProfile(input.band, planeRadius));
  return { opened, planeRadius };
}

describe('the copper topology (#743 P-5)', () => {
  it('reports 2 pieces, 2 matched and no shorts for a board whose gaps open', () => {
    const input = gapsInput();
    const { opened } = cutSlice(input);
    // `computeCopperTopology` owns every handle `sliceAt` returns (the OracleSliceAt contract).
    const report = computeCopperTopology(tl, () => opened, input, 0.02);
    expect(report.ok).toBe(true);
    expect(report.designPieces).toBe(2);
    expect(report.pieces).toBe(2);
    expect(report.matched).toBe(2);
    expect(report.shorts).toBe(0);
    expect(report.bandLeftMm2).toBeLessThanOrEqual(1e-3);
  });

  it('fails a program that never reached the copper — copper left in the band', () => {
    // A 0.03 mm file against a 0.035 mm copper leaves the whole clad in place: the two pads are one
    // piece, so the design's two are joined.
    const input = gapsInput();
    const report = computeCopperTopology(tl, () => null, input, 0.02);
    expect(report.ok).toBe(false);
    expect(report.matched).toBe(2);
    expect(report.shorts).toBe(1);
    expect(report.bandLeftMm2).toBeGreaterThan(1e-3);
  });

  it('is null on a job that is not a board', () => {
    expect(pcbCopperTopologyInput({ ...emptyJob(), stock: { ...emptyJob().stock, material: 'pla', colour: undefined } })).toBeNull();
  });
});

/** The smallest job shape the derivation reads; it carries no board, so it answers null. */
function emptyJob() {
  return {
    stock: { length: 60, width: 40, thickness: 1.6, material: 'pcb' as const },
    labels: [],
    shapes: [],
    combined: [],
    vectors: [],
    customFonts: [],
  } as unknown as Parameters<typeof pcbCopperTopologyInput>[0];
}

describe('the copper topology through the real sweep (#743 P-5)', () => {
  it('passes the tiny board’s isolation program, from the swept stock', async () => {
    const built = await buildPcbJob(tl, [file('tiny-F_Cu.gbr'), file('tiny-Edge_Cuts.gbr'), file('tiny.drl')], {
      blank: BLANK,
      tabs: TABS,
      tools: [engraver, corn],
      catalogue: ROWS,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const job = built.job;
    job.toolKey = engraver.key;
    const gen = engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: [engraver, corn] });
    expect(gen.ok).toBe(true);
    const pcb = pcbCopperTopologyInput(job);
    expect(pcb).not.toBeNull();
    if (pcb === null) return;
    // The isolation program alone — the copper is separated by it, whatever the holes and outline
    // do later. The design copper here is four pieces (two pads on a trace, a macro pad, the pour,
    // the arc).
    const session = createSimSession(tl);
    try {
      const load = session.load(gen.programs[0]!.nc, toSetup(job, Z1), engraver.tool, Z1.id);
      expect(load.ok).toBe(true);
      const report = session.oracle([], pcb);
      expect(report.copper).toBeDefined();
      expect(report.copper?.matched).toBe(report.copper?.designPieces);
      expect(report.copper?.shorts).toBe(0);
      expect(report.copper?.ok).toBe(true);
      expect(report.ok).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('fails a cut that never reaches the copper — copper left in the band', async () => {
    // The 0.1 mm isolation posts and sweeps; the stock's stated copper is 0.12 mm, so the file
    // stops above the copper's underside. That is the design's "deliberately posted shallow
    // program" case, and the simulated copper is what the check must read.
    const built = await buildPcbJob(tl, [file('gaps-pass.gbr')], {
      blank: BLANK,
      tabs: TABS,
      tools: [engraver, corn],
      catalogue: ROWS,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const job = built.job;
    job.toolKey = engraver.key;
    const gen = engraveGenerate(tl, job, engraver.tool, ROWS, null, undefined, { tools: [engraver, corn] });
    expect(gen.ok).toBe(true);
    const pcb = pcbCopperTopologyInput(job);
    expect(pcb).not.toBeNull();
    if (pcb === null) return;
    const session = createSimSession(tl);
    try {
      const load = session.load(gen.programs[0]!.nc, toSetup(job, Z1), engraver.tool, Z1.id);
      expect(load.ok).toBe(true);
      const report = session.oracle([], { ...pcb, capMm: 0.12 });
      expect(report.copper?.ok).toBe(false);
      expect(report.copper?.shorts).toBe(1);
      expect(report.copper?.bandLeftMm2).toBeGreaterThan(1e-3);
      expect(report.ok).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
