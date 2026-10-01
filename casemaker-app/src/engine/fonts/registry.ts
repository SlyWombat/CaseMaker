import * as opentype from 'opentype.js';
import type { ParsedFont } from '@/engine/compiler/glyphs';
import type { CustomFont } from '@/types/textLabel';
import { BUNDLED_FONT_DATA } from './bundledFontData';

/**
 * Font registry. A label's `font` is a registry id: either a bundled font
 * (below) or the id of a user-supplied TTF embedded in the project
 * (`Project.customFonts`). Legacy projects only ever stored 'sans-default' /
 * 'mono-default'; those ids are kept so they keep resolving.
 *
 * Fonts are embedded as base64 (see scripts/gen-font-data.mjs) so resolution is
 * synchronous everywhere the compiler runs. All bundled fonts are SIL OFL 1.1;
 * the licence texts are in ./licenses and recorded in the repo-root NOTICE.
 */
export interface BundledFontDef {
  id: string;
  label: string;
  family: 'sans' | 'mono' | 'serif';
  /** Keys into BUNDLED_FONT_DATA. */
  regular: string;
  bold: string;
}

export const BUNDLED_FONTS: readonly BundledFontDef[] = [
  { id: 'sans-default', label: 'Barlow (sans)', family: 'sans', regular: 'Barlow-Regular', bold: 'Barlow-Bold' },
  { id: 'mono-default', label: 'IBM Plex Mono (mono)', family: 'mono', regular: 'IBMPlexMono-Regular', bold: 'IBMPlexMono-Bold' },
  { id: 'serif-default', label: 'IBM Plex Serif (serif)', family: 'serif', regular: 'IBMPlexSerif-Regular', bold: 'IBMPlexSerif-Bold' },
];

export const DEFAULT_FONT_ID = 'sans-default';

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const parsedCache = new Map<string, ParsedFont>();

function parseCached(key: string, b64: string): ParsedFont {
  let f = parsedCache.get(key);
  if (!f) {
    f = opentype.parse(decodeBase64(b64));
    parsedCache.set(key, f);
  }
  return f;
}

/**
 * Resolve a label's font id to a parsed font. Unknown ids (a custom font that
 * was deleted, a hand-edited file) fall back to the default sans rather than
 * dropping the label. A custom font that fails to parse also falls back.
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
      return parseCached(`custom:${id}:${custom.data.length}:${custom.data.slice(-24)}`, custom.data);
    } catch {
      return resolveFont(DEFAULT_FONT_ID, weight);
    }
  }
  const def = BUNDLED_FONTS.find((f) => f.id === id) ?? BUNDLED_FONTS[0]!;
  const key = weight === 'bold' ? def.bold : def.regular;
  return parseCached(key, BUNDLED_FONT_DATA[key]!);
}
