// @vitest-environment jsdom
// #1167 — STEP 3 AS ONE CARD: the whole job in run order. The pure model is tested without wasm;
// the card's render is checked against the same model, so the list the operator reads and the list
// the acceptance counts cannot disagree.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { CutRunCard, cutCardModel, type CutCardProgramRow } from '@/components/panels/CutRunCard';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { RunPlan } from '@/engine/cnc/plan';
import type { EngraveJob, FrozenPackage, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
const AT = '2026-11-10T08:00:00.000Z';

function setup(id: string, itemIds: string[], tools: string[]): JobSetup {
  return { id, orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools };
}

/** A two-sided job: 10 programs in setup 1, 10 in setup 2, alternating two cutters per side. */
function trayJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  const ids = job.labels.map((l) => l.id);
  job.setups = [setup('s1', ids, ['flat-1.0', 'user:flat-0.6']), setup('s2', ids, ['flat-1.0', 'user:flat-0.6'])];
  return job;
}

function packageOf(job: EngraveJob, count: number): FrozenPackage {
  const programs = Array.from({ length: count }, (_, i) => ({
    setupIndex: i < count / 2 ? 1 : 2,
    setupId: i < count / 2 ? 's1' : 's2',
    toolKey: i % 2 === 0 ? 'flat-1.0' : 'user:flat-0.6',
    nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
    hash: `h${i + 1}`,
    frameNc: null,
    frameHash: null,
  }));
  return {
    jobId: job.id,
    frozenAt: AT,
    hash: 'package',
    jobHash: 'job',
    programs,
    setups: jobSetups(job).map((s) => ({ ...s })),
    stockEntryId: null,
    surface: null,
    hold: undefined,
  } as FrozenPackage;
}

/** A plan with one cut phase per program: 60 s each, p1's last run 4 min 12 s. */
function planOf(count: number): RunPlan {
  return {
    phases: Array.from({ length: count }, (_, i) => ({
      id: `p${i + 1}.cut`,
      kind: 'cut',
      setupIndex: i < count / 2 ? 1 : 2,
      programId: `p${i + 1}`,
      title: `Cut: p${i + 1}`,
      who: 'machine',
      needsDone: false,
      parts: [],
      seconds: 60,
      source: 'estimated',
      lastRun: i === 0 ? { seconds: 252, at: AT } : null,
    })),
    totalSeconds: 60 * count,
    totalIsLowerBound: false,
    features: [],
    airRunFor: [],
    findings: [],
    settings: {} as never,
  } as unknown as RunPlan;
}

afterEach(cleanup);

describe('#1167 the Cut card lists the whole job', () => {
  it('20 programs, two sides: every program plus the flip row between the sides', () => {
    const job = trayJob();
    const pkg = packageOf(job, 20);
    const model = cutCardModel({ job, pkg, plan: planOf(20), finishedHashes: ['h1'], runningIndex: 2 });
    const programs = model.rows.filter((r): r is CutCardProgramRow => r.kind === 'program');
    expect(model.total).toBe(20);
    expect(model.done).toBe(1);
    expect(model.running).toBe(2);
    expect(programs).toHaveLength(20);
    // THE FLIP is its own row, between setup 1's last program and setup 2's first.
    const flipAt = model.rows.findIndex((r) => r.kind === 'flip');
    expect(flipAt).toBeGreaterThan(0);
    expect((model.rows[flipAt] as { toSetup: number }).toSetup).toBe(2);
    expect((model.rows[flipAt - 1] as CutCardProgramRow).index).toBe(10);
    expect((model.rows[flipAt + 1] as CutCardProgramRow).index).toBe(11);
    // The states the glyphs read: done, running, and the change marks where the cutter moves.
    expect(programs[0]).toMatchObject({ done: true, measuredSeconds: 252 });
    expect(programs[1]).toMatchObject({ running: true, done: false });
    expect(programs[2]!.needsChange).toBe(true); // p2's 0.6 flat -> p3's 1 flat
    expect(programs[3]!.needsChange).toBe(true);
    expect(programs[4]!.needsChange).toBe(true);
    // The time left is the unfinished programs' own estimates.
    expect(model.secondsLeft).toBe(19 * 60);
    expect(model.sides).toBe(2);
  });

  it('a one-program job is one row, no flip', () => {
    const job = defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    const [a] = job.labels.map((l) => l.id);
    job.setups = [setup('s1', [a!], ['flat-1.0'])];
    const pkg = packageOf(job, 1);
    const model = cutCardModel({ job, pkg, plan: planOf(1), finishedHashes: [], runningIndex: null });
    expect(model.total).toBe(1);
    expect(model.rows).toHaveLength(1);
    expect(model.rows.some((r) => r.kind === 'flip')).toBe(false);
    expect(model.sides).toBe(1);
  });

  it('the card renders the header, every row, the flip, the footnote and the fixed controls', () => {
    const job = trayJob();
    const pkg = packageOf(job, 20);
    render(<CutRunCard job={job} pkg={pkg} plan={planOf(20)} finishedHashes={['h1']} target={null} />);
    expect(screen.getByTestId('engrave-cut-card').textContent).toContain('20 programs');
    expect(screen.getByTestId('engrave-cut-card').textContent).toContain('1 done');
    expect(screen.getByTestId('engrave-cut-card-row-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-card-row-20')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-card-flip').textContent).toContain('Flip');
    expect(screen.getByTestId('engrave-cut-card-row-1').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('engrave-cut-card-row-3').getAttribute('data-state')).toBe('bit-change');
    expect(screen.getByTestId('engrave-cut-card-footnote').textContent).toContain('bit change');
    // The control row is part of the card in the idle state too; no run is active, so both wait —
    // and each says WHY (A's acceptance rule: every disabled control carries its reason sentence;
    // the rule reads a `title` when no *-reason node is in the control's scope).
    expect((screen.getByTestId('engrave-cut-card-pause') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engrave-cut-card-stop') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-card-pause').getAttribute('title')).toBe('Nothing is running yet');
    expect(screen.getByTestId('engrave-cut-card-stop').getAttribute('title')).toBe('Choose the machine first');
  });

  it('with a machine but no run, Stop says the same reason Pause does', () => {
    const job = trayJob();
    const pkg = packageOf(job, 20);
    render(
      <CutRunCard job={job} pkg={pkg} plan={planOf(20)} finishedHashes={[]} target={{ host: '192.0.2.10', port: 2222 }} />,
    );
    expect((screen.getByTestId('engrave-cut-card-pause') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-card-pause').getAttribute('title')).toBe('Nothing is running yet');
    expect(screen.getByTestId('engrave-cut-card-stop').getAttribute('title')).toBe('Nothing is running yet');
  });

  it('stale finishedPrograms hashes from an OLD package do not count (17-program job)', () => {
    // The bench case (2026-11-10): land17's tray is a NEW 17-program package while the machine
    // record still holds two hashes from yesterday's 20-program package. The done count is
    // hash-membership in THIS package, so those hashes cannot mark any new program done.
    const job = trayJob();
    const pkg = packageOf(job, 17);
    const stale = ['5343dd8c', '1e4e7ef9'];
    const model = cutCardModel({ job, pkg, plan: planOf(17), finishedHashes: stale, runningIndex: null });
    expect(model.total).toBe(17);
    expect(model.done).toBe(0);
    expect(model.rows.some((r) => r.kind === 'program' && r.done)).toBe(false);
    render(<CutRunCard job={job} pkg={pkg} plan={planOf(17)} finishedHashes={stale} target={null} />);
    const card = screen.getByTestId('engrave-cut-card');
    expect(card.textContent).toContain('17 programs');
    expect(card.textContent).not.toContain('1 done');
    expect(card.textContent).not.toContain('20 programs');
    expect(screen.getAllByTestId(/^engrave-cut-card-row-/)).toHaveLength(17);
    expect(card.querySelectorAll('[data-state="done"]')).toHaveLength(0);
  });

  it('a one-program card has no flip row and one program row', () => {
    const job = defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    const [a] = job.labels.map((l) => l.id);
    job.setups = [setup('s1', [a!], ['flat-1.0'])];
    const pkg = packageOf(job, 1);
    render(<CutRunCard job={job} pkg={pkg} plan={planOf(1)} finishedHashes={[]} target={null} />);
    expect(screen.queryByTestId('engrave-cut-card-flip')).toBeNull();
    expect(screen.getByTestId('engrave-cut-card-row-1')).toBeTruthy();
    expect(screen.queryByTestId('engrave-cut-card-row-2')).toBeNull();
  });
});
