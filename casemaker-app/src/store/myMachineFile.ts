/**
 * The "my machine" file (#247, `/Makera-Parity.md` §14.2 A6). Everything the maintainer
 * measures lives in one browser's `localStorage`, and they work on two machines — one JSON
 * carries the saved machine setup between them.
 *
 * What it carries TODAY is `settingsStore.fixtures` — the saved vise and the sacrificial stack
 * (#203, #213) — and the house depth margins (#345). Tool-library and feed overrides do not exist
 * as persisted state yet — the `TOOL_LIBRARY` and `FEEDS_TABLE` are hardcoded tables — so there is
 * nothing of theirs to export; the format is versioned and sectioned so those land here when they
 * exist, rather than being invented now.
 *
 * Import is WHOLE-OR-NOTHING (decision 28): a record that is malformed, truncated or of an
 * unknown version is refused with a reason and nothing is applied. `source` and `measuredAt`
 * ride along verbatim, so a default is never mistaken for a measurement after a round trip.
 *
 * Pure: parse and serialize touch no DOM and no store. The caller applies the result.
 */

import { parseFixturesStrict, parseMarginsStrict, type FixturesSettings } from './settingsStore';
import type { MarginSettings } from '@/engine/cnc/engrave/depthBounds';

/** Magic string that says "this is a Case Maker machine file", not some other JSON. */
export const MY_MACHINE_KIND = 'casemaker-my-machine';
/** Bump when the record shape changes incompatibly; import refuses unknown versions. */
export const MY_MACHINE_SCHEMA_VERSION = 1;
/** Suggested download name; the version is in the file, not the name. */
export const MY_MACHINE_FILENAME = 'casemaker-my-machine.json';

export interface MyMachineFile {
  kind: typeof MY_MACHINE_KIND;
  schemaVersion: number;
  /** ISO timestamp, informational only — never read back as truth. */
  exportedAt: string;
  fixtures: FixturesSettings;
  /**
   * The house's depth margins (#345). ADDITIVE, so the version does not move: an older build
   * reading this record ignores the key, and an older record simply has none (see
   * `MyMachineParseResult.margins`).
   */
  margins: MarginSettings;
}

export type MyMachineParseResult =
  | {
      ok: true;
      fixtures: FixturesSettings;
      /**
       * The file's margins, or `null` when it carries none — an export from before #345. `null` is
       * NOT the shipped defaults: a file with no opinion on the margins must leave the importing
       * machine's own setting alone, or a round trip through an old file would silently reset it.
       */
      margins: MarginSettings | null;
    }
  | { ok: false; reason: string };

/** A fresh copy that serializes to plain JSON, so the caller's store object is never aliased. */
function cloneFixtures(fixtures: FixturesSettings): FixturesSettings {
  return JSON.parse(JSON.stringify(fixtures)) as FixturesSettings;
}

export function buildMyMachineFile(
  fixtures: FixturesSettings,
  margins: MarginSettings,
  now: Date = new Date(),
): MyMachineFile {
  return {
    kind: MY_MACHINE_KIND,
    schemaVersion: MY_MACHINE_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    fixtures: cloneFixtures(fixtures),
    margins: { ...margins },
  };
}

export function serializeMyMachineFile(
  fixtures: FixturesSettings,
  margins: MarginSettings,
  now: Date = new Date(),
): string {
  return JSON.stringify(buildMyMachineFile(fixtures, margins, now), null, 2) + '\n';
}

/**
 * Validate a parsed record (#247). Refuses — with a reason the UI can show — anything that is
 * not a whole, current "my machine" record. Absent sections are legal; a present-but-malformed
 * one refuses the lot.
 */
export function parseMyMachineRecord(raw: unknown): MyMachineParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'this is not a Case Maker machine file' };
  }
  const r = raw as Record<string, unknown>;
  if (r.kind !== MY_MACHINE_KIND) {
    return { ok: false, reason: 'this is not a Case Maker machine file' };
  }
  if (r.schemaVersion !== MY_MACHINE_SCHEMA_VERSION) {
    const v = typeof r.schemaVersion === 'number' ? r.schemaVersion : 'missing';
    return {
      ok: false,
      reason: `unsupported file version ${v}; this build reads version ${MY_MACHINE_SCHEMA_VERSION}`,
    };
  }
  if (!('fixtures' in r)) {
    return { ok: false, reason: 'the file carries no machine setup' };
  }
  const fixtures = parseFixturesStrict(r.fixtures);
  if (!fixtures.ok) return { ok: false, reason: fixtures.reason };
  // #345 — the margins section, as an ADDITIVE one. Absent is legal (a file written before it
  // existed) and means the file has no opinion; a present-but-malformed one refuses the lot, the
  // same whole-or-nothing rule every other section follows.
  if (!('margins' in r) || r.margins === undefined) {
    return { ok: true, fixtures: fixtures.fixtures, margins: null };
  }
  const margins = parseMarginsStrict(r.margins);
  if (!margins.ok) return { ok: false, reason: margins.reason };
  return { ok: true, fixtures: fixtures.fixtures, margins: margins.margins };
}

/** Parse the file's text. Non-JSON is refused with a reason rather than thrown. */
export function parseMyMachineFile(text: string): MyMachineParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the file is not valid JSON' };
  }
  return parseMyMachineRecord(raw);
}
