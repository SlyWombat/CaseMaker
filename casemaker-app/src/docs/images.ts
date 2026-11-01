/**
 * THE GUIDE'S PICTURES SHIP IN THE BUNDLE (#880).
 *
 * A document's image can only be a path relative to the document — every document exists twice
 * (canonical in `src/docs/`, mirrored in `docs/`) and the two copies are byte-identical, so an
 * absolute path cannot be right in both places. The app resolves `img/<file>` through Vite, which
 * copies each file under `src/docs/img/` into the build and hands back its hashed URL; the repo
 * mirror resolves the same relative path against `docs/img/`, which `npm run docs:sync` keeps in
 * step with the canonical folder.
 *
 * WHY NOT REMOTE URLS. The app must load its own pictures with no network: the desktop shell's
 * CSP allows images from `'self'`, `data:` and `blob:` only, and a LAN install may have no
 * internet at all. A hot-linked image is a broken picture in both cases; the unit lint
 * (`docsImages.spec.ts`) refuses one.
 */

/** Every bundled picture, keyed by its file name (the part after `img/`), valued by its URL. */
const BUNDLED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob('./img/*', { query: '?url', eager: true, import: 'default' }) as Record<string, string>,
  ).map(([path, url]) => [path.slice('./img/'.length), url] as const),
);

/** The bundled URL for `img/<file>`, or null when the file is not in the bundle. */
export function docImageUrl(file: string): string | null {
  return BUNDLED[file] ?? null;
}

/**
 * Rewrite every `<img src="img/<file>">` in a rendered document to its bundled URL. A reference
 * with no bundled file is left as written (the lint fails on that, and the alt text still shows).
 */
export function resolveDocImages(html: string): string {
  return html.replace(/src="img\/([^"]+)"/g, (whole, file: string) => {
    const url = docImageUrl(file);
    return url === null ? whole : `src="${url}"`;
  });
}
