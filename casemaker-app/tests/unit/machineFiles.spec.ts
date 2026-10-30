// #772 — the card's file list and delete, UI side.
//
// The seam is the client: `setMachineFilesLoader` swaps the socket half, so the real path
// (guard → client → outcome) runs in every test. What these pin is the panel's two safety clauses
// and the ledger that carries the first one: only a file THIS browser recorded uploading may be
// deleted, and never while the machine is running a job — both refused here, before any client is
// asked, so a future caller cannot skip them by forgetting to check.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteMachineFile,
  forgetUploadedFile,
  isUploadedFile,
  listMachineFiles,
  recordUploadedFile,
  setMachineFilesLoader,
  uploadedFileNames,
  type MachineFilesClient,
} from '@/platform/machineFiles';

// A minimal in-memory Storage: the suite runs on node, where localStorage does not exist.
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const HOST = '192.168.10.43';
const TARGET = { host: HOST, port: 2222 };

function fakeClient(overrides: Partial<MachineFilesClient> = {}): MachineFilesClient & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: async () => ({ kind: 'listed', entries: [{ name: 'a.nc', size: 10, modified: '20261029120000', directory: false }] }),
    remove: async (_t, name) => {
      removed.push(name);
      return { kind: 'deleted', name, detail: `"${name}" was deleted from the machine's card.` };
    },
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  setMachineFilesLoader(async () => fakeClient());
});

describe('#772 the upload ledger', () => {
  it('records what this browser uploaded, and forgets it when asked', () => {
    recordUploadedFile(HOST, 'job.nc');
    recordUploadedFile(HOST, 'job.nc');
    expect(uploadedFileNames(HOST)).toEqual(['job.nc']);
    expect(isUploadedFile(HOST, 'job.nc')).toBe(true);
    expect(isUploadedFile(HOST, 'other.nc')).toBe(false);
    forgetUploadedFile(HOST, 'job.nc');
    expect(isUploadedFile(HOST, 'job.nc')).toBe(false);
  });

  it('survives no storage at all', () => {
    (globalThis as unknown as { localStorage?: Storage }).localStorage = undefined;
    recordUploadedFile(HOST, 'job.nc');
    expect(uploadedFileNames(HOST)).toEqual([]);
    expect(isUploadedFile(HOST, 'job.nc')).toBe(false);
  });
});

describe('#772 deleting a file', () => {
  it('deletes a file this app uploaded, and drops it from the ledger', async () => {
    recordUploadedFile(HOST, 'job.nc');
    const client = fakeClient();
    setMachineFilesLoader(async () => client);
    const result = await deleteMachineFile(TARGET, 'job.nc');
    expect(result.kind).toBe('deleted');
    expect(client.removed).toEqual(['job.nc']);
    expect(isUploadedFile(HOST, 'job.nc')).toBe(false);
  });

  it('refuses a file it did not upload, before asking the machine', async () => {
    const client = fakeClient();
    setMachineFilesLoader(async () => client);
    const result = await deleteMachineFile(TARGET, 'studio.nc');
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.detail).toContain('was not uploaded by Case Maker');
    expect(client.removed).toEqual([]);
  });

  it('refuses while a job is running, before asking the machine', async () => {
    recordUploadedFile(HOST, 'job.nc');
    const client = fakeClient();
    setMachineFilesLoader(async () => client);
    const result = await deleteMachineFile(TARGET, 'job.nc', { busy: true });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.detail).toContain('running a job');
    expect(client.removed).toEqual([]);
  });

  it('keeps the ledger entry when the machine refuses the delete', async () => {
    recordUploadedFile(HOST, 'job.nc');
    setMachineFilesLoader(async () =>
      fakeClient({ remove: async () => ({ kind: 'refused', detail: 'rm: cannot remove: permission denied' }) }),
    );
    const result = await deleteMachineFile(TARGET, 'job.nc');
    expect(result.kind).toBe('refused');
    expect(isUploadedFile(HOST, 'job.nc')).toBe(true);
  });

  it('refuses a name with a path in it', async () => {
    recordUploadedFile(HOST, 'job.nc');
    const result = await deleteMachineFile(TARGET, '/sd/other.nc');
    expect(result.kind).toBe('refused');
  });
});

describe('#772 listing the card', () => {
  it('answers the card’s entries through the client', async () => {
    const result = await listMachineFiles(TARGET);
    expect(result.kind).toBe('listed');
    if (result.kind === 'listed') expect(result.entries.map((e) => e.name)).toEqual(['a.nc']);
  });

  it('is unavailable when the bridge cannot be loaded, not a throw', async () => {
    setMachineFilesLoader(async () => {
      throw new Error('this build cannot drive a machine');
    });
    const result = await listMachineFiles(TARGET);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.detail).toContain('cannot drive a machine');
  });

  it('refuses a machine with no address without loading a client', async () => {
    let loaded = 0;
    setMachineFilesLoader(async () => {
      loaded++;
      return fakeClient();
    });
    const result = await listMachineFiles({ host: '  ', port: 2222 });
    expect(result.kind).toBe('refused');
    expect(loaded).toBe(0);
  });
});
