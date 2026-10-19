// Types for `deploy-prune.mjs` (#546), which `tests/unit/deployPrune.spec.ts` imports directly.
// The module is plain ESM so `node` runs it from the deploy script with no build step; a
// TypeScript importer would otherwise see an implicit `any` (TS7016). Same pattern as
// `tools/z1/benchDefaults.d.mts`.

export const BUILD_RECORD_NAME: string;

export function isSourceMap(relPath: string): boolean;

export function assetBasenames(distFiles: Array<{ rel?: string } | string>): string[];

export interface BuildRecord {
  schema: number;
  version: string | null;
  sha: string | null;
  builtAt: string;
  assets: string[];
}

export function buildRecord(opts: {
  version?: string | null;
  sha?: string | null;
  assetNames: string[];
  builtAt?: string;
}): BuildRecord;

export function assetsFromRecord(record: unknown): string[];

export interface RemoteAsset {
  name: string;
  size?: number;
}

export interface PrunePlan {
  keepNames: string[];
  deleteList: Array<{ name: string; size: number }>;
  keepBytes: number;
  deleteBytes: number;
}

export function computePrune(opts: {
  newAssetNames: string[];
  prevAssetNames: string[];
  remoteAssets: Array<RemoteAsset | string>;
  alwaysKeep?: string[];
}): PrunePlan;
