import { describe, it, expect } from 'vitest';
import { faceFrame, placeOnFace } from '@/engine/coords';
import type { CaseFace } from '@/types';

const X = 100;
const Y = 70;
const Z = 30;

describe('engine/coords face frames (issue #50)', () => {
  it('all six faces produce a frame', () => {
    const faces: CaseFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    for (const f of faces) {
      const frame = faceFrame(f, X, Y, Z);
      expect(frame.uAxis).toHaveLength(3);
      expect(frame.vAxis).toHaveLength(3);
      expect(frame.outwardAxis).toHaveLength(3);
    }
  });

  it('outwardAxis, outwardLetter, outwardSign agree', () => {
    const faces: CaseFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    for (const f of faces) {
      const frame = faceFrame(f, X, Y, Z);
      const idx = frame.outwardLetter === 'x' ? 0 : frame.outwardLetter === 'y' ? 1 : 2;
      // exactly one component is non-zero, equal to outwardSign
      expect(frame.outwardAxis[idx]).toBe(frame.outwardSign);
      const others = [0, 1, 2].filter((i) => i !== idx);
      for (const i of others) expect(frame.outwardAxis[i]).toBe(0);
    }
  });

  it('uAxis and vAxis are unit vectors orthogonal to outwardAxis', () => {
    const faces: CaseFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
    for (const f of faces) {
      const frame = faceFrame(f, X, Y, Z);
      const dot = (a: readonly number[], b: readonly number[]) =>
        a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(frame.uAxis, frame.uAxis)).toBe(1);
      expect(dot(frame.vAxis, frame.vAxis)).toBe(1);
      expect(dot(frame.uAxis, frame.outwardAxis)).toBe(0);
      expect(dot(frame.vAxis, frame.outwardAxis)).toBe(0);
      expect(dot(frame.uAxis, frame.vAxis)).toBe(0);
    }
  });

  it('-z origin sits at (0,0,0) and +z origin sits at (0,0,outerZ)', () => {
    expect(faceFrame('-z', X, Y, Z).origin).toEqual([0, 0, 0]);
    expect(faceFrame('+z', X, Y, Z).origin).toEqual([0, 0, Z]);
  });

  it('+x origin sits at (outerX,0,0) and +y origin sits at (0,outerY,0)', () => {
    expect(faceFrame('+x', X, Y, Z).origin).toEqual([X, 0, 0]);
    expect(faceFrame('+y', X, Y, Z).origin).toEqual([0, Y, 0]);
    expect(faceFrame('-x', X, Y, Z).origin).toEqual([0, 0, 0]);
    expect(faceFrame('-y', X, Y, Z).origin).toEqual([0, 0, 0]);
  });

  it('placeOnFace maps (u,v) into world coords on the face plane', () => {
    // -z face: u = world X, v = world Y.
    const f = faceFrame('-z', X, Y, Z);
    expect(placeOnFace(f, 10, 20)).toEqual([10, 20, 0]);
    expect(placeOnFace(f, 0, 0)).toEqual([0, 0, 0]);
  });

  it('placeOnFace outwardOffset moves along the face normal', () => {
    // +z face: outward is +z, so offset 5 lands above the top.
    const f = faceFrame('+z', X, Y, Z);
    expect(placeOnFace(f, 10, 20, 5)).toEqual([10, 20, Z + 5]);
    // -z face: outward is -z, offset 5 lands below the bottom.
    const fb = faceFrame('-z', X, Y, Z);
    expect(placeOnFace(fb, 10, 20, 5)).toEqual([10, 20, -5]);
  });

  it('side faces: u maps to expected world axis', () => {
    // -y face: u → +x, v → +z (face plane is y=0).
    const f = faceFrame('-y', X, Y, Z);
    expect(placeOnFace(f, 10, 20)).toEqual([10, 0, 20]);
    // +x face: u → +y, v → +z (face plane is x=outerX).
    const g = faceFrame('+x', X, Y, Z);
    expect(placeOnFace(g, 10, 20)).toEqual([X, 10, 20]);
  });
});
