/**
 * #1179 — BLANK IDENTITY (issue comment 6776457695, the analyst's fields):
 *
 * - `blankId?: string` on every finished-run entry; `currentBlank?: { [jobId]: blankId }` on the
 *   MACHINE record (a job file carries no blank to another machine — nothing enters EngraveJob).
 * - The FIRST finish-write of a job with no id mints one; every later record reuses it. Never on a
 *   repeated hash: "Cut the tabs again" keeps the id and the map.
 * - New ids come from `mintBlank(machineId, jobId)` — the Register card's press and its re-finish
 *   mint ("Cut another of these", D's card, calls the same action).
 * - Records and maps merge within job + machine + blankId (the stock footprint stays a sanity
 *   check, not the identity).
 *
 * The seam is the fake HouseClient, as `finishedPrograms.spec.ts` uses: GET /location serves the
 * machines, PUT /location/machines/:id is `saveMachine`, POST /finished-programs/:id appends.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jobFingerprint } from '@/engine/cnc/engrave/package';
import type { EngraveJob } from '@/types/engraveJob';
import {
  HOUSE_SCHEMA_VERSION,
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
} from '@/platform/houseClient';
import {
  MachineRecordSchema,
  type FinishedRun,
  type FinishedSetupCutMap,
  type MachineRecord,
} from '@/platform/locationClient';
import { clearStoredBaseline, resetLocationStore, useLocationStore } from '@/store/locationStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = { host: '192.0.2.10', port: 2222 };

/** A 2-cell map at a given level; flat on both cells. */
function layer(level: number): FinishedSetupCutMap[] {
  return [
    {
      setupIndex: 1,
      state: 'complete',
      map: {
        cellMm: 2,
        cols: 2,
        rows: 1,
        x0Mm: 0,
        y0Mm: 0,
        stepMm: 0.05,
        flat: { encoding: 'rle', data: '2:1' },
        depth: { encoding: 'rle', data: `1:${level},1:0` },
      },
    },
  ];
}

function run(hash: string, jobId: string, level: number, programIndex = 1): FinishedRun {
  return {
    hash,
    jobId,
    packageKey: 'package-1',
    programIndex,
    stock: { lengthMm: 20, widthMm: 10 },
    cutMaps: layer(level),
  };
}

function fakeService(machineCount = 1): {
  client: HouseClient;
  machines: MachineRecord[];
  posts: { id: string; hash: string; run?: FinishedRun }[];
  puts: MachineRecord[];
  failPuts: (fail: boolean) => void;
} {
  const machines: MachineRecord[] = Array.from({ length: machineCount }, (_, i) =>
    MachineRecordSchema.parse({
      id: i === 0 ? 'm-1' : `m-${i + 1}`,
      address: TARGET,
      updatedAt: '2026-10-15T00:00:00.000Z',
    }),
  );
  const posts: { id: string; hash: string; run?: FinishedRun }[] = [];
  const puts: MachineRecord[] = [];
  let fail = false;
  // The location's ETag MOVES on every write, as the service's does: the store skips applying a
  // read whose etag it already holds, so a fixed etag would hide the mint from the next finish.
  let version = 1;
  const etag = () => `"loc-${version}"`;
  const view = () =>
    JSON.stringify({
      kind: 'casemaker-location',
      schemaVersion: 1,
      id: 'loc-test',
      name: 'My shop',
      createdAt: '2026-10-15T00:00:00.000Z',
      migratedFrom: null,
      machines,
    });
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present',
      base: '',
      health: {
        ok: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
        build: 'v-test',
        hasCatalogue: false,
        feedRows: 0,
        materialSpecRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: [],
      },
    }),
    tools: async () => ({ kind: 'ok', etag: '"t"', entries: [] }),
    feeds: async () => ({ kind: 'absent', reason: 'none' }),
    inventory: async () => ({ kind: 'ok', etag: '"i"', items: [] }),
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') return { kind: 'ok', text: view(), etag: etag() };
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        if (fail) return { kind: 'refused', status: 500, message: 'the service could not write the location' };
        const record = body as MachineRecord;
        puts.push(record);
        const at = machines.findIndex((m) => m.id === record.id);
        if (at >= 0) machines[at] = JSON.parse(JSON.stringify(record)) as MachineRecord;
        version += 1;
        return { kind: 'ok', text: '' };
      }
      if (method === 'POST' && path.startsWith('/finished-programs/')) {
        const id = decodeURIComponent(path.slice('/finished-programs/'.length));
        const posted = body as { hash: string; run?: FinishedRun };
        posts.push({ id, hash: posted.hash, ...(posted.run === undefined ? {} : { run: posted.run }) });
        const machine = machines.find((m) => m.id === id);
        if (machine !== undefined && posted.run !== undefined) {
          const at = machine.finishedRuns.findIndex((record) => record.hash === posted.run!.hash);
          if (at >= 0) machine.finishedRuns.splice(at, 1);
          machine.finishedRuns.push(posted.run);
        }
        version += 1;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served here` };
    },
  };
  return { client, machines, posts, puts, failPuts: (f) => (fail = f) };
}

let service: ReturnType<typeof fakeService>;
beforeEach(async () => {
  resetLocationStore();
  clearStoredBaseline();
  service = fakeService();
  setHouseClientLoader(async () => service.client);
  await useLocationStore.getState().refresh();
});
afterEach(() => {
  setHouseClientLoader(null);
});

describe('#1179 blank identity — the record side', () => {
  it('the first finish of a job with no id MINTS one, and the record carries it', async () => {
    const res = await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 4));
    expect(res.ok).toBe(true);
    const blankId = service.posts[0]!.run?.blankId;
    expect(blankId).toMatch(/^blank-/);
    // The id was WRITTEN to the machine record, keyed by job (a refresh may also write the
    // record's own baseline first, so look for the mint's write rather than counting ones).
    expect(service.puts.some((p) => p.currentBlank?.['job-1'] === blankId)).toBe(true);
    expect(useLocationStore.getState().location?.machines[0]?.currentBlank).toEqual({ 'job-1': blankId });
  });

  it('a later finish of the same job reuses the id — a repeated hash keeps the id and its map', async () => {
    await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 4));
    const first = service.posts[0]!.run!.blankId!;
    await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 4));
    expect(service.posts[1]!.run!.blankId).toBe(first);
    // No second mint, and the map is intact (its own layer over itself).
    expect(service.puts).toHaveLength(1);
    expect(service.posts[1]!.run!.cutMaps![0]!.map!.depth.data).toBe('1:4,1:0');
  });

  it('a press (mintBlank) starts a new blank: a fresh id and no inherited map', async () => {
    await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 10));
    const oldId = service.posts[0]!.run!.blankId!;
    const minted = await useLocationStore.getState().mintBlank('m-1', 'job-1');
    expect(minted.ok).toBe(true);
    expect(minted.blankId).toMatch(/^blank-/);
    expect(minted.blankId).not.toBe(oldId);
    await useLocationStore.getState().recordFinishedProgram('m-1', 'bbbb2222', run('bbbb2222', 'job-1', 4, 2));
    // The new record belongs to the new blank and does not merge the old blank's map.
    expect(service.posts[1]!.run!.blankId).toBe(minted.blankId);
    expect(service.posts[1]!.run!.cutMaps![0]!.map!.depth.data).toBe('1:4,1:0');
    // The old blank's record is history and still carries its own id.
    const history = useLocationStore.getState().location?.machines[0]?.finishedRuns ?? [];
    expect(history.find((r) => r.hash === 'aaaa1111')?.blankId).toBe(oldId);
    expect(history.find((r) => r.hash === 'bbbb2222')?.blankId).toBe(minted.blankId);
  });

  it('the same job on a SECOND machine inherits no blank', async () => {
    resetLocationStore();
    service = fakeService(2);
    setHouseClientLoader(async () => service.client);
    await useLocationStore.getState().refresh();
    await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 10));
    const firstMachineId = service.posts[0]!.run!.blankId!;
    await useLocationStore.getState().recordFinishedProgram('m-2', 'aaaa1111', run('aaaa1111', 'job-1', 4));
    // m-2's first finish mints ITS OWN id — the job file carried nothing.
    expect(service.posts[1]!.run!.blankId).toMatch(/^blank-/);
    expect(service.posts[1]!.run!.blankId).not.toBe(firstMachineId);
    // And no map crosses machines: its own layer stands alone.
    expect(service.posts[1]!.run!.cutMaps![0]!.map!.depth.data).toBe('1:4,1:0');
    expect(service.machines.find((m) => m.id === 'm-2')?.currentBlank).toEqual({ 'job-1': service.posts[1]!.run!.blankId });
  });

  it('a mint that cannot be written posts nothing and says so', async () => {
    service.failPuts(true);
    const res = await useLocationStore.getState().recordFinishedProgram('m-1', 'aaaa1111', run('aaaa1111', 'job-1', 4));
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/blank/);
    expect(service.posts).toHaveLength(0);
  });

  it('the id lives on the machine, never in the job: minting changes no program byte', async () => {
    const job = {
      schemaVersion: 3,
      id: 'job-1',
      name: 'tray',
      machineId: 'Z1',
      stock: { length: 20, width: 10, thickness: 5, material: 'hardwood' },
      targetObjects: [],
      setups: [],
    } as unknown as EngraveJob;
    const before = jobFingerprint(job);
    const minted = await useLocationStore.getState().mintBlank('m-1', 'job-1');
    expect(minted.ok).toBe(true);
    expect(jobFingerprint(job)).toBe(before);
    expect('blankId' in job).toBe(false);
    expect('currentBlank' in job).toBe(false);
  });

  it('the machine record round-trips currentBlank, and a run carries blankId through the schema', () => {
    const base = MachineRecordSchema.parse(
      JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-k3-machine-2026-11-10.json'), 'utf8')).machine,
    );
    const parsed = MachineRecordSchema.parse({
      ...base,
      currentBlank: { 'job-1': 'blank-abc' },
      finishedRuns: [{ hash: 'a1b2c3d4', jobId: 'job-1', blankId: 'blank-abc' }],
    });
    expect(parsed.currentBlank).toEqual({ 'job-1': 'blank-abc' });
    expect(parsed.finishedRuns[0]!.blankId).toBe('blank-abc');
  });
});
