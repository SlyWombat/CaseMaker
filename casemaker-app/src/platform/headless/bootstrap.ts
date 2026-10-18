/**
 * The set-up every headless entry point shares (#476).
 *
 * Three steps were copied into each script that runs the real pipeline:
 *
 *  1. initialise the Manifold wasm module and call its `setup()`;
 *  2. seed the parsed-font cache from `src/engine/fonts/files/*.ttf` — the app loads those by
 *     `fetch`ing a static asset, and Node's `fetch` refuses a `file:` URL, so a headless run reads
 *     the same bytes off disk through `registerBundledFontBytes` (the `tests/setup/fonts.ts` seam,
 *     #180);
 *  3. read the machine's own document — `location.json`, falling back to `house.json`, falling
 *     back to no document at all — validate it, and put its cutters and inventory into the tool
 *     registry (#412).
 *
 * They live here so the CLI (CNC-12 tier 1) and the MCP server (tier 2) can call them once and the
 * scripts stop carrying copies that drift. `bootstrap()` performs all three and returns the
 * handles; a caller that only wants the document calls `loadLocation()`.
 *
 * NODE, WITHOUT `node:*` IMPORTS. This module sits under `src/`, which the browser tsconfig also
 * compiles, so it reaches Node through `process.getBuiltinModule` (Node ≥ 22.3) with local
 * structural types — the same seam `src/utils/nodeGlobJson.ts` uses to stay typecheckable with and
 * without `@types/node` and inert in a browser bundle. Nothing here should ever be imported by app
 * code; the scripts and the future headless entry points are its only callers.
 */
import ManifoldModule, { type ManifoldToplevel } from 'manifold-3d';

import { ToolLibrarySchema, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { setInventoryEntries, setRegistry } from '@/engine/cnc/toolRegistry';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '@/engine/fonts/registry';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { InventorySchema, type InventoryItem } from '@/platform/houseClient';
import { checkLocationImport } from '@/platform/locationClient';
import { inventoryEntryFor } from '@/store/toolRegistryStore';

// Shadow the global so this file typechecks with AND without @types/node (see nodeGlobJson.ts).
declare const process:
  | {
      getBuiltinModule?: (id: string) => unknown;
      platform?: string;
      env: Record<string, string | undefined>;
    }
  | undefined;

/** The slice of `node:fs` this module uses. */
interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: URL): BytesLike;
  readFileSync(path: string, encoding: 'utf8'): string;
}
/** A file's bytes, with the non-shared buffer the font cache wants to take ownership of. */
interface BytesLike extends Uint8Array {
  buffer: ArrayBuffer;
}
/** The slice of `node:module` this module uses. */
interface ModuleLike {
  createRequire(url: string | URL): { resolve(id: string): string };
}

function builtin<T>(id: string): T {
  const get = typeof process === 'undefined' ? undefined : process.getBuiltinModule;
  if (typeof get !== 'function') {
    throw new Error('the headless bootstrap needs Node ≥ 22.3 (process.getBuiltinModule)');
  }
  const mod = get(id);
  if (mod === undefined) throw new Error(`Node has no built-in module "${id}"`);
  return mod as T;
}

// ---------------------------------------------------------------------------------------------
// 1. Manifold — once per process
// ---------------------------------------------------------------------------------------------

let manifoldPromise: Promise<ManifoldToplevel> | null = null;

/** The wasm module, initialised on first use and handed to every later caller unchanged. */
function manifold(): Promise<ManifoldToplevel> {
  manifoldPromise ??= (async () => {
    const require = builtin<ModuleLike>('node:module').createRequire(import.meta.url);
    // manifold-3d types `locateFile` as zero-arg; the only file it ever requests is the wasm.
    const wasmPath = require.resolve('manifold-3d/manifold.wasm');
    const tl = await ManifoldModule({ locateFile: () => wasmPath });
    tl.setup();
    return tl;
  })();
  return manifoldPromise;
}

// ---------------------------------------------------------------------------------------------
// 2. Fonts — once per process
// ---------------------------------------------------------------------------------------------

let fontsSeeded = false;

/**
 * Seed the registry's parsed-font cache from the bundled TTFs on disk. Idempotent: a second call
 * is a no-op, so two entry points that both call `bootstrap()` parse each face once.
 */
function seedFonts(): void {
  if (fontsSeeded) return;
  const fs = builtin<FsLike>('node:fs');
  for (const key of BUNDLED_FONT_KEYS) {
    const bytes = fs.readFileSync(new URL(`../../engine/fonts/files/${key}.ttf`, import.meta.url));
    registerBundledFontBytes(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  fontsSeeded = true;
}

// ---------------------------------------------------------------------------------------------
// 3. The machine's own document
// ---------------------------------------------------------------------------------------------

/**
 * Where the desktop app keeps the machine's own documents — `dirs::data_dir()/casemaker/` on the
 * Rust side, spelled here for the same two platforms: `%APPDATA%` on Windows, `$XDG_DATA_HOME` (or
 * `~/.local/share`) elsewhere. Deliberately the SAME path, so a headless run and the app see one
 * set of cutters; there is no second copy to drift.
 *
 * Two names, tried in order, because #412 moved the user's document from the second to the first
 * (`location.rs`): on a machine the location migration has run on, both files are on disk and only
 * `location.json` is still being edited, so reading the older one would resolve the job against a
 * frozen copy of the cutter list. On a machine it has not run on, `location.json` does not exist
 * and `house.json` is still the truth.
 */
function defaultDocPaths(): string[] {
  const env: Record<string, string | undefined> =
    (typeof process === 'undefined' ? undefined : process.env) ?? {};
  const base =
    process?.platform === 'win32'
      ? env.APPDATA
      : (env.XDG_DATA_HOME ?? (env.HOME ? joinPath(env.HOME, '.local', 'share') : undefined));
  if (!base) return [];
  const dir = joinPath(base, 'casemaker');
  return [joinPath(dir, 'location.json'), joinPath(dir, 'house.json')];
}

/** `node:path.join`, through the same builtin seam (no static `node:path` import). */
function joinPath(...parts: string[]): string {
  return (builtin<{ join(...p: string[]): string }>('node:path').join)(...parts);
}

/**
 * A document that is present but does not match this build. Absent files are not errors — the
 * built-in tier is what a headless run falls back to — but half of a bad one is worse than none,
 * because it would put a cutter in the registry the app itself would refuse (#305).
 */
export class LocationDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocationDocumentError';
  }
}

/** The machine's own document, as this run resolved and applied it. */
export interface LoadedLocation {
  /** The file it was read from. */
  path: string;
  /** A #412 location, or the `house.json` that came before it. */
  kind: 'location' | 'house';
  /** The location's own name; null for a house file, which has none. */
  name: string | null;
  /** The user's own cutter definitions, now in the registry. */
  tools: ToolLibraryEntry[];
  /** The cutters the user physically owns, now in the registry as `inv:` entries. */
  inventory: InventoryItem[];
  /** The shop's tunable defaults (#416/#417); null for a house file or a document without them. */
  defaults: ShopDefaults | null;
}

/**
 * Read the machine's own documents into the tool registry, so `inv:…` keys resolve.
 *
 * `path` is either the `--location` document or a list tried in order (the default is
 * {@link defaultDocPaths}). The first path that exists wins; nothing existing is not an error and
 * answers null.
 *
 * A LOCATION is checked by `checkLocationImport`, the very function the panel holds an imported
 * file to (#412): one rule for the document, so a `location.json` this reads is one the app would
 * have accepted — machine records included, which is the point of checking the whole document
 * rather than the two tiers a run actually wants. Anything of another kind is read as the house,
 * with the same two zod schemas `houseClient` uses on the HTTP path.
 */
export function loadLocation(path?: string | readonly string[]): LoadedLocation | null {
  const paths = path === undefined ? defaultDocPaths() : typeof path === 'string' ? [path] : path;
  const fs = builtin<FsLike>('node:fs');
  const found = paths.find((p) => fs.existsSync(p));
  if (found === undefined) return null; // no documents on this machine — the built-ins carry the run

  let raw: string;
  try {
    raw = fs.readFileSync(found, 'utf8');
  } catch {
    return null;
  }

  let tools: ToolLibraryEntry[];
  let inventory: InventoryItem[];
  let name: string | null;
  let kind: LoadedLocation['kind'];
  let defaults: ShopDefaults | null;
  const location = checkLocationImport(raw);
  if (location.kind === 'refused') throw new LocationDocumentError(`${found}: ${location.reason}`);
  if (location.kind === 'location') {
    tools = location.doc.tools;
    inventory = location.doc.inventory;
    // #436 — the shop's own rest-machining numbers live here, not in the source. A document that
    // predates the section reads as `{}`, which `readDefault` answers with the labelled fallback.
    defaults = location.doc.defaults;
    name = location.doc.name;
    kind = 'location';
  } else {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new LocationDocumentError(`${found} is not JSON: ${(e as Error).message}`);
    }
    const doc = json as { tools?: unknown; inventory?: unknown };
    const parsedTools = ToolLibrarySchema.safeParse(doc.tools ?? []);
    if (!parsedTools.success) {
      throw new LocationDocumentError(`${found}: "tools" is not a tool list:\n  ${parsedTools.error.message}`);
    }
    const parsedInventory = InventorySchema.safeParse(doc.inventory ?? []);
    if (!parsedInventory.success) {
      throw new LocationDocumentError(`${found}: "inventory" is not an inventory:\n  ${parsedInventory.error.message}`);
    }
    tools = parsedTools.data;
    inventory = parsedInventory.data;
    name = null;
    kind = 'house';
    defaults = null;
  }
  setRegistry(tools);
  setInventoryEntries(inventory.map(inventoryEntryFor));
  return { path: found, kind, name, tools, inventory, defaults };
}

// ---------------------------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------------------------

export interface HeadlessBootstrapOptions {
  /**
   * A document to read instead of the machine's own — the scripts' `--location <file>`. Absent
   * means `location.json`, then `house.json`, then no document at all.
   */
  location?: string;
}

export interface HeadlessBootstrap {
  /** The wasm module, `setup()` called: one instance per process. */
  manifold: ManifoldToplevel;
  /** The document that was read, or null when this machine has none. */
  location: LoadedLocation | null;
}

/**
 * Everything a headless run needs before it resolves a cutter or builds geometry: the wasm module,
 * the bundled fonts, and the machine's own document in the registry. Safe to call more than once
 * per process — the wasm and the fonts are initialised only on the first call.
 */
export async function bootstrap(options: HeadlessBootstrapOptions = {}): Promise<HeadlessBootstrap> {
  const tl = await manifold();
  seedFonts();
  const location = loadLocation(options.location);
  return { manifold: tl, location };
}
