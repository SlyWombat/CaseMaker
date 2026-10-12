import * as opentypeModule from 'opentype.js';
import type { ParsedFont } from '@/engine/compiler/glyphs';
import type { CustomFont } from '@/types/textLabel';
import { BUNDLED_FONT_URLS } from './fontAssets';

/**
 * Font registry. A label's `font` is a registry id: either a bundled font
 * (below) or the id of a user-supplied TTF embedded in the project
 * (`Project.customFonts`). Legacy projects only ever stored 'sans-default' /
 * 'mono-default'; those ids are kept so they keep resolving.
 *
 * Bundled fonts are STATIC ASSETS, not base64 in the bundle (issue #180). A build used to carry
 * all six TTFs as base64 in `bundledFontData.ts` — ~1.1 MB in the main chunk, parsed as JS on
 * every load. Now `ensureFontsLoaded` `fetch`es only the faces a project's labels actually use
 * and caches the parsed font, so the compiler's `resolveFont` stays synchronous everywhere it
 * runs (main thread, sim worker, vitest) and a project with no text labels fetches nothing.
 *
 * All bundled fonts are SIL OFL 1.1; the licence texts are in ./licenses and recorded in the
 * repo-root NOTICE.
 */
export interface BundledFontDef {
  id: string;
  label: string;
  family: 'sans' | 'mono' | 'serif';
  /** Keys into BUNDLED_FONT_URLS / the parsed-font cache. */
  regular: string;
  bold: string;
}

export const BUNDLED_FONTS: readonly BundledFontDef[] = [
  { id: 'sans-default', label: 'Barlow (sans)', family: 'sans', regular: 'Barlow-Regular', bold: 'Barlow-Bold' },
  { id: 'mono-default', label: 'IBM Plex Mono (mono)', family: 'mono', regular: 'IBMPlexMono-Regular', bold: 'IBMPlexMono-Bold' },
  { id: 'serif-default', label: 'IBM Plex Serif (serif)', family: 'serif', regular: 'IBMPlexSerif-Regular', bold: 'IBMPlexSerif-Bold' },
];

export const DEFAULT_FONT_ID = 'sans-default';

/**
 * opentype.js ships BOTH a UMD build (its CJS `main`) and an ESM build (`module`). Vite/rolldown
 * and vitest resolve the ESM build with real named exports, but Node/tsx resolve the UMD one,
 * where Node's CJS→ESM interop parks the whole API on `default` (the UMD wrapper hides the named
 * exports from cjs-module-lexer) — so `import * as opentype` there has no `parse`. Pick whichever
 * shape actually carries `parse`, so the browser/worker and the tsx scripts both work.
 */
const opentype: typeof opentypeModule = 'parse' in opentypeModule
  ? opentypeModule
  : (opentypeModule as unknown as { default: typeof opentypeModule }).default;

/** Every bundled font-file key (regular + bold), in def order. */
export const BUNDLED_FONT_KEYS: readonly string[] = BUNDLED_FONTS.flatMap((d) => [d.regular, d.bold]);

/** The minimum a label must expose for `fontKeysForLabels`; both `TextLabel` and `EngraveLabel` fit. */
export interface FontBearingLabel {
  text: string;
  font: string;
  weight: 'regular' | 'bold';
  enabled?: boolean;
}

function weightKey(def: BundledFontDef, weight: 'regular' | 'bold'): string {
  return weight === 'bold' ? def.bold : def.regular;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const parsedCache = new Map<string, ParsedFont>();

function parseCached(key: string, bytes: ArrayBuffer): ParsedFont {
  let f = parsedCache.get(key);
  if (!f) {
    f = opentype.parse(bytes);
    parsedCache.set(key, f);
  }
  return f;
}

/**
 * Node/test seam (issue #180): seed a bundled font from bytes already in memory. The browser
 * gets its bytes through `fetch` in `ensureFontsLoaded`; vitest specs call `resolveFont`
 * synchronously with no fetch seam, so `tests/setup/fonts.ts` reads the TTFs off disk here.
 */
export function registerBundledFontBytes(key: string, bytes: ArrayBuffer): void {
  parseCached(key, bytes);
}

const pendingLoads = new Map<string, Promise<void>>();

/** Fetch and parse one bundled font (or join an in-flight load of it). */
function loadBundledFont(key: string): Promise<void> {
  const inflight = pendingLoads.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const url = BUNDLED_FONT_URLS[key];
      if (!url) throw new Error(`no static asset is registered for bundled font "${key}"`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`failed to fetch bundled font "${key}" (HTTP ${res.status}) from ${url}`);
      parsedCache.set(key, opentype.parse(await res.arrayBuffer()));
    } finally {
      pendingLoads.delete(key);
    }
  })();
  pendingLoads.set(key, p);
  return p;
}

/**
 * The bundled font-file keys a set of labels needs. Disabled and empty-text labels are skipped
 * (the compiler skips them too), custom fonts live in memory and are not fetched, and an
 * unknown id resolves to the default sans — so ITS key is returned, not the unknown one.
 */
export function fontKeysForLabels(
  labels: readonly FontBearingLabel[] | undefined,
  customFonts: readonly Pick<CustomFont, 'id'>[] = [],
): string[] {
  const customIds = new Set(customFonts.map((f) => f.id));
  const keys = new Set<string>();
  for (const label of labels ?? []) {
    if (label.enabled === false) continue;
    if (!label.text || label.text.length === 0) continue;
    if (customIds.has(label.font)) {
      // `resolveFont` falls back to the default sans if a custom font fails to parse.
      keys.add(weightKey(BUNDLED_FONTS[0]!, label.weight));
      continue;
    }
    const def = BUNDLED_FONTS.find((f) => f.id === label.font) ?? BUNDLED_FONTS[0]!;
    keys.add(weightKey(def, label.weight));
  }
  return [...keys];
}

/**
 * Load (and cache) the given bundled font-file keys before a synchronous compile. Passing `[]`
 * fetches nothing — that is the "a project with no text labels fetches none" guarantee. Called
 * with no argument it loads every bundled face.
 */
export async function ensureFontsLoaded(keys?: readonly string[]): Promise<void> {
  const wanted = keys ?? BUNDLED_FONT_KEYS;
  const missing = wanted.filter((k) => !parsedCache.has(k));
  if (missing.length === 0) return;
  await Promise.all(missing.map(loadBundledFont));
}

/**
 * Load the faces a set of LABELS is set in — the two calls above, as one name, for the callers that
 * are about to MEASURE a label rather than merely draw it.
 *
 * `labelGlyphMeasure` answers `null` for a face that is not parsed yet (that is how #180's throw is
 * caught), and its readers fall back to `inkBoxOf`'s documented estimate — which is honest, but the
 * seed paths (#363/#364) were quietly measuring with it: the wizard's hand-off and the panel's two
 * buttons ran before anything on the main thread had fetched a face, so the badge seed came out at
 * the estimate's 5 mm cap instead of the 8 this module's own rows show once the faces are up (#365
 * review). A caller that is about to size or bound a line says so by awaiting this first.
 *
 * Superset of what the caller needs, deliberately: the seed borrows ONE label's face, and asking for
 * the whole set costs nothing when the keys are already cached (`ensureFontsLoaded` returns without a
 * fetch) and one extra fetch when they are not.
 */
export async function ensureLabelFontsLoaded(
  labels: readonly FontBearingLabel[] | undefined,
  customFonts: readonly Pick<CustomFont, 'id'>[] = [],
): Promise<void> {
  await ensureFontsLoaded(fontKeysForLabels(labels, customFonts));
}

/**
 * `ensureLabelFontsLoaded` for the SEED paths, where the wait is a nicety rather than a precondition.
 *
 * The store's seed MEASURES the line it lays out, and the measurement has a documented fallback — the
 * estimate — for a face that is not parsed; a fetch that plainly fails leaves the seed with exactly
 * the answer it had before this wait existed. So the failure is swallowed here: the alternative is a
 * hand-off (or a click on the panel's button) that does nothing at all, which is a worse outcome than
 * a placeholder one size small. `ensureLabelFontsLoaded` stays loud for the run sheet and the saves,
 * which must not write a document full of numbers nobody measured.
 */
export async function ensureSeedFontsLoaded(
  labels: readonly FontBearingLabel[] | undefined,
  customFonts: readonly Pick<CustomFont, 'id'>[] = [],
): Promise<void> {
  try {
    await ensureLabelFontsLoaded(labels, customFonts);
  } catch {
    // Deliberately silent: the estimate is the documented answer when no face is available.
  }
}

/**
 * The synchronous half of the call above: are those faces ALREADY up? A caller that renders rows by
 * measuring them asks this first, so that the ordinary case — every face already parsed — costs no
 * fetch, no re-render and no state bump, and only the cold first render pays for the await.
 *
 * Same question, same keys: `fontKeysForLabels` is the single list both read, so "already up" cannot
 * drift from what `ensureLabelFontsLoaded` would go and get.
 */
export function labelFontsLoaded(
  labels: readonly FontBearingLabel[] | undefined,
  customFonts: readonly Pick<CustomFont, 'id'>[] = [],
): boolean {
  return fontKeysForLabels(labels, customFonts).every((key) => parsedCache.has(key));
}

/**
 * Resolve a label's font id to a parsed font. Unknown ids (a custom font that was deleted, a
 * hand-edited file) fall back to the default sans rather than dropping the label; a custom font
 * that fails to parse also falls back.
 *
 * The bundled faces must already be loaded — `ensureFontsLoaded` is called once per compile at
 * the entry points (`JobScheduler`, the sim worker's engrave preview) for exactly the keys the
 * project's labels need. A cache miss means that wiring was skipped, so it throws loudly rather
 * than silently typesetting the wrong face.
 */
export function resolveFont(
  id: string,
  weight: 'regular' | 'bold' = 'regular',
  customFonts: readonly CustomFont[] = [],
): ParsedFont {
  const custom = customFonts.find((f) => f.id === id);
  if (custom) {
    try {
      // Key on the payload tail too so replacing a font under the same id
      // does not serve a stale parse.
      return parseCached(`custom:${id}:${custom.data.length}:${custom.data.slice(-24)}`, decodeBase64(custom.data));
    } catch {
      return resolveFont(DEFAULT_FONT_ID, weight);
    }
  }
  const def = BUNDLED_FONTS.find((f) => f.id === id) ?? BUNDLED_FONTS[0]!;
  const key = weightKey(def, weight);
  const parsed = parsedCache.get(key);
  if (!parsed) {
    throw new Error(
      `bundled font "${key}" is not loaded — call ensureFontsLoaded() with the project's font ` +
        `keys before resolving it (issue #180)`,
    );
  }
  return parsed;
}
