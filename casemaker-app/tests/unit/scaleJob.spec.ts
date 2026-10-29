// #743 D-2 — the resize the registration step offers when a disc is more than 1 % off the stated
// diameter. The rule: X/Y scale about the stock's centre; Z numbers (depths, tab heights, pecks)
// stay; a thread's SIZE is a physical standard and only its position moves.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { scaleJobAboutCentre } from '@/engine/cnc/engrave/scaleJob';
import type { EngraveJob } from '@/types/engraveJob';

function discJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 };
  job.labels = [
    { id: 'txt', text: 'HELLO', font: 'sans-default', weight: 'regular', size: 5, position: { x: 20, y: 17 }, rotation: 0, depth: 0.5, enabled: true },
  ];
  job.shapes = [
    { id: 'rect', kind: 'rect', position: { x: 10, y: 10 }, rotation: 0, depth: 1, enabled: true, width: 8, height: 4, cornerRadius: 1 },
    { id: 'poly', kind: 'polygon', position: { x: 15, y: 15 }, rotation: 0, depth: 1, enabled: true, points: [[-2, -1], [2, -1], [0, 2]] },
  ];
  job.drills = [
    { id: 'arr', kind: 'drill-array', position: { x: 5, y: 5 }, rotation: 0, depth: 2, enabled: true, through: false, count: { x: 2, y: 2 }, pitch: { x: 3, y: 4 }, diameter: 1.2, mode: 'bore' },
  ];
  job.threads = [{ kind: 'thread', id: 'thr', position: { x: 25, y: 20 }, enabled: true, size: 'M5', standard: 'metric', classFit: '6H', depth: 5, through: false }];
  job.cutouts = [{ kind: 'cutout', id: 'cut', enabled: true, of: 'rect', side: 'outside', inset: 0.5, tabs: { count: 2, width: 3, height: 0.6 } }];
  job.chamfers = [{ kind: 'chamfer', id: 'bev', enabled: true, of: 'rect', side: 'outside', width: 1 }];
  job.traces = [
    { id: 'line', kind: 'line', position: { x: 15, y: 22 }, rotation: 0, depth: 0.4, enabled: true, points: [[-5, 0], [5, 0]], closed: false },
  ];
  job.vectors = [
    {
      id: 'vec',
      kind: 'vector',
      position: { x: 18, y: 12 },
      rotation: 0,
      depth: 0.6,
      enabled: true,
      sourceName: 'star.svg',
      contours: [[[0, 0], [2, 0], [1, 2]]],
      fillRule: 'NonZero',
      width: 2,
      height: 2,
    },
  ];
  job.keepOuts = [{ id: 'void', kind: 'circle', position: { x: 15, y: 15 }, rotation: 0, enabled: true, zCeiling: 1.2, diameter: 6 }];
  return job;
}

describe('#743 D-2 scaleJobAboutCentre', () => {
  it('scales the stock and every X/Y number about the stock’s centre', () => {
    const scaled = scaleJobAboutCentre(discJob(), 1.014);
    expect(scaled.stock.length).toBeCloseTo(30.42, 2);
    expect(scaled.stock.width).toBeCloseTo(30.42, 2);
    expect(scaled.stock.diameter).toBeCloseTo(30.42, 2);
    // Positions move about (15, 15); the centre itself does not move.
    expect(scaled.labels[0]!.position).toEqual({ x: 20.07, y: 17.028 });
    expect(scaled.labels[0]!.size).toBeCloseTo(5.07, 2);
    expect(scaled.shapes[0]!.position).toEqual({ x: 9.93, y: 9.93 });
    // A polygon's points are relative to its position: they scale in place.
    expect(scaled.shapes[1]!.position).toEqual({ x: 15, y: 15 });
    expect(scaled.drills![0]!.position).toEqual({ x: 4.86, y: 4.86 });
    expect(scaled.threads![0]!.position).toEqual({ x: 25.14, y: 20.07 });
    expect(scaled.traces![0]!.position).toEqual({ x: 15, y: 22.098 });
    expect(scaled.vectors![0]!.position).toEqual({ x: 18.042, y: 11.958 });
    expect(scaled.keepOuts![0]!.position).toEqual({ x: 15, y: 15 });
  });

  it('scales the sizes that belong to the footprint', () => {
    const scaled = scaleJobAboutCentre(discJob(), 1.014);
    expect((scaled.shapes[0] as { width: number }).width).toBeCloseTo(8.112, 2);
    expect((scaled.shapes[0] as { cornerRadius: number }).cornerRadius).toBeCloseTo(1.014, 2);
    expect(scaled.drills![0]!.diameter).toBeCloseTo(1.217, 2);
    expect(scaled.drills![0]!.kind === 'drill-array' ? scaled.drills![0]!.pitch : null).toEqual({ x: 3.042, y: 4.056 });
    expect(scaled.cutouts![0]!.inset).toBeCloseTo(0.507, 2);
    expect(scaled.cutouts![0]!.tabs.width).toBeCloseTo(3.042, 2);
    expect(scaled.chamfers![0]!.width).toBeCloseTo(1.014, 2);
    expect(scaled.vectors![0]!.width).toBeCloseTo(2.028, 2);
    expect((scaled.shapes[1] as { points: [number, number][] }).points).toEqual([[-2.028, -1.014], [2.028, -1.014], [0, 2.028]]);
    expect(scaled.vectors![0]!.contours[0]).toEqual([[0, 0], [2.028, 0], [1.014, 2.028]]);
    expect(scaled.keepOuts![0] as { diameter?: number }).toMatchObject({ diameter: 6.084 });
  });

  it('leaves every Z number and every physical standard alone', () => {
    const scaled = scaleJobAboutCentre(discJob(), 1.014);
    expect(scaled.labels[0]!.depth).toBe(0.5);
    expect(scaled.shapes[0]!.depth).toBe(1);
    expect(scaled.drills![0]!.depth).toBe(2);
    expect(scaled.threads![0]!.depth).toBe(5);
    expect(scaled.traces![0]!.depth).toBe(0.4);
    // A tab's height holds the part from the underside: not a footprint number.
    expect(scaled.cutouts![0]!.tabs.height).toBe(0.6);
    // A thread's size is a standard, not a drawing: M5 stays M5.
    expect(scaled.threads![0]!.size).toBe('M5');
    expect(scaled.stock.thickness).toBe(3);
    // The keep-out's ceiling is measured up from the bottom face: Z again.
    expect(scaled.keepOuts![0]!.zCeiling).toBe(1.2);
  });

  it('a factor that is not a positive number changes nothing', () => {
    const job = discJob();
    expect(scaleJobAboutCentre(job, 0)).toBe(job);
    expect(scaleJobAboutCentre(job, Number.NaN)).toBe(job);
  });
});
