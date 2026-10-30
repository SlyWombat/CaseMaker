/**
 * Excellon drill import (#743 P-3).
 *
 * `tiny.drl` is six ⌀0.8 holes and two ⌀1.0 holes, and `tiny-inch.drl` is the same eight holes in
 * inches — the two must give identical points and sizes. `slot.drl` routes a slot with `G85`, which
 * the design refuses by name in v1 (Q9).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readExcellon } from '@/engine/import/excellon';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/pcb');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('Excellon drills (#743 P-3)', () => {
  it('reads the tool table and every hit, with sizes in mm', () => {
    const parsed = readExcellon(read('tiny.drl'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.units).toBe('mm');
    expect(parsed.holes).toHaveLength(8);
    expect(parsed.holes.filter((h) => h.tool === 1)).toHaveLength(6);
    expect(parsed.holes.filter((h) => h.tool === 2)).toHaveLength(2);
    expect(parsed.holes[0]).toEqual({ x: 5, y: 5, diameter: 0.8, tool: 1 });
    const big = parsed.holes.filter((h) => h.tool === 2);
    expect(big.map((h) => h.diameter)).toEqual([1, 1]);
    // The last hole keeps its size and lands where the file says.
    expect(parsed.holes[7]).toMatchObject({ x: 30, y: 15, diameter: 1 });
  });

  it('reads an inch file to the same holes', () => {
    const mm = readExcellon(read('tiny.drl'));
    const inch = readExcellon(read('tiny-inch.drl'));
    if (!mm.ok) throw new Error(mm.error);
    if (!inch.ok) throw new Error(inch.error);
    expect(inch.units).toBe('inch');
    expect(inch.holes).toHaveLength(mm.holes.length);
    for (let i = 0; i < mm.holes.length; i++) {
      expect(inch.holes[i]?.x).toBeCloseTo(mm.holes[i]?.x as number, 3);
      expect(inch.holes[i]?.y).toBeCloseTo(mm.holes[i]?.y as number, 3);
      expect(inch.holes[i]?.diameter).toBeCloseTo(mm.holes[i]?.diameter as number, 3);
    }
  });

  it('honours a stated digit format for coordinates without a decimal point', () => {
    const text = [
      'M48',
      'METRIC,LZ,000.000',
      'T1C0.8',
      '%',
      'T1',
      'X005000Y002500',
      'M30',
    ].join('\n');
    const parsed = readExcellon(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.holes[0]).toMatchObject({ x: 5, y: 2.5 });
  });

  it('refuses a routed slot by name, at its line', () => {
    const parsed = readExcellon(read('slot.drl'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/line 8/i);
    expect(parsed.error).toMatch(/slots/i);
  });

  it('refuses a decimal-less coordinate with no digit format rather than guessing', () => {
    const text = ['M48', 'METRIC,TZ', 'T1C0.8', '%', 'T1', 'X5000Y2500', 'M30'].join('\n');
    const parsed = readExcellon(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/digit format/i);
  });

  it('refuses a file with no header, no unit, or no holes', () => {
    expect(readExcellon('X5.0Y5.0\nM30\n').ok).toBe(false);
    const noUnit = readExcellon(['M48', 'T1C0.8', '%', 'T1', 'X5.0Y5.0', 'M30'].join('\n'));
    expect(noUnit.ok).toBe(false);
    if (!noUnit.ok) expect(noUnit.error).toMatch(/unit/i);
    const noHoles = readExcellon(['M48', 'METRIC,TZ', 'T1C0.8', '%', 'M30'].join('\n'));
    expect(noHoles.ok).toBe(false);
    if (!noHoles.ok) expect(noHoles.error).toMatch(/no holes/i);
  });
});
