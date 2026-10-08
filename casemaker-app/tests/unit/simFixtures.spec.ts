// The committed simulation fixtures (#199): `three-strokes.nc` and its deliberate-gouge twin.
// The vendor corpus is fetched, never committed (#186), so a browser run has nothing to open —
// these two files are ours and are what `tests/e2e/simulation.spec.ts` drives in the app.
//
// This spec is what keeps them honest: it loads each file through the same headless session the
// worker uses (`createSimSession`, as `simSession.spec.ts` does), deriving the setup from the
// file's own `;@MKR` header, and pins the numbers the e2e test then asserts on. If the sweep
// changes, the fixture stops meeting these expectations here rather than as a red browser run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { capsuleArea } from '@/workers/geometry/sweep';
import { parseGcode, setupFromHeader, stubSetup, Z1, resolveTool, type Setup } from '@/engine/cnc';
import { toolFromMkrRecord, type Tool } from '@/engine/cnc/tool';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** The fixture's stated tool: a 3.175 mm flat end mill, so the sweep radius is half that. */
const R = 3.175 / 2;
const N = segmentsForRadius(R);
/** The three strokes are 40 mm long and 0.5, 1 and 2 mm deep: depth sum 3.5. */
const DEPTH_SUM = 0.5 + 1 + 2;
/** 472.097 mm³, the figure the issue records for both files. */
const EXPECTED_REMOVED = capsuleArea(40, R, N) * DEPTH_SUM;

/** Volume of a closed triangle mesh, about its bbox centre to keep float32 error down. */
function meshVolume(m: NodeMeshOutput): number {
  const c = [0, 1, 2].map((i) => ((m.bbox.min[i] as number) + (m.bbox.max[i] as number)) / 2);
  const p = (i: number) => [0, 1, 2].map((a) => (m.positions[i * 3 + a] as number) - (c[a] as number));
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = p(m.indices[t] as number);
    const b = p(m.indices[t + 1] as number);
    const d = p(m.indices[t + 2] as number);
    v += (a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - a[1]! * (b[0]! * d[2]! - b[2]! * d[0]!) + a[2]! * (b[0]! * d[1]! - b[1]! * d[0]!));
  }
  return v / 6;
}

/** What the file itself says to cut with, read from its header exactly as the app reads it. */
function fixtureTool(text: string): Tool {
  const rec = parseGcode(text).header?.records.find((r) => r.tag === 'TOOL');
  if (!rec) throw new Error('fixture has no TOOL record');
  return toolFromMkrRecord(rec);
}

/**
 * Load a fixture the way the app does: `setupFromHeader` reads the UNTRUSTED `;@MKR` header and
 * prefills the stock, the picker's chosen tool is the header's, and the machine is the Z1 the
 * `MACHINE` record names. The stock dimensions are asserted first, because everything downstream
 * rests on them.
 */
function loadFixture(name: string, startingTool: Setup['startingTool'] = 1) {
  const text = readFixture(name);
  const header = setupFromHeader(parseGcode(text).header);
  const part = header.patch.part;
  if (!part || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
    throw new Error(`fixture ${name} did not prefill a cuboid stock`);
  }
  expect(part.outline.size).toEqual([60, 30]);
  expect(part.thickness).toBe(6);
  const setup: Setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool }, Z1);
  const session = createSimSession(tl);
  const r = session.load(text, setup, fixtureTool(text), Z1.id);
  return { session, r, text };
}

const errorCodes = (r: SimLoadOk): string[] =>
  r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

describe('#199 fixture: three-strokes.nc is three strokes, nothing else', () => {
  it('the closed form the spec derives is the 472.097 mm³ the issue records', () => {
    // The tests below compare the sweep against EXPECTED_REMOVED, so pin the derived figure here:
    // if `capsuleArea`/`segmentsForRadius` move, this fails at the recorded number, not silently.
    expect(EXPECTED_REMOVED).toBeCloseTo(472.097, 2);
  });

  it('the header prefills the 60 x 30 x 6 stock the issue names', () => {
    const header = setupFromHeader(parseGcode(readFixture('three-strokes.nc')).header);
    expect(header.patch.part).toEqual({
      kind: 'prism',
      outline: { kind: 'p-rect', size: [60, 30] },
      thickness: 6,
    });
    // 60 x 30 is not square, so the axes-unverified warning is expected — the header is honest.
    expect(header.diagnostics.map((d) => d.code)).toContain('stock-axes-unverified');
    expect(header.workOrigin).toEqual({ corner: 'top-front-left', source: 'header' });
  });

  it('loads as 3 checkpoints, zero errors, 472.097 mm³ removed', () => {
    const { session, r } = loadFixture('three-strokes.nc');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.count).toBe(3);
    expect(errorCodes(r)).toEqual([]);
    expect(r.meshes.gouges).toEqual([]);
    expect(r.stats.removedVolume / EXPECTED_REMOVED).toBeCloseTo(1, 2); // within 0.5 %
    // The meshes agree with the sweep's own total, so the volume is not just a number in stats.
    expect(Math.abs(meshVolume(r.meshes.stock) - meshVolume(r.meshes.result) - r.stats.removedVolume)).toBeLessThan(1);
    session.dispose();
  });

  it('counts 3 whatever the machine\'s starting tool — the app default is "unknown"', () => {
    // `setup.ts`'s StartingTool cannot come from the file. The app's e2e path uses the default
    // 'unknown', so all three must give the same 3 checkpoints and volume; the issue records this.
    for (const startingTool of ['unknown', 1, -1] as const) {
      const { session, r } = loadFixture('three-strokes.nc', startingTool);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
      expect(r.count).toBe(3);
      expect(errorCodes(r)).toEqual([]);
      expect(r.stats.removedVolume / EXPECTED_REMOVED).toBeCloseTo(1, 2);
      session.dispose();
    }
  });

  it('the tool is the header 3.175 flat, and it matches the library entry the picker picks', () => {
    const tool = fixtureTool(readFixture('three-strokes.nc'));
    expect(tool.shape).toBe('flat');
    expect(tool.tipDiameter).toBe(3.175);
    expect(tool.diameter).toBe(3.175);
    const lib = resolveTool('flat-3.175x12-metal');
    expect(lib).not.toBeNull();
    expect(lib?.tipDiameter).toBe(tool.tipDiameter);
    expect(lib?.shape).toBe(tool.shape);
  });
});

describe('#199 fixture: three-strokes-gouge.nc is a drawn gouge, not a cut', () => {
  it('loads the same 3 checkpoints and 472.097 mm³ as the clean file', () => {
    const { session, r } = loadFixture('three-strokes-gouge.nc');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.count).toBe(3);
    expect(r.stats.removedVolume / EXPECTED_REMOVED).toBeCloseTo(1, 2);
    expect(Math.abs(meshVolume(r.meshes.stock) - meshVolume(r.meshes.result) - r.stats.removedVolume)).toBeLessThan(1);
    session.dispose();
  });

  it('carries exactly one rapid-through-stock error and one gouge mesh', () => {
    const { session, r } = loadFixture('three-strokes-gouge.nc');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(errorCodes(r)).toEqual(['rapid-through-stock']);
    expect(r.meshes.gouges).toHaveLength(1);
    expect(meshVolume(r.meshes.gouges[0]!.mesh)).toBeGreaterThan(0);
    session.dispose();
  });

  it('the gouge removed no material: its volume equals the clean file\'s from the same sweep', () => {
    const clean = loadFixture('three-strokes.nc');
    const gouge = loadFixture('three-strokes-gouge.nc');
    expect(clean.r.ok && gouge.r.ok).toBe(true);
    if (!clean.r.ok || !gouge.r.ok) throw new Error('one of the fixtures failed to load');
    expect(gouge.r.stats.removedVolume).toBeCloseTo(clean.r.stats.removedVolume, 6);
    // And the final stock is the same shape: the gouge is drawn, never subtracted.
    expect(meshVolume(gouge.r.meshes.result)).toBeCloseTo(meshVolume(clean.r.meshes.result), 4);
    clean.session.dispose();
    gouge.session.dispose();
  });

  it('at the app default startingTool "unknown" — what the e2e opens it with — it reads the same', () => {
    // Deliverable 5 (the e2e) opens the gouge with the app default, not the file's T1. If the two
    // disagreed the browser run would fail where this spec is silent, so pin the default too.
    const { session, r } = loadFixture('three-strokes-gouge.nc', 'unknown');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    expect(r.count).toBe(3);
    expect(errorCodes(r)).toEqual(['rapid-through-stock']);
    expect(r.meshes.gouges).toHaveLength(1);
    expect(meshVolume(r.meshes.gouges[0]!.mesh)).toBeGreaterThan(0);
    expect(r.stats.removedVolume / EXPECTED_REMOVED).toBeCloseTo(1, 2);
    session.dispose();
  });
});
