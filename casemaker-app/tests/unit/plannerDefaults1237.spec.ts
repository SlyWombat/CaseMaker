/**
 * #1237 — THE SHOP'S SETTINGS REACH THE PLANNER, AND THE RECEIPT SAYS WHICH ONES.
 *
 * The install function, the location guard, the planner-key provenance (both the location and the
 * no-location cases), and the source scan that holds {@link PLANNER_DEFAULTS_KEYS} to the keys the
 * planning code actually reads.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installShopDefaults,
  KNOWN_DEFAULTS,
  liveShopDefaults,
  readDefault,
  resetLiveShopDefaults,
  type ShopDefaults,
} from '@/platform/defaultsClient';
import { PLANNER_DEFAULTS_KEYS, plannerDefaultsProvenance } from '@/platform/plannerDefaults';
import { BIT_CHANGE_KEYS } from '@/engine/cnc/cam/model/bitChange';
import { ROTARY_LIMIT_KEYS } from '@/engine/cnc/rotary/limits';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function entry(value: number, source: 'seeded' | 'chosen' | 'measured', unit: string | null): ShopDefaults[string] {
  return { value, source, setAt: null, unit, note: null };
}

afterEach(() => resetLiveShopDefaults());

describe('#1237 the install and the guard', () => {
  it('the installed location settings reach readDefault; without one, the recommendations', () => {
    const map: ShopDefaults = {
      'plan.leftoverTallMm': entry(5, 'seeded', 'mm'),
      'plan.leftoverEquivalencePct': entry(2, 'measured', '%'),
    };
    installShopDefaults(() => map);
    expect(readDefault(liveShopDefaults(), 'plan.leftoverTallMm').value).toBe(5);
    expect(readDefault(liveShopDefaults(), 'plan.leftoverEquivalencePct').value).toBe(2);

    resetLiveShopDefaults();
    expect(readDefault(liveShopDefaults(), 'plan.leftoverTallMm').value).toBe(KNOWN_DEFAULTS['plan.leftoverTallMm']!.fallback);
    expect(readDefault(liveShopDefaults(), 'plan.leftoverEquivalencePct').value).toBe(
      KNOWN_DEFAULTS['plan.leftoverEquivalencePct']!.fallback,
    );
  });

  it('a location stated in the planner input without defaults is an error naming it', async () => {
    // The guard is the planner's own: the input says where it came from and carries no map.
    const err = await planModelCam({ defaultsFrom: '/tmp/location.json' } as unknown as ModelPlanInput).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/\/tmp\/location\.json/);
    // A location WITH no defaults section passes `defaults: null` and is not the guard's business.
    const later = await planModelCam({ defaultsFrom: '/tmp/location.json', defaults: null } as unknown as ModelPlanInput).catch(
      (e: Error) => e,
    );
    expect((later as Error).message).not.toMatch(/no shop defaults/);
  });
});

describe('#1237 the receipt’s planner settings', () => {
  it('lists a key that differs from its recommendation, with the location’s source', () => {
    const map: ShopDefaults = {
      'plan.leftoverTallMm': entry(5, 'seeded', 'mm'),
      // At the recommendation: not listed.
      'plan.leftoverEquivalencePct': entry(KNOWN_DEFAULTS['plan.leftoverEquivalencePct']!.fallback, 'seeded', '%'),
    };
    const entries = plannerDefaultsProvenance(map, { withLocation: true });
    expect(entries).toEqual([{ name: 'plan.leftoverTallMm', value: 5, unit: 'mm', source: 'located' }]);
  });

  it('a measured value keeps its measured source', () => {
    const map: ShopDefaults = { 'plan.leftoverTallMm': entry(5, 'measured', 'mm') };
    expect(plannerDefaultsProvenance(map, { withLocation: true })[0]?.source).toBe('measured');
  });

  it('with no location, every planner key is stated at its recommendation', () => {
    const entries = plannerDefaultsProvenance(null, { withLocation: false });
    expect(entries.map((e) => e.name).sort()).toEqual([...PLANNER_DEFAULTS_KEYS].sort());
    for (const e of entries) {
      expect(e.source).toBe('seeded');
      expect(e.value).toBe(KNOWN_DEFAULTS[e.name]!.fallback);
    }
  });
});

/** Every `.ts` under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('#1237 the workers get the settings', () => {
  it('every planning realm installs what it receives', () => {
    // The one install function, called where each realm begins: the app's worker, and the CLI's
    // two pools. A realm added later must call it too — this is the check that says so.
    for (const file of [
      'src/workers/sim.worker.ts',
      'scripts/lib/casemaker/pickPoolWorker.ts',
      'scripts/lib/casemaker/rankPoolWorker.ts',
    ]) {
      expect(readFileSync(join(APP, file), 'utf8'), file).toMatch(/installShopDefaults\(/);
    }
  });
});

describe('#1237 the planner-key list is held to its read sites', () => {
  it('every key the planning code reads is listed, and every listed key is read', () => {
    const roots = [join(APP, 'src/engine/cnc'), join(APP, 'src/workers/sim')];
    const found = new Set<string>();
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/readDefault\(\s*[^,]+,\s*'([^']+)'/g)) found.add(m[1]!);
      }
    }
    // Reads through a key map: the bit-change rule and the rotary limits.
    for (const key of Object.values(BIT_CHANGE_KEYS)) found.add(key);
    for (const key of ROTARY_LIMIT_KEYS) found.add(key);
    expect([...found].sort()).toEqual([...PLANNER_DEFAULTS_KEYS].sort());
  });
});
