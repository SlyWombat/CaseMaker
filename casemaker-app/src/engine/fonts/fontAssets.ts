/**
 * Static-asset URLs for the bundled fonts (issue #180).
 *
 * Before this module, `bundledFontData.ts` inlined all six TTFs as base64 in a `.ts` module, so
 * ~1.1 MB of already-compressed font bytes landed in the main JS chunk and were parsed as
 * JavaScript on every visit — including for the many visitors who never place a text label.
 * Here the TTFs are emitted as hashed static assets and the registry `fetch`es them on first
 * use, so a project with no text labels downloads none of them.
 *
 * `new URL(..., import.meta.url)` is used (not a Vite `?url` import) on purpose: this module is
 * on the import path of `scripts/export-sample.ts`, which runs under `tsx`/esbuild and does not
 * understand the `?url` query. `new URL` is plain runtime JS there and a Vite asset reference
 * in the app and worker builds. The paths MUST stay static string literals — Vite cannot
 * analyse a template literal.
 */
export const BUNDLED_FONT_URLS: Readonly<Record<string, string>> = {
  'Barlow-Regular': new URL('./files/Barlow-Regular.ttf', import.meta.url).href,
  'Barlow-Bold': new URL('./files/Barlow-Bold.ttf', import.meta.url).href,
  'IBMPlexMono-Regular': new URL('./files/IBMPlexMono-Regular.ttf', import.meta.url).href,
  'IBMPlexMono-Bold': new URL('./files/IBMPlexMono-Bold.ttf', import.meta.url).href,
  'IBMPlexSerif-Regular': new URL('./files/IBMPlexSerif-Regular.ttf', import.meta.url).href,
  'IBMPlexSerif-Bold': new URL('./files/IBMPlexSerif-Bold.ttf', import.meta.url).href,
};
