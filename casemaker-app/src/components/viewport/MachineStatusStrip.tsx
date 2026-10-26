import { useEffect, useRef, useState, type JSX } from 'react';
import { useMachineStore } from '@/store/machineStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { accessoriesFor, machineRecordByProfile } from '@/store/locationStore';
import { MACHINES } from '@/engine/cnc/machine';
import { machineDisplayName } from '@/platform/locationClient';
import { probeNameFor } from '@/engine/cnc/registration/mountContext';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { useStripAccessoryStore } from '@/store/stripAccessoryStore';
import { useCameraPaneStore } from '@/store/cameraPaneStore';
import { useMachineCamera } from '@/hooks/useMachineCamera';
import { readStatusLine, type JobProgress, type StatusPosition } from '@/platform/desktop/protocol';
import { alarmLine } from '@/platform/machineUpload';
import { StripAccessories } from './StripAccessories';

/**
 * #526/#647 — the live machine in one line under the viewport, whenever a machine is remembered;
 * with none remembered, the same band names the absence and opens Manage › Machines (#689 review).
 *
 * THE DRO (design: `docs/design/status-strip-dro.md`, variant B). The strip answers the operator's
 * questions left to right: is it running (the state dot and word, which is also the connection) →
 * where is it (the WORK value large, the MACHINE value small and muted beneath it, per axis) → what
 * is in it (the cutter or probe by NAME) → what is on (`vacuum off`) → how far along (a bar and the
 * remaining time from the `P:` field). Everything comes from the same heartbeat line the viewport
 * and the touches read, parsed by `protocol.ts`: nothing new is read from the machine.
 *
 * NO DEFENSIVE QUALIFIERS (#646). The strip states the value; where a provenance fact belongs it is
 * in the hover (the T number and the probe's last M491), never a caveat on the value itself.
 *
 * FIXED-WIDTH CELLS, ONE ELASTIC. At 760 px nothing wraps: each cell is fixed or small, and the tool
 * name is the only cell that grows, so it is the one that ellipsises.
 */

/** The controller's state word in the operator's words (#647's vocabulary, the Cut step's own). */
function stateWord(state: string | null, registrationActive: boolean, heartbeatReachable: boolean | null): string {
  if (state === null) return heartbeatReachable === false ? 'Offline' : 'Not answering';
  switch (state) {
    case 'Idle':
      return 'Idle';
    case 'Home':
      return 'Homing';
    case 'Run':
      return registrationActive ? 'Probing' : 'Running';
    case 'Alarm':
      return 'Alarm';
    case 'Hold':
    case 'Door':
      return 'Paused';
    // #655 — the firmware's Tool state (after `T<n> M6`, an `M490.2` away from running on).
    case 'Tool':
      return 'Waiting for the cutter';
    default:
      return state;
  }
}

/** The dot's colour: the state as a glance, the word as the answer. */
function stateColour(word: string): string {
  switch (word) {
    case 'Idle':
      return '#4caf50';
    case 'Running':
    case 'Probing':
      return '#4a9eff';
    case 'Paused':
    case 'Homing':
      return '#e0a020';
    case 'Alarm':
      return '#e05252';
    default:
      return '#7a8794';
  }
}

/** `12.350` → `"12.350"`; null → `"—"`. */
function fmt3(n: number | null): string {
  return n === null ? '—' : n.toFixed(3);
}

/** `75` → `"1:15"`, `12` → `"12 s"`. */
function fmtElapsed(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** The remaining time the `P:` percent and elapsed imply, or null while there is nothing to divide. */
function remainingSeconds(p: JobProgress | null | undefined): number | null {
  if (p == null || p.percent === null || p.elapsedS === null || p.percent <= 0 || p.percent >= 100) return null;
  return Math.round((p.elapsedS * (100 - p.percent)) / p.percent);
}

/** One axis: the work value large, the machine value small and muted beneath it. */
function AxisCell({ axis, work, machine }: { axis: string; work: number | null; machine: number | null }): JSX.Element {
  return (
    <span data-testid={`machine-status-axis-${axis.toLowerCase()}`} style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#8a97a5', fontSize: 11 }}>{axis}</span>
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.05 }}>
        <span
          data-testid={`machine-status-work-${axis.toLowerCase()}`}
          style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#e8eef4' }}
        >
          {fmt3(work)}
        </span>
        <span
          data-testid={`machine-status-machine-${axis.toLowerCase()}`}
          style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', color: '#7a8794' }}
        >
          {fmt3(machine)}
        </span>
      </span>
    </span>
  );
}

/** The three (or four) axis cells, in the mock's order. */
function Axes({
  work,
  machine,
  hasRotary,
}: {
  work: StatusPosition | null;
  machine: StatusPosition | null;
  hasRotary: boolean;
}): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', whiteSpace: 'nowrap', flex: 'none' }}>
      <AxisCell axis="X" work={work?.x ?? null} machine={machine?.x ?? null} />
      <AxisCell axis="Y" work={work?.y ?? null} machine={machine?.y ?? null} />
      <AxisCell axis="Z" work={work?.z ?? null} machine={machine?.z ?? null} />
      {/* #658 — A only when a rotary module is checked out: the Z1's own frame always carries a
          fourth value (0.0000 on a machine with no module), so the frame is not the signal. */}
      {hasRotary && <AxisCell axis="A" work={work?.a ?? null} machine={machine?.a ?? null} />}
    </span>
  );
}

export function MachineStatusStrip(): JSX.Element | null {
  const machine = useMachineStore((s) => s.machine);
  const openManage = useManageModeStore((s) => s.openManage);
  const heartbeat = useMachineStore((s) => s.heartbeat);
  // #519 item 3 — a registration owns the machine: the state reads Probing and the tool slot names
  // the probe.
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const registrationStep = useRegistrationTouchesStore((s) => s.step);
  const vacuum = useEngraveReleaseStore((s) =>
    machine === null ? null : s.records[machineKey(machine)]?.vacuum ?? null,
  );
  const runPaused = useMachineRunStore((s) => (machine === null ? false : s.runs[machineKey(machine)]?.paused === true));
  const requestStop = useMachineRunStore((s) => s.requestStop);
  // #647 — the tool slot states the tool the job runs with, by name (#646: no qualifier).
  const job = useEngraveJobStore((s) => s.job);
  // #652 — the program the machine holds (prepared or running), for its own frozen cutter.
  const prepared = useMachineRunStore((s) => (machine === null ? null : s.runs[machineKey(machine)] ?? null));
  const forgetAccessories = useStripAccessoryStore((s) => s.forget);
  // #530 — the camera, when the machine's profile has one: a link inside the same popover, so the
  // strip's one-line rule survives and the bed is still a press away.
  const camera = useMachineCamera();
  const openCamera = useCameraPaneStore((s) => s.openPane);
  // #659 — the status monitor's popover, opened from the STATE element (the accessory icons'
  // pattern: nothing added to the strip's text, Escape and an outside click close it).
  const [monitorOpen, setMonitorOpen] = useState(false);
  const monitorRoot = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!monitorOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMonitorOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (monitorRoot.current !== null && e.target instanceof Node && !monitorRoot.current.contains(e.target)) {
        setMonitorOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [monitorOpen]);
  const target = machine === null ? null : machineKey(machine);
  // #652 — A RELEASE'S OWN VACUUM WORDS EXPIRE THE MANUAL ONES. The accessory store keeps what a
  // press concluded per target and nothing clears it, so a manual press before a run masked the
  // record of what the program then sent (M331 on, icon off). When the release's record moves it is
  // the newer statement; the manual entries for this target go.
  useEffect(() => {
    if (target !== null && vacuum !== null && vacuum !== 'unknown') forgetAccessories(target);
  }, [vacuum, target, forgetAccessories]);
  // #689 review — the strip is the machine's ONE home, so it says the absence rather than vanishing;
  // the action is the app's existing Manage › Machines, not a new route. The Cut step keeps its own
  // sentence where its Run press is disabled (principle 4), and this line keeps the band from being
  // a blank void in that state.
  if (machine === null) {
    return (
      <div
        data-testid="machine-status"
        data-state="no-machine"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '3px 10px',
          borderTop: '1px solid #2a2f36',
          fontSize: 11,
          color: '#9aa4b0',
          minHeight: 30,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <span data-testid="machine-status-no-machine">No machine connected</span>
        <button
          type="button"
          data-testid="machine-status-open-machines"
          onClick={() => openManage('machines')}
          style={{
            font: 'inherit',
            padding: 0,
            border: 0,
            background: 'none',
            color: '#8ab4f8',
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          Manage › Machines
        </button>
      </div>
    );
  }

  // `statusLine` is set by the store and the probe; a test fixture may hand only the raw line.
  const line = machine.statusLine ?? (machine.status === null ? null : readStatusLine(machine.status));
  const state = runPaused
    ? 'Paused'
    : stateWord(line?.state ?? null, registrationActive && line?.state === 'Run', heartbeat?.reachable ?? null);
  const idle = state === 'Idle' || state === 'Not answering' || state === 'Offline';
  // #647 — an alarm says its reason when the line carries one: `ALARM: Probe fail` is the operator's
  // next question, and it is already in the reply.
  const rawStatus = machine.status ?? (typeof machine.statusLine === 'string' ? machine.statusLine : null);
  // The reason is the line's own alarm words, never the `<Alarm|…>` state line that names the state.
  const reasonLines = (rawStatus ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<'));
  const reason = state === 'Alarm' ? alarmLine(reasonLines.join('\n')) : null;
  const progress = line?.progress ?? null;
  // #659 — what the popover reads (null before any status line).
  const monitor = line?.monitor ?? null;

  // #652 — THE TOOL IS THE FROZEN PACKAGE'S, NOT THE LIVE JOB'S. The program the machine holds names
  // its cutter on the run's context; with nothing uploaded, the package's first program does. A
  // cutter changed in Design after the freeze must not relabel a program the package already froze
  // with the old one. Only a job with NO frozen package falls back to its own tool key.
  const frozenKey = job.package?.programs[0]?.toolKey ?? null;
  const runKey = prepared?.context?.toolKey ?? null;
  const toolKey = runKey ?? frozenKey;
  const jobCutter = toolKey === null ? jobTool(job) : resolveTool(toolKey);
  // #646 — names are for people: the geometry, not the vendor label (which stays in the hover).
  const cutter = jobCutter === null ? null : toolDisplayName(jobCutter);
  const toolNumber = line?.tool ?? null;
  // The strip's machine is the OBSERVATION; the accessories and the probe name live on the saved
  // machine record it resolves to (#604's accessor).
  const record = machineRecordByProfile(machine.profileId ?? null);
  // #689 — the strip is the ONE home for the connection: the machine's name and address lead it, so
  // Cut never repeats a Machines card. The record's nickname wins; the profile name is next.
  const machineName =
    machineDisplayName(record, machine.profileId === null ? undefined : MACHINES[machine.profileId]) ??
    machine.name ??
    machine.host;
  // #658 — the rotary AXIS exists only when a rotary module is checked out to this machine. Not
  // `capabilities.rotary` or the profile's rotary block: those are static and true on a bare Z1.
  const hasRotary = record !== null && accessoriesFor(record).some((a) => a.kind === 'rotary-module');
  const probeAcc = record === null ? null : accessoriesFor(record).find((a) => a.kind === 'probe') ?? null;
  const lastM491 = probeAcc?.unit.lastM491;
  const lastM491Z =
    typeof lastM491 === 'object' && lastM491 !== null && typeof (lastM491 as { z?: unknown }).z === 'number'
      ? (lastM491 as { z: number }).z
      : null;
  const toolName = registrationActive ? (probeNameFor(record) ?? 'probe') : cutter;
  const toolTitle = [
    jobCutter?.name ?? null,
    toolNumber !== null ? `T${toolNumber}` : null,
    lastM491Z !== null ? `M491 ${fmt3(lastM491Z)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const percent = progress?.percent ?? null;
  const remaining = remainingSeconds(progress);

  return (
    <div
      data-testid="machine-status"
      style={{
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: 10,
        padding: '3px 10px',
        borderTop: '1px solid #2a2f36',
        fontSize: 11,
        color: '#c8d3de',
        minHeight: 30,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {/* #689 — the connection opens the strip: which machine, at which address, then its state. */}
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flex: 'none', minWidth: 0, maxWidth: 200 }}>
        <span
          data-testid="machine-status-name"
          style={{ fontWeight: 600, color: '#e8eef4', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={machineName}
        >
          {machineName}
        </span>
        <span aria-hidden="true" style={{ color: '#4a5560' }}>·</span>
        <span
          data-testid="machine-status-host"
          style={{ color: '#9aa4b0', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={`${machine.host}:${machine.port}`}
        >
          {machine.host}
        </span>
      </span>
      {/* #648 — the accessories beside the machine's name: icons with a popover, so the vacuum no
          longer takes the strip's text. The guards are the card switches' own (Idle, no job, an alarm
          refusing); the reason shows in the popover when the machine cannot be switched now. */}
      <StripAccessories
        target={machineKey(machine)}
        host={machine.host}
        port={machine.port}
        vacuumFromRecord={vacuum === 'on' ? true : vacuum === 'off' ? false : null}
        disabledReason={
          state === 'Alarm'
            ? 'The controller is in an alarm — clear it at the machine first.'
            : state === 'Running' || state === 'Probing'
              ? 'A program is running — stop it first.'
              : state === 'Paused'
                ? 'The program is paused — resume or stop it first.'
                : state === 'Homing'
                  ? 'The machine is homing — wait for Idle.'
                  : state === 'Not answering' || state === 'Offline'
                    ? 'The machine is not answering.'
                    : null
        }
      />
      {/* #659 — THE STATUS MONITOR sits behind a click on the state element: spindle and power
          temperatures, the firmware's halt reason (which is where the cover and a probe fault
          appear), and the machine's own leveling correction. The state dot and word remain the
          strip's only text about the machine's condition. */}
      <span ref={monitorRoot} style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
        <button
          type="button"
          data-testid="machine-status-state"
          data-state={state}
          aria-expanded={monitorOpen}
          aria-label={`${state} — status readings`}
          title="Status readings"
          onClick={() => setMonitorOpen((open) => !open)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flex: 'none',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: stateColour(state), flex: 'none' }} />
          <span style={{ fontWeight: 600, color: '#e8eef4' }}>{state}</span>
        </button>
        {monitorOpen && (
          <div
            data-testid="machine-status-monitor"
            role="dialog"
            aria-label="Status readings"
            style={{
              position: 'absolute',
              left: 0,
              top: '100%',
              marginTop: 4,
              width: 260,
              padding: 10,
              background: '#1c2229',
              border: '1px solid #2a2f36',
              borderRadius: 6,
              boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
              zIndex: 40,
              whiteSpace: 'normal',
              fontSize: 11,
              color: '#c8d3de',
            }}
          >
            {monitor === null ? (
              <p style={{ margin: 0, color: '#a8b4c0' }} data-testid="machine-status-monitor-none">
                No status line has been read yet.
              </p>
            ) : monitor.spindleTempC === null &&
              monitor.powerTempC === null &&
              monitor.halt === null &&
              monitor.levellingMm === null ? (
              <p style={{ margin: 0, color: '#a8b4c0' }} data-testid="machine-status-monitor-none">
                This machine's status frame carries no extra readings.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 14, lineHeight: 1.6 }}>
                {monitor.spindleTempC !== null && (
                  <li data-testid="machine-status-monitor-spindle">Spindle {monitor.spindleTempC.toFixed(1)} °C</li>
                )}
                {monitor.powerTempC !== null && (
                  <li data-testid="machine-status-monitor-power">Power board {monitor.powerTempC.toFixed(1)} °C</li>
                )}
                {monitor.halt !== null && (
                  <li data-testid="machine-status-monitor-halt" data-code={monitor.halt.code}>
                    Halted — {monitor.halt.words} (reason {monitor.halt.code})
                  </li>
                )}
                {monitor.levellingMm !== null && (
                  <li data-testid="machine-status-monitor-levelling">
                    Leveling — the machine is applying up to {monitor.levellingMm.toFixed(3)} mm of correction
                  </li>
                )}
              </ul>
            )}
            {/* #530 — the bed, from the same place the readings are: absent for a machine whose
                profile names no camera (and the pane itself is then unreachable). */}
            {camera !== null && (
              <button
                type="button"
                data-testid="machine-status-monitor-camera"
                title={camera.source}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 8,
                  paddingTop: 7,
                  border: 'none',
                  borderTop: '1px solid #2a2f36',
                  background: 'transparent',
                  color: '#8fb4ff',
                  font: 'inherit',
                  fontSize: 11,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setMonitorOpen(false);
                  openCamera();
                }}
              >
                Camera — see the bed
              </button>
            )}
          </div>
        )}
      </span>
      {/* #652 — the alarm's reason gets its OWN elastic cell: inside the fixed-width state cell a
          long ALARM:/ERROR: line widened the row past `overflow: hidden` and clipped Stop. */}
      {reason !== null && (
        <span
          data-testid="machine-status-alarm-reason"
          title={reason}
          style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: '#e0a0a0' }}
        >
          {reason}
        </span>
      )}
      {/* #652 — a machine that stopped answering shows NO live-looking numbers: the last WPos/MPos
          are what it said before it went quiet, so the DRO prints "—" instead. */}
      <Axes
        work={heartbeat?.reachable === false ? null : line?.wpos ?? null}
        machine={heartbeat?.reachable === false ? null : line?.mpos ?? null}
        hasRotary={hasRotary}
      />
      {/* The registration's current step is the operator's "what is it doing now" while the probe
          is in: it sits where the program name would, after the coordinates. */}
      {registrationActive && registrationStep !== null && (
        <span data-testid="machine-status-step" style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: '#a8b4c0' }}>
          {registrationStep}
        </span>
      )}
      <span
        data-testid="machine-status-tool"
        title={toolTitle}
        style={{ flex: '0 1 auto', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600, color: '#e8eef4' }}
      >
        {toolName ?? (toolNumber !== null ? `T${toolNumber}` : 'no cutter')}
      </span>
      {percent !== null && (
        <span data-testid="machine-status-progress" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <span aria-hidden="true" style={{ width: 56, height: 6, borderRadius: 3, background: '#2a2f36', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, percent))}%`, background: '#4a9eff' }} />
          </span>
          <span data-testid="machine-status-percent" style={{ fontWeight: 600, color: '#e8eef4', fontVariantNumeric: 'tabular-nums' }}>
            {percent} %
          </span>
          {remaining !== null && (
            <span data-testid="machine-status-remaining" style={{ color: '#8a97a5' }}>
              {fmtElapsed(remaining)} left
            </span>
          )}
        </span>
      )}
      {!idle && (
        <button
          type="button"
          data-testid="machine-status-stop"
          style={{ flex: 'none', padding: '1px 8px' }}
          onClick={() => requestStop(machineKey(machine))}
        >
          Stop
        </button>
      )}
    </div>
  );
}
