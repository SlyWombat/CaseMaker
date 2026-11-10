/**
 * Machines (#311, tracking #212): the machines this app has reached, each as it answered last time.
 *
 * THE CHECK IS THE WIZARD'S, THE RECORD IS THIS SURFACE'S. `probeMachine` (#280) already asks the
 * network and returns one of four outcomes; `machineStore` already holds the result and persists it.
 * Nothing here is a second implementation — this is where that record LIVES when no project is open,
 * which is the whole reason the surface exists. The wizard re-runs the check every time it opens;
 * this pane shows what the last one concluded, with the time, because a machine that answered an
 * hour ago is a different claim from one answering now.
 *
 * WHAT IS DRAWN IS THE MOMENT, AND THE PROFILE IS THE ONLY STANDING THING. The status line is shown
 * verbatim and parsed by nothing on this pane: `T:1,-9.751,1` is the controller's own tool-offset
 * field, this app stores no tool offset, and inventing one by reading a vendor field whose units no
 * source states is exactly the inference the bench discipline forbids. The state WORD comes from
 * `controllerState`, which is the one parser that exists for a status line. Everything in the right
 * half of the card — envelope, sensor, clearance, probe feeds — is the profile's, with its source
 * named, because those are the numbers every `.nc` this app writes is verified against (#184, #208).
 *
 * THE "MY MACHINE" FILE MOVED HERE (#247). Vise and sacrificial measurements travel with
 * `casemaker-my-machine.json`; the catalogue never goes into it (#212). Settings was where the
 * button happened to live, not where the file belonged — it is a fact about a machine, and this is
 * the machine's pane.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MACHINE_FRAME_UNREAD, MACHINE_RUN_ELSEWHERE, PRINTER_PROFILES, millModelById, type Mill } from '@/engine/cnc/machine';
import { canReachMachine, NO_MACHINE_RELAY_SENTENCE } from '@/platform/capabilities';
import { controllerState } from '@/platform/machineUpload';
import { probeMachine } from '@/platform/machineProbe';
import {
  checkSerialPort,
  listSerialPorts,
  serialAvailable,
  type SerialCheckResult,
  type SerialPortChoice,
} from '@/platform/machineSerial';
import { machineDisplayName } from '@/platform/locationClient';
import {
  MY_MACHINE_FILENAME,
  parseMyMachineFile,
  serializeMyMachineFile,
} from '@/store/myMachineFile';
import { useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useLocationStore, useMachineRecord } from '@/store/locationStore';
import { LocationCard, LocationProblemCard } from './LocationCard';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { MachineConsole } from './MachineConsole';
import { MachineFiles } from './MachineFiles';
import { MachineVacuum } from './MachineVacuum';
import { outputPlanFor } from './machineOutputs';
import { MachineLight } from './MachineLight';
import { MachineAccessory } from './MachineAccessory';
import { ACCESSORIES, AIR_SENTENCE } from '@/platform/machineAccessory';
import { MachineUnlock } from './MachineUnlock';
import { MachineStop } from './MachineStop';
import { MachineLaserOptions } from './MachineLaserOptions';
import { formatStamp, mm, timeOfDayWords } from './display';

/** One `label → value` pair in the card's two-column read-out. */
function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <b>{children}</b>
    </>
  );
}

export function MachinesScope() {
  // #566 — the build the house service reports (`/api/v1/health`). Read here, not from the page's
  // own bundle: on a machine running the installed app the service IS the build being verified,
  // and a LAN browser talking to it needs that answer rather than the page's.
  const build = useToolRegistryStore((s) => s.health?.build ?? null);
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  const checkedAt = useMachineStore((s) => s.checkedAt);
  // #1149 M3 — the heartbeat's live answer, so a machine that stopped answering stops reading as a
  // found one. `reachable` is null until the first heartbeat this session; then the check's record
  // stands, as it always did.
  const heartbeat = useMachineStore((s) => s.heartbeat);
  const unreachable = heartbeat.reachable === false;
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const forget = useMachineStore((s) => s.forget);
  const setMachineCalibration = useSettingsStore((s) => s.setMachineCalibration);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const replaceFixtures = useSettingsStore((s) => s.replaceFixtures);
  const setMargins = useSettingsStore((s) => s.setMargins);

  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [transfer, setTransfer] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

  // #775 — USB serial. The section exists only where the page can actually open a port: the Tauri
  // webview on Windows. A LAN browser served by the same build has the HTTP transport, which has no
  // serial calls, so `serialAvailable` answers false and nothing is drawn (#354's rule: do not offer
  // what cannot work).
  const [serialHere, setSerialHere] = useState(false);
  const [serialPorts, setSerialPorts] = useState<readonly SerialPortChoice[]>([]);
  const [serialPort, setSerialPort] = useState('');
  const [serialBusy, setSerialBusy] = useState(false);
  const [serialResult, setSerialResult] = useState<SerialCheckResult | null>(null);

  useEffect(() => {
    if (!canReachMachine) return;
    let live = true;
    void (async () => {
      if (!(await serialAvailable())) return;
      const ports = await listSerialPorts();
      if (!live) return;
      setSerialHere(true);
      setSerialPorts(ports);
      setSerialPort((current) => (current.length > 0 ? current : (ports[0]?.portName ?? '')));
    })();
    return () => {
      live = false;
    };
  }, []);

  async function refreshSerialPorts(): Promise<void> {
    const ports = await listSerialPorts();
    setSerialPorts(ports);
    setSerialPort((current) =>
      ports.some((p) => p.portName === current) ? current : (ports[0]?.portName ?? ''),
    );
  }

  async function connectSerial(): Promise<void> {
    setSerialBusy(true);
    try {
      setSerialResult(await checkSerialPort(serialPort));
    } finally {
      setSerialBusy(false);
    }
  }

  // `probeMachine` resolves every failure into one of its four outcomes, so there is nothing to
  // catch here — a thrown probe would be a bug in the probe, not an error to swallow.
  async function runCheck(host?: string): Promise<void> {
    setBusy(true);
    try {
      const result = await probeMachine(host === undefined ? {} : { host });
      setProbeResult(result);
      // The machine's own frame, saved where its provenance lives (#279). Only a COMPLETE read ever
      // produces one, so this cannot half-apply; a failed read leaves the saved record in force.
      if (result.kind === 'found' && result.calibration !== null) {
        setMachineCalibration(result.calibration);
      }
    } finally {
      setBusy(false);
    }
  }

  const onExportMachine = () => {
    // #345 — the house depth margins ride along with the fixtures: they are the same kind of fact
    // (numbers this machine was set up with, measured or chosen here), and the maintainer's two
    // machines should not drift on them.
    const text = serializeMyMachineFile(useSettingsStore.getState().fixtures, useSettingsStore.getState().margins);
    const why = saveText(text, MY_MACHINE_FILENAME);
    setTransfer(
      why === null
        ? { kind: 'ok', message: `Exported ${MY_MACHINE_FILENAME}` }
        : { kind: 'error', message: why },
    );
  };

  const onImportMachineFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = parseMyMachineFile(await file.text());
      if (!result.ok) {
        // Whole-or-nothing: a refused file changes nothing.
        setTransfer({ kind: 'error', message: result.reason });
        return;
      }
      replaceFixtures(result.fixtures);
      // #345 — only a file that HAS margins applies them; an older export leaves this machine's
      // own setting alone rather than resetting it to whatever the file's absent section implies.
      if (result.margins) setMargins(result.margins);
      setTransfer({ kind: 'ok', message: 'Imported — measured values restored.' });
    } catch (err) {
      setTransfer({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (importInput.current) importInput.current.value = '';
    }
  };

  // #773 — a machine record may name a MODEL whose controller frame has never been read (the
  // Carvera). The card still names it and shows its vendor row; everything positional is absent,
  // with the sentence saying what one connection supplies.
  const model = millModelById(machine?.profileId ?? null);
  const profile = model !== undefined && model.frameState === 'read' ? model : undefined;
  const record = useMachineRecord(machine);
  const typed = address.trim().length > 0;

  // #247's "my machine" file, in one node used by both cards: it is a fact about the machine setup
  // and not about whether a controller happened to answer, so an empty pane offers it too.
  const machineFileRow = (
    <div className="btn-row">
      <button
        type="button"
        className="btn btn--sm"
        data-testid="manage-machine-export"
        onClick={onExportMachine}
        title="Download the measured machine setup as JSON"
      >
        Export my machine
      </button>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="manage-machine-import"
        onClick={() => importInput.current?.click()}
        title="Restore the machine setup from a 'my machine' JSON file"
      >
        Import
      </button>
      <input
        ref={importInput}
        type="file"
        accept=".json,application/json"
        onChange={onImportMachineFile}
        data-testid="manage-machine-import-input"
        style={{ display: 'none' }}
      />
    </div>
  );

  const machineStatus = transfer !== null && (
    <p className="hint" data-testid="manage-machine-status" data-status={transfer.kind}>
      {transfer.message}
    </p>
  );

  return (
    <>
      <section className="mmain">
        <div className="mhead">
          <div>
            <h3>Machines</h3>
            <p>Machines this app has connected to.</p>
            {/* #566 — the commit this installed build came from, from the service's own health
                report. On k3 the only way to tell one fixed build from the next used to be the
                binary's md5 and the build timestamp; this is the answer in the place a person
                checking a fix against the machine already looks. Nothing is drawn where there is
                no service to ask (the static web build). */}
            {build !== null && (
              <p className="hint" data-testid="manage-app-build">
                Case Maker build <b>{build}</b>
              </p>
            )}
          </div>
          {/* #354 — a build that cannot open a socket to a controller does not offer to check one.
              The check, the address box and Connect used to sit here under a sentence saying a check
              could only ever answer "unavailable": #346's rule, which the wizard already follows. */}
          {canReachMachine && (
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--primary"
                data-testid="manage-machine-check"
                disabled={busy}
                title="Search the network for a controller and ask it what it is"
                onClick={() => void runCheck()}
              >
                {busy ? 'Checking…' : 'Check for a machine'}
              </button>
              <input
                className="fld fld--text mono"
                type="text"
                placeholder="192.168.1.50"
                value={address}
                aria-label="A controller's address"
                data-testid="manage-machine-address"
                onChange={(e) => setAddress(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                data-testid="manage-machine-connect"
                disabled={busy || !typed}
                title={
                  typed
                    ? 'Connect straight to this address, skipping the search'
                    : 'Type an address first — the search already covers this network'
                }
                onClick={() => void runCheck(address.trim())}
              >
                Connect
              </button>
            </div>
          )}
        </div>

        {/* #885 — THE BODY SCROLLS. `.mmain` is an overflow:hidden flex column, so without this
            wrapper the card's lower half (Console, then the files) could not be reached at all;
            Tools and Accessories already wrapped theirs. The header stays put. */}
        <div className="mscroll">

        {/* #821 — the relay-less deploy says why in one sentence, and where a machine can be
            driven from. */}
        {!canReachMachine && (
          <p className="hint" data-testid="manage-machine-web-hint">
            {NO_MACHINE_RELAY_SENTENCE}
          </p>
        )}

        {machine !== null ? (
          <div className="mcard" data-testid="manage-machine-card">
            <h4>
              {machineDisplayName(record, model) ?? machine.name ?? 'A controller'}{' '}
              <span className={unreachable ? 'tag tag--muted' : 'tag tag--owned'}>
                {unreachable ? 'unreachable' : 'found'}
              </span>
            </h4>
            <div className="sub">
              {machine.host} ·{' '}
              {unreachable
                ? heartbeat.lastSeenAt === null
                  ? 'unreachable · not heard since this page opened'
                  : `unreachable · last heard ${timeOfDayWords(heartbeat.lastSeenAt) ?? 'at an unreadable time'}`
                : `checked ${timeOfDayWords(checkedAt ?? machine.observedAt) ?? 'at an unreadable time'}`}
            </div>
            <div className="two">
              <div className="kv">
                <Kv label="status line">{machine.status ?? '— did not answer'}</Kv>
                <Kv label="state">
                  {controllerState(machine.status) ?? '—'}
                </Kv>
                <Kv label="busy">
                  {machine.busy === null ? (
                    '—'
                  ) : machine.busy ? (
                    'yes'
                  ) : (
                    'no'
                  )}
                </Kv>
                <Kv label="ip">{machine.ip ?? '— as broadcast'}</Kv>
                <Kv label="mac">{machine.mac ?? '— as broadcast'}</Kv>
              </div>
              <ProfileKv model={model} />
            </div>
            {machine.notes.length > 0 && (
              <ul className="notes" data-testid="manage-machine-notes">
                {machine.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <div className="btn-row">
              {/* The card is the RECORD of the last check either way; where there is no socket,
                  re-running one is offered by nothing (#354). */}
              {canReachMachine && (
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="manage-machine-recheck"
                  disabled={busy}
                  onClick={() => void runCheck(machine.host)}
                >
                  {busy ? 'Checking…' : 'Check again'}
                </button>
              )}
              {machineFileRow}
              <span className="spacer" />
              <button
                type="button"
                className="btn btn--sm btn--danger"
                data-testid="manage-machine-forget"
                title="Forget this machine — the profile keeps its own numbers; this forgets it here"
                onClick={forget}
              >
                Forget this machine
              </button>
            </div>
            {machineStatus}
            {/* #390 — the vacuum switch, above the console. Like it, it owns its own
                `canReachMachine` rule and draws nothing without it (#354's rule).

                THE `key` IS THE RESET, and it names one CONNECTION rather than one machine. The
                switch shows the mode it last sent, which is a claim about the connection that sent
                it: a machine found at a new address, or the same machine reached again — a re-check,
                a fresh wizard run, an upload's own live status — is a different connection, and what
                we sent on the old one is no longer something this panel can stand behind. A power
                cycle is the sharpest case: `M331`/`M332` do not survive it, so a remembered "on"
                would be wrong outright. `observedAt` is what moves on every one of those, so keying
                on it remounts the switch and it starts at `unknown` again. What this CANNOT see is a
                plug switched off with nothing else happening — there is no power feed in this app
                (`tools/z1/power.sh` is a person's act) and nothing polls — so the switch stops
                claiming the moment anything reaches the machine again, and not before. */}
            {/* #884 — the machine does not report these switches; say so ONCE here rather than
                "unknown" on every row. A row shows only what this page has sent (or what the
                machine's diagnose line reported, where it carries it). */}
            <p className="hint" data-testid="manage-accessory-unreported">
              These outputs are not reported by the machine; a row shows only what this page has sent.
            </p>
            <MachineVacuum
              key={`${machine.host}:${machine.port}@${machine.observedAt}`}
              host={machine.host}
              port={machine.port}
              label={
                outputPlanFor(machine.profileId ?? record?.profileId ?? null).externalOutputIsVacuum
                  ? 'External output: the vacuum on this machine'
                  : 'Vacuum'
              }
            />
            {/* #422 — the work light, the vacuum switch's shape: asked live, idle-only, `unknown`
                until it has sent something, and keyed on the observation for the same reset rule. */}
            <MachineLight
              key={`light:${machine.host}:${machine.port}@${machine.observedAt}`}
              host={machine.host}
              port={machine.port}
            />
            {/* #289 — the machine's other accessory modes, the same shape and the same reset rule:
                spindle fan (M811/M812), power fan (M801/M802), external output (M851/M852), the
                wireless-probe charge (M841/M842) — all from configZ1.default's switch instances. */}
            {(() => {
              const plan = outputPlanFor(machine.profileId ?? record?.profileId ?? null);
              return ACCESSORIES.filter((spec) =>
                spec.id === 'external-output'
                  ? !plan.externalOutputIsVacuum
                  : spec.id === 'wp-charge'
                    ? plan.showProbeCharger
                    : true,
              ).map((spec) => (
                <MachineAccessory
                  key={`${spec.id}:${machine.host}:${machine.port}@${machine.observedAt}`}
                  host={machine.host}
                  port={machine.port}
                  id={spec.id}
                />
              ));
            })()}
            {/* #289 — air is NOT offered: the Z1's switch.air is commented out, M7/M9 answer `ok`
                and blow nothing, and its blowing mode (M331.1) is not driven here. The panel states
                the fact rather than drawing a switch that does nothing. */}
            <p className="hint" data-testid="manage-accessory-no-air">
              {AIR_SENTENCE}
            </p>
            {/* #644 — clear the alarm lock ($X), offered only against a machine that reports Alarm. */}
            <MachineUnlock host={machine.host} port={machine.port} />
            {/* #424 — Stop: `abort` for a running program, labelled as not the emergency stop. */}
            <MachineStop host={machine.host} port={machine.port} />
            {/* #431 — the probe laser's two options, both off by default. */}
            <MachineLaserOptions />
            {/* #302 item 4 — the console, collapsed, at the foot of the card. It owns its own
                `canReachMachine` rule and draws nothing without it, so a web build sees the card it
                has always seen (#354's rule: do not offer what cannot work). */}
            <MachineConsole host={machine.host} port={machine.port} />
            {/* #772 — the card's files: what is on the SD card, and deleting a file this app put
                there. Same `canReachMachine` rule as the console, and the seam owns the delete
                rules (only this app's uploads, never while a job runs). */}
            <MachineFiles host={machine.host} port={machine.port} busy={machine.busy === true} />
          </div>
        ) : (
          <div className="mcard" data-testid="manage-machine-none">
            <h4>No machine yet</h4>
            <div className="sub">
              {outcome === null
                ? 'no check has run on this profile'
                : outcome === 'not-found'
                  ? 'the last check found nothing on this network'
                  : outcome === 'unavailable'
                    ? 'this build cannot reach a machine'
                    : 'the last check failed'}
              {checkedAt !== null ? ` · checked ${formatStamp(checkedAt)}` : ''}
            </div>
            {reason !== null && <p className="hint">{reason}</p>}
            {machineFileRow}
            {machineStatus}
          </div>
        )}

        {/* #775 — USB serial: a machine on its cable, with no network at all. The same protocol
            runs over this link as over TCP :2222, including the framing, but no job is sent over it
            yet — the Cut flow is network-only, and the pane says so rather than leaving a reader to
            assume. The model cannot be established: nothing on the link announces it. */}
        {canReachMachine && serialHere && (
          <div className="mcard" data-testid="manage-serial">
            <h4>
              USB serial <span className="tag tag--muted">desktop only</span>
            </h4>
            <div className="sub">
              A controller on its USB cable, with no network needed. Discovery is a LAN broadcast, so
              a serial machine cannot be found — pick its port here.
            </div>
            <div className="btn-row">
              <select
                className="fld fld--text"
                aria-label="Serial port"
                data-testid="manage-serial-port"
                value={serialPort}
                onChange={(e) => setSerialPort(e.target.value)}
              >
                {serialPorts.length === 0 && <option value="">No serial ports found</option>}
                {serialPorts.map((p) => (
                  <option key={p.portName} value={p.portName}>
                    {p.label.length > 0 ? `${p.label} (${p.portName})` : p.portName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                data-testid="manage-serial-refresh"
                onClick={() => void refreshSerialPorts()}
                title="List the serial ports again — plug the cable in, then press this"
              >
                Refresh
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="manage-serial-connect"
                disabled={serialBusy || serialPort.trim().length === 0}
                title="Open this port and ask the controller what it is"
                onClick={() => void connectSerial()}
              >
                {serialBusy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            {serialResult !== null && serialResult.kind === 'found' && (
              <div data-testid="manage-serial-result">
                <div className="two">
                  <div className="kv">
                    <Kv label="port">{serialResult.reach.portName}</Kv>
                    <Kv label="ip">{serialResult.reach.ip ?? '— not reported'}</Kv>
                    <Kv label="mac">{serialResult.reach.mac ?? '— not reported'}</Kv>
                    <Kv label="status line">{serialResult.reach.status ?? '— did not answer'}</Kv>
                    <Kv label="state">
                      {serialResult.reach.statusLine === null
                        ? '—'
                        : controllerState(serialResult.reach.status)}
                    </Kv>
                  </div>
                </div>
                {serialResult.reach.notes.length > 0 && (
                  <ul className="notes" data-testid="manage-serial-notes">
                    {serialResult.reach.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <p className="hint" data-testid="manage-serial-upload-note">
                  Programs are still sent to the machine over the network. Sending a job over USB
                  serial is not wired into the Cut flow yet — the link itself carries the same
                  protocol, and the bench check (#767) is what decides the transfer's behaviour.
                </p>
              </div>
            )}
            {serialResult !== null && serialResult.kind === 'error' && (
              <p className="hint" data-testid="manage-serial-error">
                The port did not answer: {serialResult.detail}
              </p>
            )}
            {serialResult !== null && serialResult.kind === 'unavailable' && (
              <p className="hint" data-testid="manage-serial-unavailable">
                {serialResult.reason}
              </p>
            )}
          </div>
        )}

        {/* #412 — the location's own record of this machine, read from `location.json`. Drawn only
            where there is a house service to hold one; the web build has no location. */}
        <LocationSection />

        <div className="mcard mcard--muted" data-testid="manage-printers">
          <h4>
            Printers <span className="tag tag--muted">from the profile list</span>
          </h4>
          <div className="sub">
            the printer profiles the export modal already uses — listed here for completeness,
            nothing to connect to
          </div>
          <div className="kv">
            <Kv label="profiles">{PRINTER_PROFILES.map((p) => p.name).join(' · ')}</Kv>
          </div>
        </div>
        </div>
      </section>

      <aside className="context-panel" data-testid="manage-machine-detail">
        <div className="panel-head">
          <h3>
            {machine === null
              ? 'No machine'
              : `${machineDisplayName(record, model) ?? machine.host} · from the machine’s config.txt · read ${
                  timeOfDayWords(checkedAt ?? machine.observedAt) ?? 'at an unreadable time'
                }`}
          </h3>
        </div>

        <div className="panel-subhead">Calibration read back</div>
        {calibration === undefined ? (
          <p className="hint" data-testid="manage-calibration-none">
            No calibration has been read back on this profile, so the shipped profile’s vendor
            defaults are in force. A check reads them when the controller answers.
          </p>
        ) : (
          <table className="ro" data-testid="manage-calibration">
            <tbody>
              <tr>
                <th>anchor 1</th>
                <td>
                  X {calibration.frame.anchor1[0]} · Y {calibration.frame.anchor1[1]}
                </td>
              </tr>
              <tr>
                <th>clearance</th>
                <td>
                  X {calibration.frame.clearanceXY[0]} · Y {calibration.frame.clearanceXY[1]} · Z{' '}
                  {calibration.frame.clearanceZ}
                </td>
              </tr>
              <tr>
                <th>toolrack</th>
                <td>
                  {calibration.frame.toolrackOffset[0]} · {calibration.frame.toolrackOffset[1]} ·
                  Z {calibration.frame.toolrackZ}
                </td>
              </tr>
              <tr>
                <th>soft endstops</th>
                <td>
                  {calibration.softEndstop.enabled ? 'enabled' : 'disabled'} ·{' '}
                  {calibration.softEndstop.xMin} / {calibration.softEndstop.yMin} /{' '}
                  {calibration.softEndstop.zMin}
                </td>
              </tr>
              <tr>
                <th>read</th>
                <td>{calibration.source}</td>
              </tr>
            </tbody>
          </table>
        )}

        {profile !== undefined && (
          <>
            <div className="panel-subhead">Tool-length probe</div>
            <table className="ro">
              <tbody>
                <tr>
                  <th>fast · slow</th>
                  <td>
                    {profile.toolChange.probeFastFeed} · {profile.toolChange.probeSlowFeed} mm/min
                  </td>
                </tr>
                <tr>
                  <th>retract</th>
                  <td>{mm(profile.toolChange.probeRetract)} mm</td>
                </tr>
                <tr>
                  <th>sensor</th>
                  <td>
                    X {profile.toolChange.sensor[0]} · Y {profile.toolChange.sensor[1]}{' '}
                    <span className="dim">
                      (anchor + {profile.sensorOffsetFromAnchor1[0]} · +{profile.sensorOffsetFromAnchor1[1]})
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>4th axis</th>
                  <td>
                    {profile.capabilities.rotary ? 'fitted · not simulated in V1' : 'none'}
                  </td>
                </tr>
                <tr>
                  <th>collet nut</th>
                  <td>
                    {profile.holder === null ? 'not modelled' : 'measured'}{' '}
                    {profile.holder === null && (
                      <span className="dim">asked about only for an obstacle above the stock top</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <details data-testid="manage-machine-technical">
          <summary>Technical</summary>
          <div className="panel-subhead">What a job gets from this</div>
          <p className="hint">
            The envelope gate, the tool-change positions and the probe feeds in every <code>.nc</code>{' '}
            this app writes for it — the numbers the file is verified against.
          </p>
        </details>

        {/* #416 — no "Bench power" paragraph for everyone: a machine with no switch shows nothing
            about power. A configured switch is on the machine card (`MachinePower`). */}
      </aside>
    </>
  );
}

/** The profile half of the card: the standing numbers, each with where it came from. */
function ProfileKv({ model }: { model: Mill | undefined }) {
  if (model === undefined) {
    return (
      <div className="kv">
        <Kv label="profile">
          unknown{' '}
          <span className="dim">
            — every machine-dependent number for this job is unknown, rather than borrowed from
            another machine
          </span>
        </Kv>
      </div>
    );
  }
  // #773 — a vendor row with no frame: the envelope and limits are the row's, and every position
  // the app drives to stays absent until the machine is connected once.
  if (model.frameState !== 'read') {
    // #845 — TWO NON-FRAMED CASES. `'unread'` is a vendor row whose controller has not been
    // connected once; `'stated'` is a machine the owner states and runs from their own sender.
    const stated = model.frameState === 'stated';
    const row = model.envelope;
    return (
      <div className="kv" data-testid={stated ? 'manage-profile-stated' : 'manage-profile-unread'}>
        <Kv label="profile">
          {stated ? `${model.name} — values stated by you` : `${model.name} — id “${model.id}”, vendor row only`}
        </Kv>
        <Kv label="work envelope">
          X {row.x.min} → {row.x.max} · Y {row.y.min} → {row.y.max} · Z {row.z.min} → {row.z.max} mm
        </Kv>
        <Kv label="limits">
          {model.maxCutFeed} mm/min cut feed · {model.maxRpm} RPM ·{' '}
          {model.hasATC ? `${model.toolSlots}-slot tool changer` : 'manual tool change'}
        </Kv>
        <Kv label="frame">
          <span data-testid={stated ? 'manage-profile-frame-stated' : 'manage-profile-frame-unread'}>
            {stated ? MACHINE_RUN_ELSEWHERE : MACHINE_FRAME_UNREAD}
          </span>{' '}
          <span className="dim">
            {stated
              ? '— the .nc is written for your own sender; Case Maker does not connect to this machine.'
              : `— anchors, toolrack, clearance and soft endstops are the controller's, and none has been read from a ${model.name}.`}
          </span>
        </Kv>
      </div>
    );
  }
  const profile = model;
  const { x, y, z } = profile.envelope;
  return (
    <div className="kv" data-testid="manage-profile">
      <Kv label="profile">{profile.name} — the controller's identity resolved to id “{profile.id}”</Kv>
      <Kv label="work envelope">
        X {x.min} → {x.max} · Y {y.min} → {y.max} · Z {z.min} → {z.max} mm
      </Kv>
      <Kv label="soft endstops">
        {profile.softEndstop.enabled ? 'enabled' : 'disabled'} · {profile.softEndstop.xMin} /{' '}
        {profile.softEndstop.yMin} / {profile.softEndstop.zMin}{' '}
        <span className="dim">{profile.softEndstop.source}</span>
      </Kv>
      <Kv label="limits">
        {profile.maxCutFeed} mm/min cut feed · {profile.maxRpm} RPM
      </Kv>
      <Kv label="clearance">
        X {profile.toolChange.clearanceXY[0]} · Y {profile.toolChange.clearanceXY[1]} · Z{' '}
        {profile.toolChange.clearanceZ}
      </Kv>
      <Kv label="tool change">
        {profile.hasATC ? `${profile.toolSlots}-slot automatic tool changer` : 'manual tool change'}
      </Kv>
      {/* #828 — an ATC's rack is STATED, not commanded: our post writes `Tn M6` and the controller
          drives its own slots, so the positions are here to be read, with their source. */}
      {profile.toolRack !== undefined && (
        <Kv label="tool rack">
          {profile.toolSlots} slot{profile.toolSlots === 1 ? '' : 's'} · Z {mm(profile.toolRack.z)} ·{' '}
          tool 1 X {mm(profile.toolRack.slots[0]?.[0] ?? 0)} · Y {mm(profile.toolRack.slots[0]?.[1] ?? 0)}{' '}
          <span className="dim">{profile.toolRack.source}</span>
        </Kv>
      )}
      <Kv label="collet nut">
        {profile.holder === null
          ? 'not modelled — asked about only for an obstacle above the stock top'
          : 'measured'}
      </Kv>
    </div>
  );
}

/**
 * Anchor-tag download. Returns the reason it could not be saved, or null when it was — the same
 * guard `houseStore`'s export uses, and for the same reason: a download that silently did nothing
 * is the one failure the user has no way to notice.
 */
function saveText(text: string, filename: string): string | null {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return 'this browser would not save the file — nothing is lost by trying again from a browser window';
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The location card, when this window has a location to show (#412) — or the reason it cannot. */
function LocationSection() {
  const status = useLocationStore((st) => st.status);
  const location = useLocationStore((st) => st.location);
  const reason = useLocationStore((st) => st.reason);
  const writeNote = useLocationStore((st) => st.writeNote);
  const warnings = useToolRegistryStore((st) => st.health?.warnings ?? NO_WARNINGS);
  if (status === 'error') return <LocationProblemCard reason={reason} />;
  if (status !== 'present' || location === null) return null;
  return <LocationCard location={location} writeNote={writeNote} warnings={warnings} />;
}

const NO_WARNINGS: readonly string[] = [];
