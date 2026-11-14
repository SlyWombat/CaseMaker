/**
 * #1276 — THE SHOP'S SETTINGS, SAID. The page's Generate never plans on the recommendations in
 * silence: while the settings are being read it says so, when they could not be read it does not
 * run, and with no shop connected it says it planned on the recommended settings. The sentences
 * live here, once, for the run store, the generate slot's blocker and the run sheet.
 */

/** The run's progress line while the settings store has not answered yet. */
export const SETTINGS_READING_LABEL = "reading the shop's settings";

/** The generate slot's blocker, and the run's own refusal, when a house is connected but its settings could not be read. */
export const SETTINGS_UNREAD_SENTENCE = "The shop's settings could not be read, so nothing was planned.";

/** The same fact for a restored run's re-check, which plans nothing but checks against the shop's limits. */
export const SETTINGS_UNREAD_RECHECK = "The shop's settings could not be read, so this stored run was not re-checked.";

/** The info line on a run planned with no house connected (the hosted build): the recommendations are the truth there. */
export const SETTINGS_ABSENT_SENTENCE = 'Planned on the recommended settings — no shop is connected.';

/** The settings store's state, read together with its map and version — never the map alone. */
export interface ShopSettingsRead {
  status: 'unknown' | 'present' | 'absent' | 'error';
  defaults: import('@/platform/defaultsClient').ShopDefaults | null;
  etag: string | null;
}
