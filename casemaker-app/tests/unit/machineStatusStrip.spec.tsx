// @vitest-environment jsdom
// #526/#647 — the status strip's DRO (design: docs/design/status-strip-dro.md, variant B).
//
// The strip against fake status lines: the WORK value large over the MACHINE value, the state as a
// connection, the tool slot's two sources (the job's cutter, the checked-out probe during a
// registration), the vacuum with no qualifier, and progress from the `P:` field. The line is fed
// through `machineStore` exactly as the heartbeat leaves it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MachineStatusStrip } from '@/components/viewport/MachineStatusStrip';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetMachineRunStore, useMachineRunStore, type RunEntry } from '@/store/machineRunStore';
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { resetStripAccessoryStore, useStripAccessoryStore } from '@/store/stripAccessoryStore';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import type { FrozenPackage } from '@/types/engraveJob';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetManageMode, useManageModeStore } from '@/store/manageModeStore';
import { useViewportStore } from '@/store/viewportStore';
import { resetCameraPaneStore, useCameraPaneStore } from '@/store/cameraPaneStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { rotaryAngleWords } from '@/components/viewport/rotaryWords';
import type { ReleaseRecord } from '@/store/engraveReleaseStore';
import type { MachineObservation } from '@/platform/machineProbe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** #658 — a rotary module checked out to the strip's machine. */
const ROTARY = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'Makera rotary',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'm1', since: '2026-10-23T00:00:00.000Z' },
  history: [],
} as unknown as { id: string };

const PROBE = {
  id: 'fx-probe-1',
  kind: 'probe',
  product: 'Makera Wired Probe V2',
  variant: 'wired-touch',
  constants: {},
  unit: { tipDiameterMm: 2, rimOffsetMm: 0.7, lastM491: { z: -72.529, at: '2026-10-24T12:00:00.000Z' } },
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'm1', since: '2026-10-23T00:00:00.000Z' },
  history: [],
} as unknown as { id: string };

const LOCATION = {
  machines: [
    {
      id: 'm1',
      profileId: 'Z1',
      address: { host: '192.0.2.10', port: 2222 },
      bedProfiles: [],
      accessories: [],
    },
  ],
  accessories: [
    {
      id: 'fx-probe-1',
      kind: 'probe',
      product: 'Makera Wired Probe V2',
      variant: 'wired-touch',
      constants: {},
      unit: { tipDiameterMm: 2, rimOffsetMm: 0.7, lastM491: { z: -72.529, at: '2026-10-24T12:00:00.000Z' } },
      provenance: {},
      whereabouts: { kind: 'machine', machineId: 'm1', since: '2026-10-23T00:00:00.000Z' },
      history: [],
    },
  ],
} as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>;
void PROBE;

function remember(line: string | null, profileId: string | null = 'Z1'): void {
  const observation: MachineObservation = {
    name: 'QA Z1',
    host: '192.0.2.10',
    port: 2222,
    busy: false,
    ip: null,
    mac: null,
    status: line,
    profileId,
    observedAt: '2026-10-24T12:00:00.000Z',
    notes: [],
  };
  useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null });
  if (line !== null) useMachineStore.getState().noteLiveStatusLine(line);
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetRegistrationTouchesStore();
  resetEngraveReleaseStore();
  resetMachineRunStore();
  resetStripAccessoryStore();
  resetManageMode();
  useViewportStore.setState({ activeSidebarSection: null });
  resetLocationStore();
  resetCameraPaneStore();
  useLocationStore.setState({ status: 'present', location: LOCATION, etag: '"e1"', reason: null });
  useEngraveJobStore.getState().replace({ ...defaultEngraveJob(), toolKey: 'flat-1.0' });
});

afterEach(cleanup);

describe('#647 the DRO — coordinates', () => {
  it('states the WORK value over the MACHINE value, per axis, at three decimals', () => {
    // Tonight's G54 against the homed rest: work 178.975 / 191.925 / 53.129, machine −1 / −1 / −1.
    remember('<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:178.9750,191.9250,53.1290>');
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-work-x').textContent).toBe('178.975');
    expect(screen.getByTestId('machine-status-machine-x').textContent).toBe('-1.000');
    expect(screen.getByTestId('machine-status-work-y').textContent).toBe('191.925');
    expect(screen.getByTestId('machine-status-work-z').textContent).toBe('53.129');
    expect(screen.getByTestId('machine-status-machine-z').textContent).toBe('-1.000');
  });

  it('shows dashes before a status has been read, and no A axis on a 3-axis machine', () => {
    remember(null);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-work-x').textContent).toBe('—');
    expect(screen.getByTestId('machine-status-machine-x').textContent).toBe('—');
    expect(screen.queryByTestId('machine-status-axis-a')).toBeNull();
  });

  it('#658 shows A only when a rotary MODULE is checked out, not because the frame carries one', () => {
    // The Z1's own frame always carries a fourth value (0.0000 on a machine with no module), so the
    // frame is not the signal; the accessory checkout is.
    remember('<Idle|MPos:-1,-2,-3,10|WPos:0,0,0,10>');
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-axis-a')).toBeNull();
    cleanup();

    useLocationStore.setState({
      location: { ...LOCATION, accessories: [ROTARY] } as unknown as NonNullable<
        ReturnType<typeof useLocationStore.getState>['location']
      >,
    });
    render(<MachineStatusStrip />);
    // #769 — the A reads in the rotary read-out's words, degrees within the turn plus the turns.
    expect(screen.getByTestId('machine-status-work-a').textContent).toBe(rotaryAngleWords(10));
    expect(screen.getByTestId('machine-status-work-a').textContent).toBe('A 10° · 0 turns');
    expect(screen.getByTestId('machine-status-machine-a').textContent).toBe('10.000');
  });
});

describe('#689 the connection', () => {
  it('leads with the machine name and its address, so Cut needs no Machines card', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-name').textContent).toBe('Makera Z1');
    expect(screen.getByTestId('machine-status-host').textContent).toBe('192.0.2.10');
  });

  it('#689 review — with no machine the band says so and opens Manage › Machines', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status').getAttribute('data-state')).toBe('no-machine');
    expect(screen.getByTestId('machine-status-no-machine').textContent).toBe('No machine connected');
    fireEvent.click(screen.getByTestId('machine-status-open-machines'));
    expect(useManageModeStore.getState().open).toBe(true);
    expect(useManageModeStore.getState().scope).toBe('machines');
  });

  it('#689 review — the no-machine band stays out of a print project', () => {
    useViewportStore.setState({ activeSidebarSection: 'part' });
    const { container } = render(<MachineStatusStrip />);

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('machine-status')).toBeNull();
  });
});

describe('#647 the DRO — state as connection', () => {
  it('reads the state word in the operator’s vocabulary', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Idle');
    expect(screen.getByTestId('machine-status-state').getAttribute('data-state')).toBe('Idle');
  });

  it('#655 reads the firmware’s Tool state as waiting for the cutter', () => {
    remember('<Tool|MPos:-10.09,-12.83,-3|WPos:0,0,0|T:0,-9.757,1>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Waiting for the cutter');
    expect(screen.getByTestId('machine-status-state').getAttribute('data-state')).toBe('Waiting for the cutter');
  });

  it('names an alarm and carries its reason', () => {
    remember('<Alarm|MPos:0,0,0>\nALARM: Probe fail');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toContain('Alarm');
    expect(screen.getByTestId('machine-status-alarm-reason').textContent).toContain('Probe fail');
  });

  it('says Not answering with no status yet, and Offline when the heartbeat cannot reach it', () => {
    remember(null);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Not answering');
    cleanup();
    useMachineStore.getState().noteHeartbeat(false);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Offline');
  });

  it('reads Paused while the app holds a suspended run, even if the line says Idle', () => {
    remember('<Idle|MPos:-10,-10,-3|WPos:0,0,0>');
    useMachineRunStore.setState({ runs: { '192.0.2.10:2222': { paused: true } as unknown as RunEntry } });
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Paused');
  });
});

describe('#647 the DRO — the tool slot', () => {
  it('names the cutter the job runs with, and the hover carries T and the last M491', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0|T:1>');
    render(<MachineStatusStrip />);
    // #687 — the strip draws the one display form, not the registry record's raw label/name.
    const name = toolDisplayName(jobTool(useEngraveJobStore.getState().job)!);
    const slot = screen.getByTestId('machine-status-tool');
    // #769 — the cell names the cutter AND says the frame's own active tool number.
    expect(slot.textContent).toBe(`T1 · ${name}`);
    expect(slot.textContent).toBe('T1 · ⌀ 1 mm flat end');
    expect(slot.getAttribute('title')).toContain('T1');
    expect(slot.getAttribute('title')).toContain('M491 -72.529');
  });

  it('names the checked-out PROBE while a registration owns the machine', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|T:6>');
    useMachineStore.getState().setRegistrationActive(true);
    useRegistrationTouchesStore.getState().setStep('as low as machine Z -57.2 (the surface seek)');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Probing');
    expect(screen.getByTestId('machine-status-tool').textContent).toBe('T6 · Makera Wired Probe V2');
    expect(screen.getByTestId('machine-status-step').textContent).toContain('the surface seek');
  });

  it('#769 does not state T:0 as the active tool — it is the firmware’s ‘nothing fitted’', () => {
    // 2026-10-08-console.log: stopped at an M6 waiting for the cutter (T:0 = none, waiting for 1).
    remember(
      '<Tool|MPos:-10.0900,-12.8300,-3.0000,0.0000,0.0000|WPos:138.3100,111.9700,71.8750,0.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,24.8,23.7,0,0,0,0|T:0,-9.757,1|L:0, 0, 0, 0.0,100.0|C:3,1,0,0|E:0,0,0,692,7610|OTA:0,0>',
    );
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-tool').textContent).toBe('⌀ 1 mm flat end');
    expect(screen.getByTestId('machine-status-tool').textContent).not.toContain('T0');
  });
});

// #769 — WHAT IT IS DOING, from the frame's own F: and S: fields, pinned against recorded frames
// from docs/bench/traces. The maintainer's rule: an absent/unreadable field prints "—", never breaks
// the strip, and an Offline machine never shows its last figures as if they were live.
describe('#769 the DRO — feed, spindle and the ATC state', () => {
  it('shows the live feed and spindle from a recorded cutting frame', () => {
    // docs/bench/traces/2026-10-12-cut-rowA.log — mid-cut: F 600 of 2000, spindle 11 677.9 of 12 000.
    remember(
      '<Run|MPos:-162.0500,-162.2000,-5.7381,0.0000,0.0000|WPos:18.4500,20.0000,50.8059,0.0000,0.0000|F:600.0,2000.0,100.0|S:11677.9,12000.0,100.0,1,37.6,24.9,0,0,0,0|T:1,0.000,1|L:0, 0, 0, 0.0,100.0|P:0,17,10|C:3,1,0,1|E:0,0,0,692,7610|OTA:0,0>',
    );
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-feed').textContent).toBe('F600');
    expect(screen.getByTestId('machine-status-spindle').textContent).toBe('S11678');
    // The set figure and the unit are in the hover; the override at 100 % is not news (#646).
    expect(screen.getByTestId('machine-status-feed').getAttribute('title')).toBe('Feed 600 of 2000 mm/min · override 100 %');
    expect(screen.getByTestId('machine-status-spindle').getAttribute('title')).toBe(
      'Spindle 11678 of 12000 rpm · override 100 %',
    );
    expect(screen.queryByTestId('machine-status-feed-override')).toBeNull();
    expect(screen.queryByTestId('machine-status-spindle-override')).toBeNull();
  });

  it('shows a resting machine as zero, not as a dash — the frame did say zero', () => {
    // docs/bench/traces/2026-10-24-run1-status-trail.log 15:17:58 — Idle at the home rest.
    remember(
      '<Idle|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000|WPos:180.2000,198.1250,57.1727,0.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,19.4,20.5,0,0,0,0|T:1,0.050,-1|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|E:0,0,0,702,7610|OTA:0,0>',
    );
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-feed').textContent).toBe('F0');
    expect(screen.getByTestId('machine-status-spindle').textContent).toBe('S0');
    expect(screen.getByTestId('machine-status-tool').textContent).toBe('T1 · ⌀ 1 mm flat end');
  });

  it('shows a feed reduced by the override beside the value', () => {
    // No recorded frame carries a non-100 override (every corpus F:/S: is 100.0), so this line is
    // SYNTHETIC: step-down to 50 % is the capability the cell adds, and it is marked as such here.
    remember('<Run|MPos:0,0,0|WPos:0,0,0|F:250,500,50|S:6000,12000,80|T:1>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-feed').textContent).toContain('F250');
    expect(screen.getByTestId('machine-status-feed-override').textContent).toBe('· 50 %');
    expect(screen.getByTestId('machine-status-spindle').textContent).toContain('S6000');
    expect(screen.getByTestId('machine-status-spindle-override').textContent).toBe('· 80 %');
  });

  it('prints dashes for a frame without F: or S: — absent is not zero', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-feed').textContent).toBe('F—');
    expect(screen.getByTestId('machine-status-spindle').textContent).toBe('S—');
    expect(screen.getByTestId('machine-status-feed').getAttribute('title')).toContain('no reading');
  });

  it('prints dashes, not the last figures, once the machine has gone Offline', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|F:1501.1,2000.0,100.0|S:8000.0,10000.0,100.0|T:1>');
    useMachineStore.getState().noteHeartbeat(false);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-feed').textContent).toBe('F—');
    expect(screen.getByTestId('machine-status-spindle').textContent).toBe('S—');
  });

  it('shows the frame’s A: as the ATC state, and only where a machine sends one', () => {
    // No frame in the corpus carries A: (0 of 5 689 across docs/ and .scratch; the Z1 has the ATC bit
    // clear, and the firmware writes the field only when it is set), so the recorded-frame case is
    // the ABSENT cell. The ATC machine's line below is SYNTHETIC, shaped from the firmware's
    // `|A:%d` write (Kernel::get_query_string) — the parser is pinned against that shape.
    remember(
      '<Run|MPos:-162.0500,-162.2000,-5.7381,0.0000,0.0000|WPos:18.4500,20.0000,50.8059,0.0000,0.0000|F:600.0,2000.0,100.0|S:11677.9,12000.0,100.0,1,37.6,24.9,0,0,0,0|T:1,0.000,1|L:0, 0, 0, 0.0,100.0|P:0,17,10|C:3,1,0,1|E:0,0,0,692,7610|OTA:0,0>',
    );
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-atc')).toBeNull();
    cleanup();

    remember('<Idle|MPos:0,0,0|WPos:0,0,0|A:3>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-atc').textContent).toBe('ATC3');
  });
});

describe('#647 the DRO — vacuum and progress', () => {
  it('carries no vacuum TEXT — the mode lives in the accessory indicators (#648)', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0>');
    useEngraveReleaseStore.setState({
      records: { '192.0.2.10:2222': { vacuum: 'on' } as unknown as ReleaseRecord },
    });
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-vacuum')).toBeNull();
    expect(screen.getByTestId('machine-status-accessory-vacuum').getAttribute('data-mode')).toBe('on');
  });

  it('drives the bar and the remaining time from the P: field', () => {
    // line 12, 40 %, 75 s elapsed → about 113 s left (1:53).
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|P:12,40,75>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-percent').textContent).toBe('40 %');
    expect(screen.getByTestId('machine-status-remaining').textContent).toBe('1:53 left');
  });

  it('omits the progress cell when the line carries no P:', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-progress')).toBeNull();
  });
});

describe('#647 the DRO — the layout contract', () => {
  it('wraps rather than clips: a wrapping band with ONE elastic cell (the tool name), everything else fixed', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|P:12,40,75>');
    render(<MachineStatusStrip />);
    const strip = screen.getByTestId('machine-status');
    // #769 review: at the 760 px column with a rotary module the row measured 987 px and clipped
    // its tail, so the band breaks at cell boundaries onto a second line instead — no field hidden.
    // jsdom does no layout, so the pin here is the wrap itself; the measured pin is the e2e spec
    // (`scrollWidth <= clientWidth` and every kept cell's box inside the band at 760 px).
    expect(strip.style.flexWrap).toBe('wrap');
    expect(strip.style.whiteSpace).toBe('nowrap');
    const tool = screen.getByTestId('machine-status-tool');
    // The tool name is still the only cell that may SHRINK — the last resort when it alone is wider
    // than the band, not what keeps the row inside its column (that is the wrap); the state cell is
    // a fixed width like the others.
    expect(tool.style.flexShrink).toBe('1');
    expect(tool.style.textOverflow).toBe('ellipsis');
    expect(tool.style.overflow).toBe('hidden');
    expect(screen.getByTestId('machine-status-state').style.flexShrink).toBe('0');
  });
});

describe('#652 the strip’s follow-ups', () => {
  /** The job as the document holds it, with a frozen package naming `programs[0].toolKey`. */
  function withFrozenCutter(toolKey: string): void {
    const job = useEngraveJobStore.getState().job;
    useEngraveJobStore.getState().replace({
      ...job,
      package: { programs: [{ toolKey }] } as unknown as FrozenPackage,
    });
  }

  function named(key: string): string {
    return toolDisplayName(resolveTool(key)!);
  }

  it('names the FROZEN package’s cutter, not the job edited after the freeze', () => {
    // The package froze setup 1 with the 3.175 flat end; Design then picks the 1 mm cutter.
    useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, toolKey: 'flat-1.0' } });
    withFrozenCutter('flat-3.175x12-metal');
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-tool').textContent).toBe(named('flat-3.175x12-metal'));
  });

  it('prefers the program the machine holds, when one is uploaded', () => {
    // The package (and the job) name the 1 mm cutter; the program actually uploaded is the 3.175.
    withFrozenCutter('flat-1.0');
    useMachineRunStore.setState({
      runs: {
        '192.0.2.10:2222': { context: { nc: 'G90', toolKey: 'flat-3.175x12-metal' } } as unknown as RunEntry,
      },
    });
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-tool').textContent).toBe(named('flat-3.175x12-metal'));
  });

  it('falls back to the job’s own cutter only when nothing is frozen', () => {
    useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, toolKey: 'flat-1.0' } });
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-tool').textContent).toBe(named('flat-1.0'));
  });

  it('shows no live-looking numbers when the machine has gone Offline', () => {
    remember('<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:178.9750,191.9250,53.1290>');
    useMachineStore.getState().noteHeartbeat(false);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-work-x').textContent).toBe('—');
    expect(screen.getByTestId('machine-status-machine-z').textContent).toBe('—');
  });

  it('gives a long alarm reason its own elastic cell, outside the fixed state cell', () => {
    remember('<Alarm|MPos:0,0,0>\nALARM: Probe fail — the probe was not seated in the spindle before the run started');
    render(<MachineStatusStrip />);
    const reason = screen.getByTestId('machine-status-alarm-reason');
    expect(reason.style.flexShrink).toBe('1');
    expect(reason.style.overflow).toBe('hidden');
    expect(reason.style.textOverflow).toBe('ellipsis');
    // The state cell stays fixed; the reason no longer lives inside it.
    expect(screen.getByTestId('machine-status-state').style.flexShrink).toBe('0');
    expect(screen.getByTestId('machine-status-state').contains(reason)).toBe(false);
    expect(reason.getAttribute('title')).toContain('Probe fail');
  });

  it('a release’s vacuum record expires a manual press on the same target', () => {
    const target = '192.0.2.10:2222';
    // The operator pressed the vacuum off by hand; a program then ran with its own M331 and the
    // release recorded 'on'. The manual entry must not mask what the program sent.
    useStripAccessoryStore.getState().note(target, 'vacuum', false);
    useEngraveReleaseStore.setState({ records: { [target]: { vacuum: 'on' } as unknown as ReleaseRecord } });
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-accessory-vacuum').getAttribute('data-mode')).toBe('on');
    expect(useStripAccessoryStore.getState().modes[target]).toBeUndefined();
  });
});

// #659 — THE STATUS MONITOR behind a click on the state element: nothing added to the strip's text,
// the readings in operator words, Escape closes.
describe('#659 the state popover', () => {
  it('shows the spindle and power temperatures, and closes on Escape', () => {
    remember(
      '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>',
    );
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-monitor')).toBeNull();
    fireEvent.click(screen.getByTestId('machine-status-state'));
    expect(screen.getByTestId('machine-status-monitor')).toBeTruthy();
    expect(screen.getByTestId('machine-status-monitor-spindle').textContent).toBe('Spindle 25.8 °C');
    expect(screen.getByTestId('machine-status-monitor-power').textContent).toBe('Power board 24.0 °C');
    expect(screen.queryByTestId('machine-status-monitor-halt')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('machine-status-monitor')).toBeNull();
  });

  it('names a halt reason — the cover, a probe fault — in operator words', () => {
    remember('<Alarm|MPos:0,0,0|H:11>');
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-state'));
    const halt = screen.getByTestId('machine-status-monitor-halt');
    expect(halt.textContent).toContain('the cover was opened');
    expect(halt.getAttribute('data-code')).toBe('11');
  });

  it('#530 offers the camera from the same popover, and the bed is one press away', () => {
    remember('<Idle|MPos:0,0,0>');
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-state'));
    fireEvent.click(screen.getByTestId('machine-status-monitor-camera'));
    expect(useCameraPaneStore.getState().open).toBe(true);
    // The popover closes behind it: the pane is the thing to look at now.
    expect(screen.queryByTestId('machine-status-monitor')).toBeNull();
  });

  it('#530 offers no camera for a machine whose profile names none', () => {
    // An unknown identity resolves to no profile at all (#280): the strip says what it can, and
    // does not borrow the Z1's camera for a machine it does not know.
    remember('<Idle|MPos:0,0,0>', null);
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-state'));
    expect(screen.getByTestId('machine-status-monitor')).toBeTruthy();
    expect(screen.queryByTestId('machine-status-monitor-camera')).toBeNull();
  });

  it('says the frame carries no extra readings rather than inventing one', () => {
    remember('<Idle|MPos:-1,-1,-1|WPos:0,0,0>');
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-state'));
    expect(screen.getByTestId('machine-status-monitor-none').textContent).toBe(
      "This machine's status frame carries no extra readings.",
    );
    expect(screen.queryByTestId('machine-status-monitor-spindle')).toBeNull();
  });
});
