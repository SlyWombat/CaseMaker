/**
 * #829 — THE 3D CHAMFER CAM. The 2D bevel rule applied point by point along a mesh's rim: the tip
 * one radius off the edge on the air side, its plane `depth` below each point's own top face.
 * Straight and closed chains, the air side, and the varying z of a rim drawn over a shaped part.
 */
import { describe, expect, it } from 'vitest';

import { generateChamfer3d, type Chamfer3dCut } from '@/engine/cnc/cam/chamfer3d';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import type { RimChain } from '@/engine/cnc/engrave/targetRim';

/** The catalogue's 3.175 mm 90° chamfer: a 0.1 mm tip, 45° half angle. */
const CHAMFER: Tool = {
  ...flatEndMill(3.175),
  name: '3.175mm*90º Chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
  cornerRadius: null,
};

const PARAMS: CutParams = { rpm: 12000, feed: 900, plungeFeed: 300, stepDown: 1, stepOver: 1, peck: 1, air: true };
const RAPID: RapidEstimate = { xyMmPerMin: 5000, zMmPerMin: 2500, accelMmPerS2: 500, source: 'test' };

function chain(points: [number, number, number][], closed: boolean, air: [number, number] = [0, -1]): RimChain {
  return {
    points: points.map(([x, y, z]) => ({ x, y, z })),
    outward: points.map(() => ({ x: air[0], y: air[1] })),
    closed,
    lengthMm: 0,
    topTiltDeg: 0,
  };
}

function cut(c: RimChain, depth = 0.5): Chamfer3dCut {
  return { id: 'goal-1', name: 'the part’s edge', chain: c, depth };
}

describe('#829 the 3D chamfer CAM', () => {
  it('traces the air side one tip radius off the edge, with the tip plane below each point’s top', () => {
    const ir = generateChamfer3d([cut(chain([[0, 0, 5], [10, 0, 5]], false))], CHAMFER, PARAMS, RAPID);
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    expect(op.labelId).toBe('goal-1');
    expect(op.name).toBe('[T1]the part’s edge 0.5mm');
    // The chain runs along +X with the air toward −Y: every point is pushed 0.05 mm (the tip
    // radius) that way, and 0.5 mm (the depth) below the top face at z = 5.
    const feeds = op.moves.filter((m) => m.kind === 'feed');
    expect(feeds.map((m) => [m.x, m.y, m.z])).toEqual([
      [0, -0.05, 4.5],
      [10, -0.05, 4.5],
    ]);
    // The cut is a FEED from the hop height, and the chain ends with a rapid in the air.
    expect(op.moves[0]).toMatchObject({ kind: 'rapid', z: HOP_Z });
    expect(op.moves[op.moves.length - 1]).toMatchObject({ kind: 'rapid', z: SAFE_Z });
  });

  it('a shaped rim follows its own z at every point', () => {
    const ir = generateChamfer3d(
      [cut(chain([[0, 0, 6], [5, 0, 5], [10, 0, 4]], false))],
      CHAMFER,
      PARAMS,
      RAPID,
    );
    const feeds = ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(feeds.map((m) => m.z)).toEqual([5.5, 4.5, 3.5]);
  });

  it('a closed ring is closed by the same pass, back to its first point', () => {
    const square = chain(
      [
        [0, 0, 5],
        [10, 0, 5],
        [10, 10, 5],
        [0, 10, 5],
      ],
      true,
      [0, -1],
    );
    const ir = generateChamfer3d([cut(square)], CHAMFER, PARAMS, RAPID);
    const feeds = ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    // Plunge at the first point, three edges, then back to the start at the same z.
    expect(feeds).toHaveLength(5);
    expect(feeds[feeds.length - 1]).toMatchObject({ x: 0, y: -0.05, z: 4.5 });
  });

  it('refuses a cutter with no cone rather than cutting a bevel with it', () => {
    expect(() => generateChamfer3d([cut(chain([[0, 0, 5], [10, 0, 5]], false))], flatEndMill(3.175), PARAMS, RAPID)).toThrow(
      /cone/,
    );
  });
});
