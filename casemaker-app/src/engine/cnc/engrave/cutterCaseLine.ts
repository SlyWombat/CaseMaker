/**
 * The bench's identity for a cutter (#491): its case colour FIRST, then the full label name and the
 * code printed on the box — `Yellow case — TiN Coating Corn Bit … (C1-BIT-CORN-2.0-10.5)`.
 *
 * This is one place because three surfaces say the same thing: the release step's bit-change
 * instruction, the single-file upload's cutter line, and the run sheet's "The cutter" step. The
 * colour is the CHOSEN COPY's, resolved by `toolCondition` from the same pool the pick uses; when
 * the pick is indifferent between two cases both are named, in condition order. No case is ever
 * inferred: an owner who has not recorded one gets the old, colourless sentence.
 */

import { entryFor, inventoryKey } from '@/engine/cnc/toolRegistry';
import { casePhraseForKey } from '@/engine/cnc/toolCondition';
import type { InventoryItem } from '@/platform/houseClient';

export interface CutterIdentity {
  /** The registry key the program names (`inv:<id>`, a built-in or a `cat:` row). */
  toolKey: string;
  /** The FULL label name — what the case says — or the key when the registry has no row. */
  name: string;
  /** The code printed on the box, when the possession carries one; else the registry key. */
  code: string;
  /** `Yellow case`, or `Yellow case (new) or green case (used)`, or null when no case is known. */
  casePhrase: string | null;
}

/** The possession behind an `inv:` key, when there is one. */
function possessionFor(toolKey: string, items: readonly InventoryItem[]): InventoryItem | null {
  return items.find((item) => inventoryKey(item.id) === toolKey) ?? null;
}

export function cutterIdentity(toolKey: string, items: readonly InventoryItem[]): CutterIdentity {
  const entry = entryFor(toolKey);
  const possession = possessionFor(toolKey, items);
  return {
    toolKey,
    name: entry?.tool.name ?? toolKey,
    code: possession?.codes[0]?.value ?? toolKey,
    casePhrase: casePhraseForKey(toolKey),
  };
}

/** The bench form as one string: `Yellow case — Name (CODE)`, with no colour when none is known. */
export function cutterLine(identity: CutterIdentity): string {
  return `${identity.casePhrase === null ? '' : `${identity.casePhrase} — `}${identity.name} (${identity.code})`;
}

/** The bit-change sentence, in the maintainer's bench form (#491). */
export function bitChangeSentence(
  identity: CutterIdentity,
  program: { index: number; total: number },
): string {
  return `Change the cutter for program ${program.index} of ${program.total}: ${cutterLine(identity)}.`;
}
