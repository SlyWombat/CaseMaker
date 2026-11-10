// @vitest-environment jsdom
// #1170 — THE END OF THE JOB: the card UNDER step 3, never in place of the steps.
//
// The numbers are read from what the run recorded (the timed run's own clocks, the package's cut
// order, the document's run log); the two questions are the operator's, and "Cut the tabs again"
// replays ONLY the program that leaves the tabs — the tab-release file the generated result names.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CutEndCard, cutEndModel } from '@/components/panels/CutEndCard';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import type { RunRecord } from '@/engine/cnc/engrave/runRecord';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { machineKey, useMachineRunStore, type RunEntry } from '@/store/machineRunStore';
import type { EngraveJob, FrozenPackage, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
const FLIPPED = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'front', back: 'back' } as const;
const AT = '2026-11-10T08:00:00.000Z';
const TARGET = { host: '192.0.2.10', port: 2222 };
const MACHINE = machineKey(TARGET);

function setup(id: string, over: Partial<JobSetup> = {}): JobSetup {
  return {
    id,
    orientation: { ...IDENTITY },
    mount: { kind: 'bracket' },
    itemIds: [],
    tools: ['flat-1.0'],
    ...over,
  } as unknown as JobSetup;
}

function trayJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  // The offcut description names what is cut OUT of it in the document's own words.
  job.labels = [{ ...job.labels[0]!, text: 'Tray' }];
  const ids = job.labels.map((l) => l.id);
  job.setups = [setup('s1', { itemIds: ids }), setup('s2', { itemIds: ids, orientation: { ...FLIPPED } })];
  return job;
}

function packageOf(job: EngraveJob, count = 20): FrozenPackage {
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

/** The generated result: one program carries the tab release, and it is the LAST one posted. */
function generated(count = 20): EngraveGenerated {
  return {
    programs: Array.from({ length: count }, (_, i) => ({
      programHash: `h${i + 1}`,
      setupIndex: i < count / 2 ? 1 : 2,
      toolKey: i % 2 === 0 ? 'flat-1.0' : 'user:flat-0.6',
      nc: `G0 X0 Y0\n; p${i + 1}\nM02\n`,
      ...(i === count - 1 ? { tabRelease: { count: 3, widthMm: 6, heightMm: 2.5, at: [] } } : {}),
    })),
  } as unknown as EngraveGenerated;
}

/** 1 h 31 min of cutting, 2 h 09 min at the machine → 38 min of the operator's own time. */
const TIMED = {
  jobName: 'tray',
  cutOn: '2026-11-10',
  minutes: 129,
  actualSeconds: 5460,
  estimatedSeconds: 4920,
} as unknown as RunRecord;

const OFF_CUT = {
  item: {
    id: 'stock-1',
    material: 'hardwood',
    form: 'block',
    size: { length: 160, width: 126, thickness: 25 },
    quantity: 1,
    reservations: [],
    consumed: [],
    source: 'offcut',
    addedAt: AT,
  },
  text: '160 × 126 × 25 mm of hardwood is left over from the cut-out — keep it on the shelf?',
  state: 'asked',
} as never;

function finishedRun(): RunEntry {
  return {
    running: false,
    runId: 1,
    filename: 'job-p20.nc',
    programHash: 'h20',
    paused: false,
    stopAsked: false,
    progress: null,
    firstProgressAt: null,
    pausedMs: 0,
    lines: [],
    outcome: { kind: 'finished', last: { line: 10, percent: 100, elapsedS: 120 }, homed: true, vacuumOff: true },
    context: { nc: 'M02\n', jobId: 'job' },
    end: { kind: 'finished', lines: [], offcut: OFF_CUT, stockQuestion: null },
    pendingStock: null,
  } as unknown as RunEntry;
}

/** The document's run log: everything finished, except program 5, which the operator stopped. */
function logWithStop(job: EngraveJob): void {
  job.runLog = Array.from({ length: 20 }, (_, i) => ({
    at: AT,
    outcome: i === 4 ? 'stopped' : 'finished',
    programHash: `h${i + 1}`,
  })) as never;
}

describe('#1170 the end card model', () => {
  it('counts the clocks, the changes, the turn and the stop, and finds the release program by its own hash', () => {
    const job = trayJob();
    logWithStop(job);
    const pkg = packageOf(job);
    const model = cutEndModel({
      job,
      pkg,
      generated: generated(),
      run: finishedRun(),
      lastMeasuredRun: TIMED,
    });
    expect(model.cuttingSeconds).toBe(5460);
    expect(model.estimateSeconds).toBe(4920);
    expect(model.yourSeconds).toBe(2280);
    expect(model.bitChanges).toBe(19);
    expect(model.flips).toBe(1);
    expect(model.stops.count).toBe(1);
    expect(model.stops.lines[0]).toContain('program 5');
    expect(model.stops.lines[0]).toContain('you');
    expect(model.releaseIndex).toBe(20);
    expect(model.offcutText).toContain('160 × 126 × 25 mm');
    expect(model.offcutText).toContain('hardwood');
    // What is cut out of it, in the document's own names.
    expect(model.offcutText).toContain('Tray');
  });

  it('a one-sided job has no turn, and no tab release means nothing to replay', () => {
    const job = trayJob();
    job.setups = job.setups!.slice(0, 1);
    const pkg = packageOf(job, 1);
    pkg.programs.forEach((p) => (p.setupIndex = 1));
    const model = cutEndModel({
      job,
      pkg,
      // A one-sided job's generated result never carries a tab release (the flipped side posts it).
      generated: { programs: [] } as unknown as EngraveGenerated,
      run: { ...finishedRun(), end: { kind: 'finished', lines: [], offcut: null, stockQuestion: null } } as never,
      lastMeasuredRun: null,
    });
    expect(model.flips).toBe(0);
    expect(model.releaseIndex).toBeNull();
    expect(model.offcutText).toBeNull();
    expect(model.cuttingSeconds).toBeNull();
  });
});

describe('#1170 the end card', () => {
  afterEach(cleanup);

  function draw(): { rerun: ReturnType<typeof vi.spyOn>; keep: ReturnType<typeof vi.spyOn> } {
    const job = trayJob();
    logWithStop(job);
    const pkg = packageOf(job);
    useEngraveJobStore.setState({ job });
    useMachineRunStore.setState({ runs: { [MACHINE]: finishedRun() } as never });
    useEngraveReleaseStore.setState({
      records: {
        [MACHINE]: {
          phase: 'done',
          active: 20,
          next: null,
          vacuum: 'off',
          atMachine: false,
          stopAsked: false,
          job,
          files: pkg.programs.map((p, i) => ({ index: i + 1, toolKey: p.toolKey, done: true, nc: p.nc })),
          walks: { airwalk: null, clean: null },
        },
      },
    } as never);
    const rerun = vi.spyOn(useEngraveReleaseStore.getState(), 'rerunProgram').mockResolvedValue(undefined as never);
    const keep = vi.spyOn(useMachineRunStore.getState(), 'keepOffcut').mockResolvedValue(undefined as never);
    render(
      <CutEndCard
        job={job}
        pkg={pkg}
        generated={generated()}
        run={finishedRun()}
        lastMeasuredRun={TIMED}
        measuredSentence="The run recorded on 2026-11-10 took 1 h 31 min against 1 h 22 min predicted."
        target={TARGET}
      />,
    );
    return { rerun, keep };
  }

  it('shows the three tiles, the two questions and the three actions', () => {
    draw();
    expect(screen.getByTestId('engrave-cut-end-card')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-end-cutting').textContent).toContain('1 h 31 min');
    expect(screen.getByTestId('engrave-cut-end-cutting').textContent).toContain('1 h 22 min');
    expect(screen.getByTestId('engrave-cut-end-your').textContent).toContain('38 min');
    expect(screen.getByTestId('engrave-cut-end-your').textContent).toContain('19 bit changes, 1 flip');
    expect(screen.getByTestId('engrave-cut-end-stops').textContent).toContain('1');
    expect(screen.getByTestId('engrave-cut-end-stops').textContent).toContain('program 5');
    expect(screen.getByTestId('engrave-cut-end-offcut-question').textContent).toContain('Tray');
    expect(screen.getByTestId('engrave-cut-end-save').textContent).toBe('Save the run record');
    expect(screen.getByTestId('engrave-cut-end-another')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-end-new')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-end-steps-note').textContent).toContain('three steps stay above');
  });

  it('“Cut the tabs again” replays the one release program, never the job', () => {
    const { rerun } = draw();
    fireEvent.click(screen.getByTestId('engrave-cut-end-tabs'));
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith(TARGET, 20);
  });

  it('Keep hands the offcut to the shelf action for this machine', () => {
    const { keep } = draw();
    fireEvent.click(screen.getByTestId('engrave-cut-end-keep'));
    expect(keep).toHaveBeenCalledWith(MACHINE);
  });

  it('a job with no release program says so instead of offering the replay', () => {
    const job = trayJob();
    logWithStop(job);
    const pkg = packageOf(job);
    useEngraveJobStore.setState({ job });
    render(
      <CutEndCard
        job={job}
        pkg={pkg}
        generated={{ programs: [] } as unknown as EngraveGenerated}
        run={finishedRun()}
        lastMeasuredRun={TIMED}
        measuredSentence="The run recorded on 2026-11-10 took 1 h 31 min against 1 h 22 min predicted."
        target={TARGET}
      />,
    );
    const tabs = screen.getByTestId('engrave-cut-end-tabs') as HTMLButtonElement;
    expect(tabs.disabled).toBe(true);
    expect(tabs.getAttribute('title')).toContain('no tab-release program');
  });
});
