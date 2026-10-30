/**
 * #787 — the flight recorder: the ring's bounds, the session marker, and the report a crash leaves
 * behind. No IndexedDB, no window: both are replaced through the module's own seams.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  CRUMB_BYTES_LIMIT,
  CRUMB_LIMIT,
  __resetFlightRecorderForTests,
  buildCrashReport,
  crashMoment,
  crashReportFileName,
  flightCrumbs,
  flightSession,
  flushFlightRecorder,
  lastWorkFacts,
  markCleanExit,
  noteFinding,
  noteProgress,
  noteStage,
  noteWorkEnd,
  noteWorkStart,
  recordCrumb,
  sampleMemory,
  setFlightCrumbIO,
  setFlightMarkerIO,
  startFlightRecorder,
  type Crumb,
  type FlightCrumbIO,
  type FlightMarkerIO,
  type SessionMarker,
} from '@/platform/flightRecorder';

class FakeCrumbs implements FlightCrumbIO {
  stored: Crumb[] = [];
  saves = 0;
  async load(): Promise<Crumb[]> {
    return this.stored.map((c) => ({ ...c }));
  }
  async save(crumbs: readonly Crumb[]): Promise<void> {
    this.saves++;
    this.stored = crumbs.map((c) => ({ ...c }));
  }
}

class FakeMarker implements FlightMarkerIO {
  value: SessionMarker | null = null;
  writes: (SessionMarker | null)[] = [];
  read(): SessionMarker | null {
    return this.value;
  }
  write(marker: SessionMarker | null): void {
    this.value = marker;
    this.writes.push(marker);
  }
}

afterEach(() => __resetFlightRecorderForTests());

const marker = (over: Partial<SessionMarker> = {}): SessionMarker => ({
  id: 's-old',
  startedAt: 1_000,
  appVersion: '1.0.0',
  commit: 'abc1234',
  work: null,
  stage: null,
  label: null,
  ...over,
});

describe('#787 — the ring', () => {
  it('keeps the LAST 500 crumbs and drops the oldest', () => {
    for (let i = 0; i < CRUMB_LIMIT + 75; i++) recordCrumb({ kind: 'note', data: { i } });
    const crumbs = flightCrumbs();
    expect(crumbs).toHaveLength(CRUMB_LIMIT);
    expect((crumbs[0]!.data as { i: number }).i).toBe(75);
    expect((crumbs.at(-1)!.data as { i: number }).i).toBe(CRUMB_LIMIT + 74);
  });

  it('keeps the ring under its byte cap even when the crumbs are large', () => {
    const big = 'x'.repeat(120_000);
    for (let i = 0; i < 20; i++) recordCrumb({ kind: 'note', data: { i, big } });
    const crumbs = flightCrumbs();
    expect(crumbs.length).toBeLessThan(CRUMB_LIMIT);
    expect(JSON.stringify(crumbs).length).toBeLessThanOrEqual(CRUMB_BYTES_LIMIT + 130_000);
    // The newest survive; the oldest are the ones dropped.
    expect((crumbs.at(-1)!.data as { i: number }).i).toBe(19);
    expect((crumbs[0]!.data as { i: number }).i).toBeGreaterThan(0);
  });

  it('a full ring flushes to its store at once on a stage, and on demand', async () => {
    const io = new FakeCrumbs();
    setFlightCrumbIO(io);
    noteStage('generate', 'sample', 'sampling the goal');
    await Promise.resolve();
    expect(io.saves).toBeGreaterThanOrEqual(1);
    await flushFlightRecorder();
    expect(io.stored.some((c) => c.kind === 'stage' && c.stage === 'sample')).toBe(true);
  });
});

describe('#787 — the session marker', () => {
  it('a clean start writes this session and returns no previous session', async () => {
    const crumbs = new FakeCrumbs();
    const marks = new FakeMarker();
    setFlightCrumbIO(crumbs);
    setFlightMarkerIO(marks);
    const previous = await startFlightRecorder({ appVersion: '2.1.0', commit: 'deadbee', now: 5_000 });
    expect(previous).toBeNull();
    expect(marks.value?.appVersion).toBe('2.1.0');
    expect(marks.value?.commit).toBe('deadbee');
    expect(marks.value?.startedAt).toBe(5_000);
    expect(flightSession()?.id).toBe(marks.value?.id);
    // The session crumb carries the environment facts.
    const session = flightCrumbs().find((c) => c.kind === 'session');
    expect(session?.data?.version).toBe('2.1.0');
  });

  it('a leftover marker is an UNCLEAN exit, and its crumbs are handed back, not folded into the new ring', async () => {
    const oldCrumbs: Crumb[] = [
      { at: 1_100, kind: 'work', work: 'generate', stage: 'start', data: { jobName: 'mouse', stock: { length: 50, width: 50, thickness: 150 } } },
      { at: 1_200, kind: 'stage', work: 'generate', stage: 'plan', label: 'roughing level 41 of 112' },
      { at: 1_300, kind: 'memory', data: { usedMb: 3_800 } },
    ];
    const crumbs = new FakeCrumbs();
    crumbs.stored = oldCrumbs;
    const marks = new FakeMarker();
    marks.value = marker({ work: 'generate', stage: 'plan', label: 'roughing level 41 of 112' });
    setFlightCrumbIO(crumbs);
    setFlightMarkerIO(marks);

    const previous = await startFlightRecorder({ appVersion: '2.1.0', now: 9_000 });
    expect(previous?.marker.work).toBe('generate');
    expect(previous?.crumbs).toHaveLength(3);
    // The new session's ring starts empty; the old crumbs live in the returned record.
    expect(flightCrumbs().some((c) => c.stage === 'plan')).toBe(false);

    const moment = crashMoment(previous!);
    expect(moment.work).toBe('generate');
    expect(moment.label).toBe('roughing level 41 of 112');
    expect(moment.heapMb).toBe(3_800);
    expect(lastWorkFacts(previous!)?.jobName).toBe('mouse');
  });

  it('the work notes move the marker, and a clean exit clears it', async () => {
    const marks = new FakeMarker();
    setFlightCrumbIO(new FakeCrumbs());
    setFlightMarkerIO(marks);
    await startFlightRecorder({ appVersion: '2.1.0' });
    noteWorkStart('generate');
    expect(marks.value?.work).toBe('generate');
    noteStage('generate', 'post', 'posting the program');
    expect(marks.value?.stage).toBe('post');
    noteWorkEnd('generate', 'done');
    expect(marks.value?.work).toBeNull();
    markCleanExit();
    expect(marks.value).toBeNull();
    expect(flightCrumbs().some((c) => c.kind === 'note' && c.data?.event === 'clean-exit')).toBe(true);
  });
});

describe('#787 — the report', () => {
  const previous = (): { marker: SessionMarker; crumbs: Crumb[] } => ({
    marker: marker({ work: 'generate', stage: 'plan', label: 'roughing level 41 of 112' }),
    crumbs: [
      {
        at: 1_100,
        kind: 'work',
        work: 'generate',
        stage: 'start',
        data: {
          jobName: 'nude-panther',
          stock: { length: 50, width: 50, thickness: 150 },
          goalTriangles: 184_000,
          goalBytes: 9_204_512,
          meshes: [{ name: 'panther.stl', sha256: 'a'.repeat(64), format: 'stl', bytes: 9_204_512 }],
        },
      },
      { at: 1_200, kind: 'stage', work: 'generate', stage: 'plan', label: 'roughing level 41 of 112' },
      { at: 1_250, kind: 'finding', data: { code: 'goal-reach-short', severity: 'error', message: 'The goal is 116 mm deep…' } },
      { at: 1_300, kind: 'memory', data: { usedMb: 3_800 } },
    ],
  });

  it('carries the last stage, the job facts and the findings — and no meshes unless asked', () => {
    const src = previous();
    const report = buildCrashReport(src, { appVersion: '2.1.0', commit: 'deadbee', desktop: false, now: 2_000_000 });
    expect(report.kind).toBe('casemaker-crash-report');
    expect(report.stopped.work).toBe('generate');
    expect(report.stopped.label).toBe('roughing level 41 of 112');
    expect(report.stopped.heapMb).toBe(3_800);
    expect(report.job?.jobName).toBe('nude-panther');
    expect(report.job?.goalTriangles).toBe(184_000);
    expect(report.crumbs.some((c) => c.kind === 'finding' && c.data?.code === 'goal-reach-short')).toBe(true);
    expect(report.meshes).toBeUndefined();
  });

  it('includes a mesh only when the caller asks', () => {
    const report = buildCrashReport(previous(), {
      appVersion: '2.1.0',
      commit: null,
      desktop: true,
      meshes: [{ name: 'panther.stl', sha256: 'a'.repeat(64), format: 'stl', data: 'AAAA' }],
    });
    expect(report.meshes).toHaveLength(1);
    expect(report.app.desktop).toBe(true);
  });

  it('carries the desktop crash log when one is supplied, and omits it otherwise', () => {
    const withLog = buildCrashReport(previous(), {
      appVersion: '2.1.0',
      commit: null,
      desktop: true,
      desktopLog: ['{"at":1,"kind":"frame-render-process-exited","reason":"out-of-memory"}'],
    });
    expect(withLog.desktopLog).toHaveLength(1);
    expect(withLog.desktopLog?.[0]).toContain('out-of-memory');
    expect(buildCrashReport(previous(), { appVersion: '2.1.0', commit: null, desktop: false }).desktopLog).toBeUndefined();
  });

  it('names its file from the time it stopped', () => {
    const name = crashReportFileName(new Date(2026, 9, 30, 17, 2).getTime());
    expect(name).toBe('casemaker-crash-2026-10-30-1702.json');
  });

  it('the notes record the work start, progress, findings and a memory sample when one exists', () => {
    noteWorkStart('generate', { jobName: 'x' });
    noteProgress('generate', 'plan', 41, 112, 'roughing level 41 of 112');
    noteFinding({ code: 'goal-reach-short', severity: 'error', message: 'deep' });
    sampleMemory(); // no performance.memory in Node: no crumb, and no throw
    const kinds = flightCrumbs().map((c) => c.kind);
    expect(kinds).toContain('work');
    expect(kinds).toContain('progress');
    expect(kinds).toContain('finding');
    expect(kinds).not.toContain('memory');
  });
});
