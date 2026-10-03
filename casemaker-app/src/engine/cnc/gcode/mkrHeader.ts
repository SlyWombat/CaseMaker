/**
 * `;@MKR|…` header records, as written by Makera Studio (`/Fabrication.md` §2).
 *
 *   ;@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|…
 *
 * A record is a tag followed by `key=value` fields separated by `|`. This function ONLY
 * splits — it interprets nothing. The header is untrusted input, and some of it is still
 * a hypothesis: the `ORIGIN` semantics (which stock axis `length` maps to, which corner
 * `topFrontLeft` is) rest on one square-stock sample (`/Makera-Parity.md` §6.1), and the
 * strings Studio writes for `TOOL|type=` are known only for flat and ball end mills.
 * Baking any of that in here would turn a guess into the parser's behaviour, so
 * downstream consumers read the raw fields and decide, and refuse what they cannot
 * identify.
 *
 * Field values may themselves contain `=` (a tool name like `3.175*M4*12mm Thread`
 * contains none, but nothing guarantees that), so only the FIRST `=` splits a field.
 * Fields without an `=` are kept under their own name with an empty value rather than
 * dropped, so a malformed record is still visible to whoever reads it.
 */

import type { MkrRecord } from './types';

const PREFIX = ';@MKR|';

/** Parse one header line. Returns `null` if it is not a `;@MKR|` record or has no tag. */
export function parseMkrRecord(rawLine: string, line: number): MkrRecord | null {
  const trimmed = rawLine.trimStart();
  if (!trimmed.startsWith(PREFIX)) return null;
  const parts = trimmed.slice(PREFIX.length).trimEnd().split('|');
  const tag = parts[0];
  if (tag === undefined || tag === '') return null;
  const fields: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] as string;
    const eq = part.indexOf('=');
    if (eq < 0) {
      if (part !== '') fields[part] = '';
    } else {
      fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { tag, fields, line };
}

/** Convenience: a numeric field, or `null` if absent or not a finite number. */
export function mkrNumber(record: MkrRecord, key: string): number | null {
  const v = record.fields[key];
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
