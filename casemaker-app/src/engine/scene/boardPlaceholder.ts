import * as THREE from 'three';
import type { BoardProfile, ComponentKind, BoardComponent } from '@/types';
import { buildFixture } from './fixtures';

const KIND_COLORS: Record<ComponentKind, string> = {
  'usb-c': '#bcbcbc',
  'usb-a': '#9aa0a6',
  'usb-b': '#9aa0a6',
  'micro-usb': '#9aa0a6',
  hdmi: '#2a2a2a',
  'micro-hdmi': '#2a2a2a',
  'barrel-jack': '#1c1c1c',
  'ethernet-rj45': '#d4af37',
  'gpio-header': '#1a1a1a',
  'sd-card': '#3b6fb6',
  'flat-cable': '#c0a060',
  'fan-mount': '#444444',
  'text-label': '#666666',
  'antenna-connector': '#9c5a3c',
  custom: '#7a7a7a',
};

const PCB_COLOR = '#0d6b3a';

function colorFor(kind: ComponentKind): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.custom;
}

/**
 * Build a representative 3D mesh for a board when no GLB asset is available.
 * The mesh is positioned in the same coordinate frame as the case cavity:
 * board origin at (cl, cl, floor + standoff) — matching the host PCB
 * placement used by the cutout compiler.
 *
 * The placeholder is purely informational; it does not feed the cutout
 * pipeline (the schema-driven `BoardComponent` data already does that).
 */
export interface PlaceholderTransform {
  /** World offset of the PCB lower-left corner. */
  origin: { x: number; y: number; z: number };
}

export function buildBoardPlaceholderGroup(
  board: BoardProfile,
  transform: PlaceholderTransform = { origin: { x: 0, y: 0, z: 0 } },
): THREE.Group {
  const group = new THREE.Group();
  group.name = `board-placeholder:${board.id}`;
  group.userData = { boardId: board.id, kind: 'board-placeholder' };

  const pcb = board.pcb.size;
  const pcbGeom = new THREE.BoxGeometry(pcb.x, pcb.y, pcb.z);
  const pcbMat = new THREE.MeshStandardMaterial({
    color: PCB_COLOR,
    metalness: 0.05,
    roughness: 0.85,
  });
  const pcbMesh = new THREE.Mesh(pcbGeom, pcbMat);
  pcbMesh.position.set(pcb.x / 2, pcb.y / 2, pcb.z / 2);
  pcbMesh.name = 'pcb';
  group.add(pcbMesh);

  // Mounting holes — drawn as small light-colored rings on top of the PCB so
  // users can sanity-check hole alignment against the case bosses.
  for (const hole of board.mountingHoles) {
    const r = hole.diameter / 2;
    const ringGeom = new THREE.RingGeometry(r, r + 0.4, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: '#ffd54a',
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.set(hole.x, hole.y, pcb.z + 0.05);
    ring.name = `hole:${hole.id}`;
    group.add(ring);
  }

  for (const comp of board.components) {
    const obj = componentObject(comp);
    if (obj) group.add(obj);
  }

  group.position.set(transform.origin.x, transform.origin.y, transform.origin.z);
  return group;
}

function componentObject(comp: BoardComponent): THREE.Object3D | null {
  if (comp.size.x <= 0 || comp.size.y <= 0 || comp.size.z <= 0) return null;
  // Resolution ladder: explicit fixtureId → kind-based procedural fixture →
  // plain coloured block keyed by kind.
  const fixture = buildFixture(comp.kind, comp.size, comp.fixtureId);
  if (fixture) {
    fixture.position.set(comp.position.x, comp.position.y, comp.position.z);
    fixture.name = `component:${comp.id}`;
    fixture.userData = {
      componentId: comp.id,
      kind: comp.kind,
      fixtureId: comp.fixtureId,
    };
    return fixture;
  }
  const geom = new THREE.BoxGeometry(comp.size.x, comp.size.y, comp.size.z);
  const mat = new THREE.MeshStandardMaterial({
    color: colorFor(comp.kind),
    metalness: 0.2,
    roughness: 0.6,
  });
  const m = new THREE.Mesh(geom, mat);
  m.position.set(
    comp.position.x + comp.size.x / 2,
    comp.position.y + comp.size.y / 2,
    comp.position.z + comp.size.z / 2,
  );
  m.name = `component:${comp.id}`;
  m.userData = { componentId: comp.id, kind: comp.kind };
  return m;
}

/**
 * Compute the placeholder bounding box without instantiating Three meshes —
 * useful for tests and for layout decisions before the scene mounts.
 */
export function placeholderBounds(board: BoardProfile): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  let minX = 0;
  let minY = 0;
  let minZ = 0;
  let maxX = board.pcb.size.x;
  let maxY = board.pcb.size.y;
  let maxZ = board.pcb.size.z;
  for (const c of board.components) {
    minX = Math.min(minX, c.position.x);
    minY = Math.min(minY, c.position.y);
    minZ = Math.min(minZ, c.position.z);
    maxX = Math.max(maxX, c.position.x + c.size.x);
    maxY = Math.max(maxY, c.position.y + c.size.y);
    maxZ = Math.max(maxZ, c.position.z + c.size.z);
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}
