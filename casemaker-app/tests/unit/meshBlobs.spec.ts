// #720 — a target mesh's BYTES live beside the job. The localStorage copy keeps the hash, the size
// and the name; the blob store (IndexedDB in the app) keeps the bytes keyed by SHA-256; a reload
// re-attaches them, and a miss is a sentence with "Import it again".
//
// The blob store is replaced with an in-memory map (the app's own seam), so the store's behaviours
// are pinned without IndexedDB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A localStorage shim, installed in the body like the other store specs: the shim exists by the
// time a test WRITES, which is when the store's persist() reads it.
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
import { validateJob, withTargetBlobState } from '@/engine/cnc/engrave/jobSetup';
import { parseJobFile, serializeJobFile } from '@/engine/cnc/engrave/jobFile';
import { sweepUnusedMeshBlobs } from '@/store/meshBlobSweep';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { adoptInitialTargetBlob, ENGRAVE_JOB_KEY, reattachTargetBlob, useEngraveJobStore } from '@/store/engraveJobStore';
import { setMeshBlobIO } from '@/platform/meshBlobs';
import type { EngraveTargetObject } from '@/types/engraveJob';

const SHA = 'b'.repeat(64);
const TARGET: EngraveTargetObject = {
  id: 'tgt-1',
  name: 'CrimsonDragon.3mf',
  format: '3mf',
  sha256: SHA,
  data: 'QUJD',
  size: { x: 40, y: 30, z: 6 },
  position: { x: 50, y: 30, z: 0 },
  rotation: 0,
  enabled: true,
  role: 'goal',
};

const { data: _bytes, ...NO_BYTES } = TARGET;

let blobs: Map<string, string>;

beforeEach(() => {
  blobs = new Map();
  setMeshBlobIO({
    put: async (sha256, data) => void blobs.set(sha256, data),
    get: async (sha256) => blobs.get(sha256) ?? null,
  });
  backing.clear();
  useEngraveJobStore.getState().reset();
});

afterEach(() => {
  setMeshBlobIO(null);
});

const job = () => useEngraveJobStore.getState().job;
const blobState = () => useEngraveJobStore.getState().targetBlob;

describe('#720 the bytes live beside the job', () => {
  it('importing writes the blob and keeps it OUT of the persisted copy', () => {
    useEngraveJobStore.getState().setTargetObject({ ...TARGET });

    // The open job holds the bytes; the blob store has them by hash.
    expect(job().targetObject?.data).toBe('QUJD');
    expect(blobs.get(SHA)).toBe('QUJD');
    expect(blobState()).toBe('ready');

    // The localStorage copy keeps the identity and NOT the bytes (a 12 MB mesh would blow the
    // ~5 MB quota once base64'd).
    const persisted = JSON.parse(backing.get(ENGRAVE_JOB_KEY) ?? '{}') as {
      targetObject?: Record<string, unknown>;
    };
    expect(persisted.targetObject?.sha256).toBe(SHA);
    expect(persisted.targetObject?.name).toBe('CrimsonDragon.3mf');
    expect(persisted.targetObject?.size).toEqual({ x: 40, y: 30, z: 6 });
    expect('data' in (persisted.targetObject ?? {})).toBe(false);
  });

  it('a reload re-attaches the bytes by hash', async () => {
    blobs.set(SHA, 'QUJD');
    // What the persisted job loads as: the same target, without bytes.
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), targetObject: { ...NO_BYTES } });

    await reattachTargetBlob();
    expect(job().targetObject?.data).toBe('QUJD');
    expect(blobState()).toBe('ready');
    // …and the persisted copy stays lean.
    const persisted = JSON.parse(backing.get(ENGRAVE_JOB_KEY) ?? '{}') as { targetObject?: Record<string, unknown> };
    expect('data' in (persisted.targetObject ?? {})).toBe(false);
  });

  it('a job written before #720 adopts its embedded bytes, so the first reload keeps them', async () => {
    // The pre-#720 round trip: the job in memory HAS the bytes, and the next persist strips them.
    // At start-up those bytes must reach the blob store first (or the first reload loses the mesh).
    const before = { ...defaultEngraveJob(), targetObject: { ...TARGET } };
    adoptInitialTargetBlob(before);
    await vi.waitFor(() => expect(blobs.get(SHA)).toBe('QUJD'));
    // The stripped document then comes back with its mesh, as any later reload does.
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), targetObject: { ...NO_BYTES } });
    await reattachTargetBlob();
    expect(job().targetObject?.data).toBe('QUJD');
  });

  it('a .cutjob with the bytes embedded stores them for the next reload', async () => {
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), targetObject: { ...TARGET } });
    await vi.waitFor(() => expect(blobs.get(SHA)).toBe('QUJD'));
    expect(blobState()).toBe('ready');
  });

  it('a mesh this browser does not hold is a sentence, an error for a goal and a warning for a reference', async () => {
    useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), targetObject: { ...NO_BYTES } });
    await reattachTargetBlob();
    expect(blobState()).toBe('missing');

    const goal = validateJob(job()).find((f) => f.code === 'target-mesh-missing');
    expect(goal?.severity).toBe('error');
    expect(goal?.message).toBe(
      'The goal mesh “CrimsonDragon.3mf” is not in this browser any more — Import it again.',
    );

    useEngraveJobStore.getState().replace({
      ...defaultEngraveJob(),
      targetObject: { ...NO_BYTES, role: undefined },
    });
    await reattachTargetBlob();
    const reference = validateJob(job()).find((f) => f.code === 'target-mesh-missing');
    expect(reference?.severity).toBe('warning');
    expect(reference?.message).toContain('The reference mesh');
  });

  it('a document with no bytes is still a valid document (and one with bytes is too)', () => {
    const without = { ...defaultEngraveJob(), targetObject: { ...NO_BYTES } };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(without)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.targetObject?.data).toBeUndefined();
    const withBytes = parseEngraveJob(JSON.parse(JSON.stringify({ ...defaultEngraveJob(), targetObject: { ...TARGET } })));
    expect(withBytes.ok).toBe(true);
    if (withBytes.ok) expect(withBytes.job.targetObject?.data).toBe('QUJD');
  });
});

describe('#728 the blob store review', () => {
  it('a refused write is a sentence: the open job keeps the mesh, a reload would not', async () => {
    setMeshBlobIO({
      put: async () => {
        throw new Error('QuotaExceededError');
      },
      get: async () => null,
    });
    useEngraveJobStore.getState().setTargetObject({ ...TARGET });
    await vi.waitFor(() => expect(blobState()).toBe('unstored'));
    expect(job().targetObject?.data).toBe('QUJD');
    const findings = withTargetBlobState(validateJob(job()), job(), blobState());
    const unstored = findings.find((f) => f.code === 'target-mesh-unstored');
    expect(unstored?.severity).toBe('warning');
    expect(unstored?.message).toContain('Save the job to a file');
  });

  it('while the store is being asked, the mesh is loading — not "Import it again"', () => {
    const findings = validateJob({ ...defaultEngraveJob(), targetObject: { ...NO_BYTES } });
    expect(findings.some((f) => f.code === 'target-mesh-missing')).toBe(true);
    const loading = withTargetBlobState(findings, { ...defaultEngraveJob(), targetObject: { ...NO_BYTES } }, 'loading');
    expect(loading.some((f) => f.code === 'target-mesh-missing')).toBe(false);
    expect(loading.find((f) => f.code === 'target-mesh-loading')?.severity).toBe('info');
    // Once the store has answered that it does not hold it, the sentence is the import door again.
    const missing = withTargetBlobState(findings, { ...defaultEngraveJob(), targetObject: { ...NO_BYTES } }, 'missing');
    expect(missing.find((f) => f.code === 'target-mesh-missing')?.message).toContain('Import it again');
  });

  it('undoing a removal made while the mesh was loading fetches it again', async () => {
    blobs.set(SHA, 'QUJD');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    setMeshBlobIO({
      put: async (sha256, data) => void blobs.set(sha256, data),
      get: async (sha256) => {
        await gate;
        return blobs.get(sha256) ?? null;
      },
    });
    useEngraveJobStore.getState().setTargetObject({ ...NO_BYTES });
    expect(blobState()).toBe('loading');
    useEngraveJobStore.getState().removeTargetObject();
    expect(blobState()).toBe('none');
    release();
    await Promise.resolve();
    useEngraveJobStore.getState().undoRemove();
    await vi.waitFor(() => expect(blobState()).toBe('ready'));
    expect(job().targetObject?.data).toBe('QUJD');
  });

  it('the sweep drops every stored mesh nothing refers to', async () => {
    blobs.set(SHA, 'QUJD');
    blobs.set('c'.repeat(64), 'REVG');
    setMeshBlobIO({
      put: async (sha256, data) => void blobs.set(sha256, data),
      get: async (sha256) => blobs.get(sha256) ?? null,
      keys: async () => [...blobs.keys()],
      delete: async (sha256) => void blobs.delete(sha256),
    });
    useEngraveJobStore.getState().setTargetObject({ ...TARGET });
    expect(await sweepUnusedMeshBlobs()).toBe(1);
    expect([...blobs.keys()]).toEqual([SHA]);
  });

  it('a file whose mesh does not match its fingerprint opens under the fingerprint of its bytes', async () => {
    const text = serializeJobFile({ ...defaultEngraveJob(), targetObject: { ...TARGET } });
    const parsed = await parseJobFile(text);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    // 'QUJD' is "ABC".
    const abc = 'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78';
    expect(parsed.job.targetObject?.sha256).toBe(abc);
    expect(parsed.meshNote).toContain('does not match');
    const honest = await parseJobFile(
      serializeJobFile({ ...defaultEngraveJob(), targetObject: { ...TARGET, sha256: abc } }),
    );
    expect(honest.ok && honest.meshNote).toBeNull();
  });
});
