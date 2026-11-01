/**
 * #786 slice 4c-2 — A CUTTER'S UNSTATED GEOMETRY, FROM MAKERA'S OWN RECORD OF THE SAME CUTTER.
 *
 * A cutter carries Makera's `g_ID` (`Tool.id`) when it came from the catalogue, an `inv:` copy of
 * one, or a clone. When the operator's own record leaves a cutting field blank — a V-bit's tip, a
 * cutter's flute — the catalogue's row for the SAME `g_ID` is a statement about the same physical
 * cutter, not a guess: the id is the vendor's identity for it. This module fills exactly those
 * blanks, returns the tool the CAM must use, and names what it filled so a finding can say where
 * the number came from.
 *
 * It never fills a field the record STATES. A stated 0 tip is a point the operator recorded
 * (`tipNotRecorded`'s rule, tool.ts); a stated short flute is the cutter's real reach. Only an
 * ABSENT value is filled, so no sentence can disagree with the record the operator typed.
 *
 * The values are the catalogue's own fields, never derived: the tip a V-bit cuts with
 * (`tipDiameter`), and the reach the holder rule reads (`shoulderLength`, else `fluteLength`, the
 * same order `knownReach` uses). A catalogue row that states none fills nothing.
 */

import { threadMillUnambiguousDiameter, vendorId, type Tool } from '@/engine/cnc/tool';
import { THREAD_LABEL_TOLERANCE_MM } from '@/engine/cnc/feeds';
import { isVShape } from '@/engine/cnc/vProfile';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

/** Which blank the catalogue filled, and the number it stated. */
export interface CatalogueValue {
  field: 'tip' | 'diameter' | 'reach';
  /** The catalogue's number, mm. */
  mm: number;
  /** The catalogue cutter's own name — the record the number comes from. */
  cutterName: string;
  /**
   * #859 — the record's own, coarser statement of the same size the catalogue replaced (a thread
   * mill label's `d2.4` for the catalogue's 2.42), or absent when the record stated none.
   */
  replaced?: number;
}

export interface ToolWithCatalogueValues {
  /** The tool the CAM and every reach sentence must use. */
  tool: Tool;
  /** What was filled, in reading order (tip first). Empty when the record states everything. */
  filled: CatalogueValue[];
}

/**
 * The catalogue entry for the same physical cutter: a `cat:` row whose vendor id equals this
 * tool's. A tool with no `g_ID` (the clone and the hand-typed definition keep it off, #212) never
 * matches — two no-id cutters must never be taken for each other (`knownReach`'s rule).
 */
function catalogueTwin(tool: Tool, entries: readonly ToolLibraryEntry[]): ToolLibraryEntry | null {
  const id = vendorId(tool);
  if (id === null) return null;
  for (const entry of entries) {
    if (!entry.key.startsWith('cat:')) continue;
    if (vendorId(entry.tool) !== id) continue;
    return entry;
  }
  return null;
}

const positive = (v: number | null | undefined): number | null => (v !== null && v !== undefined && v > 0 ? v : null);

/**
 * The tool with the catalogue's tip and reach filled where the record states neither.
 *
 * The return is always a COPY: the caller's tool (usually the job's own snapshot) is never edited.
 */
export function withCatalogueValues(
  tool: Tool,
  entries: readonly ToolLibraryEntry[] | null | undefined,
): ToolWithCatalogueValues {
  const list = entries ?? [];
  const twin = catalogueTwin(tool, list);
  if (twin === null) return { tool, filled: [] };

  const filled: CatalogueValue[] = [];
  let next: Tool = tool;

  // THE TIP — only a pointed cutter whose record leaves it blank: a flat end's size is its
  // diameter, and a stated 0 is the point the operator recorded (tool.ts's rule). An engraver with
  // no tip cannot form a cone at all (`vCone` refuses it), so this fill is also what lets such a
  // record cut as the catalogue's cutter rather than being refused for a field the catalogue has.
  if (isVShape(tool) && tool.tipDiameter === null) {
    const tip = positive(twin.tool.tipDiameter);
    if (tip !== null) {
      next = { ...next, tipDiameter: tip };
      filled.push({ field: 'tip', mm: tip, cutterName: twin.tool.name });
    }
  }

  // THE CUTTING DIAMETER — a V shape's BODY. A chamfer's reach at a given bevel width is the
  // cone's flank up to its base, derived from the base diameter and the angle; a record that
  // states neither a tip nor a base cannot say how wide a chamfer its cone reaches
  // (`chamfer-reach-unproven`). The catalogue row for the same g_ID states the base it machined,
  // so the body is filled from it — and the run then proves the reach it cuts with.
  if (isVShape(tool) && positive(tool.diameter) === null) {
    const stated = positive(twin.tool.diameter);
    if (stated !== null) {
      next = { ...next, diameter: stated };
      filled.push({ field: 'diameter', mm: stated, cutterName: twin.tool.name });
    }
  }

  // #859 — A THREAD MILL'S CUTTING DIAMETER IS THE CATALOGUE'S. Makera's row for the same g_ID
  // states it in its cutting column (`diameter`, 2.42 mm for the M3 mill); a house record put the
  // 3.175 mm SHANK in `diameter` and the label's rounded `d2.4` in the tip. When the record states
  // nothing that disagrees (a tip or a named size within the label's 0.1 mm printing, or nothing
  // but a shank-sized `diameter`), the catalogue's number is the cutter's, in both fields, so no
  // reader can take the shank for the cut. A record that disagrees is left alone: the coverage
  // rule (`catalogueCoverageFor`) names it a different cutter.
  if (tool.shape === 'thread') {
    const cut = positive(twin.tool.tipDiameter) ?? positive(twin.tool.diameter);
    const own = threadMillUnambiguousDiameter(tool);
    if (
      cut !== null &&
      (own === null || Math.abs(own - cut) <= THREAD_LABEL_TOLERANCE_MM) &&
      (tool.diameter !== cut || tool.tipDiameter !== cut)
    ) {
      next = { ...next, diameter: cut, tipDiameter: cut };
      filled.push({ field: 'diameter', mm: cut, cutterName: twin.tool.name, ...(own === null || own === cut ? {} : { replaced: own }) });
    }
  }

  // THE REACH — a cutter that states neither a shoulder nor a flute. The shoulder wins when the
  // catalogue states one, because it is the shank-collision limit the holder rule reads first.
  if (positive(tool.shoulderLength) === null && positive(tool.fluteLength) === null) {
    const shoulder = positive(twin.tool.shoulderLength);
    const flute = positive(twin.tool.fluteLength);
    if (shoulder !== null) {
      next = { ...next, shoulderLength: shoulder };
      filled.push({ field: 'reach', mm: shoulder, cutterName: twin.tool.name });
    } else if (flute !== null) {
      next = { ...next, fluteLength: flute };
      filled.push({ field: 'reach', mm: flute, cutterName: twin.tool.name });
    }
  }

  return { tool: next, filled };
}

/**
 * Every entry with its tool enriched by its catalogue twin. The `cat:` rows themselves are left
 * alone (they ARE the record); every other row that carries a Makera `g_ID` is filled where its
 * own record leaves a tip or a reach blank. One call at a worker's entry makes every key the run
 * resolves — a setup's per-program cutters included — carry the same values the sentence names.
 */
export function withCatalogueEntries(entries: readonly ToolLibraryEntry[]): readonly ToolLibraryEntry[];
export function withCatalogueEntries(entries: null): null;
export function withCatalogueEntries(entries: undefined): undefined;
export function withCatalogueEntries(
  entries: readonly ToolLibraryEntry[] | null | undefined,
): readonly ToolLibraryEntry[] | null | undefined;
export function withCatalogueEntries(
  entries: readonly ToolLibraryEntry[] | null | undefined,
): readonly ToolLibraryEntry[] | null | undefined {
  if (entries === null || entries === undefined) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.key.startsWith('cat:')) return entry;
    const enriched = withCatalogueValues(entry.tool, entries);
    if (enriched.filled.length === 0) return entry;
    changed = true;
    return { ...entry, tool: enriched.tool };
  });
  return changed ? next : entries;
}

/** `0.2` — a catalogue number as a sentence writes it (three decimals, trailing zeros dropped). */
function mm3(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** The info finding's sentence, one line for each blank the catalogue filled. */
export function catalogueValueSentence(tool: Tool, filled: readonly CatalogueValue[]): string | null {
  if (filled.length === 0) return null;
  // #859 — a size the record DID state, coarser than the catalogue's: say both numbers.
  const refined = filled.filter((f) => f.replaced !== undefined);
  const blanks = filled.filter((f) => f.replaced === undefined);
  const refinedWords = refined.map(
    (f) =>
      `The cutter "${tool.name}" states its cutting diameter as ${mm3(f.replaced!)} mm; this run uses ` +
      `${mm3(f.mm)} mm, the size Makera's catalogue record for "${f.cutterName}" states.`,
  );
  if (blanks.length === 0) return refinedWords.join(' ');
  const blankWords = blankSentence(tool, blanks);
  return [blankWords, ...refinedWords].join(' ');
}

function blankSentence(tool: Tool, filled: readonly CatalogueValue[]): string {
  const parts = filled.map((f) =>
    f.field === 'tip'
      ? `its tip ⌀ (${mm3(f.mm)} mm) from Makera's catalogue record for "${f.cutterName}"`
      : f.field === 'diameter'
        ? `its cutting diameter (${mm3(f.mm)} mm) from Makera's catalogue record for "${f.cutterName}"`
        : `its reach (${mm3(f.mm)} mm) from Makera's catalogue record for "${f.cutterName}"`,
  );
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return `The cutter "${tool.name}" records no ${filled.map((f) => (f.field === 'tip' ? 'tip ⌀' : f.field === 'diameter' ? 'cutting diameter' : 'flute length')).join(' or ')}; this run uses ${joined}.`;
}
