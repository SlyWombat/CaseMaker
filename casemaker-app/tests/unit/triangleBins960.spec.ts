/**
 * #960 — THE TRIANGLE BIN, RED-FIRST ON THE TRAY MESH.
 *
 * `reachableTriangles` scans every triangle on every drop-cutter query; the bin answers the same
 * question from a grid. The contract checked here is EXACT: at every sampled point the binned
 * query returns the same triangle SET as the brute scan — so any height computed from it (the
 * drop-cutter's own max over per-triangle contributions) is identical by construction — at least
 * 10× the speed.
 *
 * The mesh is the tray's own STL (`.scratch/makerables`, CC BY-NC-SA, evaluation only — the
 * committed artefact is the contract and its numbers, never the data). Skipped when the file is
 * absent or its sha256 has moved.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { reachableTriangles, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';
import { binnedReachableTriangles, buildTriangleBins } from '@/engine/cnc/cam/model/triangleBins';

const ROOT = process.env.CM_MAKERABLES ?? path.resolve(process.cwd(), '..', '.scratch/makerables');
const STL = path.join(ROOT, 'dl', 'modular-stackable-tool-trays', '70mm_Tool_Tray-msgtf7oi.stl');
const SHA = 'f89683c8aaad50fb80c6553e4eed83fb7649c2d505650a5fa4e2529c969c203f';

/** A binary STL as the drop-cutter's mesh: positions + one index per vertex, three per triangle. */
function binaryStl(file: string): DropCutterMesh {
  const buf = readFileSync(file);
  const count = buf.readUInt32LE(80);
  const positions = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  let at = 84;
  for (let t = 0; t < count; t++) {
    at += 12; // the facet normal
    for (let v = 0; v < 3; v++) {
      positions[(t * 3 + v) * 3] = buf.readFloatLE(at);
      positions[(t * 3 + v) * 3 + 1] = buf.readFloatLE(at + 4);
      positions[(t * 3 + v) * 3 + 2] = buf.readFloatLE(at + 8);
      indices[t * 3 + v] = t * 3 + v;
      at += 12;
    }
    at += 2; // attribute byte count
  }
  return { positions, indices, triangleCount: count };
}

const usable = existsSync(STL) && createHash('sha256').update(readFileSync(STL)).digest('hex') === SHA;
const maybe = usable ? it : it.skip;

maybe('answers the drop-cutter’s query exactly, at least 10× faster than the full scan', () => {
  const mesh = binaryStl(STL);
  const bins = buildTriangleBins(mesh);
  // A deterministic sample over the mesh's own XY bbox, at a typical 3 mm cutter radius.
  const minX = Math.min(...Array.from({ length: mesh.triangleCount }, (_, t) => mesh.positions[t * 9]!));
  const maxX = Math.max(...Array.from({ length: mesh.triangleCount }, (_, t) => mesh.positions[t * 9]!));
  const minY = Math.min(...Array.from({ length: mesh.triangleCount }, (_, t) => mesh.positions[t * 9 + 1]!));
  const maxY = Math.max(...Array.from({ length: mesh.triangleCount }, (_, t) => mesh.positions[t * 9 + 1]!));
  const R = 3;
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const points: [number, number][] = [];
  for (let i = 0; i < 400; i++) points.push([minX + (maxX - minX) * rand(), minY + (maxY - minY) * rand()]);

  // EXACT SET EQUALITY at every sampled point.
  for (const [x, y] of points) {
    const brute = reachableTriangles(mesh, x, y, R).sort((a, b) => a - b);
    const binned = binnedReachableTriangles(bins, x, y, R).sort((a, b) => a - b);
    expect(binned).toEqual(brute);
  }

  // SPEED: the same query over a larger sample, brute scan versus bins.
  const many: [number, number][] = [];
  for (let i = 0; i < 3000; i++) many.push([minX + (maxX - minX) * rand(), minY + (maxY - minY) * rand()]);
  let sink = 0;
  const t0 = performance.now();
  for (const [x, y] of many) sink += reachableTriangles(mesh, x, y, R).length;
  const bruteMs = performance.now() - t0;
  const t1 = performance.now();
  for (const [x, y] of many) sink += binnedReachableTriangles(bins, x, y, R).length;
  const binnedMs = performance.now() - t1;
  expect(sink).toBeGreaterThan(0);
  const speedup = bruteMs / Math.max(binnedMs, 1e-6);
  console.log(`triangle bins: ${mesh.triangleCount} triangles, ${bins.nx}x${bins.ny} cells of ${bins.cellMm.toFixed(2)} mm; brute ${bruteMs.toFixed(1)} ms vs binned ${binnedMs.toFixed(1)} ms — ${speedup.toFixed(1)}x`);
  expect(speedup).toBeGreaterThanOrEqual(10);
}, 120_000);
