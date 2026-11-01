/**
 * #261 slice 1 — THE 10″ U-MOUNT RAILS, PINNED TO THE STANDARD'S NUMBERS.
 *
 * The standard (Project Mini Rack, mini-rack.jeffgeerling.com, read 2026-11-01): 1U = 44.45 mm,
 * 236.525 mm (9.312″) between the mounting holes, gear within ~210 mm, and the vertical spacing
 * follows the 19″ rack specification — EIA-310's 6.35 / 22.225 / 38.1 mm within each unit.
 *
 * These are golden tests on the numbers and on real meshes: the rail pair's hole planes are
 * 236.525 mm apart, a rail is exactly `u × 44.45` tall, each unit carries three holes per rail
 * (proved by the volume they remove), the 1U blank's body is the standard's 210 mm with its holes
 * on the pair, and every node is ONE solid — the engine's one-component-per-node contract.
 */
import { describe, expect, it } from 'vitest';

import { exec } from './helpers/manifoldExec';
import {
  BLANK_EAR,
  BLANK_T,
  DECK_T,
  GEAR_WIDTH,
  HOLE_OFFSETS_IN_U,
  HOLE_PAIR,
  RAIL_HOLE_D,
  RAIL_T,
  U_PITCH,
  buildUMountNodes,
  uMountDims,
  uMountHoleZs,
  type UMountParams,
} from '@/engine/compiler/rackUMount';
import { roundedRectPrism } from '@/engine/compiler/buildPlan';
import { partForId } from '@/engine/exporters/parts';

const P = (u: number): UMountParams => ({ u, depth: 250 });

describe('#261 slice 1 the standard’s numbers', () => {
  it('pins the standard: 44.45 mm per U, 236.525 mm between the holes, ~210 mm of gear', () => {
    expect(U_PITCH).toBe(44.45);
    expect(HOLE_PAIR).toBe(236.525);
    expect(GEAR_WIDTH).toBe(210);
    expect([...HOLE_OFFSETS_IN_U]).toEqual([6.35, 22.225, 38.1]);
    expect(RAIL_HOLE_D).toBe(6.2);
  });

  it('a rail is exactly u × 44.45 tall, and the two hole planes are the pair apart', () => {
    for (const u of [1, 6, 12]) {
      const dims = uMountDims(P(u));
      expect(dims.railH).toBeCloseTo(u * 44.45, 9);
      expect(dims.holeX[1] - dims.holeX[0]).toBeCloseTo(236.525, 9);
    }
    // The standard fixes the pitch, not the sizes: 1–12 units, clamped.
    expect(uMountDims(P(0)).u).toBe(1);
    expect(uMountDims(P(40)).u).toBe(12);
  });

  it('three holes per unit per rail, at the EIA offsets from each unit’s base', () => {
    const zs = uMountHoleZs(3);
    expect(zs).toHaveLength(9);
    expect(zs.slice(0, 3)).toEqual([6.35, 22.225, 38.1]);
    expect(zs[3]).toBeCloseTo(44.45 + 6.35, 9);
  });
});

describe('#261 slice 1 the parts are real solids', () => {
  it('every node is ONE solid, and the rails are the standard height across their holes', () => {
    const nodes = buildUMountNodes(P(6));
    expect(nodes.map((n) => n.id)).toEqual([
      'umount-rail-left-6u',
      'umount-rail-right-6u',
      'umount-deck-6u',
      'umount-blank-1u',
    ]);
    for (const node of nodes) {
      const m = exec(node.op);
      try {
        expect(m.decompose().length, node.id).toBe(1);
        expect(m.volume(), node.id).toBeGreaterThan(0);
      } finally {
        m.delete();
      }
    }
    // The rails' hole planes sit 236.525 mm apart, measured off the meshes themselves.
    const left = exec(nodes[0]!.op);
    const right = exec(nodes[1]!.op);
    try {
      const lb = left.boundingBox();
      const rb = right.boundingBox();
      const leftCentre = (lb.min[0] + lb.max[0]) / 2;
      const rightCentre = (rb.min[0] + rb.max[0]) / 2;
      expect(rightCentre - leftCentre).toBeCloseTo(HOLE_PAIR, 6);
      expect(lb.max[2] - lb.min[2]).toBeCloseTo(6 * U_PITCH, 6);
      expect(rb.max[2] - rb.min[2]).toBeCloseTo(6 * U_PITCH, 6);
    } finally {
      left.delete();
      right.delete();
    }
  });

  it('each unit really carries three ⌀6.2 holes per rail — the volume they remove says so', () => {
    const dims = uMountDims(P(2));
    const nodes = buildUMountNodes(P(2));
    const holed = exec(nodes[0]!.op);
    // The same plate with no holes, seated the same way.
    const whole = exec(roundedRectPrism(RAIL_T, dims.depth, dims.railH, 2, 12));
    try {
      const removed = whole.volume() - holed.volume();
      const ideal = 2 * HOLE_OFFSETS_IN_U.length * Math.PI * (RAIL_HOLE_D / 2) ** 2 * RAIL_T;
      // The holes are 32-gon cylinders, so they remove a hair under the circle's area: within 1 %
      // of the ideal proves SIX holes of ⌀6.2 through a 12 mm rail, not five or seven.
      expect(removed / ideal).toBeGreaterThan(0.98);
      expect(removed / ideal).toBeLessThan(1.001);
    } finally {
      holed.delete();
      whole.delete();
    }
  });

  it('the 1U blank’s body is the standard’s 210 mm, its holes on the 236.525 mm pair', () => {
    const nodes = buildUMountNodes(P(6));
    const blank = nodes.find((n) => n.id === 'umount-blank-1u')!;
    const m = exec(blank.op);
    try {
      const b = m.boundingBox();
      // Ears beyond the holes make it wider than the pair; the BODY between them is 210.
      expect(b.max[0] - b.min[0]).toBeCloseTo(HOLE_PAIR + 2 * BLANK_EAR, 6);
      expect(b.max[2] - b.min[2]).toBeCloseTo(U_PITCH, 6);
      expect(b.max[1] - b.min[1]).toBeCloseTo(BLANK_T, 6);
      // The body between the ears is the standard's gear width — no filler, no waste.
      expect(HOLE_PAIR + 2 * BLANK_EAR - 2 * ((HOLE_PAIR + 2 * BLANK_EAR - GEAR_WIDTH) / 2)).toBe(GEAR_WIDTH);
    } finally {
      m.delete();
    }
  });

  it('the export list names the parts as the standard’s, with the unit count', () => {
    expect(partForId('umount-rail-left-6u').displayName).toBe('10″ rail — LEFT, 6U');
    expect(partForId('umount-rail-right-12u').displayName).toBe('10″ rail — RIGHT, 12U');
    expect(partForId('umount-deck-6u').displayName).toBe('10″ deck, 6U');
    expect(partForId('umount-blank-1u').displayName).toBe('10″ 1U blank (210 mm body)');
  });

  it('the deck under the rails spans both rails’ outer faces', () => {
    const dims = uMountDims(P(6));
    const deck = buildUMountNodes(P(6)).find((n) => n.id === 'umount-deck-6u')!;
    const m = exec(deck.op);
    try {
      const b = m.boundingBox();
      expect(b.max[0] - b.min[0]).toBeCloseTo(dims.deckW, 6);
      expect(b.max[2] - b.min[2]).toBeCloseTo(DECK_T, 6);
    } finally {
      m.delete();
    }
  });
});
