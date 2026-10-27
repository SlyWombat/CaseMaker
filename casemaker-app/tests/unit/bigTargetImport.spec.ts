// #720 — the maintainer's model: a 12 MB 3MF imports as a goal, the job reloads with it, and it
// generates. No size cap; the bytes live in the mesh blob store, keyed by SHA-256, and the
// persisted job keeps only the hash, the size and the name.
//
// The fixture is built in the test (a 16 MB model XML in a STORED 3MF entry — a real .3mf is a ZIP,
// and stored entries are legal) so the repository carries no multi-megabyte binary, and the
// triangle count is a real model's order (240k+ triangles).

import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';

// A localStorage shim, installed before the store is used (the store reads it on every write).
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { flatEndMill } from '@/engine/cnc/tool';
import { setMeshBlobIO } from '@/platform/meshBlobs';
import { ENGRAVE_JOB_KEY, reattachTargetBlob, useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/** A terrain grid's model XML, as large as `n` makes it; z is noisy so deflate cannot shrink it. */
function terrainModelXml(n: number, sizeMm = 40): string {
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<resources><object id="1" type="model"><mesh><vertices>',
  ];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      parts.push(
        `<vertex x="${Math.round((i / (n - 1)) * sizeMm * 1000) / 1000}" y="${Math.round((j / (n - 1)) * sizeMm * 1000) / 1000}" z="${Math.round(rnd() * 6000) / 1000}"/>`,
      );
    }
  parts.push('</vertices><triangles>');
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      parts.push(`<triangle v1="${a}" v2="${b}" v3="${d}"/>`);
      parts.push(`<triangle v1="${a}" v2="${d}" v3="${c}"/>`);
    }
  parts.push('</triangles></mesh></object></resources></model>');
  return parts.join('');
}

function stored3mf(model: string): ArrayBuffer {
  const zip = zipSync({ '3D/3dmodel.model': strToU8(model) }, { level: 0 });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

const goalOf = (read: {
  id: string;
  name: string;
  format: EngraveTargetObject['format'];
  sha256: string;
  data: string;
  size: { x: number; y: number; z: number };
}): EngraveTargetObject => ({
  id: read.id,
  name: read.name,
  format: read.format,
  sha256: read.sha256,
  data: read.data,
  size: read.size,
  position: { x: 50, y: 30, z: 0 },
  rotation: 0,
  enabled: true,
  role: 'goal',
});

describe('#720 a 12 MB-class 3MF is an ordinary goal', () => {
  it(
    'imports (no cap), reloads from the blob store, and generates',
    async () => {
      clearTargetObjectMeshCache();
      const model = terrainModelXml(350);
      const bytes = stored3mf(model);
      expect(bytes.byteLength).toBeGreaterThanOrEqual(12 * 1024 * 1024);

      const imported = await readTargetObjectFile(new File([bytes], 'CrimsonDragon.3mf'), 'tgt-big');
      expect(imported.ok, imported.ok ? '' : imported.error).toBe(true);
      if (!imported.ok) return;
      expect(imported.format).toBe('3mf');
      expect(imported.size.x).toBeCloseTo(40, 3);
      expect(imported.size.y).toBeCloseTo(40, 3);

      // The job takes it: the open job holds the bytes, the blob store holds them by hash, and
      // the persisted copy holds neither.
      const blobs = new Map<string, string>();
      setMeshBlobIO({
        put: async (sha256, data) => void blobs.set(sha256, data),
        get: async (sha256) => blobs.get(sha256) ?? null,
      });
      try {
        backing.clear();
        const goal = goalOf(imported);
        const job: EngraveJob = { ...defaultEngraveJob(), labels: [], targetObject: goal };
        useEngraveJobStore.getState().replace(job);
        await vi.waitFor(() => expect(blobs.get(imported.sha256)).toBe(imported.data));
        const persisted = JSON.parse(backing.get(ENGRAVE_JOB_KEY) ?? '{}') as {
          targetObject?: Record<string, unknown>;
        };
        expect(persisted.targetObject?.sha256).toBe(imported.sha256);
        expect('data' in (persisted.targetObject ?? {})).toBe(false);

        // A reload: the document names the hash, the store puts the bytes back.
        const { data: _data, ...withoutBytes } = goal;
        useEngraveJobStore.getState().replace({ ...job, targetObject: withoutBytes });
        await reattachTargetBlob();
        expect(useEngraveJobStore.getState().job.targetObject?.data).toBe(imported.data);

        // And it generates: a pure-goal job's roughing and finishing program.
        const out = generateGoalProgram(
          useEngraveJobStore.getState().job,
          useEngraveJobStore.getState().job.targetObject!,
          flatEndMill(3.175),
          [],
          null,
          {},
        );
        expect(out.ok, `${out.stage} ${JSON.stringify(out.errors)}`).toBe(true);
        expect(out.nc).not.toBeNull();
        expect(out.programs).toHaveLength(1);
      } finally {
        setMeshBlobIO(null);
      }
    },
    60_000,
  );
});
