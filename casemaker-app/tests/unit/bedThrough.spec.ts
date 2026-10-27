// #712 (BM-5 of #707) — a through cut on the bed goes into the WASTEBOARD or a board, never the
// bed: the wasteboard counts as the board under (Q7), a bare bed needs one put under it, a board
// must cover the stock, and a cut may enter the wasteboard only to the shop's depth limit.
// Design: `docs/design/bed-mounts-flow.md` §3.5 and §6 fixture 2.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import { toSetup, validateJob, type BedUnderFacts } from '@/engine/cnc/engrave/jobSetup';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobVise } from '@/engine/cnc/fixture';
import { parseGcode } from '@/engine/cnc/gcode';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import type { EngraveCutout, EngraveJob, EngraveShape, TapeHold } from '@/types/engraveJob';

const TAPE: TapeHold = { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' };

const BARE_BED: BedUnderFacts = {
  surface: 'bare-bed',
  wasteboardMm: null,
  wasteboardLimitMm: 0.5,
  boardMm: 2,
  boardLengthMm: 100,
  boardWidthMm: 100,
  boardWords: '2 mm MDF',
};
const WASTEBOARD: BedUnderFacts = { ...BARE_BED, surface: 'wasteboard', wasteboardMm: 18 };

/** A 40 × 30 through pocket on a 2 mm sheet — the design's tag. */
const TAG: EngraveShape = {
  kind: 'rect',
  id: 'sh-tag',
  name: 'Tag',
  width: 40,
  height: 30,
  cornerRadius: 3,
  position: { x: 40, y: 30 },
  rotation: 0,
  depth: 2,
  through: true,
  enabled: true,
};

function sheet(over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 80, width: 60, thickness: 2, material: 'pla' },
    labels: [],
    shapes: [TAG],
    toolKey: 'flat-1.0',
    tool: flatEndMill(3.175),
    workholding: { kind: 'tape', tape: { ...TAPE } },
    ...over,
  };
}

const codes = (job: EngraveJob, bed?: BedUnderFacts | null): string[] =>
  validateJob(job, null, bed === undefined ? {} : { bed }).map((f) => f.code);
const finding = (job: EngraveJob, bed: BedUnderFacts | null, code: string) =>
  validateJob(job, null, { bed }).find((f) => f.code === code);

describe('#712 a through cut on the bed (§3.5)', () => {
  it('a bare bed with no board is refused in the design’s words, naming the house board', () => {
    const f = finding(sheet(), BARE_BED, 'through-needs-board');
    expect(f?.severity).toBe('error');
    expect(f?.message).toBe(
      'Rectangle "Tag" 40×30 cuts through the blank, and only the bed is under it — put a 2 mm MDF board ' +
        'under it, or tape it on the wasteboard.',
    );
  });

  it('a bad board whose boards are too small is refused with the board’s own size', () => {
    const big = sheet({ stock: { ...defaultEngraveJob().stock, length: 120, width: 90, thickness: 2, material: 'pla' } });
    const f = finding(big, BARE_BED, 'board-too-small');
    expect(f?.severity).toBe('error');
    expect(f?.message).toBe('The 2 mm MDF boards are 100 × 100 mm; this plate is 120 mm long — tape it to the wasteboard, or choose a larger board.');
    // …and the item finding stands aside: one fix, one sentence.
    expect(codes(big, BARE_BED)).not.toContain('through-needs-board');
  });

  it('the WASTEBOARD is the board under: no board needed, and the cut stays in it', () => {
    expect(codes(sheet(), WASTEBOARD)).not.toContain('through-needs-board');
    expect(codes(sheet(), WASTEBOARD)).not.toContain('board-too-small');
    // A breakthrough deeper than the shop's limit is refused once, job-level.
    const deep = sheet({ breakthrough: 0.8 });
    const f = finding(deep, WASTEBOARD, 'wasteboard-depth');
    expect(f?.severity).toBe('error');
    expect(f?.message).toBe(
      'A through cut goes 0.8 mm into the wasteboard, deeper than the 0.5 mm limit — reduce the ' +
        'breakthrough, or put a board under the part.',
    );
  });

  it('the job’s OWN board takes the cut: nothing to refuse, on either surface', () => {
    const board = {
      under: { thickness: 2, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' as const },
      sides: { left: null, right: null, front: null, back: null },
      source: 'saved' as const,
    };
    expect(codes(sheet({ sacrificial: board }), BARE_BED)).not.toContain('through-needs-board');
    expect(codes(sheet({ sacrificial: board }), WASTEBOARD)).not.toContain('wasteboard-depth');
  });

  it('a WASTEBOARD too thin to take the breakthrough needs a board on top of it', () => {
    const thin: BedUnderFacts = { ...WASTEBOARD, wasteboardMm: 1 };
    const f = finding(sheet(), thin, 'through-needs-board');
    expect(f?.message).toContain('the wasteboard is 1 mm — a through cut needs at least 1.3 mm under it');
    expect(f?.message).toContain('put a 2 mm MDF board under it');
  });

  it('a VISE job and a caller with no bed facts keep the sentences they always had', () => {
    const vise = sheet({ workholding: defaultEngraveJob().workholding });
    expect(finding(vise, BARE_BED, 'through-needs-board')?.message).toContain('this cut reaches the vise');
    // No location at all: the bed facts are absent and the sentence is unchanged.
    expect(finding(sheet(), null, 'through-needs-board')?.message).toContain('this cut reaches the vise');
    expect(codes(sheet(), null)).not.toContain('board-too-small');
  });
});

describe('#712 through the pipeline: the tag on each surface (§6 fixture 2)', () => {
  const deepestCutZ = (nc: string): number => {
    let deepest = 0;
    for (const e of parseGcode(nc).events) {
      if (e.kind !== 'move' || e.mode !== 'cut') continue;
      for (const z of [e.from[2], e.to[2]]) if (z !== null) deepest = Math.min(deepest, z);
    }
    return deepest;
  };

  it('no board on the bare bed is refused at Generate', () => {
    const g = generate(tl, sheet(), null, [], undefined, { bed: BARE_BED });
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    const f = g.findings.find((x) => x.code === 'through-needs-board');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('only the bed is under it');
  });

  it('with the 2 mm board it generates, and the cut’s floor is 0.3 mm into the board (Z −2.3)', () => {
    const board = {
      under: { thickness: 2, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' as const },
      sides: { left: null, right: null, front: null, back: null },
      source: 'saved' as const,
    };
    const g = generate(tl, sheet({ sacrificial: board }), null, [], undefined, { bed: BARE_BED });
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(deepestCutZ(g.nc ?? '')).toBeCloseTo(-2.3, 6);
  });

  it('on the wasteboard it generates with no board of its own', () => {
    const g = generate(tl, sheet(), null, [], undefined, { bed: WASTEBOARD });
    expect(g.ok, `${g.stage} ${JSON.stringify(g.errors)}`).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(deepestCutZ(g.nc ?? '')).toBeCloseTo(-2.3, 6);
  });

  it('#725 B7 — the wasteboard rides the SWEEP’s setup as the under-board, and only there', () => {
    const job = sheet();
    const setup = toSetup(job, jobMachine(job, null), undefined, WASTEBOARD);
    // The exact sweeper models `setup.sacrificial` as a second body: the board's underside is the
    // bed floor, so the breakthrough a through cut is allowed into it simulates.
    expect(setup.sacrificial?.under?.thickness).toBe(18);
    // The DOCUMENT is untouched — the operator never chose a board, and no finding changes.
    expect(job.sacrificial.under).toBeNull();
    // A board of the operator's own wins over the machine's.
    const own = toSetup(
      { ...job, sacrificial: { ...job.sacrificial, under: { thickness: 2, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' } } },
      jobMachine(job, null),
      undefined,
      WASTEBOARD,
    );
    expect(own.sacrificial?.under?.thickness).toBe(2);
    // A vise job has no wasteboard under it.
    const vise = toSetup({ ...job, workholding: { kind: 'vise', vise: jobVise(job) } }, jobMachine(job, null), undefined, WASTEBOARD);
    expect(vise.sacrificial?.under ?? null).toBeNull();
  });

  it('#727 F5 — a through DRILL’s point is part of what enters the wasteboard', () => {
    // A 3 mm 118° drill bit through a 0.3 mm breakthrough: its tip stands 0.901 mm below the full
    // diameter, so it enters the wasteboard ~1.2 mm — more than the 0.5 mm limit, and it used to
    // be judged by the breakthrough alone (0.3 ≤ 0.5) and pass unflagged.
    const bit = flatEndMill(3, {
      name: '3 mm drill',
      typeText: 'Drill',
      shape: 'drill',
      tipDiameter: 3,
      diameter: 3,
      cornerRadius: null,
      angle: null,
      centreCutting: null,
    });
    const drilled = sheet({
      shapes: [],
      tool: bit,
      drills: [
        {
          id: 'hole',
          kind: 'drill',
          name: 'port',
          position: { x: 40, y: 30 },
          rotation: 0,
          depth: 2.3,
          enabled: true,
          through: true,
        } as EngraveJob['drills'][number],
      ],
    });
    const f = validateJob(drilled, { deg: 118, source: 'test' }, { bed: WASTEBOARD }).find((x) => x.code === 'wasteboard-depth');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('1.201 mm');
  });

  it('#727 F8 — only the depth PAST the operator’s own board enters the wasteboard', () => {
    // A 0.5 mm board under the part and a 0.7 mm breakthrough: the board takes 0.5 of it, so the
    // wasteboard sees 0.2 mm — inside the 0.5 mm limit. Judged by the raw breakthrough (0.7) it
    // used to be refused.
    const board = {
      under: { thickness: 0.5, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' as const },
      sides: { left: null, right: null, front: null, back: null },
      source: 'saved' as const,
    };
    const job = sheet({ sacrificial: board, breakthrough: 0.7 });
    const codes = validateJob(job, null, { bed: WASTEBOARD }).map((x) => x.code);
    expect(codes).not.toContain('wasteboard-depth');
  });

  it('a cut-out that frees a piece on a bare bed is refused like any through cut', () => {
    const cut: EngraveCutout = {
      kind: 'cutout',
      id: 'cut-tag',
      name: 'Tag',
      enabled: true,
      of: 'sh-tag',
      side: 'outside',
      inset: 0,
      tabs: { count: 2, width: 4, height: 1 },
    };
    // The shape is only REFERENCED (a construction item cuts nothing of its own), so the cut-out
    // is the job's one through cut and its own sentence names it.
    const g = generate(tl, sheet({ shapes: [{ ...TAG, construction: true }], cutouts: [cut] }), null, [], undefined, { bed: BARE_BED });
    expect(g.ok).toBe(false);
    expect(g.findings.find((x) => x.code === 'through-needs-board')?.message).toContain('Cut-out "Tag"');
  });
});
