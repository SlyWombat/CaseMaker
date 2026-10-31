/**
 * #743 P-5 — the isolation's own measurement: a gap the cut cannot open is a SHORT (an error),
 * and a trace the surface budget leaves finer than the cutter's tip is a warning.
 *
 * Real Manifold, the same harness the engravability specs use: the band's opening is the
 * morphological one the CAM's pocket erosion applies, so the refusal and the path agree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { pOffset, poly, type Profile } from '@/engine/compiler/profile';
import { itemProfile } from '@/engine/cnc/engrave/partPlan';
import { flatStockOutline } from '@/engine/cnc/engrave/partPlan';
import { planPcbImport, PCB_ISOLATION_DEPTH_MM } from '@/engine/import/pcbImport';
import { pcbIsolationFindings } from '@/workers/sim/pcbIsolation';
import type { EngraveFrameShape, EngraveVectorShape } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { buildPcbJob, type PcbJobFile } from '../../scripts/lib/casemaker/pcbJob';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';

const file = (name: string): PcbJobFile => ({ name, bytes: bytes(name) });
const ENGRAVER: ToolLibraryEntry = {
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
const CORN: ToolLibraryEntry = {
  key: 'inv:corn-0-8',
  provenance: 'test',
  tool: flatEndMill(0.8, { id: 'pcb-corn-0-8', name: '0.8 mm corn bit', fluteLength: 12 }),
};
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
  { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
];

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));

const BLANK = { length: 60, width: 40, thickness: 1.6 };
const CONE = vCone(
  flatEndMill(3.175, {
    name: '60° 0.1 mm engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.1,
    diameter: 3.175,
    halfAngle: 30,
    angle: 60,
    fluteLength: 12,
  }),
)!;

/** The band and copper a Gerber file becomes, placed on the blank by the real import. */
function imported(name: string): { band: Profile; copper: Profile; frameId: string } {
  let n = 0;
  const plan = planPcbImport(tl, [{ name, bytes: bytes(name) }], {
    blank: BLANK,
    tabs: { count: 3, width: 3, height: 1 },
    idFor: (what) => `${what}-${n++}`,
  });
  if (!plan.ok) throw new Error(plan.error);
  const copperItem = plan.items.vectors.find((v) => v.id === plan.copperId) as EngraveVectorShape;
  const frame = plan.items.frames[0] as EngraveFrameShape;
  const stockOutline = flatStockOutline({ length: BLANK.length, width: BLANK.width });
  const copper = itemProfile(copperItem, []);
  const band = itemProfile(frame, [], { stockOutline, profileOf: (id) => (id === plan.copperId ? copper : null) });
  return { band, copper, frameId: frame.id };
}

describe('isolation-short (#743 P-5)', () => {
  it('refuses a 0.15 mm gap beside a 0.40 mm one, and names the place', () => {
    const { band, copper, frameId } = imported('gaps.gbr');
    const findings = pcbIsolationFindings(tl, {
      band,
      copper,
      cone: CONE,
      depthMm: PCB_ISOLATION_DEPTH_MM,
      colourMm: 0.035,
      zToleranceMm: 0.02,
      frameId,
    });
    const short = findings.filter((f) => f.code === 'isolation-short');
    expect(short).toHaveLength(1);
    // #743 P-5 review — a WARNING: the board still cuts, and the operator may bridge the gap.
    expect(short[0]!.severity).toBe('warning');
    // 0.1 tip + 2 × (0.1 − 0.035) × tan 30° = 0.175 mm at the copper; the 0.15 gap is narrower.
    expect(short[0]!.message).toContain('0.175 mm wide at the copper');
    expect(short[0]!.message).toContain('the gap is 0.15 mm across');
    expect(short[0]!.message).toMatch(/near X \d+(\.\d)? Y \d+(\.\d)?/);
    expect(short[0]!.message).toContain('widen the gap');
    // No finer engraver in this list: the message carries the design fix and no button.
    expect(short[0]!.suggestedCutterKey).toBeUndefined();
  });

  it('passes a board whose only gap is 0.40 mm', () => {
    const { band, copper, frameId } = imported('gaps-pass.gbr');
    const findings = pcbIsolationFindings(tl, {
      band,
      copper,
      cone: CONE,
      depthMm: PCB_ISOLATION_DEPTH_MM,
      colourMm: 0.035,
      zToleranceMm: 0.02,
      frameId,
    });
    expect(findings.filter((f) => f.code === 'isolation-short')).toHaveLength(0);
  });
});

describe('thin-trace (#743 P-5)', () => {
  /** A board of one straight strip, with a band around it — the morphology reads the strip. */
  const strip = (width: number): { band: Profile; copper: Profile } => {
    const copper = poly([
      [20, 10],
      [20 + 3, 10],
      [20 + 3, 10 + width],
      [20, 10 + width],
    ]);
    return { band: pOffset(copper, 0.4), copper };
  };

  const findingsFor = (width: number) =>
    pcbIsolationFindings(tl, {
      ...strip(width),
      cone: CONE,
      depthMm: PCB_ISOLATION_DEPTH_MM,
      colourMm: 0.035,
      zToleranceMm: 0.02,
      frameId: 'iso',
    });

  it('warns on a 0.12 mm trace with the numbers it leaves', () => {
    const warning = findingsFor(0.12).find((f) => f.code === 'thin-trace');
    expect(warning?.severity).toBe('warning');
    // 0.12 mm less 2 × 0.02 × tan 30° = 0.097 mm, under the 0.1 mm tip.
    expect(warning?.message).toContain('A trace is 0.12 mm wide');
    expect(warning?.message).toContain('leaving 0.097 mm');
    expect(warning?.message).toContain('0.1 mm tip of the isolation bit');
  });

  it('says nothing on a 0.30 mm trace', () => {
    expect(findingsFor(0.3).some((f) => f.code === 'thin-trace')).toBe(false);
  });
});

describe('the isolation reaches Generate (#743 P-5)', () => {
  it('still posts the gaps board, with the short stated as a warning', async () => {
    const built = await buildPcbJob(tl, [file('gaps.gbr')], {
      blank: BLANK,
      tabs: { count: 3, width: 3, height: 1 },
      tools: [ENGRAVER, CORN],
      catalogue: ROWS,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const job = built.job;
    job.toolKey = ENGRAVER.key;
    const gen = engraveGenerate(tl, job, ENGRAVER.tool, ROWS, null, undefined, { tools: [ENGRAVER, CORN] });
    // #743 P-5 review — INFORM: the board still generates; the short is a warning on the run.
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs.length).toBeGreaterThan(0);
    expect(gen.findings.some((f) => f.code === 'isolation-short' && f.severity === 'warning')).toBe(true);
  });

  it('generates the board whose gap opens', async () => {
    const built = await buildPcbJob(tl, [file('gaps-pass.gbr')], {
      blank: BLANK,
      tabs: { count: 3, width: 3, height: 1 },
      tools: [ENGRAVER, CORN],
      catalogue: ROWS,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const job = built.job;
    job.toolKey = ENGRAVER.key;
    const gen = engraveGenerate(tl, job, ENGRAVER.tool, ROWS, null, undefined, { tools: [ENGRAVER, CORN] });
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.findings.some((f) => f.code === 'isolation-short')).toBe(false);
  });
});
