/**
 * #1079 — §1 NAMES THE CUTTER THE POSTED PROGRAMS RUN, OR IT NAMES NONE.
 *
 * The toolholder card's sheet said "⌀ 1.5 mm ball · 8 mm flute" while program 1's NC runs a
 * 6*22 mm flat (`;@CM|TOOL|key=inv:lib-111031605022`). The job names no cutter (`toolKey` is
 * empty), the posted key did not resolve to a name in that build's library, and §1 fell back to
 * `jobTool(job)` — the picked cutter's snapshot — so it printed a bit no program runs.
 *
 * The rule: when the job names no cutter, §1 takes its cutter(s) from the POSTED programs and
 * nothing else — the single posted cutter by name when the key resolves, every program's cutter
 * listed when several run, and NO name (the NC header's own tool line is the reference) when the
 * key cannot be resolved. A named job's line and its #1070 override are unchanged.
 *
 * RED at 0c1d3cfc6: the fallback prints the snapshot's 1.5 ball for an empty-key job, an unnamed
 * program key and a multi-cutter run alike.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet, type RunSheetGenerated, type RunSheetProgram } from '@/engine/cnc/engrave/runSheet';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-11-08T12:00:00Z');

const FLAT6: Tool = flatEndMill(6, { fluteLength: 22 });
const FLAT3: Tool = flatEndMill(3, { fluteLength: 12 });
/** The picked cutter's snapshot the old sheet printed: a ⌀1.5 × 8 ball no program runs. */
const PICK: Tool = flatEndMill(1.5, { name: '1.5 mm ball', shape: 'ball', typeText: 'Ball Nose', fluteLength: 8 });

beforeEach(() => {
  setRegistry([
    { key: 'inv:lib-flat-6', tool: FLAT6, provenance: 'spec' },
    { key: 'inv:lib-flat-3', tool: FLAT3, provenance: 'spec' },
  ]);
});
afterEach(() => resetRegistry());

function jobWith(toolKey: string, snapshot?: Tool): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, toolKey, ...(snapshot === undefined ? {} : { tool: snapshot }) };
}

function program(setupIndex: number, toolKey: string, nc: string): RunSheetProgram {
  return { kind: 'engrave', setupIndex, toolKey, nc, frameNc: null, cam: null };
}

/** §1's cutter step for a job and its posted programs. */
function cutterStep(job: EngraveJob, programs: RunSheetProgram[]): { text: string; value?: string } {
  const generated: RunSheetGenerated = {
    findings: [],
    feeds: null,
    cam: null,
    nc: programs[0]?.nc ?? 'job.nc',
    verify: null,
    frameNc: null,
    programs,
  };
  const sheet = buildRunSheet(job, generated, { diagnostics: [] }, NOW);
  const need = sheet.sections.find((s) => s.id === 'need');
  expect(need, 'the sheet has its need section').toBeTruthy();
  const step = need!.steps.find((s) => s.text.startsWith('The cutter'));
  expect(step, '§1 states the cutter').toBeTruthy();
  return step!;
}

describe('#1079 §1 never names a cutter the programs do not run', () => {
  it('an empty-key job with an unresolved posted key names NO cutter — not the pick’s snapshot', () => {
    // The toolholder shape: the job's key is empty, its snapshot is the pick's ball, and the
    // posted program's key is not in this build's library.
    const step = cutterStep(jobWith('', PICK), [program(1, 'inv:lib-not-in-this-library', 'job.nc')]);
    expect(step.text).not.toContain('1.5');
    expect(step.text).not.toContain('ball');
    expect(step.text).toContain('NC header');
    expect(step.value).toBe('cutting diameter unknown');
  });

  it('an empty-key job with a resolvable single posted cutter NAMES it, with the #1070 suffix', () => {
    const step = cutterStep(jobWith('', PICK), [program(1, 'inv:lib-flat-6', 'job.nc')]);
    expect(step.text).toContain('⌀ 6 mm flat end');
    expect(step.text).toContain('the cutter the posted programs run');
    expect(step.text).not.toContain('1.5');
    expect(step.value).toBe('⌀ 6 mm cutting');
  });

  it('an empty-key job whose programs carry no key names no cutter either', () => {
    const step = cutterStep(jobWith('', PICK), [program(1, '', 'job.nc')]);
    expect(step.text).not.toContain('1.5');
    expect(step.text).toContain('NC header');
  });

  it('a multi-cutter run lists each program’s cutter and names none as THE cutter', () => {
    const step = cutterStep(jobWith('', PICK), [
      program(1, 'inv:lib-flat-6', 'job.nc'),
      program(2, 'inv:lib-flat-3', 'job-2.nc'),
    ]);
    expect(step.text).toContain('program 1 — ⌀ 6 mm flat end');
    expect(step.text).toContain('program 2 — ⌀ 3 mm flat end');
    expect(step.text).not.toContain('the cutter the posted programs run');
    expect(step.text).not.toContain('1.5');
    expect(step.value).toBe('one per program');
  });

  it('a named job’s own line is unchanged, and #1070’s override still names the posted cutter', () => {
    const own = cutterStep(jobWith('inv:lib-flat-6'), [program(1, 'inv:lib-flat-6', 'job.nc')]);
    expect(own.text).toBe(`The cutter — ${'⌀ 6 mm flat end · 22 mm flute'}.`);
    expect(own.value).toBe('⌀ 6 mm cutting');
    const posted = cutterStep(jobWith('inv:lib-flat-6'), [program(1, 'inv:lib-flat-3', 'job.nc')]);
    expect(posted.text).toContain('⌀ 3 mm flat end');
    expect(posted.text).toContain('the cutter the posted programs run');
  });
});
