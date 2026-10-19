// #546 — the deploy's prune maths. Pure, no host: given the NEW build's files,
// the PREVIOUS (v-1) build's files and a listing of what is in assets/ on the
// host, it must keep exactly current ∪ v-1 (∪ the record) and delete the rest,
// and it must never have let a source map into any build's file set.
import { describe, expect, it } from 'vitest';
import {
  BUILD_RECORD_NAME,
  isSourceMap,
  assetBasenames,
  buildRecord,
  assetsFromRecord,
  computePrune,
} from '../../scripts/deploy-prune.mjs';

describe('isSourceMap', () => {
  it('matches *.map and nothing else', () => {
    expect(isSourceMap('assets/index-abc.js.map')).toBe(true);
    expect(isSourceMap('assets/index-abc.css.map')).toBe(true);
    expect(isSourceMap('x.MAP')).toBe(true);
    expect(isSourceMap('assets/index-abc.js')).toBe(false);
    expect(isSourceMap('assets/manifold-x.wasm')).toBe(false);
    expect(isSourceMap('assets/roadmap-x.js')).toBe(false); // not ".map"
  });
});

describe('assetBasenames', () => {
  const walked = [
    { rel: 'index.html' },
    { rel: 'favicon.ico' },
    { rel: 'assets/index-AAA.js' },
    { rel: 'assets/index-AAA.js.map' }, // map — excluded
    { rel: 'assets/index-AAA.css' },
    { rel: 'assets/vendor-three-BBB.js' },
    { rel: 'assets/vendor-three-BBB.js.map' }, // map — excluded
    { rel: 'assets/geometry.worker-CCC.js' },
    { rel: 'assets/manifold-DDD.wasm' },
    { rel: 'board-assets/rpi-5/top.svg' }, // not under assets/
  ];

  it('returns only files directly under assets/, maps excluded, sorted', () => {
    expect(assetBasenames(walked)).toEqual([
      'geometry.worker-CCC.js',
      'index-AAA.css',
      'index-AAA.js',
      'manifold-DDD.wasm',
      'vendor-three-BBB.js',
    ]);
  });

  it('normalises Windows backslash separators', () => {
    expect(assetBasenames([{ rel: 'assets\\index-Z.js' }])).toEqual(['index-Z.js']);
  });

  it('accepts bare string entries', () => {
    expect(assetBasenames(['assets/a-1.js', 'assets/a-1.js.map'])).toEqual(['a-1.js']);
  });
});

describe('buildRecord / assetsFromRecord', () => {
  it('round-trips the asset list and sorts it', () => {
    const rec = buildRecord({ version: '1.2.3', sha: 'deadbee', assetNames: ['b.js', 'a.js'] });
    expect(rec.schema).toBe(1);
    expect(rec.version).toBe('1.2.3');
    expect(rec.assets).toEqual(['a.js', 'b.js']);
    expect(assetsFromRecord(rec)).toEqual(['a.js', 'b.js']);
  });

  it('treats a missing or malformed record as no previous build', () => {
    expect(assetsFromRecord(null)).toEqual([]);
    expect(assetsFromRecord(undefined)).toEqual([]);
    expect(assetsFromRecord({})).toEqual([]);
    expect(assetsFromRecord({ assets: 'nope' })).toEqual([]);
    expect(assetsFromRecord({ assets: ['ok.js', 42, null] })).toEqual(['ok.js']);
  });
});

describe('computePrune', () => {
  // New build references v2 files; v-1 referenced v1 files. The host also holds
  // two older builds (v0) plus a pile of source maps and the record file.
  const newAssetNames = ['index-V2.js', 'index-V2.css', 'vendor-three-V2.js', 'manifold-V2.wasm'];
  const prevAssetNames = ['index-V1.js', 'index-V1.css', 'vendor-three-V1.js', 'manifold-V2.wasm'];
  const remoteAssets = [
    // current (v2)
    { name: 'index-V2.js', size: 1_000 },
    { name: 'index-V2.css', size: 200 },
    { name: 'vendor-three-V2.js', size: 5_000 },
    { name: 'manifold-V2.wasm', size: 9_000 }, // shared with v-1, listed once
    // previous (v-1)
    { name: 'index-V1.js', size: 1_100 },
    { name: 'index-V1.css', size: 210 },
    { name: 'vendor-three-V1.js', size: 5_100 },
    // ancient (v0) — must be deleted
    { name: 'index-V0.js', size: 1_200 },
    { name: 'index-V0.css', size: 220 },
    { name: 'vendor-three-V0.js', size: 5_200 },
    // stray source maps from old deploys — must be deleted
    { name: 'index-V1.js.map', size: 7_700_000 },
    { name: 'index-V0.js.map', size: 7_700_000 },
    { name: 'vendor-three-V2.js.map', size: 7_700_000 },
    // the on-host build record — always kept
    { name: BUILD_RECORD_NAME, size: 300 },
  ];

  const plan = computePrune({ newAssetNames, prevAssetNames, remoteAssets });

  it('keeps every current and every v-1 file', () => {
    for (const n of [...newAssetNames, ...prevAssetNames]) {
      expect(plan.keepNames).toContain(n);
    }
  });

  it('never deletes a current or v-1 file', () => {
    const deleted = new Set(plan.deleteList.map((d) => d.name));
    for (const n of [...newAssetNames, ...prevAssetNames]) {
      expect(deleted.has(n)).toBe(false);
    }
  });

  it('keeps the build record', () => {
    expect(plan.keepNames).toContain(BUILD_RECORD_NAME);
  });

  it('deletes exactly the ancient build and every stray source map', () => {
    expect(plan.deleteList.map((d) => d.name)).toEqual([
      'index-V0.css',
      'index-V0.js',
      'index-V0.js.map',
      'index-V1.js.map',
      'vendor-three-V0.js',
      'vendor-three-V2.js.map',
    ]);
  });

  it('reports the freed byte total (the three maps dominate)', () => {
    expect(plan.deleteBytes).toBe(220 + 1_200 + 7_700_000 + 7_700_000 + 5_200 + 7_700_000);
  });

  it('counts a shared file (manifold) once on the keep side', () => {
    expect(plan.keepNames.filter((n) => n === 'manifold-V2.wasm')).toHaveLength(1);
  });

  it('honours an explicit alwaysKeep list', () => {
    const p = computePrune({
      newAssetNames: ['a.js'],
      prevAssetNames: [],
      remoteAssets: [{ name: 'a.js' }, { name: 'keepme.txt' }, { name: 'gone.js' }],
      alwaysKeep: ['keepme.txt'],
    });
    expect(p.keepNames.sort()).toEqual(['a.js', 'keepme.txt']);
    expect(p.deleteList.map((d) => d.name)).toEqual(['gone.js']);
  });

  it('with no previous build known, keeps only the new build (first pruned run)', () => {
    const p = computePrune({
      newAssetNames: ['index-V2.js'],
      prevAssetNames: [],
      remoteAssets: [
        { name: 'index-V2.js', size: 1 },
        { name: 'index-V1.js', size: 1 },
        { name: 'index-V0.js', size: 1 },
      ],
    });
    expect(p.keepNames).toEqual(['index-V2.js']);
    expect(p.deleteList.map((d) => d.name)).toEqual(['index-V0.js', 'index-V1.js']);
  });
});
