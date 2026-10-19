/**
 * Where the service is, from the page's own point of view.
 *
 * The origin that served this page is the only candidate, and not a guess: in the desktop app the
 * window's URL is the embedded server's address, and a browser can only have loaded this page from
 * something that answers `{@link HOUSE_API_PATH}` — a second address would need its own discovery
 * and its own Windows firewall story for nothing (#306). Returns `''` when there is no `location`
 * at all (a unit test, a worker), which makes every URL relative and every probe honestly `absent`.
 *
 * THE ORIGIN PLUS THE BUILD'S OWN BASE PATH (#342). The web deployment serves the app from a
 * subdirectory (`https://electricrv.ca/casemaker/`, `DEPLOY_BASE=/casemaker/`), so asking the origin
 * alone reached `https://electricrv.ca/api/v1/health` — the right verdict (`absent`), the wrong
 * request, and a 404 in the console on every visit. The API root hangs under the app's own base, and
 * that base is read from the BUILD rather than guessed: `import.meta.env.BASE_URL` is where Vite
 * actually mounted the app. `document.baseURI` would not do — there is no `<base>` element, so it is
 * the current page's URL, and a deep link like `/casemaker/jobs/7` would resolve to the wrong root.
 * On electricrv.ca this is still a 404 (nothing is mounted there): the verdict is the same `absent`,
 * and the console line stays until the host answers the path. The point is the path, not the line.
 *
 * Lives in its own module (not `platform/houseClient.ts`) because it is the one browser-only piece
 * of that module; the headless scripts import the house client for `InventorySchema` and its types,
 * and must not statically reach `location` (#544, same class as #534).
 */
export function houseBaseUrl(): string {
  // `location` is browser-only; read it off `globalThis` so this module — reached from the shared
  // house client — also type-checks under the headless no-DOM scripts config (#544).
  const loc = (globalThis as { location?: { origin: string } }).location;
  if (loc === undefined) return '';
  const origin = loc.origin;
  // `file://` and other opaque origins report the literal string "null"; a relative URL is the
  // honest version of "this page has no origin", and it fails the probe rather than fetching
  // `null/api/v1/health`.
  if (origin === 'null' || origin === '') return '';
  // `BASE_URL` is a path prefix in every build this repo makes (`vite.config.ts`'s `DEPLOY_BASE`,
  // default `/`), resolved against the origin so that it works with or without a trailing slash.
  // Only its PATH is taken: a full-URL base (Vite allows `base: 'https://cdn/x/'`) must not move
  // the probe off the page's own origin, which is the only candidate (above).
  const base = new URL(import.meta.env.BASE_URL, `${origin}/`);
  return `${origin}${base.pathname}`.replace(/\/+$/, '');
}
