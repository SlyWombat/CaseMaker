import { useSyncExternalStore } from 'react';
import { getRendererVerdict, subscribeRendererVerdict, type RendererVerdict } from '@/engine/cnc/rendererBits';

/**
 * #1124 — the page's renderer verdict, for Generate's blocker. The check is one module value in
 * `engine/cnc/rendererBits` (the `toolRegistry` pattern), so the panel subscribes to it directly
 * rather than through a store.
 */
export function useRendererVerdict(): RendererVerdict {
  return useSyncExternalStore(subscribeRendererVerdict, getRendererVerdict);
}
