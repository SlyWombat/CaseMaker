/**
 * #787 — the crash-recovery store: what a leftover marker means at load, and the report a press
 * writes. The recorder's storage and the file save are both replaced through their seams.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetFlightRecorderForTests,
  setFlightCrumbIO,
  setFlightMarkerIO,
  type Crumb,
  type FlightCrumbIO,
  type FlightMarkerIO,
  type SessionMarker,
} from '@/platform/flightRecorder';
import {
  __resetFlightRecorderStoreForTests,
  setCrashProbeIO,
  setCrashSaveIO,
  setCrashSendIO,
  useFlightRecorderStore,
} from '@/store/flightRecorderStore';
import { setMeshBlobIO } from '@/platform/meshBlobs';

class FakeCrumbs implements FlightCrumbIO {
  stored: Crumb[] = [];
  async load(): Promise<Crumb[]> {
    return this.stored.map((c) => ({ ...c }));
  }
  async save(crumbs: readonly Crumb[]): Promise<void> {
    this.stored = crumbs.map((c) => ({ ...c }));
  }
}
class FakeMarker implements FlightMarkerIO {
  value: SessionMarker | null = null;
  read(): SessionMarker | null {
    return this.value;
  }
  write(marker: SessionMarker | null): void {
    this.value = marker;
  }
}

afterEach(() => {
  __resetFlightRecorderStoreForTests();
  __resetFlightRecorderForTests();
  setMeshBlobIO(null);
});

const CRASHED: Crumb[] = [
  {
    at: new Date(2026, 9, 30, 17, 0).getTime(),
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
  {
    at: new Date(2026, 9, 30, 17, 2).getTime(),
    kind: 'stage',
    work: 'generate',
    stage: 'rough',
    label: 'roughing level 41 of 112',
  },
  { at: new Date(2026, 9, 30, 17, 2).getTime(), kind: 'memory', data: { usedMb: 3_800 } },
];

function primeCrash(): void {
  const crumbs = new FakeCrumbs();
  crumbs.stored = CRASHED;
  const marker = new FakeMarker();
  marker.value = {
    id: 's-crashed',
    startedAt: CRASHED[0]!.at,
    appVersion: '1.0.0',
    commit: 'abc1234',
    work: 'generate',
    stage: 'rough',
    label: 'roughing level 41 of 112',
  };
  setFlightCrumbIO(crumbs);
  setFlightMarkerIO(marker);
}

describe('#787 — the crash-recovery store', () => {
  it('a clean start shows nothing', async () => {
    setFlightCrumbIO(new FakeCrumbs());
    setFlightMarkerIO(new FakeMarker());
    setCrashProbeIO(async () => ({ kind: 'absent' }));
    await useFlightRecorderStore.getState().init();
    expect(useFlightRecorderStore.getState().previous).toBeNull();
    expect(useFlightRecorderStore.getState().moment).toBeNull();
  });

  it('a leftover marker becomes the previous session, with its last stage and heap', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'absent' }));
    await useFlightRecorderStore.getState().init();
    const state = useFlightRecorderStore.getState();
    expect(state.previous?.marker.id).toBe('s-crashed');
    expect(state.moment?.work).toBe('generate');
    expect(state.moment?.label).toBe('roughing level 41 of 112');
    expect(state.moment?.heapMb).toBe(3_800);
    expect(state.houseOk).toBe(false);
  });

  it('Save writes ONE json file, with the last stage and the job facts, and no meshes unless asked', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'absent' }));
    const saved: { text: string; filename: string }[] = [];
    setCrashSaveIO({ save: async (text, filename) => void saved.push({ text, filename }) });

    await useFlightRecorderStore.getState().init();
    await useFlightRecorderStore.getState().saveReport(false);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.filename).toMatch(/^casemaker-crash-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    const report = JSON.parse(saved[0]!.text) as Record<string, unknown>;
    expect(report.kind).toBe('casemaker-crash-report');
    expect((report.stopped as { label: string }).label).toBe('roughing level 41 of 112');
    expect((report.job as { jobName: string }).jobName).toBe('nude-panther');
    expect(report.meshes).toBeUndefined();
    expect(useFlightRecorderStore.getState().saved).toBe(saved[0]!.filename);
  });

  it('“include the models” adds the stored mesh bytes to the report', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'absent' }));
    let savedText = '';
    setCrashSaveIO({ save: async (text) => void (savedText = text) });
    setMeshBlobIO({
      put: async () => undefined,
      get: async (sha) => (sha === 'a'.repeat(64) ? 'QUJD' : null),
    });

    await useFlightRecorderStore.getState().init();
    await useFlightRecorderStore.getState().saveReport(true);
    const report = JSON.parse(savedText) as { meshes?: { name: string; data: string }[] };
    expect(report.meshes).toHaveLength(1);
    expect(report.meshes?.[0]).toMatchObject({ name: 'panther.stl', data: 'QUJD' });
  });

  it('Send posts the SAME report to the house, and says where it went', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'present' }));
    const sent: unknown[] = [];
    setCrashSendIO(async (report) => {
      sent.push(report);
      return { kind: 'ok', path: 'crash-reports/crash-1-0.json' };
    });
    await useFlightRecorderStore.getState().init();
    expect(useFlightRecorderStore.getState().houseOk).toBe(true);
    expect(sent).toHaveLength(0); // nothing leaves on the probe
    await useFlightRecorderStore.getState().sendReport(false);
    expect(sent).toHaveLength(1);
    const report = sent[0] as { kind: string; stopped: { label: string } };
    expect(report.kind).toBe('casemaker-crash-report');
    expect(report.stopped.label).toBe('roughing level 41 of 112');
    expect(useFlightRecorderStore.getState().sent).toBe('crash-reports/crash-1-0.json');
  });

  it('a refused send keeps the service\u2019s own words and does not mark the report sent', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'present' }));
    setCrashSendIO(async () => ({ kind: 'refused', status: 400, message: 'the body is not a Case Maker crash report' }));
    await useFlightRecorderStore.getState().init();
    await useFlightRecorderStore.getState().sendReport(false);
    const state = useFlightRecorderStore.getState();
    expect(state.sent).toBeNull();
    expect(state.sendError).toContain('the body is not a Case Maker crash report');
  });

  it('nothing is written on load — only a press writes', async () => {
    primeCrash();
    setCrashProbeIO(async () => ({ kind: 'present' }));
    let writes = 0;
    setCrashSaveIO({ save: async () => void (writes += 1) });
    await useFlightRecorderStore.getState().init();
    expect(writes).toBe(0);
    // The house was probed (so the send half can be offered) but nothing was sent: the store has
    // no request path at all beyond the probe, and this module's only write is the Save button.
    expect(useFlightRecorderStore.getState().houseOk).toBe(true);
    expect(writes).toBe(0);
  });
});
