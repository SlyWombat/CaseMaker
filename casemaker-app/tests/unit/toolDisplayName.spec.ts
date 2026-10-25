// #646 — a tool's name for people, from its own geometry: the strip, the run sheet and the pickers
// all read it from here, so they cannot disagree; the vendor label stays data (a hover).

import { describe, expect, it } from 'vitest';

import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const tool = (over: Partial<Tool>): Tool => ({ ...flatEndMill(1, { number: 1, name: 'vendor label' }), ...over });

describe('#646 the tool display name', () => {
  it('names a V-bit by its tip diameter, its included angle and its kind', () => {
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.5, angle: 30 }))).toBe('0.5 mm 30° engraver');
    expect(toolDisplayName(tool({ shape: 'engraving', tipDiameter: 0.3, angle: 30 }))).toBe('0.3 mm 30° engraver');
  });

  it('names a flat end and a ball by diameter and kind', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1, diameter: 1 }))).toBe('1 mm flat end');
    expect(toolDisplayName(tool({ shape: 'ball', tipDiameter: 3, diameter: 3 }))).toBe('3 mm ball');
  });

  it('drops trailing zeros rather than inventing precision', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 1.0, diameter: 1.0 }))).toBe('1 mm flat end');
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 3.175, diameter: 3.175 }))).toBe('3.17 mm flat end'); // 3.175 is 3.1749… in binary
  });

  it('never reads the vendor label', () => {
    expect(toolDisplayName(tool({ shape: 'flat', tipDiameter: 2, name: '4*0.5mm*30º Engraving(Metal)' }))).not.toContain('Engraving');
  });
});
