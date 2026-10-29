// #716 slice 2 — the rotary simulation's words: A within the turn plus the turns, Z above the axis.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SimPath } from '@/workers/sim/session';
import { aboveAxisWords, angleAtStep, rotaryAngleWords, turningRadians } from '@/components/viewport/rotarySimView';

function path(a?: number[]): SimPath {
  const n = a?.length ?? 4;
  const step: number[] = [];
  const xyz: number[] = [];
  for (let i = 0; i < n; i++) {
    step.push(i * 10);
    xyz.push(i, 0, -i);
  }
  return {
    xyz: Float32Array.from(xyz),
    step: Uint32Array.from(step),
    kind: new Uint8Array(n).fill(1),
    t: new Float32Array(n),
    ...(a === undefined ? {} : { a: Float64Array.from(a) }),
  };
}

describe('#716 the rotary read-out', () => {
  it('A reads within the turn and the turns, never the unwound total alone', () => {
    expect(rotaryAngleWords(154.5)).toBe('A 154.5° · 0 turns');
    expect(rotaryAngleWords(1234.5)).toBe('A 154.5° · 3 turns');
    expect(rotaryAngleWords(360)).toBe('A 0° · 1 turn');
    expect(rotaryAngleWords(0)).toBe('A 0° · 0 turns');
  });

  it('rounds within the turn before carrying, so the angle never prints as 360°', () => {
    expect(rotaryAngleWords(359.96)).toBe('A 0° · 1 turn');
    expect(rotaryAngleWords(719.96)).toBe('A 0° · 2 turns');
    expect(rotaryAngleWords(-0.04)).toBe('A 0° · 0 turns');
    expect(rotaryAngleWords(359.94)).toBe('A 359.9° · 0 turns');
  });

  it('Z is the height above the axis, one decimal at most', () => {
    expect(aboveAxisWords(9.5)).toBe('above the axis 9.5 mm');
    expect(aboveAxisWords(10)).toBe('above the axis 10 mm');
  });

  it('the angle is read at the same vertex the tool tip is, and NaN is "unknown"', () => {
    const p = path([0, Number.NaN, 360, 720]);
    // Vertices are at steps 0, 10, 20, 30; between them the last one at or before the step wins.
    expect(angleAtStep(p, 0)).toBe(0);
    expect(angleAtStep(p, 15)).toBeNull();
    expect(angleAtStep(p, 20)).toBe(360);
    expect(angleAtStep(p, 999)).toBe(720);
    expect(angleAtStep(p, -1)).toBeNull();
  });

  it('a flat path has no A at all', () => {
    expect(angleAtStep(path(), 10)).toBeNull();
  });

  it('the stock turns by +A: the column under the cutter (θ = A) comes to the top', () => {
    // The column engine's convention: a stock point at θ is (0, r sinθ, r cosθ), and it is under
    // the tool when A = θ (`closestAngularOffset`). Rotating the stock group by turningRadians(A)
    // must bring that point to +Z — the sign is not a style choice but the engine's own model.
    const r = 10;
    const theta = (75 * Math.PI) / 180;
    const point = new THREE.Vector3(0, r * Math.sin(theta), r * Math.cos(theta));
    point.applyAxisAngle(new THREE.Vector3(1, 0, 0), turningRadians(75));
    expect(point.y).toBeCloseTo(0, 9);
    expect(point.z).toBeCloseTo(r, 9);
    // A quarter turn puts the stock's +Z point at the −Y side (θ = 0 → −90°).
    const top = new THREE.Vector3(0, 0, r);
    top.applyAxisAngle(new THREE.Vector3(1, 0, 0), turningRadians(90));
    expect(top.y).toBeCloseTo(-r, 9);
    expect(top.z).toBeCloseTo(0, 9);
  });
});
