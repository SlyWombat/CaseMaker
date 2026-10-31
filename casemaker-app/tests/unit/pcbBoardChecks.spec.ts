/**
 * #743 P-5 — a board's own two design checks: a hole size no owned cutter makes, and a hole the
 * board outline does not contain.
 *
 * Both read what the IMPORT placed: a drill item that states its hole's diameter (a hand-made
 * drill's hole is its cutter) and a cut-out following a simple outline. Everything else is left
 * alone — a check that fires on a normal job of its kind is noise, not a warning.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveCutout, EngraveDrill, EngraveJob, EngraveVectorShape } from '@/types/engraveJob';

const drillBit = (key: string, d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { shape: 'drill', tipDiameter: d, diameter: d, fluteLength: 12 }),
});
const flat = (key: string, d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { fluteLength: 12 }),
});

const hole = (id: string, diameter: number, x: number, y: number): EngraveDrill => ({
  id,
  kind: 'drill',
  position: { x, y },
  rotation: 0,
  depth: 1.6,
  enabled: true,
  through: true,
  mode: 'drill',
  diameter,
});

const outline = (): EngraveVectorShape => ({
  id: 'outline',
  kind: 'vector',
  name: 'Board outline',
  sourceName: 'outline.gbr',
  position: { x: 30, y: 20 },
  rotation: 0,
  depth: 1.6,
  enabled: true,
  construction: true,
  contours: [
    [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
  ],
  fillRule: 'NonZero',
  width: 20,
  height: 10,
});

const cutout = (of: string): EngraveCutout => ({
  id: 'cut-out',
  kind: 'cutout',
  enabled: true,
  of,
  side: 'outside',
  inset: 0,
  tabs: { count: 3, width: 3, height: 1 },
});

function boardJob(drills: EngraveDrill[], over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], drills, toolKey: 'inv:d10', tool: drillBit('inv:d10', 1.0).tool, ...over };
}

describe('hole-no-cutter (#743 P-5)', () => {
  it('names the hole size, its count and the smallest cutter that could have made it', () => {
    const findings = validateJob(boardJob([hole('a', 0.6, 10, 10), hole('b', 0.6, 12, 10)]), null, {
      tools: [drillBit('inv:d10', 1.0), drillBit('inv:d08', 0.8)],
    });
    const finding = findings.find((f) => f.code === 'hole-no-cutter');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('No cutter for the 0.6 mm holes (2)');
    expect(finding?.message).toContain('smallest drill or flat end mill you own is 0.8 mm');
  });

  it('says nothing when the assigned cutter is the hole’s size, or when a flat can bore it', () => {
    const exact = validateJob(boardJob([hole('a', 1.0, 10, 10)]), null, {
      tools: [drillBit('inv:d10', 1.0)],
    });
    expect(exact.some((f) => f.code === 'hole-no-cutter')).toBe(false);

    // A 0.4 flat is narrower than the 0.6 hole: it bores it, so a cutter exists.
    const bore = validateJob(boardJob([hole('a', 0.6, 10, 10)]), null, {
      tools: [drillBit('inv:d10', 1.0), flat('inv:f04', 0.4)],
    });
    expect(bore.some((f) => f.code === 'hole-no-cutter')).toBe(false);
  });

  it('is silent on a hand-made drill whose size it does not state', () => {
    const plain = { ...hole('a', 0.6, 10, 10), diameter: undefined };
    const findings = validateJob(boardJob([plain]), null, { tools: [drillBit('inv:d10', 1.0)] });
    expect(findings.some((f) => f.code === 'hole-no-cutter')).toBe(false);
  });
});

describe('item-off-board (#743 P-5)', () => {
  const withOutline = (drills: EngraveDrill[]): EngraveJob =>
    boardJob(drills, { vectors: [outline()], cutouts: [cutout('outline')] });

  it('names the holes outside the outline the cut-out frees', () => {
    const findings = validateJob(withOutline([hole('in', 1.0, 40, 25), hole('out', 1.0, 10, 10)]), null, {
      tools: [drillBit('inv:d10', 1.0)],
    });
    const finding = findings.find((f) => f.code === 'item-off-board');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('1 hole is outside the board outline');
  });

  it('says nothing when every hole is on the board', () => {
    const findings = validateJob(withOutline([hole('in', 1.0, 40, 25), hole('in2', 1.0, 45, 22)]), null, {
      tools: [drillBit('inv:d10', 1.0)],
    });
    expect(findings.some((f) => f.code === 'item-off-board')).toBe(false);
  });

  it('is silent when the outline is a reference this pure check cannot place', () => {
    const job: EngraveJob = boardJob([hole('out', 1.0, 10, 10)], { cutouts: [cutout('stock-inset')] });
    const findings = validateJob(job, null, { tools: [drillBit('inv:d10', 1.0)] });
    expect(findings.some((f) => f.code === 'item-off-board')).toBe(false);
  });
});
