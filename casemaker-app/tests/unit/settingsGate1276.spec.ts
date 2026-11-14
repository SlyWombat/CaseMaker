/**
 * #1276 — THE PAGE'S GENERATE NEVER PLANS ON THE RECOMMENDATIONS IN SILENCE.
 *
 * The settings store's map is null in three different states (`unknown`, `absent`, `error`), which is
 * how a Generate pressed before the read, or after it failed, planned on the fallbacks and said
 * nothing. The run reads { status, defaults, etag } together and:
 *   unknown → WAITS for the read ("reading the shop's settings"), then plans on whichever state the
 *             read ends in — on THAT map, never null;
 *   error   → does NOT run: "The shop's settings could not be read, so nothing was planned." (fail
 *             closed; Retry is a re-read); once a read succeeds the press plans with the map;
 *   absent  → plans as before, plus one info line on the run (and so its sheet);
 * and the state joins the run's stamp and the shop signature, so a result planned under one state is
 * stale under another. The fake settings store here is the real one with a controllable `refresh`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_ABSENT_SENTENCE,
  SETTINGS_READING_LABEL,
  SETTINGS_UNREAD_RECHECK,
  SETTINGS_UNREAD_SENTENCE,
} from '@/engine/cnc/engrave/settingsWords';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { runShopSignature, setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { EngraveGenerated, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { settleShopSettings } from '../tools/settledShop';

const realRefresh = useShopDefaultsStore.getState().refresh;
const MAP: ShopDefaults = { 'tabs.count': { value: 2, source: 'chosen', setAt: null, unit: null, note: null } } as ShopDefaults;

let shops: Array<EngraveShopOpts | undefined> = [];
/** A generate that ends at once, refusing: the point of these specs is what the planner was handed, not a program. */
const REFUSED = { ok: false, stage: 'cam', findings: [], errors: [{ stage: 'cam', message: 'test: nothing to plan' }], programs: [], nc: null } as unknown as EngraveGenerated;

/** A `refresh` the test releases, ending in the state it names. */
function controllableRefresh(end: { status: 'present' | 'absent' | 'error'; defaults: ShopDefaults | null; etag: string | null }) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const refresh = vi.fn(async () => {
    await gate;
    useShopDefaultsStore.setState({ ...end, reason: end.status === 'error' ? 'the house did not answer' : null });
  });
  useShopDefaultsStore.setState({ refresh });
  return { refresh, release: () => release() };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  shops = [];
  useEngraveRunStore.getState().reset();
  useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } });
  setEngraveRunClientLoader(async () => ({
    engraveGenerate: async (_job: unknown, _tool: unknown, _catalogue: unknown, _calibration: unknown, _margins: unknown, shop?: EngraveShopOpts) => {
      shops.push(shop);
      return REFUSED;
    },
  }) as never);
});
afterEach(() => {
  useShopDefaultsStore.setState({ refresh: realRefresh });
  settleShopSettings('unknown', null, null);
  setEngraveRunClientLoader(null);
  useEngraveRunStore.getState().reset();
});

describe('#1276 unknown: Generate waits for the read', () => {
  it('and the planner receives THAT map — not null — once', async () => {
    settleShopSettings('unknown', null, null);
    const read = controllableRefresh({ status: 'present', defaults: MAP, etag: '"e1"' });
    const press = useEngraveRunStore.getState().generate();
    await flush();
    const waiting = useEngraveRunStore.getState();
    expect(waiting.phase).toBe('generating');
    expect(waiting.progress?.label).toBe(SETTINGS_READING_LABEL);
    expect(shops, 'no plan is started on a map that has not arrived').toHaveLength(0);
    read.release();
    await press;
    expect(shops).toHaveLength(1);
    expect(shops[0]!.defaults).toBe(MAP);
    expect(read.refresh).toHaveBeenCalledTimes(1);
  });

  it('unknown, then the read fails: blocked with the sentence, no plan started', async () => {
    settleShopSettings('unknown', null, null);
    const read = controllableRefresh({ status: 'error', defaults: null, etag: null });
    const press = useEngraveRunStore.getState().generate();
    await flush();
    read.release();
    await press;
    const run = useEngraveRunStore.getState();
    expect(run.phase).toBe('blocked');
    expect(run.error).toBe(SETTINGS_UNREAD_SENTENCE);
    expect(shops).toHaveLength(0);
  });
});

describe('#1276 error: fail closed, and a successful re-read plans with the map', () => {
  it('error at the press: nothing planned; Retry (a re-read) succeeds; the next press plans with the map', async () => {
    settleShopSettings('error', null, null);
    await useEngraveRunStore.getState().generate();
    expect(useEngraveRunStore.getState().phase).toBe('blocked');
    expect(useEngraveRunStore.getState().error).toBe(SETTINGS_UNREAD_SENTENCE);
    expect(shops).toHaveLength(0);

    const retry = controllableRefresh({ status: 'present', defaults: MAP, etag: '"e2"' });
    retry.release();
    await useShopDefaultsStore.getState().refresh(); // the Retry control is exactly this call
    await useEngraveRunStore.getState().generate();
    expect(shops).toHaveLength(1);
    expect(shops[0]!.defaults).toBe(MAP);
  });
});

describe('#1276 absent: plans, and says so', () => {
  it('plans on the recommendations with one info line on the run', async () => {
    settleShopSettings('absent', null, null);
    await useEngraveRunStore.getState().generate();
    expect(shops).toHaveLength(1);
    expect(shops[0]!.defaults ?? null).toBeNull();
    const notes = (useEngraveRunStore.getState().generated?.findings ?? []).filter((f) => f.code === 'location-no-settings');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: 'info', message: SETTINGS_ABSENT_SENTENCE });
  });

  it('a result planned as absent is STALE once the store becomes present', async () => {
    settleShopSettings('absent', null, null);
    await useEngraveRunStore.getState().generate();
    expect(useEngraveRunStore.getState().staleSince).toBeNull();
    useShopDefaultsStore.setState({ status: 'present', defaults: {}, etag: '"e3"' });
    const run = useEngraveRunStore.getState();
    expect(run.staleSince).not.toBeNull();
    expect(run.staleReason).toBe('shop');
  });
});

describe('#1276 the state and version are in the shop signature', () => {
  it('absent, present at one version and present at another are three different shops', () => {
    settleShopSettings('absent', null, null);
    const absent = runShopSignature();
    settleShopSettings('present', {}, '"v1"');
    const v1 = runShopSignature();
    settleShopSettings('present', {}, '"v2"');
    const v2 = runShopSignature();
    expect(new Set([absent, v1, v2]).size).toBe(3);
    expect(v1).toContain('settings:present:"v1"');
    expect(absent).toContain('settings:absent:');
  });
});

describe('#1276 the restored-run re-check follows the same rule', () => {
  it('error: the stored run is not re-checked against the recommendations — it says so and is stale', async () => {
    settleShopSettings('error', null, null);
    useEngraveRunStore.setState({ generated: REFUSED });
    await useEngraveRunStore.getState().recheckRestoredRun({ generated: REFUSED } as never);
    const run = useEngraveRunStore.getState();
    expect(run.restoreNote).toBe(SETTINGS_UNREAD_RECHECK);
    expect(run.restoreChecking).toBe(false);
    expect(run.staleSince).not.toBeNull();
  });
});

describe('#1276 the press settles the settings before the cutter pick (awaitShopSettings)', () => {
  it('unknown → the read ends present: true, and the run is back to its earlier phase', async () => {
    settleShopSettings('unknown', null, null);
    const read = controllableRefresh({ status: 'present', defaults: MAP, etag: '"e4"' });
    const settled = useEngraveRunStore.getState().awaitShopSettings();
    await flush();
    expect(useEngraveRunStore.getState().phase).toBe('generating');
    expect(useEngraveRunStore.getState().progress?.label).toBe(SETTINGS_READING_LABEL);
    read.release();
    expect(await settled).toBe(true);
    expect(useEngraveRunStore.getState().phase).toBe('idle');
    expect(useEngraveRunStore.getState().progress).toBeNull();
  });
  it('error → false, blocked with the unread sentence; absent → true', async () => {
    settleShopSettings('error', null, null);
    expect(await useEngraveRunStore.getState().awaitShopSettings()).toBe(false);
    expect(useEngraveRunStore.getState().phase).toBe('blocked');
    expect(useEngraveRunStore.getState().error).toBe(SETTINGS_UNREAD_SENTENCE);
    settleShopSettings('absent', null, null);
    expect(await useEngraveRunStore.getState().awaitShopSettings()).toBe(true);
  });
});

