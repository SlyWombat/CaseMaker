// @vitest-environment jsdom
// #419 §4.5 — a machine's finished programs: the writer appends once, the reader hands the persisted
// list to the run plan, and the key is the program's own FNV hash (decision 3, Q14).
//
// The seam is the `HouseClient` fake, as `locationStore.spec.ts` uses: `GET /location` serves the
// machine list, and `POST /finished-programs/:id` appends (deduping, as `finished_programs.rs` does).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { Z1 } from '@/engine/cnc/machine';
import { planRun, type RunPlanInput } from '@/engine/cnc/plan';
import { programHash } from '@/platform/machineRun';
import {
  HOUSE_SCHEMA_VERSION,
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
} from '@/platform/houseClient';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';
import {
  clearStoredBaseline,
  finishedProgramsFor,
  machineAt,
  resetLocationStore,
  useLocationStore,
} from '@/store/locationStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const DEFAULTS = ShopDefaultsSchema.parse(DOC.defaults);

const TARGET = { host: '192.0.2.10', port: 2222 };
const NC = ['G90 G21', 'T1 M6', 'M3', 'G0 X10 Y10', 'G1 Z-0.5 F600', 'G1 X20 Y10 F600', 'M5', 'M2'].join('\n');
const HASH = programHash(NC);

/** The service's location with one machine at `TARGET`, and the append endpoint the writer calls. */
function fakeService() {
  const machine: MachineRecord = MachineRecordSchema.parse({
    id: 'm-1',
    address: TARGET,
    updatedAt: '2026-10-15T00:00:00.000Z',
  });
  const posts: { id: string; hash: string }[] = [];
  let version = 1;
  const view = () =>
    JSON.stringify({
      kind: 'casemaker-location',
      schemaVersion: 1,
      id: 'loc-test',
      name: 'My shop',
      createdAt: '2026-10-15T00:00:00.000Z',
      migratedFrom: null,
      machines: [machine],
    });
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present',
      base: '',
      health: {
        ok: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
        hasCatalogue: false,
        feedRows: 0,
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
      if (method === 'GET' && path === '/location') return { kind: 'ok', text: view(), etag: `"loc-${version}"` };
      if (method === 'POST' && path.startsWith('/finished-programs/')) {
        const id = decodeURIComponent(path.slice('/finished-programs/'.length));
        if (id !== machine.id) return { kind: 'refused', status: 404, message: `machine ${id} is not in the location` };
        const hash = (body as { hash: string }).hash;
        posts.push({ id, hash });
        if (!machine.finishedPrograms.includes(hash)) machine.finishedPrograms.push(hash);
        version += 1;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served here` };
    },
  };
  setHouseClientLoader(async () => client);
  return { posts, machine };
}

const ONE_SETUP = [{ index: 1, mountStep: false, faced: false, registration: null }];
function planInput(over: Partial<RunPlanInput> = {}): RunPlanInput {
  return {
    setups: ONE_SETUP,
    programs: [{ id: 't1', setupIndex: 1, label: 'T1 ⌀2 flat', hash: HASH, estimatedSeconds: 10 }],
    machine: Z1,
    mount: 'vise',
    stock: { flatness: 'domed' },
    shallowestCutMm: 0.2,
    finishedHashes: [],
    defaults: DEFAULTS,
    ...over,
  };
}

let service: ReturnType<typeof fakeService>;
beforeEach(async () => {
  resetLocationStore();
  clearStoredBaseline();
  service = fakeService();
  await useLocationStore.getState().refresh();
});
afterEach(() => {
  setHouseClientLoader(null);
});

describe('#419 §4.5 finished programs: the durable per-machine list', () => {
  it('a finish appends its FNV hash once; a repeated finish sends nothing and does not duplicate', async () => {
    const once = await useLocationStore.getState().recordFinishedProgram('m-1', HASH);
    expect(once).toEqual({ ok: true, added: true, text: '' });
    expect(service.posts).toEqual([{ id: 'm-1', hash: HASH }]);
    expect(finishedProgramsFor(TARGET)).toEqual([HASH]);

    const again = await useLocationStore.getState().recordFinishedProgram('m-1', HASH);
    expect(again).toEqual({ ok: true, added: false, text: '' });
    expect(service.posts).toHaveLength(1);
    expect(service.machine.finishedPrograms).toEqual([HASH]);
  });

  it('the persisted list is what the plan sees, so an already-cut program is not “new”', async () => {
    await useLocationStore.getState().recordFinishedProgram('m-1', HASH);
    const plan = planRun(planInput({ finishedHashes: finishedProgramsFor(TARGET) }));
    expect(plan.airRunFor).toEqual([false]);
    expect(plan.phases.some((p) => p.kind === 'air-run')).toBe(false);

    const other = planRun(
      planInput({
        programs: [{ id: 't2', setupIndex: 1, label: 'T1 ⌀2 flat', hash: '0badf00d', estimatedSeconds: 10 }],
        finishedHashes: finishedProgramsFor(TARGET),
      }),
    );
    expect(other.airRunFor).toEqual([true]);
  });

  it('an unknown machine, or an unknown address, records nothing and plans as new', async () => {
    const r = await useLocationStore.getState().recordFinishedProgram('m-2', HASH);
    expect(r.ok).toBe(false);
    expect(service.posts).toEqual([]);
    expect(machineAt({ host: '192.0.2.99', port: 2222 })).toBeNull();
    expect(finishedProgramsFor({ host: '192.0.2.99', port: 2222 })).toEqual([]);
  });
});
