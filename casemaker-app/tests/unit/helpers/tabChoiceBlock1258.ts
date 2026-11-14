/**
 * #1258 — the asking fixture, shared by the CLI spec and the pick spec: a 27 x 10 x 10 body (walls
 * drafted 1 mm) on a 60 x 40 blank, in the committed Set B shop with the span limit at the registry's
 * lowest, 10 mm. Its four edges each hold one tab and the stretches between them stay over the limit
 * (no tab fits in them), so every cutter's plan raises the tab question.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultEngraveJob } from '../../../src/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveTargetObject } from '../../../src/types/engraveJob';
import { stl, type MeshTri } from './meshes';

export const SETB = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'giraffe-1155', 'setb');

/** The Set B location document with `tabs.maxSpanMm` set to 10 mm, written to `dir`; returns its path. */
export function blockLocation(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const doc = JSON.parse(readFileSync(join(SETB, 'location.json'), 'utf8')) as { defaults: Record<string, Record<string, unknown>> };
  doc.defaults['tabs.maxSpanMm'] = {
    value: 10,
    source: 'chosen',
    setAt: '2026-11-13T12:00:00.000Z',
    unit: 'mm',
    note: 'chosen for this spec: the lowest span limit the registry allows',
  };
  const path = join(dir, 'location.json');
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}

export function blockTarget(): EngraveTargetObject {
  const [w, d, h] = [27, 10, 10];
  const v: [number, number, number][] = [
    [1, 1, 0], [w - 1, 1, 0], [w - 1, d - 1, 0], [1, d - 1, 0],
    [0, 0, -h], [w, 0, -h], [w, d, -h], [0, d, -h],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const tris: MeshTri[] = faces.map((f) => [v[f[0]]!, v[f[1]]!, v[f[2]]!]);
  return {
    id: 'goal-1258',
    name: 'block-1258.stl',
    format: 'stl',
    sha256: 'e'.repeat(64),
    data: stl(tris),
    size: { x: w, y: d, z: h },
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

export function blockJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 60, width: 40, thickness: 10, material: 'hardwood' },
    targetObject: blockTarget(),
  };
}
