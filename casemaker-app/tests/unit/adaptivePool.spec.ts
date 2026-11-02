// Issue #881 — the roughing level pool's size rule, and the pool actually spawning.
//
// The pool is the app's parallelism: `roughingAdaptiveMoves` hands every non-reused level to it.
// The core rule keeps one core for the sim worker's own assembly, caps the pool so a many-core
// machine does not spawn a planner per level, and runs a single planner on a phone — the device
// whose cores and battery are not ours to spend. The memory rule then narrows further: each
// planner holds one level, so `planners × the largest level + the parent` must fit the page's
// stated budget (#889's 640 MB / 256 MB), and `navigator.deviceMemory` can lower the count again.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AdaptivePool,
  forgetPoolSizing,
  lastPoolSizing,
  type PoolMessage,
} from '@/engine/jobs/adaptivePool';
import type { PoolPlanReply } from '@/workers/adaptivePool.worker';
import {
  adaptivePoolSize,
  deviceMemoryPoolCap,
  estimateLevelPlannerBytes,
  memoryBoundPoolSize,
  LEVEL_PLANNER_BASE_BYTES,
} from '@/engine/jobs/poolSizing';

const MiB = 1024 * 1024;

describe('#881 — the level pool size', () => {
  it('is one fewer than the machine has, capped at eight', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 8 }, false)).toBe(7);
    expect(adaptivePoolSize({ hardwareConcurrency: 16 }, false)).toBe(8);
    expect(adaptivePoolSize({ hardwareConcurrency: 64 }, false)).toBe(8);
  });

  it('never asks for more planners than there is work to give them', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 2 }, false)).toBe(1);
    expect(adaptivePoolSize({ hardwareConcurrency: 1 }, false)).toBe(1);
    expect(adaptivePoolSize({}, false)).toBe(1);
  });

  it('is one on a phone, whatever the core count says', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 8 }, true)).toBe(1);
  });
});

describe('#881 — the memory bound', () => {
  it('buys only the planners the budget leaves room for', () => {
    // 640 MB budget, 400 MB already the program's own estimate, 60 MB the largest level:
    // 240 MB spare pays for four planners.
    const levelBytes = estimateLevelPlannerBytes(314_572);
    expect(levelBytes).toBe(LEVEL_PLANNER_BASE_BYTES + 50_331_520);
    expect(
      memoryBoundPoolSize({ budgetBytes: 640 * MiB, parentBytes: 400 * MiB, levelBytes, coreCap: 8 }),
    ).toBe(4);
  });

  it('never exceeds the cores, however much room the budget leaves', () => {
    expect(
      memoryBoundPoolSize({ budgetBytes: 640 * MiB, parentBytes: 10 * MiB, levelBytes: 1 * MiB, coreCap: 3 }),
    ).toBe(3);
  });

  it('keeps one planner even when the parent alone stands at the budget', () => {
    expect(
      memoryBoundPoolSize({ budgetBytes: 256 * MiB, parentBytes: 256 * MiB, levelBytes: 30 * MiB, coreCap: 8 }),
    ).toBe(1);
    expect(
      memoryBoundPoolSize({ budgetBytes: 256 * MiB, parentBytes: 400 * MiB, levelBytes: 30 * MiB, coreCap: 8 }),
    ).toBe(1);
  });

  it('lets the device lie about itself only downwards', () => {
    const huge = estimateLevelPlannerBytes(0);
    expect(deviceMemoryPoolCap(2)).toBe(1);
    expect(deviceMemoryPoolCap(4)).toBe(2);
    expect(deviceMemoryPoolCap(8)).toBe(Number.POSITIVE_INFINITY);
    expect(deviceMemoryPoolCap(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(
      memoryBoundPoolSize({
        budgetBytes: 640 * MiB,
        parentBytes: 100 * MiB,
        levelBytes: huge,
        coreCap: 8,
        deviceMemoryGb: 4,
      }),
    ).toBe(2);
    // A good budget does not talk a 2 GB device into more than one planner.
    expect(
      memoryBoundPoolSize({
        budgetBytes: 640 * MiB,
        parentBytes: 10 * MiB,
        levelBytes: 1 * MiB,
        coreCap: 8,
        deviceMemoryGb: 2,
      }),
    ).toBe(1);
  });
});

// ── THE POOL ITSELF, over a fake Worker and a real MessageChannel ───────────────────────────────

interface FakeWorkerStatic {
  spawned: FakeWorker[];
}

class FakeWorker {
  static spawned: FakeWorker[] = [];
  readonly name: string;
  onmessage: ((event: { data: PoolPlanReply }) => void) | null = null;
  onerror: ((event: { preventDefault?: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: Record<string, unknown>[] = [];
  terminated = false;

  constructor(_url: URL, opts?: { name?: string }) {
    this.name = opts?.name ?? '';
    (FakeWorker as unknown as FakeWorkerStatic).spawned.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Wait for the MessageChannel to deliver what was posted (a macrotask or two in Node). */
async function delivered(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the pool did not receive the message');
}

describe('#881 — the pool spawns to the stated budget', () => {
  let realWorker: unknown;

  beforeEach(() => {
    FakeWorker.spawned = [];
    forgetPoolSizing();
    realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { Worker: unknown }).Worker = FakeWorker;
  });

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
    forgetPoolSizing();
  });

  it('waits for the run’s numbers before spawning, then spawns exactly what they allow', async () => {
    const pool = new AdaptivePool(8);
    const port = pool.beginRun();
    expect(FakeWorker.spawned.length).toBe(0);

    const begin: PoolMessage = {
      kind: 'begin',
      maxLevelCells: 314_572,
      memory: { budgetBytes: 640 * MiB, parentBytes: 400 * MiB },
    };
    port.postMessage(begin);
    await delivered(() => FakeWorker.spawned.length > 0);

    expect(FakeWorker.spawned.map((w) => w.name)).toEqual([
      'rough-pool-0',
      'rough-pool-1',
      'rough-pool-2',
      'rough-pool-3',
    ]);
    expect(pool.decision?.planners).toBe(4);
    expect(lastPoolSizing()?.budgetBytes).toBe(640 * MiB);
    pool.dispose();
    expect(FakeWorker.spawned.every((w) => w.terminated)).toBe(true);
  });

  it('hands a level to an idle worker (a spawned planner is not dead weight)', async () => {
    const pool = new AdaptivePool(2);
    const port = pool.beginRun();
    // No begin: an older caller still gets its core-sized pool on the first plan.
    const plan: PoolMessage = {
      kind: 'plan',
      id: 7,
      request: { index: 0, levelZ: 0, depth: 1, cells: 10, region: [] },
      shared: { tool: {} as never, settings: {} as never, feed: 1, plungeFeed: 1 },
    };
    port.postMessage(plan);
    await delivered(() => FakeWorker.spawned.length > 0);
    expect(FakeWorker.spawned.length).toBe(2);
    await delivered(() => FakeWorker.spawned.some((w) => w.posted.some((m) => m.id === 7)));
    pool.dispose();
  });

  it('re-sizes between batches, and never kills a planner mid-level', async () => {
    const pool = new AdaptivePool(8);
    const port = pool.beginRun();
    port.postMessage({
      kind: 'begin',
      maxLevelCells: 314_572,
      memory: { budgetBytes: 640 * MiB, parentBytes: 400 * MiB },
    } satisfies PoolMessage);
    await delivered(() => FakeWorker.spawned.length === 4);
    const first = [...FakeWorker.spawned];

    port.postMessage({
      kind: 'begin',
      maxLevelCells: 314_572,
      memory: { budgetBytes: 256 * MiB, parentBytes: 200 * MiB },
    } satisfies PoolMessage);
    // 56 MB spare over a 60 MB level buys nothing: one planner, the floor.
    await delivered(() => FakeWorker.spawned.length === 5);
    expect(first.every((w) => w.terminated)).toBe(true);
    expect(pool.decision?.planners).toBe(1);
    pool.dispose();
  });
});
