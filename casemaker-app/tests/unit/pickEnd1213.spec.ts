/**
 * #1213 follow-up — THE PICK FAMILY CLOSES WHEN THE SEARCH REFUSES.
 *
 * `smartPick` writes `pick:start` before it looks at the candidate list; when the list is empty it
 * returns the refusal WITHOUT a `pick:end`. The app's worker never sees it (`runSmartPick`
 * pre-checks the candidate list before calling the search), but the CLI calls the search directly,
 * so every CLI run whose search refuses leaves an OPEN pick family in the `--mem-trace` file:
 * `pick: runs 1 coarse 0 full 0`, no candidates, and `plan-counts` prints `incomplete yes` on a
 * run that stopped where it meant to (D's tray-bottom trace).
 *
 * A refusal is a COMPLETED pick — it decided no candidate can be tried. It must close the family
 * with the same row the app path writes (`evaluated`, `postings`), so a reader can tell "the
 * search refused" from "the run died mid-search".
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { parseTrace, summarizeTrace } from '../../tools/plan-counts/summarize';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { smartPick, type Evaluate } from '@/engine/cnc/engrave/smartPick';
import { setMemTraceSink } from '@/engine/cnc/memTrace';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { notchedPlate } from './helpers/meshes';

function entry(key: string, shape: ToolShape, over: Partial<Tool> = {}): ToolLibraryEntry {
  return {
    key,
    provenance: 'test',
    tool: {
      number: null,
      id: null,
      name: key,
      typeText: '',
      shape,
      handleDiameter: 3.175,
      tipDiameter: null,
      diameter: null,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
      ...over,
    },
  };
}

// The shape gate refuses these before any evaluation: a goal is ball work, and these are flats.
const FLAT_2 = entry('inv:flat-2', 'flat', { tipDiameter: 2, diameter: 2, fluteLength: 12 });
const FLAT_1 = entry('inv:flat-1', 'flat', { tipDiameter: 1, diameter: 1, fluteLength: 7 });

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-pick-end',
    name: 'notched plate',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 },
    rotation: 0,
    size: { x: 20, y: 10, z: 5 },
  } as EngraveTargetObject;
}

/** A pure goal that names no cutter: the search runs, and finds no ball to try. */
function goalJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'pick-end job',
    labels: [],
    shapes: [],
    combined: [],
    traces: [],
    vectors: [],
    targetObject: goalTarget(),
    toolKey: '',
    tool: undefined,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

describe('#1213 follow-up — a refusing pick closes its family', () => {
  it('smartPick writes pick:end with its counts when there is no candidate', async () => {
    const rows: string[] = [];
    setMemTraceSink((line) => rows.push(line));
    let pick;
    try {
      const evaluate: Evaluate = () => {
        throw new Error('a refused search evaluates nothing');
      };
      pick = await smartPick(goalJob(), [FLAT_2, FLAT_1], [], evaluate);
    } finally {
      setMemTraceSink(null);
    }
    expect(pick.refused).toBe(true);
    const stages = parseTrace(rows.join('')).map((r) => r.stage);
    expect(stages).toContain('pick:start');
    expect(stages).toContain('pick:end');
    const end = parseTrace(rows.join('')).find((r) => r.stage === 'pick:end')!;
    expect(end.evaluated).toBe(0);
    expect(end.postings).toBe(0);
    const counts = summarizeTrace(parseTrace(rows.join('')));
    expect(counts.pick).toEqual({ runs: 1, coarse: 0, full: 0, wallMs: counts.pick.wallMs });
    expect(counts.incomplete).toBe(false);
  });

  it('a CLI trace of the refusing search reads incomplete no', async () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const LOCATION = join(HERE, '..', '..', 'tests', 'unit', 'fixtures', 'location-doc.json');
    const scratch = mkdtempSync(join(tmpdir(), 'casemaker-pick-end-'));
    const jobPath = join(scratch, 'job.json');
    writeFileSync(jobPath, JSON.stringify(goalJob(), null, 2) + '\n');
    const tracePath = join(scratch, 'mem.jsonl');
    const silent = { json: true, now: new Date('2026-11-12T12:00:00.000Z') } as const;

    // The location holds two flat cutters and the goal needs a ball: the search refuses.
    const code = await engraveJobMain(
      [jobPath, '--out', join(scratch, 'out'), '--location', LOCATION, '--mem-trace', tracePath],
      silent,
    );
    expect(code).not.toBe(0);

    const rows = parseTrace(readFileSync(tracePath, 'utf8'));
    const stages = rows.map((r) => r.stage);
    expect(stages).toContain('pick:start');
    expect(stages).toContain('pick:end');
    const counts = summarizeTrace(rows);
    expect(counts.pick.runs).toBe(1);
    expect(counts.pick.coarse).toBe(0);
    expect(counts.pick.full).toBe(0);
    expect(counts.incomplete).toBe(false);
  }, 120_000);
});
