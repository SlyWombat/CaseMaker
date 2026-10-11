/**
 * Which registry entry a `.nc` header names (#316, #305 design point 3).
 *
 * The question is "which of my cutters is the one this file names?", and the file states it three
 * ways, in descending order of how much they actually say:
 *
 *  1. our own registry key, on the `;@CM|TOOL|key=` line (#332) — an identity the post writes for
 *     ANY cutter, including the clones and hand-typed definitions that may not carry Makera's
 *     `g_ID` at all (#212). It is step (0) because nothing else is as specific: a key THIS list
 *     holds settles the question outright, and a key it does not hold is the file saying it was cut
 *     with something this house does not have — which caps what the rules below may claim.
 *  2. the vendor `id=`, which is the catalogue's `g_ID` (`/Makera-Parity.md` §3.2) — what the file
 *     asserts the cutter WAS, when it was cut with a catalogue tool.
 *  3. shape + cutting diameter, which is the only rule that can match a file written for a cutter
 *     no tier knows — and which, alone, is not evidence of identity: Makera's own catalogue sells
 *     SIX 3.175 mm flat end mills that differ only in length (#316). Under that rule alone the
 *     built-in `flat-3.175x12-metal` won every tie, because the built-ins come first in
 *     `getTools()` and "first hit wins" is not a match.
 *
 * **So the lengths the header states are part of the match, and a match that leans on less than
 * they state is a SUGGESTION, not an answer.** `exact` means every length the file states agrees
 * with the entry (within 0.01 mm, the tolerance `cuttingRadiusForSweep` uses); `suggested` means
 * shape and diameter agreed and the file states lengths this entry does not match — the panel says
 * so rather than printing "matched" over a different cutter. The stated CUTTING DIAMETER is checked
 * on the key step too (#316 review): a key the list holds settles the identity, but a key whose
 * entry no longer measures what the file cut is a cutter edited since, and it drops to `suggested`
 * like any other disagreement.
 *
 * A file that states NO lengths cannot be checked, and `suggested` is the honest strength for it:
 * "shape and diameter only" is exactly the evidence there is. That is the common case for a file
 * from another CAM package, which is why the weaker sentence has to exist.
 *
 * **On the id step a tie between tiers is resolved toward the service's row (#316's decision of
 * 2026-10-09).** A built-in and a `cat:` row can carry the same `g_ID` — the built-in IS the
 * catalogue's cutter, copied verbatim from the TopClamp reference (`toolLibrary.ts`) — and there
 * the namespaced key wins, because it is the row the service owns and re-syncs. The decision names
 * that tie and only that one; the shape steps keep taking the FIRST hit, which is the built-in,
 * because a key the registry may not currently hold is not a better answer than one it always
 * holds. Which rule answered is what `provenance` reports.
 *
 * Pure, and given the list rather than reading the registry: the matcher's tests hand it two
 * entries, and the sim worker realm has no store to read.
 */

import { cuttingDiameter, type Tool } from './tool';
import type { ToolLibraryEntry } from './toolLibrary';

/** How well the entry fits the file. `exact` = every length the header states agrees. */
export type MatchStrength = 'exact' | 'suggested';

/** Which rule decided it: our key line, the vendor `id=`, or shape and diameter alone. */
export type MatchProvenance = 'key' | 'id' | 'shape';

export interface HeaderToolMatch {
  /** The registry key the file names, or the closest entry by shape and diameter. */
  key: string;
  strength: MatchStrength;
  provenance: MatchProvenance;
}

/** 0.01 mm — the same tolerance `cuttingRadiusForSweep` matches the swept cutter with. */
const TOLERANCE_MM = 0.01;

/**
 * Two lengths agree. A length only one side states does NOT agree: an entry that does not state a
 * flute length cannot be shown to be the 12 mm cutter, and "unknown" is not a match.
 */
function agrees(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= TOLERANCE_MM;
}

/** Every length the header states, against the entry — vacuously true when it states none. */
function lengthsAgree(header: Tool, entry: Tool): boolean {
  for (const field of ['fluteLength', 'shoulderLength'] as const) {
    if (header[field] === null) continue;
    if (!agrees(header[field], entry[field])) return false;
  }
  return true;
}

/** Whether the header states a length at all — the evidence an `exact` shape match needs. */
function statesALength(tool: Tool): boolean {
  return tool.fluteLength !== null || tool.shoulderLength !== null;
}

/**
 * The namespaced entry if the hits include one, the first hit otherwise (#316's decision). A key
 * with a namespace is `cat:`, `user:` or `inv:` (`toolLibrary.isToolKey`); a bare key is a
 * built-in, which is the row that answers when no service does.
 */
function preferNamespaced(hits: readonly ToolLibraryEntry[]): ToolLibraryEntry | null {
  return hits.find((e) => e.key.includes(':')) ?? hits[0] ?? null;
}

/**
 * The entry a header's `;@MKR|TOOL` record names, or null when nothing in the list is close.
 *
 * The order is the whole of it, and each step refuses to fall through silently:
 * (0) our own registry key, when the file carries a `;@CM|TOOL|key=` line (#332) and the list holds
 * it; (a) the vendor id, with every length the header states agreeing; (b) shape, cutting diameter
 * AND the stated lengths; (c) shape and cutting diameter alone — which is a suggestion, because that
 * is all the evidence it has.
 *
 * `statedKey` is what the file's `;@CM|` line names, or null when it has none. A key the list does
 * NOT hold caps everything under it at `suggested`: the file has stated which cutter it was written
 * for and we are about to hand over a different one, so no rule here may call that exact.
 *
 * `tool` is null for a file that carries the key line and NO `;@MKR|TOOL` record (#332 review) —
 * hand-edited, or written by a post that puts identity in the CM line only. Step (0) still answers
 * it on its own; every step below needs the header's geometry and so finds nothing.
 */
export function matchHeaderTool(
  tool: Tool | null,
  entries: readonly ToolLibraryEntry[],
  statedKey: string | null = null,
): HeaderToolMatch | null {
  // (0) the file's own statement, and the strongest one there is (#332). Resolving it is almost the
  // whole test: the entry carries the tool, so nothing about the vendor id or the shape can add to
  // it — EXCEPT the geometry the file itself states (#316 review). A `user:` cutter edited after
  // the file was posted (same key, different diameter) reopens as the cutter the file names, over a
  // sweep it was not cut with; a stated diameter this entry does not match makes it a suggestion.
  // The key is still the answer — it is what the file says — so the provenance stays `'key'`.
  if (statedKey !== null) {
    const named = entries.find((e) => e.key === statedKey);
    if (named) {
      const stated = tool === null ? null : cuttingDiameter(tool);
      const entry = cuttingDiameter(named.tool);
      const agreesOnDiameter = stated === null || entry === null || Math.abs(stated - entry) <= TOLERANCE_MM;
      return { key: named.key, strength: agreesOnDiameter ? 'exact' : 'suggested', provenance: 'key' };
    }
    const fallback = tool === null ? null : matchByIdOrShape(tool, entries);
    return fallback ? { ...fallback, strength: 'suggested' } : null;
  }
  return tool === null ? null : matchByIdOrShape(tool, entries);
}

/** Steps (a)–(c) on their own: what a file that names no registry key can be matched by. */
function matchByIdOrShape(tool: Tool, entries: readonly ToolLibraryEntry[]): HeaderToolMatch | null {
  // (a) the file's own statement of the cutter, when the lengths back it up. An id whose lengths
  // disagree is not this entry: the six same-diameter flats share a shape, not a length.
  if (tool.id !== null) {
    const byId = entries.filter(
      (e) => e.tool.id !== null && e.tool.id === tool.id && lengthsAgree(tool, e.tool),
    );
    const hit = preferNamespaced(byId);
    if (hit) return { key: hit.key, strength: 'exact', provenance: 'id' };
  }

  const d = cuttingDiameter(tool);
  if (d === null) return null;
  const sameShape = entries.filter((e) => e.tool.shape === tool.shape && agrees(cuttingDiameter(e.tool), d));

  // (b) shape and diameter, and the header's own lengths agree with the entry's.
  if (statesALength(tool)) {
    const withLengths = sameShape.find((e) => lengthsAgree(tool, e.tool));
    if (withLengths) return { key: withLengths.key, strength: 'exact', provenance: 'shape' };
  }

  // (c) shape and diameter only — suggest the first, and let the panel say the match is weak.
  const byShape = sameShape[0];
  return byShape ? { key: byShape.key, strength: 'suggested', provenance: 'shape' } : null;
}
