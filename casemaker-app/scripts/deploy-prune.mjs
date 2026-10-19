// Issue #546 — pure helpers for the cPanel deploy's asset pruning.
//
// The web deploy uploads each new hashed build into `casemaker/assets/` and
// never removed earlier builds, so ~200 builds (and their ~7.7 MB source maps
// each) accumulated to ~1.1 GB. These helpers decide, from file lists alone and
// without any network call, what the deploy keeps and what it deletes:
//
//   KEEP = every file the NEW build references
//        ∪ every file the PREVIOUS (v-1) build referenced   (so a browser that
//          still holds the previous index.html can finish loading its chunks)
//        ∪ a small always-keep set (the on-host build record itself).
//   DELETE = everything else currently in `assets/`.
//
// Source maps are excluded from the upload entirely (see isSourceMap), so they
// never enter a build's KEEP set and every `*.map` left on the host is pruned.
//
// Kept pure and dependency-free on purpose: scripts/deploy-cpanel.mjs wires
// these to the real host, and tests/unit/deployPrune.spec.ts exercises them.

/** A build's own on-host record of its asset filenames. Never hashed, so its
 *  name is stable across deploys; always in the KEEP set. */
export const BUILD_RECORD_NAME = 'build-manifest.json';

/** Source maps are never needed to serve the app, so the deploy neither uploads
 *  them nor keeps them. Matches `*.map` (e.g. `index-abc.js.map`, `x.css.map`). */
export function isSourceMap(relPath) {
  return /\.map$/i.test(String(relPath));
}

/** Normalise a walked relative path to forward slashes (the walk yields OS
 *  separators — backslashes on Windows). */
function norm(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Given the files walked from `dist/` (each `{ rel }`, rel relative to dist),
 * return the sorted set of basenames that live directly under `assets/`,
 * excluding source maps. This is the NEW build's complete asset file list: a
 * fresh build regenerates `dist/` wholesale, so everything under `dist/assets`
 * belongs to this build (entry + css + every lazy chunk + workers + wasm +
 * fonts). It is authoritative in a way that parsing index.html is not —
 * index.html lists only the entry, its modulepreloads and the css, never the
 * lazily-imported chunks.
 */
export function assetBasenames(distFiles) {
  const out = new Set();
  for (const f of distFiles) {
    const rel = norm(f.rel ?? f);
    if (!rel.startsWith('assets/')) continue;
    if (isSourceMap(rel)) continue;
    const name = rel.slice('assets/'.length);
    // Only files directly in assets/ (no nested subdirs today); if a nested
    // path ever appears, keep its full sub-path so it stays addressable.
    out.add(name);
  }
  return [...out].sort();
}

/** The JSON record this deploy writes to the host so the NEXT deploy knows what
 *  v-1 is. Shape is intentionally small and forward-compatible. */
export function buildRecord({ version, sha, assetNames, builtAt }) {
  return {
    schema: 1,
    version: version ?? null,
    sha: sha ?? null,
    builtAt: builtAt ?? new Date().toISOString(),
    assets: [...assetNames].sort(),
  };
}

/** Read an on-host record back into a flat name list, tolerant of a missing or
 *  malformed record (treated as "no previous build known"). */
export function assetsFromRecord(record) {
  if (!record || typeof record !== 'object' || !Array.isArray(record.assets)) return [];
  return record.assets.filter((n) => typeof n === 'string');
}

/**
 * Compute the prune plan for `assets/`.
 *
 * @param {object} p
 * @param {string[]} p.newAssetNames  basenames the NEW build references
 * @param {string[]} p.prevAssetNames basenames the PREVIOUS (v-1) build referenced
 * @param {{name:string,size?:number}[]} p.remoteAssets  files currently in assets/
 * @param {string[]} [p.alwaysKeep]   extra names never deleted (e.g. the record)
 * @returns {{ keepNames:string[], deleteList:{name:string,size:number}[],
 *             keepBytes:number, deleteBytes:number }}
 */
export function computePrune({ newAssetNames, prevAssetNames, remoteAssets, alwaysKeep = [] }) {
  const keep = new Set([
    ...newAssetNames,
    ...prevAssetNames,
    ...alwaysKeep,
    BUILD_RECORD_NAME,
  ]);
  const keepNames = [];
  const deleteList = [];
  let keepBytes = 0;
  let deleteBytes = 0;
  for (const entry of remoteAssets) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const size = (typeof entry === 'object' && Number.isFinite(entry.size)) ? entry.size : 0;
    if (keep.has(name)) {
      keepNames.push(name);
      keepBytes += size;
    } else {
      deleteList.push({ name, size });
      deleteBytes += size;
    }
  }
  keepNames.sort();
  deleteList.sort((a, b) => a.name.localeCompare(b.name));
  return { keepNames, deleteList, keepBytes, deleteBytes };
}
