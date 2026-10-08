import { useSyncExternalStore } from 'react';
import { getTools, subscribeRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

/**
 * The resolved tool list, for a picker (#305). The registry is not a store — it is one small
 * module in `engine/cnc` — so the pickers subscribe to it directly rather than through Zustand,
 * and a `setRegistry` from a later stage (#212's catalogue) re-renders every picker at once.
 */
export function useToolRegistry(): readonly ToolLibraryEntry[] {
  return useSyncExternalStore(subscribeRegistry, getTools);
}
