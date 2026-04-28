import * as THREE from 'three';
import type { ComponentKind } from '@/types';
import { fixtureGroup, box, placeAt, cylinder, type FixtureSize } from './_common';

export type FixtureBuilder = (size: FixtureSize) => THREE.Group;

/**
 * Procedural fixture builders for board / HAT components. Each builder produces
 * a group that fills the requested bounding box (so it slots in wherever the
 * plain placeholder block went). Tier 1 of issue #39 — recognisable shapes,
 * no external assets required.
 */

function buildPort(
  size: FixtureSize,
  body: { color: string; insetX?: number; insetY?: number; insetZ?: number },
  opening: { color: string; depth?: number },
): THREE.Group {
  const g = fixtureGroup('port');
  // Outer metal shell
  g.add(
    placeAt(
      box(size, body.color, { metalness: 0.7, roughness: 0.35 }),
      size.x / 2,
      size.y / 2,
      size.z / 2,
    ),
  );
  // Inner darker recess hinting at the connector throat
  const inX = body.insetX ?? Math.min(1.5, size.x * 0.2);
  const inY = body.insetY ?? Math.min(1.5, size.y * 0.2);
  const inZ = body.insetZ ?? Math.min(1.5, size.z * 0.25);
  const inner = box(
    { x: Math.max(0.5, size.x - inX), y: Math.max(0.5, size.y - inY * 2), z: Math.max(0.5, size.z - inZ * 2) },
    opening.color,
    { metalness: 0.1, roughness: 0.85 },
  );
  // Push the recess to one face — assume +x is the open mouth (caller rotates
  // through component facing later if needed; for now centre it).
  inner.position.set(size.x / 2 - inX / 4, size.y / 2, size.z / 2);
  g.add(inner);
  return g;
}

const buildUsbA: FixtureBuilder = (size) =>
  buildPort(size, { color: '#a5a8ad' }, { color: '#1c1c1c' });

const buildUsbB: FixtureBuilder = (size) =>
  buildPort(size, { color: '#a5a8ad' }, { color: '#1c1c1c' });

const buildUsbC: FixtureBuilder = (size) => {
  const g = fixtureGroup('usb-c');
  g.add(
    placeAt(
      box(size, '#bcbcbc', { metalness: 0.75, roughness: 0.3 }),
      size.x / 2,
      size.y / 2,
      size.z / 2,
    ),
  );
  // Oval-ish dark recess
  const slot = box(
    { x: Math.max(0.6, size.x * 0.5), y: Math.max(0.6, size.y * 0.55), z: Math.max(0.6, size.z * 0.5) },
    '#0e0e0e',
    { metalness: 0.05, roughness: 0.95 },
  );
  slot.position.set(size.x * 0.6, size.y / 2, size.z / 2);
  g.add(slot);
  return g;
};

const buildMicroUsb: FixtureBuilder = (size) =>
  buildPort(size, { color: '#a5a8ad' }, { color: '#1c1c1c' });

const buildHdmi: FixtureBuilder = (size) =>
  buildPort(size, { color: '#2a2a2a' }, { color: '#0a0a0a' });

const buildMicroHdmi: FixtureBuilder = (size) =>
  buildPort(size, { color: '#2a2a2a' }, { color: '#0a0a0a' });

const buildBarrelJack: FixtureBuilder = (size) => {
  const g = fixtureGroup('barrel-jack');
  // Plastic body
  g.add(
    placeAt(box(size, '#1c1c1c', { metalness: 0.05, roughness: 0.9 }), size.x / 2, size.y / 2, size.z / 2),
  );
  // Cylindrical socket
  const r = Math.min(size.y, size.z) * 0.32;
  const cyl = cylinder(r, Math.max(0.5, size.x * 0.35), '#3a3a3a');
  cyl.rotation.z = Math.PI / 2;
  cyl.position.set(size.x * 0.75, size.y / 2, size.z / 2);
  g.add(cyl);
  return g;
};

const buildRj45: FixtureBuilder = (size) => {
  const g = fixtureGroup('rj45');
  // Metal shielded body
  g.add(
    placeAt(box(size, '#c4a85a', { metalness: 0.6, roughness: 0.45 }), size.x / 2, size.y / 2, size.z / 2),
  );
  // Plastic latch slot in the middle
  const latch = box(
    { x: Math.max(0.6, size.x * 0.5), y: Math.max(0.6, size.y * 0.6), z: Math.max(0.6, size.z * 0.55) },
    '#1a1a1a',
    { metalness: 0.05, roughness: 0.95 },
  );
  latch.position.set(size.x * 0.65, size.y / 2, size.z / 2);
  g.add(latch);
  return g;
};

const buildPinHeader: FixtureBuilder = (size) => {
  const g = fixtureGroup('pin-header');
  // Black plastic strip occupies the bottom 30% of the requested size.
  const strikeZ = size.z * 0.3;
  g.add(
    placeAt(box({ x: size.x, y: size.y, z: strikeZ }, '#0e0e0e', { metalness: 0.05, roughness: 0.95 }),
      size.x / 2,
      size.y / 2,
      strikeZ / 2,
    ),
  );
  // Tile 2.54mm pins above the plastic strip; pin height fills the remaining
  // 70% so the union bbox equals `size` exactly (issue #42 fixture-bbox fix).
  const PITCH = 2.54;
  const pinHeight = size.z - strikeZ;
  const cols = Math.max(1, Math.round(size.x / PITCH));
  const rows = Math.max(1, Math.round(size.y / PITCH));
  // Cap rows × cols so we don't allocate thousands of meshes for very wide
  // headers that the user can't visually distinguish anyway.
  const MAX = 80;
  const totalNominal = cols * rows;
  const skip = totalNominal > MAX ? Math.ceil(totalNominal / MAX) : 1;
  let drawn = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if ((i * rows + j) % skip !== 0) continue;
      const pin = box(
        { x: 0.6, y: 0.6, z: pinHeight },
        '#d4af37',
        { metalness: 0.85, roughness: 0.25 },
      );
      pin.position.set(
        (i + 0.5) * (size.x / cols),
        (j + 0.5) * (size.y / rows),
        strikeZ + pinHeight / 2,
      );
      g.add(pin);
      drawn++;
      if (drawn >= MAX) break;
    }
    if (drawn >= MAX) break;
  }
  return g;
};

const buildSdSlot: FixtureBuilder = (size) => {
  const g = fixtureGroup('sd-slot');
  // Tin-plated tray
  g.add(
    placeAt(box(size, '#c8c8c8', { metalness: 0.55, roughness: 0.5 }), size.x / 2, size.y / 2, size.z / 2),
  );
  // Recessed slot
  const slot = box(
    { x: Math.max(0.3, size.x * 0.6), y: Math.max(0.3, size.y * 0.85), z: Math.max(0.2, size.z * 0.3) },
    '#1a1a1a',
    { metalness: 0.05, roughness: 0.95 },
  );
  slot.position.set(size.x * 0.65, size.y / 2, size.z * 0.85);
  g.add(slot);
  return g;
};

const buildFpcConnector: FixtureBuilder = (size) => {
  const g = fixtureGroup('fpc');
  // Brown body
  g.add(
    placeAt(box({ x: size.x, y: size.y, z: size.z * 0.7 }, '#8a5a2a', { metalness: 0.05, roughness: 0.9 }),
      size.x / 2,
      size.y / 2,
      size.z * 0.35,
    ),
  );
  // Black flap
  g.add(
    placeAt(box({ x: size.x, y: size.y, z: size.z * 0.3 }, '#1a1a1a', { metalness: 0.05, roughness: 0.95 }),
      size.x / 2,
      size.y / 2,
      size.z * 0.85,
    ),
  );
  return g;
};

const buildFanMount: FixtureBuilder = (size) => {
  const g = fixtureGroup('fan-mount');
  // Outer frame
  g.add(
    placeAt(box(size, '#2a2a2a', { metalness: 0.3, roughness: 0.6 }), size.x / 2, size.y / 2, size.z / 2),
  );
  // Hub
  const r = Math.min(size.x, size.y) * 0.18;
  const hub = cylinder(r, size.z, '#1a1a1a');
  hub.rotation.x = Math.PI / 2;
  hub.position.set(size.x / 2, size.y / 2, size.z / 2);
  g.add(hub);
  return g;
};

const buildAntennaConnector: FixtureBuilder = (size) => {
  const g = fixtureGroup('ufl');
  g.add(
    placeAt(box(size, '#8a5a3a', { metalness: 0.4, roughness: 0.5 }), size.x / 2, size.y / 2, size.z / 2),
  );
  const r = Math.min(size.x, size.y) * 0.32;
  const top = cylinder(r, size.z * 0.4, '#d4af37');
  top.rotation.x = Math.PI / 2;
  top.position.set(size.x / 2, size.y / 2, size.z * 0.8);
  g.add(top);
  return g;
};

const buildAudioJack35: FixtureBuilder = (size) => {
  const g = fixtureGroup('audio-jack-3-5');
  const r = Math.min(size.y, size.z) * 0.45;
  const body = cylinder(r, size.x, '#1c1c1c');
  body.rotation.z = Math.PI / 2;
  body.position.set(size.x / 2, size.y / 2, size.z / 2);
  g.add(body);
  // Inner hole
  const hole = cylinder(r * 0.45, size.x * 0.5, '#000000');
  hole.rotation.z = Math.PI / 2;
  hole.position.set(size.x * 0.75, size.y / 2, size.z / 2);
  g.add(hole);
  return g;
};

const buildXlr3: FixtureBuilder = (size) => {
  const g = fixtureGroup('xlr-3');
  const r = Math.min(size.x, size.z) * 0.45;
  const body = cylinder(r, size.y, '#222222', { segments: 32 });
  body.rotation.x = Math.PI / 2;
  body.position.set(size.x / 2, size.y / 2, size.z / 2);
  g.add(body);
  // Three-pin pattern hint
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI * 2 * i) / 3 - Math.PI / 2;
    const px = size.x / 2 + Math.cos(angle) * r * 0.4;
    const pz = size.z / 2 + Math.sin(angle) * r * 0.4;
    const pin = cylinder(0.6, size.y * 0.4, '#d4af37');
    pin.rotation.x = Math.PI / 2;
    pin.position.set(px, size.y * 0.75, pz);
    g.add(pin);
  }
  return g;
};

const KIND_BUILDERS: Partial<Record<ComponentKind, FixtureBuilder>> = {
  'usb-c': buildUsbC,
  'usb-a': buildUsbA,
  'usb-b': buildUsbB,
  'micro-usb': buildMicroUsb,
  hdmi: buildHdmi,
  'micro-hdmi': buildMicroHdmi,
  'barrel-jack': buildBarrelJack,
  'ethernet-rj45': buildRj45,
  'gpio-header': buildPinHeader,
  'sd-card': buildSdSlot,
  'flat-cable': buildFpcConnector,
  'fan-mount': buildFanMount,
  'antenna-connector': buildAntennaConnector,
};

const FIXTURE_ID_BUILDERS: Record<string, FixtureBuilder> = {
  'audio-jack-3-5': buildAudioJack35,
  'xlr-3': buildXlr3,
};

/**
 * Resolve a fixture for a given kind / fixtureId. Returns null if neither has
 * a procedural builder; the caller should fall back to a plain coloured block.
 */
export function buildFixture(
  kind: ComponentKind,
  size: FixtureSize,
  fixtureId?: string,
): THREE.Group | null {
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
  if (fixtureId && FIXTURE_ID_BUILDERS[fixtureId]) {
    return FIXTURE_ID_BUILDERS[fixtureId]!(size);
  }
  const builder = KIND_BUILDERS[kind];
  if (!builder) return null;
  return builder(size);
}

export function listProceduralKinds(): ComponentKind[] {
  return Object.keys(KIND_BUILDERS) as ComponentKind[];
}

export function listProceduralFixtureIds(): string[] {
  return Object.keys(FIXTURE_ID_BUILDERS);
}
