/**
 * Node-runtime stand-in for Vite's `import.meta.glob(pattern, { eager: true })`
 * over a directory of JSON files.
 *
 * The library index modules glob their JSON at build time under Vite (dev
 * server, production build). Plain-Node runners (tsx — scripts/export-sample.ts,
 * and vitest's node environment) have no glob transform available at runtime,
 * so they read the same files off disk here instead. Keys match the glob's
 * relative-path form ("./boards/rpi-4b.json") and are emitted in sorted order,
 * mirroring Vite.
 *
 * `process.getBuiltinModule` (Node ≥ 22.3) keeps this module free of static
 * `node:*` imports, so the browser bundle carries it as an inert no-op — in
 * the browser `hasNodeGlob()` is false and the Vite branch is taken.
 */

// Shadow the global so this file typechecks with AND without @types/node.
declare const process: { getBuiltinModule?: (id: string) => unknown } | undefined;

interface FsLike {
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
}
interface PathLike {
  join(...parts: string[]): string;
}
interface UrlLike {
  fileURLToPath(u: URL): string;
}

/** True when running under plain Node with built-in module access. */
export function hasNodeGlob(): boolean {
  return typeof process !== 'undefined' && typeof process?.getBuiltinModule === 'function';
}

/**
 * Read `<relDir>*.json` next to the calling module.
 *
 * @param baseUrl the caller's `import.meta.url`
 * @param relDir  directory relative to the caller, with trailing slash
 *                (e.g. "./boards/") — also used as the key prefix
 */
export function nodeGlobJson<T = unknown>(
  baseUrl: string,
  relDir: string,
): Record<string, { default: T }> {
  const get = typeof process !== 'undefined' ? process?.getBuiltinModule : undefined;
  if (!get) {
    throw new Error('nodeGlobJson requires Node >= 22.3 (process.getBuiltinModule)');
  }
  const fs = get('node:fs') as FsLike;
  const path = get('node:path') as PathLike;
  const url = get('node:url') as UrlLike;
  // Both args stay variables so Vite's asset-URL plugin leaves this alone.
  const dir = url.fileURLToPath(new URL(relDir, baseUrl));
  const out: Record<string, { default: T }> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    out[`${relDir}${f}`] = { default: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T };
  }
  return out;
}
