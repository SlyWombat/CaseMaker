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
 * **A tie between two TIERS is not resolved here, and is not resolved silently (#316's decision of
 * 2026-10-12).** The 2026-10-09 decision named one tie and only one: a built-in and a `cat:` row
 * carrying the same `g_ID` — the built-in IS the catalogue's cutter, copied verbatim from the
 * TopClamp reference (`toolLibrary.ts`) — where the namespaced key wins because it is the row the
 * service owns and re-syncs. `preferNamespaced` still does exactly that, and only that: it breaks a
 * tie whose namespaced side all comes from ONE tier. **It now does so on every rung**, the two
 * shape rungs included, which used to take the first hit in `getTools()` order — and the built-ins
 * come first there, so a file stating only shape and diameter took a built-in even when the
 * service's own row for that cutter was in the list (#316 review). Two NAMESPACED rows in
 * different tiers — an owned `inv:` row and a `cat:` row matching the same shape and diameter — are
 * two different claims about the same program, and neither is entitled to win: the entry is
 * `suggested` with BOTH named as `candidates`, and the person picks. Which rule answered is what
 * `provenance` reports.
 *
 * Pure, and given the list rather than reading the registry: the matcher's tests hand it two
 * entries, and the sim worker realm has no store to read.
 */

import { cuttingDiameter, vendorId, type Tool } from './tool';
import { tierOf, TIER_ORDER, type ToolTier } from './toolTiers';
import type { ToolLibraryEntry } from './toolLibrary';

/** How well the entry fits the file. `exact` = every length the header states agrees. */
export type MatchStrength = 'exact' | 'suggested';

/** Which rule decided it: our key line, the vendor `id=`, or shape and diameter alone. */
export type MatchProvenance = 'key' | 'id' | 'shape';

/**
 * One row that answers the header's evidence as well as another (#316). Carries its tier because the
 * tier is what the person is choosing between: the same cutter the house OWNS and the catalogue row
 * it was cloned from are different things to say about the same program.
 */
export interface ToolMatchCandidate {
  key: string;
  tier: ToolTier;
}

export interface HeaderToolMatch {
  /** The registry key the file names, or the closest entry by shape and diameter. */
  key: string;
  strength: MatchStrength;
  provenance: MatchProvenance;
  /**
   * Every row that answers the same evidence, in tier order — present ONLY when two or more tiers
   * do, and then `strength` is always `suggested`, because which of them the file names is exactly
   * what is unresolved. `key` is then the first of these, which is the ENGINE's best default and
   * not an answer: a caller that can ask (the sim setup) does not apply it, and one that cannot
   * (a worker with no person to ask) still has the best row rather than none.
   */
  candidates?: ToolMatchCandidate[];
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
 * The namespaced entry if the hits include one, the first hit otherwise (#316's decision of
 * 2026-10-09). A key with a namespace is `cat:`, `user:` or `inv:` (`toolLibrary.isToolKey`); a bare
 * key is a built-in, which is the row that answers when no service does.
 *
 * This is a tie-break among rows of ONE tier — built-in versus namespaced, where the namespaced row
 * is the one the service owns. Every rung resolves through it, the two shape rungs included; those
 * used to take the first hit in `getTools()` order, which is registry order and put the built-in
 * first. It is deliberately NOT a tie-break between two namespaced rows: that is the ambiguity
 * `resolveHits` reports instead of deciding (#316's decision of 2026-10-12).
 */
function preferNamespaced(hits: readonly ToolLibraryEntry[]): ToolLibraryEntry | null {
  return hits.find((e) => e.key.includes(':')) ?? hits[0] ?? null;
}

/**
 * One step's hits, resolved to a single answer — or, when two tiers answer it, to both (#316).
 *
 * `strength` is what the step's own evidence earns (the caller passes `exact` or `suggested` for
 * it); an ambiguous answer overrides it to `suggested`, because "which of these two rows is it" is
 * unresolved however good the evidence for the PAIR is.
 */
function resolveHits(
  hits: readonly ToolLibraryEntry[],
  strength: MatchStrength,
  provenance: MatchProvenance,
): HeaderToolMatch | null {
  const namespaced = hits.filter((e) => e.key.includes(':'));
  const tiers = new Set(namespaced.map((e) => tierOf(e.key)));
  if (tiers.size >= 2) {
    // Tier order, and stable within a tier, so the list the person sees is the order the Manage
    // picker draws and the first candidate is the one the tiers themselves put first.
    const candidates = [...namespaced]
      .sort((a, b) => TIER_ORDER.indexOf(tierOf(a.key)) - TIER_ORDER.indexOf(tierOf(b.key)))
      .map((e): ToolMatchCandidate => ({ key: e.key, tier: tierOf(e.key) }));
    return { key: candidates[0]!.key, strength: 'suggested', provenance, candidates };
  }
  const hit = preferNamespaced(hits);
  return hit ? { key: hit.key, strength, provenance } : null;
}

/**
 * The evidence a header's TOOL record offers, as the string the pick memory is keyed by (#316) —
 * the header's OWN identity in the match order, so a remembered choice follows the program and not
 * the file name. One of, in descending specificity:
 *
 *   `key=<the ;@CM|TOOL|key= line>` › `id=<the vendor g_ID>` › `shape=<shape>@<diameter, 3 dp>`
 *
 * Null when the record states none of the three — nothing about such a file can tie, so there is
 * nothing to remember. The diameter is quantised the way the panel writes it, since two files that
 * state the same cutter must produce the same string. A rung the record does not really answer is
 * skipped: a zero vendor id is not an id (`vendorId`), so a clone's file, whose MKR line says
 * `id=0`, keys on its shape rather than colliding with every other no-id file (#316 review).
 */
export function headerSignature(tool: Tool | null, statedKey: string | null): string | null {
  if (statedKey !== null) return `key=${statedKey}`;
  if (tool === null) return null;
  // `vendorId` skips a zero (a clone's file says `id=0`, which is the ABSENCE of an id): the
  // signature has to name the rung the file really answered, or two no-id files of different
  // shapes would share one remembered pick. See `vendorId` in `tool.ts` (#316 review).
  const id = vendorId(tool);
  if (id !== null) return `id=${id}`;
  const d = cuttingDiameter(tool);
  return d === null ? null : `shape=${tool.shape}@${d.toFixed(3)}`;
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
  // disagree is not this entry: the six same-diameter flats share a shape, not a length — and a
  // ZERO id is not a statement at all (`vendorId`: it is how a file with no `g_ID` writes the
  // field), so this rung may never pair two absences and call that an identity (#316 review).
  const fileId = vendorId(tool);
  if (fileId !== null) {
    const byId = entries.filter(
      (e) => vendorId(e.tool) === fileId && lengthsAgree(tool, e.tool),
    );
    const hit = resolveHits(byId, 'exact', 'id');
    if (hit) return hit;
  }

  const d = cuttingDiameter(tool);
  if (d === null) return null;
  const sameShape = entries.filter((e) => e.tool.shape === tool.shape && agrees(cuttingDiameter(e.tool), d));

  // (b) shape and diameter, and the header's own lengths agree with the entry's. Every agreeing
  // entry is resolved TOGETHER rather than the first being taken: two tiers answering this step are
  // as ambiguous as two answering (a), and picking the one that happens to be first in the registry
  // is the silent choice #316 exists to remove.
  if (statesALength(tool)) {
    const hit = resolveHits(
      sameShape.filter((e) => lengthsAgree(tool, e.tool)),
      'exact',
      'shape',
    );
    if (hit) return hit;
  }

  // (c) shape and diameter only — suggest the best of them, and let the panel say the match is weak.
  return resolveHits(sameShape, 'suggested', 'shape');
}
