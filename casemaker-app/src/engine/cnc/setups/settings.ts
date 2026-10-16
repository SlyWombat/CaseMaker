/**
 * The setups tunables, from the shop's defaults (`setups.*` in `location.json`) — never constants in
 * the planner (the maintainer's rule, 2026-10-15). The labelled fallbacks in `defaultsClient.ts` are
 * used only with no house service. The vise's ledge (its step and width) is a PRODUCT constant, in
 * `fixture.ts` — measured on the vise, not a setting.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';

export interface SetupsSettings {
  /** Less stock than this left to grip is a `thin-grip` warning, mm. */
  minGripMm: number;
  /** The time a remount takes, for the plan's phase estimate, minutes. */
  remountMinutes: number;
  /** The time re-registering takes after one, minutes. */
  reregisterMinutes: number;
}

export function setupsSettings(defaults: ShopDefaults | null): SetupsSettings {
  return {
    minGripMm: readDefault(defaults, 'setups.minGripMm').value,
    remountMinutes: readDefault(defaults, 'setups.remountMinutes').value,
    reregisterMinutes: readDefault(defaults, 'setups.reregisterMinutes').value,
  };
}
