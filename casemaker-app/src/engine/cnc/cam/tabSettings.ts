/**
 * The three numbers a HOLDING TAB is cut with (#218), where each came from, and the pair the
 * no-location build falls back to.
 *
 * A tab is shop knowledge, not a document constant: how many tabs hold a part, how wide they are
 * and how much material they leave are things the bench learns from parts that moved or broke.
 * They are therefore entries in the location document's shop `defaults`
 * (`location.json` → `defaults`, read through `defaults.rs` / `defaultsClient.ts`), exactly as
 * #436's rest-machining pair and #434's drill numbers are. What lives in this file is only the
 * triple used when there is NO LOCATION TO READ — the hosted web build — and
 * {@link TAB_SETTINGS_FALLBACK} says that in its name.
 *
 * ALL THREE ARE PROVISIONAL AND CHOSEN, NOT MEASURED (the #218 brief: `4 × 4 × 1` waits on a real
 * tabbed cut). A job stores its own tab spec: the values are read here when a new cut-out is
 * created, so an existing document keeps the numbers it was cut with even after the shop's change.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';

/** The tab spec a job carries: how many, how wide in material, how tall the kept material is. */
export interface TabSettings {
  /** Tabs per cut-out, a whole number. `0` cuts the part free. */
  count: number;
  /** Tab width in MATERIAL, mm. The centre path stops `2 × toolRadius` further apart. */
  widthMm: number;
  /** How much material the tab leaves below the tab top, mm. */
  heightMm: number;
}

/** The keys these three numbers are stored under, in the location's shop `defaults` section. */
export const TAB_KEYS: Record<keyof TabSettings, string> = {
  count: 'tabs.count',
  widthMm: 'tabs.widthMm',
  heightMm: 'tabs.heightMm',
};

/**
 * The triple used when there is NO LOCATION TO READ — the hosted web build, and any caller not
 * handed the document. The numbers match `defaults.rs`'s `UNMEASURED_SEEDS`, so a build with no
 * service behaves the same as a fresh bench; the literals are duplicated by necessity (one
 * language per side).
 *
 * PROVISIONAL. `4 × 4 × 1` on a 3.81 mm badge blank leaves 1 mm of tab under a 2.81 mm cut, which
 * is a plausible holding tab and nothing more; the first tabbed cut replaces all three.
 */
export const TAB_SETTINGS_FALLBACK: TabSettings = {
  count: 4,
  widthMm: 4,
  heightMm: 1,
};

/** Where a tab number came from, as `readDefault` reports it (seeded/chosen/measured/fallback). */
export type TabSettingSource = string;

/**
 * The tab settings from the shop defaults, with each one's source.
 *
 * A key the location does not hold, or holds outside its rule, reports `fallback` — never a silent
 * literal: the caller that prints provenance (the panel, the run sheet) can then say which number
 * the part was designed around.
 */
export function tabSettings(defaults: ShopDefaults | null): {
  settings: TabSettings;
  sources: Record<keyof TabSettings, TabSettingSource>;
} {
  const settings = {} as TabSettings;
  const sources = {} as Record<keyof TabSettings, TabSettingSource>;
  for (const [field, key] of Object.entries(TAB_KEYS) as [keyof TabSettings, string][]) {
    const d = readDefault(defaults, key);
    settings[field] = d.value;
    sources[field] = d.source;
  }
  return { settings, sources };
}
