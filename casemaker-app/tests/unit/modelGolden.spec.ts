/**
 * #964 — GOLDEN PINS FOR THE REBUILT ENGINE'S PROGRAMS.
 *
 * Empty until the CAM rebuild posts its first accepted programs (#957–#966). The list is
 * deliberately empty rather than absent: the contract is stated now so every engine slice lands
 * with its own pin in the same reviewed act, and the spec that compares a pin against a fresh
 * generation is written with the engine, not this scaffold.
 *
 * Each case, when it exists, lives under `fixtures/golden/model/<id>/` with the same artefacts as
 * the 10-24 badge pins (`program.nc.sha256`, `verifier.json`) plus `estimate.json` (#927's cycle
 * terms and the program facts the seven-line scorer reads) and `card.json` (the seven lines as
 * `tests/tools/seven-lines.ts` prints them). The manifest names the job and the goal mesh's
 * sha256; the mesh itself stays a local input, injected by sha like `samples/3d`.
 *
 * Regeneration is a deliberate act: `CASEMAKER_UPDATE_GOLDEN=1 npx vitest run
 * tests/unit/modelGolden.spec.ts`, with a landing note naming which artefact moved and why.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'golden', 'model');
const MANIFEST = join(GOLDEN, 'manifest.json');

interface ModelGoldenCase {
  /** The pin directory's name. */
  id: string;
  /** The job the pin was generated from, relative to the repository root. */
  job: string;
  /** The goal mesh's sha256 (the mesh is a local input, never committed). */
  meshSha256: string;
  /** What the program is, in words. */
  note?: string;
}

interface ModelGoldenManifest {
  version: number;
  note: string;
  cases: ModelGoldenCase[];
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ModelGoldenManifest;

describe('#964 golden pins for the rebuilt engine’s programs', () => {
  it('the pin list parses, and every case names the job and the mesh it was cut from', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.note).toContain('rebuilt engine');
    for (const c of manifest.cases) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.job.length).toBeGreaterThan(0);
      expect(c.meshSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.skipIf(manifest.cases.length === 0)(
    'every pinned program carries the four artefacts the contract names',
    () => {
      for (const c of manifest.cases) {
        const dir = join(GOLDEN, c.id);
        expect(existsSync(dir)).toBe(true);
        // The hash pin, in the engrave-golden format: `sha256 <hash> (<bytes> bytes)`.
        const pin = readFileSync(join(dir, 'program.nc.sha256'), 'utf8').trim();
        expect(pin).toMatch(/^sha256 [0-9a-f]{64} \(\d+ bytes\)$/);
        // The verifier's own report on that text.
        expect(existsSync(join(dir, 'verifier.json'))).toBe(true);
        // #927's terms and the program facts, as the seven-line scorer reads them.
        const estimate = JSON.parse(readFileSync(join(dir, 'estimate.json'), 'utf8')) as {
          cycleSeconds: number;
          rapidsPer1000FeedLines: number;
          cutters: number;
        };
        expect(estimate.cycleSeconds).toBeGreaterThan(0);
        expect(estimate.rapidsPer1000FeedLines).toBeGreaterThanOrEqual(0);
        expect(estimate.cutters).toBeGreaterThan(0);
        // The card's seven lines, as the page prints them.
        const card = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')) as { lines: unknown[] };
        expect(card.lines).toHaveLength(7);
      }
    },
  );

  it.skipIf(manifest.cases.length === 0)('no case directory is unlisted', () => {
    const listed = new Set(manifest.cases.map((c) => c.id));
    const dirs = readdirSync(GOLDEN, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.filter((d) => !listed.has(d))).toEqual([]);
  });

  it.skipIf(manifest.cases.length > 0)('states why the list is empty (the engine has not posted)', () => {
    expect(manifest.cases).toEqual([]);
    expect(manifest.note).toContain('Empty until');
  });
});
