/**
 * §3.4's hole rule (#743 P-4b): drill where an owned cutter IS the hole's size, bore where a flat
 * must helix it, and say nothing the job's own checks will not say better.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { PCB_DRILL_SLACK_MM, pcbCutterPlan, pcbHoleAssignment, withPcbCutters } from '@/engine/import/pcbCutters';

const entry = (key: string, shape: 'flat' | 'drill' | 'engraving', d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { shape, tipDiameter: d, diameter: d }),
});

const drill = (id: string, diameter: number): { id: string; diameter: number } => ({ id, diameter });

describe('§3.4 — a board hole and the cutter it asks for (#743 P-4b)', () => {
  it('drills with an owned drill of the hole size, and with a mill up to +0.1 mm over', () => {
    expect(PCB_DRILL_SLACK_MM).toBe(0.1);
    const exact = pcbHoleAssignment([drill('a', 0.8)], [entry('user:d', 'drill', 0.8)]);
    expect(exact.modes.get('a')).toBe('drill');

    const over = pcbHoleAssignment([drill('a', 1.0)], [entry('user:m', 'flat', 1.1)]);
    expect(over.modes.get('a')).toBe('drill');

    // Over by more than the slack is not the hole's cutter.
    const tooBig = pcbHoleAssignment([drill('a', 1.0)], [entry('user:m', 'flat', 1.11)]);
    expect(tooBig.modes.get('a')).toBe('drill');
    // (no narrower flat either, so the mode stays a plunge and the job's checks name the gap)
    expect(tooBig.notes).toEqual([]);
  });

  it('never drills UNDER the hole, and bores with a flat narrower than it, saying so once', () => {
    const out = pcbHoleAssignment(
      [drill('a', 0.8), drill('b', 0.8), drill('c', 1.0)],
      [entry('user:v', 'engraving', 0.1), entry('user:f', 'flat', 0.5), entry('user:dr', 'drill', 0.79)],
    );
    // 0.79 is under 0.8, so the 0.8 holes are bored; so is the 1.0 hole.
    expect(out.modes.get('a')).toBe('bore');
    expect(out.modes.get('b')).toBe('bore');
    expect(out.modes.get('c')).toBe('bore');
    expect(out.notes).toHaveLength(2);
    expect(out.notes[0]).toContain('the 2 ⌀0.8 holes are bored');
    expect(out.notes[1]).toContain('the 1 ⌀1 hole is bored');
  });

  it('a drill of exactly the size wins over boring', () => {
    const out = pcbHoleAssignment(
      [drill('a', 0.8)],
      [entry('user:f', 'flat', 0.5), entry('user:dr', 'drill', 0.8)],
    );
    expect(out.modes.get('a')).toBe('drill');
    expect(out.notes).toEqual([]);
  });
});

describe('§3.4 — the whole board’s cutter plan (#743 P-5)', () => {
  const cone = (key: string, tip: number, id?: string): ToolLibraryEntry => ({
    key,
    provenance: 'test',
    tool: flatEndMill(3.175, {
      ...(id === undefined ? {} : { id }),
      shape: 'engraving',
      tipDiameter: tip,
      diameter: 3.175,
      halfAngle: 30,
      angle: 60,
      fluteLength: 12,
    }),
  });
  const flat = (key: string, d: number, reach = 12): ToolLibraryEntry => ({
    key,
    provenance: 'test',
    tool: flatEndMill(d, { fluteLength: reach }),
  });
  const items = {
    frames: [{ id: 'iso' }],
    drills: [drill('h08', 0.8), drill('h10', 1.0)],
    cutouts: [{ id: 'out' }],
  };

  it('gives the engraver the isolation, each hole its bit, and the cut-out a flat that reaches', () => {
    const plan = pcbCutterPlan(items, [flat('inv:corn', 0.8), cone('inv:v02', 0.2), cone('inv:v01', 0.1), entry('inv:d08', 'drill', 0.8)], 2);
    expect(plan.tools).toEqual(['inv:v01', 'inv:d08', 'inv:corn']);
    expect(plan.assignment.get('iso')).toBe('inv:v01');
    expect(plan.assignment.get('h08')).toBe('inv:d08');
    // No 1.0 bit: the 0.8 corn bit is narrower than the hole, so it BORES it.
    expect(plan.assignment.get('h10')).toBe('inv:corn');
    expect(plan.assignment.get('out')).toBe('inv:corn');
    // The 0.2 engraver is listed for PCB but the 0.1 is not: the design's rule is the smallest tip
    // with a PCB row, so WITH a row for the 0.2 it wins; with none, the smallest stands.
    const listed = pcbCutterPlan(items, [cone('inv:v02', 0.2, 'pcb-v02'), cone('inv:v01', 0.1)], 2, [
      { cutterId: 'pcb-v02', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
    ]);
    expect(listed.assignment.get('iso')).toBe('inv:v02');
  });

  it('states the roles no owned cutter fills, and leaves those items unassigned', () => {
    // A 1.2 flat is neither the 1.0 hole's cutter (0.2 over the slack) nor narrower than it, so the
    // 1.0 hole has no cutter at all — and with no engraver and no reaching flat, neither has the
    // isolation or the outline.
    const plan = pcbCutterPlan(items, [entry('inv:d08', 'drill', 0.8), flat('inv:f12', 1.2, 1.5)], 2);
    expect(plan.assignment.get('iso')).toBeUndefined();
    expect(plan.assignment.get('out')).toBeUndefined();
    expect(plan.notes.join(' ')).toContain('No engraving bit');
    expect(plan.notes.join(' ')).toContain('No flat end mill');
  });

  it('a setup gains the plan without unassigning a single item it already cut', () => {
    const base = {
      id: 'setup-1',
      orientation: { top: 'top' as const, rotationDeg: 0 },
      mount: 'vise' as const,
      itemIds: ['note-1', 'iso', 'out'],
      tools: ['inv:engrave'],
    } as unknown as Parameters<typeof withPcbCutters>[0];
    const plan = pcbCutterPlan(items, [cone('inv:v01', 0.1), flat('inv:corn', 0.8)], 2);
    const setup = withPcbCutters(base, plan, ['iso', 'out']);
    // The job's own item stays with the first cutter; the board's are owned by the plan's cutters
    // exactly once.
    expect(setup.toolItems?.['inv:engrave']).toEqual(['note-1']);
    expect(setup.toolItems?.['inv:v01']).toEqual(['iso']);
    expect(setup.toolItems?.['inv:corn']).toEqual(['out']);
    expect(setup.tools).toEqual(['inv:engrave', 'inv:v01', 'inv:corn']);
  });
});
