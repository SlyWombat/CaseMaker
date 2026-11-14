/**
 * #1258 — THE REAL PATH, END TO END: `casemaker cut` on a goal job whose freeing contour cannot meet
 * both tab rules, through the measured pick and `engraveGenerate`.
 *
 *   - no flag    → the run STOPS with `tab-choice-needed` and the question's sentence — never
 *                  `invalid-job` ("no plan the search tried can post"), which is what the pick used
 *                  to turn the question into;
 *   - each flag  → programs are posted and the run sheet carries the tab sentences.
 *
 * The block is a 27 × 10 × 10 body (walls drafted 1 mm) on a 60 × 40 blank with the shop's span limit at 10 mm: its four
 * edges each hold one tab and the stretches between them stay over the limit (no tab fits in them).
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import type { Receipt } from '../../src/platform/headless/receipt';
import type { EngraveJob, EngraveTargetObject } from '../../src/types/engraveJob';
import { stl, type MeshTri } from './helpers/meshes';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETB = join(HERE, 'fixtures', 'giraffe-1155', 'setb');
const NOW = new Date('2026-11-13T12:00:00.000Z');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-tab-choice-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** The committed Set B shop (owned flats and balls with feeds) with its span limit moved to the registry's lowest, 10 mm. */
function location(): string {
  const doc = JSON.parse(readFileSync(join(SETB, 'location.json'), 'utf8')) as { defaults: Record<string, Record<string, unknown>> };
  doc.defaults['tabs.maxSpanMm'] = {
    value: 10,
    source: 'chosen',
    setAt: '2026-11-13T12:00:00.000Z',
    unit: 'mm',
    note: 'chosen for this spec: the lowest span limit the registry allows',
  };
  const path = join(SCRATCH, 'location.json');
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}

function boxTarget(): EngraveTargetObject {
  const [w, d, h] = [27, 10, 10];
  const v: [number, number, number][] = [
    [1, 1, 0], [w - 1, 1, 0], [w - 1, d - 1, 0], [1, d - 1, 0],
    [0, 0, -h], [w, 0, -h], [w, d, -h], [0, d, -h],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const tris: MeshTri[] = faces.map((f) => [v[f[0]]!, v[f[1]]!, v[f[2]]!]);
  return {
    id: 'goal-1258',
    name: 'block-1258.stl',
    format: 'stl',
    sha256: 'e'.repeat(64),
    data: stl(tris),
    size: { x: w, y: d, z: h },
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function job(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, length: 60, width: 40, thickness: 10, material: 'hardwood' },
    targetObject: boxTarget(),
  };
}

interface Run {
  code: number;
  receipt: Receipt;
  outDir: string;
  progress: string[];
}

async function cut(name: string, flag: string[]): Promise<Run> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job(), null, 2) + '\n');
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = { json: true, now: NOW, sink: { progress: (line) => progress.push(line), receipt: (r) => { receipt = r; } } };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', location(), '--catalogue', join(SETB, 'catalogue.json'), ...flag], options);
  return { code, receipt: receipt!, outDir, progress };
}

const sheetText = (outDir: string): string =>
  readdirSync(outDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(outDir, f), 'utf8'))
    .join('\n');

describe('#1258 casemaker cut, flag to planner', () => {
  it('no flag: stops with tab-choice-needed and the question — not invalid-job', async () => {
    const run = await cut('ask', []);
    expect(run.code).not.toBe(0);
    const codes = run.receipt.refusals.map((r) => r.code);
    expect(codes).toContain('tab-choice-needed');
    expect(codes).not.toContain('invalid-job');
    const reason = run.receipt.refusals.find((r) => r.code === 'tab-choice-needed')!.reason;
    expect(reason).toContain("This part can't be held within both of the shop's tab rules");
    expect(reason).toContain('--tab-choice inside-margin');
    expect(reason).toContain('--tab-choice longer-stretch');
    // CONDITION 1: the pick measured under a provisional answer — and its plan was NOT handed to the cut.
    const said = run.progress.join('\n');
    expect(said).toContain('the pick ranked the cutters under a provisional tab answer');
    expect(said).not.toContain("the pick's plan reused");
  }, 300_000);

  for (const [flag, sentence] of [
    ['inside-margin', /of the outline has no tab and no tab fits there; the shop's limit is 10 mm\./],
    ['longer-stretch', /of the outline has no tab; the shop's limit is 10 mm — the operator's choice\./],
  ] as const) {
    it(`--tab-choice ${flag}: programs are posted and the sheet says what was done`, async () => {
      const run = await cut(flag, ['--tab-choice', flag]);
      expect(run.receipt.refusals.map((r) => r.code), JSON.stringify(run.receipt.refusals)).toEqual([]);
      expect(run.code).toBe(0);
      expect((run.receipt.details as { programs: unknown[] }).programs.length).toBeGreaterThan(0);
      expect(sheetText(run.outDir)).toMatch(sentence);
      // CONDITION 1, the other half: under a real answer the pick's measured plan IS the cut's plan
      // (reused), and nothing was ranked under an assumed one.
      const said = run.progress.join('\n');
      expect(said).toContain("the pick's plan reused");
      expect(said).not.toContain('provisional tab answer');
    }, 300_000);
  }
});
