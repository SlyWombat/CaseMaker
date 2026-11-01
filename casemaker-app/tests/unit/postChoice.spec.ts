/**
 * #845 — WHICH POST WRITES A MACHINE'S FILE. The machine's `post` decides; absent is the Z1's
 * Smoothie dialect, so nothing written before the field existed changes. The emitter is returned
 * BOUND to its machine, so the test reads what each machine's file actually says rather than
 * comparing function identities: the choice is the file the operator gets.
 */
import { describe, expect, it } from 'vitest';

import { postFor, postKey, postOriginFor } from '@/engine/cnc/post';
import { SHAPEOKO_4, Z1, type Mill, type MillModel } from '@/engine/cnc/machine';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import { flatEndMill } from '@/engine/cnc/tool';
import type { PostContext } from '@/engine/cnc/post/z1';

const TOOL = { ...flatEndMill(1, { name: '1 mm flat end' }), id: null };

const CTX: PostContext = {
  jobName: 'demo pocket',
  stock: { length: 20, width: 10, thickness: 5 },
  materialName: 'PLA',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'flat-1.0',
};

const MOVES: CamMove[] = [
  { kind: 'rapid', x: 2, y: 2, z: 3 },
  { kind: 'feed', x: 2, y: 2, z: -0.5, f: 300 },
  { kind: 'feed', x: 6, y: 2, z: -0.5, f: 600 },
  { kind: 'rapid', x: 6, y: 2, z: 3 },
];

function ir(): ToolpathIR {
  return {
    frame: 'flat',
    tool: TOOL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: false,
    safeZ: 3,
    hopZ: 1,
    operations: [
      { number: 1, name: '[T1]pocket 0.5mm', labelId: 'pocket', depth: 0.5, depthPasses: 1, passStepMm: 0.5, moves: MOVES, estimatedSeconds: 4 },
    ],
  };
}

function postedText(machine: Mill): string {
  const out = postFor(machine)(ir(), CTX);
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.text;
}

describe('#845 the post a machine is written by', () => {
  it('is the Z1 post when the machine states no post, and for post: z1', () => {
    expect(postKey({})).toBe('z1');
    expect(postKey(Z1)).toBe('z1');
    // The Z1's file opens with its own `;@MKR` header — the Smoothie dialect, byte for byte.
    expect(postedText(Z1)).toContain(';@MKR');
  });

  it('is the GRBL post when the machine states it, and the file says so', () => {
    expect(postKey(SHAPEOKO_4)).toBe('grbl');
    const text = postedText(SHAPEOKO_4);
    expect(text.split('\n')[0]).toBe('; Case Maker — demo pocket');
    expect(text).toContain('; dialect: GRBL 1.1');
    expect(text).not.toContain(';@MKR');
  });

  it('writes the work-origin convention the machine states', () => {
    // A framed profile is the Z1's own convention whatever its record says; a stated machine
    // writes the one its owner chose, so the header sentence and the coordinates cannot disagree.
    expect(postOriginFor(Z1)).toBe('topFrontLeft');
    expect(postOriginFor(SHAPEOKO_4)).toBe('topFrontLeft');
    expect(postOriginFor({ ...SHAPEOKO_4, workOrigin: 'top-centre' })).toBe('topCentre');
  });

  it('refuses a stated machine that names no post: it has no frame to write from', () => {
    const unposted: MillModel = { ...SHAPEOKO_4, post: undefined };
    expect(() => postFor(unposted)).toThrow(/names no post and carries no frame/);
  });
});
