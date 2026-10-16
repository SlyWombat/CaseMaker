// #442 — the store hands the bench's cutter conditions to the client.
//
// The conditions cannot be read on the worker's side: `toolCondition`'s summary map is main-thread
// module state, and the worker is a real `Worker` over Comlink where that map is empty. So `run()`
// reads `inventoryConditions()` HERE, at request time, and passes it as the sixth argument — the same
// hand-over `getTools()` and the Makera feed rows get (#305/#324). A wiring bug would be invisible:
// the worker would simply answer for a bench with no cutter marked worn or broken. These cases pin
// the hand-over itself; `recommendTool.spec.ts` and `toolCondition.spec.ts` pin the rule it feeds.
//
// The client is the seam — a fake that records what it was asked, so the store's own orchestration is
// the real one, exactly as `toolRegistryStore.spec.ts` drives the house client.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENGRAVE_PREVIEW_DEBOUNCE_MS,
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import {
  conditionForKey,
  resetInventoryConditions,
  setInventoryConditions,
  type ConditionSummary,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';

/** The arguments one debounced request handed the client — the fields these cases read. */
interface HandOff {
  job: EngraveJob;
  margins: EngraveMargins;
  conditions: ReadonlyMap<string, ConditionSummary>;
}

let handed: HandOff[] = [];

/** A client that records every call's arguments and answers "no new preview". */
const recorder = (): EngravePreviewClient => ({
  engravePreview: async (job, _tools, _catalogue, _gen, margins, conditions) => {
    handed.push({ job, margins, conditions });
    return null;
  },
});

/** One described copy of a cutter, in its box. */
function copy(id: string, condition: ToolCopy['condition']): ToolCopy {
  return { id, condition, whereabouts: { kind: 'box' }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null };
}

/** Fire one request and let its debounce elapse, so the client has been handed the table. */
async function requestThrough(job: EngraveJob): Promise<void> {
  useEngravePreviewStore.getState().request(job);
  await vi.advanceTimersByTimeAsync(ENGRAVE_PREVIEW_DEBOUNCE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  handed = [];
  resetInventoryConditions();
  setEngravePreviewClientLoader(async () => recorder());
  useEngravePreviewStore.getState().dispose(); // a pending debounce must not leak into the next case
});

afterEach(() => {
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  resetInventoryConditions();
  vi.useRealTimers();
});

describe('the engrave preview hands the bench’s conditions to the client (#442)', () => {
  it('hands the inventory’s summary table, keyed by registry key', async () => {
    setInventoryConditions([{ id: 'abc', quantity: 1, copies: [copy('abc-1', 'worn')] }], (id) => `inv:${id}`);
    const job = defaultEngraveJob();
    await requestThrough(job);

    expect(handed).toHaveLength(1);
    // The job travels with it, unchanged: this is the same request `run` makes, not a second one.
    expect(handed[0]!.job).toBe(job);
    // The table is the inventory's own — the same object `conditionForKey` answers with, note and all
    // — so the worker's pick carries the operator's own words rather than a rebuild of them.
    const conditions = handed[0]!.conditions;
    expect(conditions.get('inv:abc')).toEqual(conditionForKey('inv:abc'));
    expect(conditions.get('inv:abc')!.note).toContain('worn');
  });

  it('hands an empty table for a bench with nothing set', async () => {
    await requestThrough(defaultEngraveJob());

    expect(handed).toHaveLength(1);
    // "Nothing known" is the honest answer for a bench nobody has described: no cutter is excluded
    // as broken and none carries a caution, because the app knows of no possession of any of them.
    expect(handed[0]!.conditions.size).toBe(0);
  });

  it('reads the table at request time, so a change between requests arrives', async () => {
    setInventoryConditions([{ id: 'first', quantity: 1, copies: [copy('first-1', 'new')] }], (id) => `inv:${id}`);
    await requestThrough(defaultEngraveJob());
    expect(handed[0]!.conditions.get('inv:first')!.best).toBe('new');

    // The inventory changes while the panel is open — the next preview must see the NEW bench. This
    // is why the read is HERE (beside `getTools`) and not captured once at module load (#305/#442).
    setInventoryConditions([{ id: 'second', quantity: 1, copies: [copy('second-1', 'broken')] }], (id) => `inv:${id}`);
    await requestThrough(defaultEngraveJob());

    expect(handed).toHaveLength(2);
    expect(handed[1]!.conditions.has('inv:first')).toBe(false);
    expect(handed[1]!.conditions.get('inv:second')!.usable).toBe(0);
  });
});
