/**
 * Which cutter faces the blank (#432 slice 2).
 *
 * A facing pass is a SEPARATE PROGRAM, so it is a separate cutter. The job's engraving tool is
 * chosen for the detail its items need — a 1 mm flat for 2 mm text — while a skim of the whole top
 * wants the widest flat the shop can justify: more of the disc in the cut, fewer passes, and the
 * stiffest cutter against the blank's edges. One cutter cannot be both, which is why the facing
 * program names its own.
 *
 * THE DEFAULT RULE, as filed on #432: **the largest flat end mill the catalogue recommends for the
 * job's material**, skipping cutters with no usable copy. Largest is `cuttingDiameter`; an equal
 * diameter goes to the better-kept condition, then the registry key, so the same shop picks the
 * same cutter twice.
 *
 *   - FLAT. A facing pass is a flat bottom over a plane: `cuttingForTrace` refuses a thread mill, and
 *     a V-bit's cone or a ball nose's point leaves a corrugated surface by definition.
 *   - RECOMMENDED BY THE CATALOGUE, which is `catalogueStandingFor`'s answer and not "has some row
 *     somewhere" (#455): a cutter the catalogue lists and lists for OTHER materials is out, and the
 *     metal line is never the default on a non-metal blank (`isMetalTool`, #405/#398). A catalogue
 *     that says nothing — none synced, or a cutter it cannot name — does not veto, exactly as it
 *     does not veto the engraving cutter's recommendation.
 *   - A CUTTER WITH NO USABLE COPY IS NOT A CANDIDATE (#467, review R10): every copy marked broken
 *     excludes it by name before the catalogue is asked. A WORN cutter stays eligible and can still
 *     be the default — condition is a TIEBREAK, never a priority — so the largest diameter is asked
 *     first and only an equal-diameter tie goes to the fresher bench (`conditionRank`, the order
 *     `recommendTool` uses). A cutter whose condition nobody has set ranks as "not set", not worn.
 *   - NOTHING SURVIVES: the answer is a REFUSAL, not a fallback to the job's cutter. The caller then
 *     emits no facing program and says why; the engraving still generates.
 *
 * AN EXPLICIT PICK WINS, with two hard requirements: it has to be a flat end mill, and it has to have
 * a usable copy. A cutter the catalogue does not recommend for the material still cuts when the
 * operator names it — #455's "the job names it by hand, so it still cuts" — because the name is the
 * operator's assertion, not the vendor's. A cutter every copy of which is marked broken is a
 * statement about the PHYSICAL bit, which no name can overrule (#415).
 *
 * PURE, and handed all three lists: this runs in the sim worker, where the tool registry, the feed
 * catalogue and the condition table are empty (#305/#324/#442), so the caller sends `getTools()`,
 * `feedCatalogueRows()` and `inventoryConditions()`. The condition table is handed in for exactly
 * that reason, never read from `toolCondition`'s module state.
 */

import {
  catalogueCoverageFor,
  catalogueStandingFor,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import { isMetalMaterial, MATERIAL_LABELS } from '@/engine/cnc/materials';
import { isMetalTool } from '@/engine/cnc/registerCutter';
import { cuttingDiameter, cuttingForTrace } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { conditionRank, type ConditionSummary } from '@/engine/cnc/toolCondition';
import type { StockMaterial } from '@/types/engraveJob';

/** The caller's condition snapshot by registry key, or null/absent when the bench is undescribed. */
type ConditionTable = ReadonlyMap<string, ConditionSummary> | null | undefined;

/** The cutter the facing program runs with, or the sentence saying why there is none. */
export type FacingToolPick =
  | { entry: ToolLibraryEntry; reason: null }
  | { entry: null; reason: string };

/** A flat end mill, by the same reading every other cutter filter uses (`cuttingForTrace`). */
function isFlat(entry: ToolLibraryEntry): boolean {
  const usable = cuttingForTrace(entry.tool);
  return usable.ok && usable.tool.shape === 'flat';
}

function diameterOf(entry: ToolLibraryEntry): number {
  return cuttingDiameter(entry.tool) ?? 0;
}

/**
 * Whether the condition table says every copy of this cutter is broken. A cutter with no entry, or
 * with an entry that still counts a usable copy, is eligible: "nothing known" is not "broken".
 */
function hasNoUsableCopy(entry: ToolLibraryEntry, conditions: ConditionTable): boolean {
  return conditions?.get(entry.key)?.usable === 0;
}

/**
 * Largest first. An EQUAL diameter goes to the better-kept cutter — condition is a tiebreak, never
 * a priority (#467/#415) — and the key breaks what condition cannot, so two equal cutters do not
 * alternate run to run.
 */
function byLargest(a: ToolLibraryEntry, b: ToolLibraryEntry, conditions: ConditionTable): number {
  const da = diameterOf(a);
  const db = diameterOf(b);
  if (da !== db) return db - da;
  const ra = conditionRank(conditions?.get(a.key)?.best ?? null);
  const rb = conditionRank(conditions?.get(b.key)?.best ?? null);
  if (ra !== rb) return ra - rb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function notFlatReason(entry: ToolLibraryEntry): string {
  return (
    `the job's facing tool "${entry.tool.name}" is not a flat end mill — a facing pass is a flat ` +
    `bottom over a plane, so it needs one`
  );
}

/**
 * The facing cutter for `material`, or the refusal sentence.
 *
 * `requestedKey` is the job's own `facing.toolKey` when it names one; `null`/absent asks for the
 * default rule. `tools`, `catalogue` and `conditions` are the caller's snapshots — see the module
 * doc. A missing `conditions` table means the bench is undescribed, so nothing is excluded as broken.
 */
export function chooseFacingTool(
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  material: StockMaterial,
  requestedKey: string | null = null,
  conditions: ConditionTable = null,
): FacingToolPick {
  if (requestedKey !== null && requestedKey !== '') {
    const entry = tools.find((e) => e.key === requestedKey);
    if (entry === undefined) {
      return { entry: null, reason: `the job's facing tool "${requestedKey}" is not in the tool list` };
    }
    if (!isFlat(entry)) return { entry: null, reason: notFlatReason(entry) };
    if (hasNoUsableCopy(entry, conditions)) {
      return {
        entry: null,
        reason: `the job's facing tool "${entry.tool.name}" has no usable copy — every copy of it is marked broken`,
      };
    }
    return { entry, reason: null };
  }

  const label = MATERIAL_LABELS[material];
  const flat = tools.filter(isFlat);
  if (flat.length === 0) {
    return { entry: null, reason: 'the tool list has no flat end mill, and a facing pass needs one' };
  }

  // #405/#398 — the metal line is a property of the PAIR (the bit and the blank), and a metal bit
  // will cut plastic badly at numbers nobody measured. It is a warning about the job's own cutter,
  // but this pick has no warning channel, so the default simply does not make that choice.
  const onLine = isMetalMaterial(material) ? flat : flat.filter((e) => !isMetalTool(e.tool));
  if (onLine.length === 0) {
    return {
      entry: null,
      reason:
        `every flat end mill in the tool list is Makera's "for Metal" line, and ${label} is not a ` +
        `metal — name a facing tool on the job if one of them is what you mean to use`,
    };
  }

  // #467/review R10 — skip broken cutters before the catalogue is asked, and say so if that is why
  // nothing is left. A worn cutter stays here; only an equal-diameter tie prefers a fresher one.
  const usable = onLine.filter((entry) => !hasNoUsableCopy(entry, conditions));
  if (usable.length === 0) {
    const names = onLine.map((entry) => `"${entry.tool.name}"`).join(', ');
    return {
      entry: null,
      reason:
        `every flat end mill in the tool list is marked broken (${names}) — a facing pass needs a ` +
        `cutter with a usable copy`,
    };
  }

  const standing = usable.map((entry) => ({
    entry,
    verdict: catalogueStandingFor(catalogueCoverageFor(catalogue, material, entry.tool), material, entry.tool.name),
  }));
  const eligible = standing.filter((s) => s.verdict.recommend);
  if (eligible.length === 0) {
    // The only `recommend: false` is "the catalogue lists it for other materials" (#455), whose
    // note is the vendor's own words — so the refusal can quote them instead of guessing.
    const notes = standing
      .map((s) => s.verdict.note)
      .filter((note): note is string => note !== null)
      .slice(0, 2);
    return {
      entry: null,
      reason:
        `the tool list has no flat end mill the catalogue recommends for ${label}` +
        (notes.length > 0 ? ` — ${notes.join(' ')}` : ''),
    };
  }

  return {
    entry: [...eligible].map((s) => s.entry).sort((a, b) => byLargest(a, b, conditions))[0]!,
    reason: null,
  };
}
