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

import { useRef, useState, type ReactNode } from 'react';
import { MACHINES, PRINTER_PROFILES, type MillProfile } from '@/engine/cnc/machine';
import { canDriveMachine } from '@/platform/capabilities';
import { controllerState } from '@/platform/machineUpload';
import { probeMachine } from '@/platform/machineProbe';
import {
  MY_MACHINE_FILENAME,
  parseMyMachineFile,
  serializeMyMachineFile,
} from '@/store/myMachineFile';
import { useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { formatStamp, mm } from './display';

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
  const machine = useMachineStore((s) => s.machine);
  const outcome = useMachineStore((s) => s.outcome);
  const reason = useMachineStore((s) => s.reason);
  const checkedAt = useMachineStore((s) => s.checkedAt);
  const setProbeResult = useMachineStore((s) => s.setProbeResult);
  const forget = useMachineStore((s) => s.forget);
  const setMachineCalibration = useSettingsStore((s) => s.setMachineCalibration);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const replaceFixtures = useSettingsStore((s) => s.replaceFixtures);

  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [transfer, setTransfer] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

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
    const text = serializeMyMachineFile(useSettingsStore.getState().fixtures);
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
      setTransfer({ kind: 'ok', message: 'Imported — measured values restored.' });
    } catch (err) {
      setTransfer({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (importInput.current) importInput.current.value = '';
    }
  };

  const profile = machine?.profileId != null ? MACHINES[machine.profileId] : undefined;
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
            <p>
              The machines this app has reached, each as it answered last time. A check asks the
              network; the machine answers or it does not.
            </p>
          </div>
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
        </div>

        {!canDriveMachine && (
          <p className="hint" data-testid="manage-machine-web-hint">
            This build cannot open a raw socket to a controller, so a check can only ever answer
            “unavailable”. The desktop build is the one that can reach a machine on your LAN.
          </p>
        )}

        {machine !== null ? (
          <div className="mcard" data-testid="manage-machine-card">
            <h4>
              {profile?.name ?? machine.name ?? 'A controller'}{' '}
              <span className="tag tag--owned">found</span>
              <span className="badge">
                profile: {machine.profileId ?? 'unknown'}
              </span>
            </h4>
            <div className="sub">
              {machine.host} : {machine.port} · checked{' '}
              {formatStamp(checkedAt ?? machine.observedAt) ?? 'at an unreadable time'} · a record of
              that moment, not a standing claim
            </div>
            <div className="two">
              <div className="kv">
                <Kv label="status line">{machine.status ?? '— did not answer'}</Kv>
                <Kv label="state">
                  {controllerState(machine.status) ?? '—'}
                </Kv>
                <Kv label="busy">
                  {machine.busy === null ? (
                    <>
                      — <span className="dim">nothing announced it; a typed address has no broadcast</span>
                    </>
                  ) : machine.busy ? (
                    'yes'
                  ) : (
                    'no'
                  )}
                </Kv>
                <Kv label="ip">{machine.ip ?? '— as broadcast'}</Kv>
                <Kv label="mac">{machine.mac ?? '— as broadcast'}</Kv>
              </div>
              <ProfileKv profile={profile} />
            </div>
            {machine.notes.length > 0 && (
              <ul className="notes" data-testid="manage-machine-notes">
                {machine.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--sm"
                data-testid="manage-machine-recheck"
                disabled={busy}
                onClick={() => void runCheck(machine.host)}
              >
                {busy ? 'Checking…' : 'Check again'}
              </button>
              {machineFileRow}
              <span className="spacer" />
              <button
                type="button"
                className="btn btn--sm btn--danger"
                data-testid="manage-machine-forget"
                title="Forget this machine — the profile keeps its own numbers, this drops our record of it"
                onClick={forget}
              >
                Forget this machine
              </button>
            </div>
            {machineStatus}
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
      </section>

      <aside className="context-panel" data-testid="manage-machine-detail">
        <div className="panel-head">
          <h3>{machine === null ? 'No machine' : `${profile?.name ?? machine.host} · last check`}</h3>
        </div>
        <p className="hint">
          {machine === null
            ? 'A check writes a record here: where the machine answered, when, and which profile its identity resolved to. Nothing on this rail is edited by hand — the machine owns these numbers, and “Forget” is the only write.'
            : `Everything here was read from the machine at ${formatStamp(checkedAt ?? machine.observedAt) ?? 'an unreadable time'}. Nothing is edited on this rail: the machine owns these numbers, and “Forget” is the only write.`}
        </p>

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
                    <span className="dim">(anchor + 181)</span>
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
                    {profile.holder === null && <span className="dim">the holder gate says so</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <div className="panel-subhead">What a job gets from this</div>
        <p className="hint">
          The envelope gate, the tool-change positions and the probe feeds in every <code>.nc</code>{' '}
          this app writes for it — the numbers the file is verified against (#184, #208).
        </p>

        <div className="panel-subhead">Bench power</div>
        <p className="hint">
          Not here. The plug is a physical act and stays with the person at the machine
          (<code>tools/z1/power.sh</code>).
        </p>
      </aside>
    </>
  );
}

/** The profile half of the card: the standing numbers, each with where it came from. */
function ProfileKv({ profile }: { profile: MillProfile | undefined }) {
  if (profile === undefined) {
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
  const { x, y, z } = profile.envelope;
  return (
    <div className="kv">
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
      <Kv label="collet nut">
        {profile.holder === null ? 'not modelled — the holder gate says the clearance is unproven' : 'measured'}
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
