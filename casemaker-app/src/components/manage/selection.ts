/**
 * The row the Manage surface has selected, and what a clone of it is (#311).
 *
 * Kept out of the list component because two panes act on the selection — the list's `Clone` button
 * and the detail rail — and the rule for reading it belongs in one place: the selection is a KEY,
 * the registry is the source of truth for what that key resolves to today, and an inventory item is
 * a separate document that only exists for an `inv:` row.
 *
 * `cloneOf` is the whole of Decision 2 (#311): a clone is a SEPARATE definition that remembers what
 * it was cloned from, and it never edits the row it came from. The prose it mints is what the Yours
 * group's second line shows, so it is the only record of the origin — the wire shape a `POST /tools`
 * sends carries no `origin` field (`house.rs`), which is why the sentence has to be complete on its
 * own rather than a bare reference to a key the clone does not hold.
 */

import { newId } from '@/utils/id';
import { tierOf } from '@/engine/cnc/toolTiers';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { inventoryKey } from '@/engine/cnc/toolRegistry';
import type { InventoryItem } from '@/platform/houseClient';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { formatDay } from './display';

/** The entry behind the selected key, or null when nothing is selected or the row has gone. */
export function useSelectedEntry(): ToolLibraryEntry | null {
  const key = useManageModeStore((s) => s.selectedKey);
  const tools = useToolRegistry();
  if (key === null) return null;
  return tools.find((e) => e.key === key) ?? null;
}

/**
 * Point the list at a cutter that was just registered (#337), WITHOUT closing the register frame.
 *
 * `manageModeStore.select` closes the frame, which is right for a click in the list and wrong here:
 * a registration is one of several — the user at the bench has the next box in hand — so the door
 * resets, the new `inv:` row is highlighted behind it (the write's re-read has already brought it
 * in), and closing the frame then lands on the row that was just made. The store has no action for
 * "select but stay", so this sets the one field directly; it belongs beside `select` if a second
 * caller ever appears.
 */
export function selectRegistered(itemId: string): void {
  useManageModeStore.setState({ selectedKey: inventoryKey(itemId) });
}

/** The possession behind the selected key. Only an `inv:` row has one. */
export function useSelectedItem(): InventoryItem | null {
  const key = useManageModeStore((s) => s.selectedKey);
  const items = useToolRegistryStore((s) => s.items);
  if (key === null || !key.startsWith('inv:')) return null;
  return items.find((i) => inventoryKey(i.id) === key) ?? null;
}

/**
 * A new `user:` definition cloned from an existing row.
 *
 * The key is minted here and not derived from the source, exactly as `InventoryItem.id` is: the
 * service keys its own file by what the client sends, so two clones of the same row must be two
 * rows (`house.rs`). The tool is copied field for field — a clone that improved a number the source
 * never stated would be inventing a measurement, and the whole point of the Yours tier is that the
 * user changes it ON PURPOSE.
 *
 * **Makera's `id` and `number` are dropped, and that is the one field that is not copied** (#212's
 * "Do not let a clone inherit the vendor id"). `Tool.id` IS the vendor's `g_ID`, and two things read
 * it: `post/z1.ts` writes it into the `.nc` header, and `simSetupStore.matchRegistryTool` matches a
 * header back to a registry row **id first**. A clone that kept it would therefore write the id of
 * the catalogue row it was cloned from — so an edited cutter would reopen as the unedited original,
 * which is exactly the silent substitution the clone exists to prevent. A `user:` definition is not
 * a Makera row, so it has no vendor id and no vendor cutter number: both are `null`, which is the
 * honest value rather than a borrowed one.
 */
export function cloneOf(entry: ToolLibraryEntry, today: string): ToolLibraryEntry {
  const tier = tierOf(entry.key);
  const from =
    tier === 'catalogue'
      ? 'Makera catalogue'
      : tier === 'owned'
        ? 'your inventory'
        : tier === 'yours'
          ? 'your own'
          : 'the built-in';
  const day = formatDay(today) ?? today;
  return {
    key: `user:${newId()}`,
    tool: { ...entry.tool, id: null, number: null },
    provenance: `cloned from ${from} “${entry.tool.name}” on ${day}`,
  };
}
