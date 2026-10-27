import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * A CSS media query, as React state (#726 W19/P12).
 *
 * The same reasoning as ContextPanel's compact query (#462): React reads `matches` from the
 * MediaQueryList the stylesheet itself uses and subscribes to that list's own `change` event, via
 * `useSyncExternalStore`, so a render can never disagree with the layout CSS applies. A
 * `resize`-driven `useState` can be one task behind the query it is standing in for.
 *
 * The lists are cached per window, so `getSnapshot` stays cheap and subscriptions do not build a
 * new `MediaQueryList` on every render. jsdom has no `matchMedia`: the query is then `false` for
 * the life of the render, which is the desktop layout the unit specs are written against.
 */
const LISTS = new WeakMap<Window, Map<string, MediaQueryList>>();

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  let byQuery = LISTS.get(window);
  if (byQuery === undefined) {
    byQuery = new Map();
    LISTS.set(window, byQuery);
  }
  const existing = byQuery.get(query);
  if (existing !== undefined) return existing;
  const created = window.matchMedia(query);
  byQuery.set(query, created);
  return created;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useMemo(
    () => (onChange: () => void): (() => void) => {
      const list = mediaList(query);
      if (list === null) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => mediaList(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
