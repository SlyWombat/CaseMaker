import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildFixture,
  listProceduralKinds,
  listProceduralFixtureIds,
} from '@/engine/scene/fixtures';
import type { ComponentKind } from '@/types';

const SAMPLE_SIZE = { x: 12, y: 8, z: 6 };

function bbox(g: THREE.Group): THREE.Box3 {
  return new THREE.Box3().setFromObject(g);
}

describe('Procedural fixture library (#39 Phase 1)', () => {
  it('returns null for unknown kinds with no fixtureId', () => {
    expect(buildFixture('text-label' as ComponentKind, SAMPLE_SIZE)).toBeNull();
  });

  it('returns null for zero / negative size', () => {
    expect(buildFixture('usb-c', { x: 0, y: 1, z: 1 })).toBeNull();
    expect(buildFixture('usb-c', { x: 1, y: -1, z: 1 })).toBeNull();
  });

  for (const kind of listProceduralKinds()) {
    it(`builds a non-empty group for kind=${kind} that fits within the bbox`, () => {
      const g = buildFixture(kind, SAMPLE_SIZE)!;
      expect(g).toBeInstanceOf(THREE.Group);
      expect(g.children.length).toBeGreaterThan(0);
      const box = bbox(g);
      const size = new THREE.Vector3();
      box.getSize(size);
      // Allow a small slack for cylinder approximations.
      expect(size.x).toBeLessThanOrEqual(SAMPLE_SIZE.x + 0.01);
      expect(size.y).toBeLessThanOrEqual(SAMPLE_SIZE.y + 0.01);
      expect(size.z).toBeLessThanOrEqual(SAMPLE_SIZE.z + 0.01);
    });
  }

  for (const id of listProceduralFixtureIds()) {
    it(`builds a fixture for id=${id}`, () => {
      const g = buildFixture('custom', SAMPLE_SIZE, id)!;
      expect(g).toBeInstanceOf(THREE.Group);
      expect(g.children.length).toBeGreaterThan(0);
    });
  }

  it('fixtureId wins over kind when both have a builder', () => {
    const g = buildFixture('custom', SAMPLE_SIZE, 'xlr-3')!;
    expect(g.name).toBe('xlr-3');
  });
});
