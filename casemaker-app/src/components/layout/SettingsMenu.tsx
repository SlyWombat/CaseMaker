// Issue #74 — Gear-icon settings menu in the title bar. Replaces the sidebar SettingsPanel.
//
// The server controls are a desktop capability (#181) and are not drawn in a web build, which has no
// embedded HTTP server to configure. WHAT THEY WRITE changed in #372: they used to set a value in
// `settingsStore` that nothing on the Rust side ever read, so the field could not have changed the
// port the app binds to. They now read and write `config.json` through `platform/houseClient`, which
// is the file `lib.rs` starts from — and the fact that a change applies at the NEXT start is a
// property of the app's origin, not a stale note, so the section says so and explains the cost.

// #311 — the "My machine" block that used to live here MOVED. The `casemaker-my-machine.json`
// round trip (vise and sacrificial measurements, #247) is a fact about a machine, so it now sits on
// the Machines pane of the Manage surface, beside the machine it describes. Settings keeps the
// settings.

import { useEffect, useRef, useState } from 'react';
import { useSettingsStore, type ExportFormat, type ExportLayoutMode } from '@/store/settingsStore';
import { MARGIN_DEFAULTS, type MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import { featureSim } from '@/platform/features';
import { canRunLocalServer } from '@/platform/capabilities';
import {
  houseSaveServerConfig,
  houseServerConfig,
  type HouseFailure,
  type ServerConfig,
} from '@/platform/houseClient';

interface Props {
  onClose: () => void;
}

/**
 * Why a settings call came back with nothing, in the words the service gave — a refusal is written
 * for the user (`houseClient`'s own contract) and is shown as-is, never re-worded here. `absent` and
 * `error` are the transport's, and they read as what they are: nothing usable answered.
 */
function sentenceOf(failure: HouseFailure): string {
  return failure.kind === 'refused'
    ? failure.message
    : failure.kind === 'absent'
      ? failure.reason
      : failure.detail;
}

/**
 * The app's own server settings (#372) — the one section of this dialog that is NOT in
 * `settingsStore`, and deliberately so. These two values are read by `lib.rs` from `config.json` at
 * start-up; a copy in an origin-keyed store is the defect this section replaces. So the section
 * reads and writes that file, over `/api/v1/config`, and shows what the file says rather than what
 * the user last typed.
 *
 * WHAT "APPLIES NEXT START" MEANS HERE. A change cannot take effect under the running page: the
 * window is loaded from `http://127.0.0.1:<port>`, so the port is part of the app's ORIGIN, and
 * moving it would leave every origin-keyed store behind — settings, library, run records — while the
 * page kept the old storage. That is why the response carries both numbers and why the banner appears
 * only while they disagree: it is the one moment the user can still be told, in the words the #312
 * refusal uses, what the restart costs.
 *
 * A LAN BROWSER SEES THIS TOO, and can read it: the service answers the read for anyone, because the
 * dialog is how that browser finds out what it is looking at. Its WRITE is refused — loopback only
 * (decision 35) — and the refusal shown here is the service's own sentence, not a second copy of it.
 */
function ServerSection() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // The setting can arrive after the first render, so the draft follows it — adjusted DURING the
  // render that noticed the change rather than in an effect, the same pattern `MarginRow` uses.
  const [seen, setSeen] = useState<number | null>(null);
  if (config !== null && config.port !== seen) {
    setSeen(config.port);
    setDraft(String(config.port));
  }

  // Read on open rather than from a cache: `config.json` is a plain file a user can edit by hand
  // between two visits to this dialog, and the numbers shown have to be the ones the app will read.
  useEffect(() => {
    let live = true;
    void houseServerConfig().then((res) => {
      if (!live) return;
      if (res.kind === 'ok') setConfig(res.config);
      else setFailure(sentenceOf(res));
    });
    return () => {
      live = false;
    };
  }, []);

  // The answer IS the new state, so both numbers come back from the service: `port` (what the next
  // start will bind) and `servingPort` (what this process is on). Nothing is assumed locally.
  const save = async (next: { port: number; bindToAll: boolean }): Promise<void> => {
    if (config === null) return;
    // What the file holds as this request goes out, and so what the box goes back to if it is refused.
    const before = config.port;
    const res = await houseSaveServerConfig(next);
    if (res.kind === 'ok') {
      setConfig(res.config);
      setFailure(null);
      setDraft(String(res.config.port));
    } else {
      setFailure(sentenceOf(res));
      // The file did not change, so the box goes back to what it holds. Leaving the refused number on
      // screen would be the very defect this section replaces: a field showing a value nothing
      // honours, with the only evidence being a sentence underneath it.
      setDraft(String(before));
    }
  };

  const commitPort = (): void => {
    if (config === null) return;
    const port = Number(draft);
    // Not a number at all is not a statement about a port, so it is not sent: the box goes back to
    // what the setting IS. Everything a number can be wrong about — the range, the type — is the
    // service's judgement, and its refusal names the port and the range it would have accepted.
    if (draft.trim() === '' || !Number.isFinite(port)) {
      setDraft(String(config.port));
      return;
    }
    if (port === config.port) return;
    void save({ port, bindToAll: config.bindToAll });
  };

  const pending = config !== null && config.port !== config.servingPort;

  return (
    <>
      <div className="settings-subhead">App server</div>
      {config !== null && (
        <>
          <div className="settings-row">
            <label htmlFor="settings-port">App port</label>
            <input
              id="settings-port"
              type="number"
              min={1024}
              max={65535}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitPort}
              data-testid="settings-port"
              title="The port Case Maker serves its own interface on. 1024–65535."
            />
          </div>
          <p className="settings-hint">
            Range 1024–65535. Case Maker serves its own interface on this port; a change applies the
            next time the app starts.
          </p>
          <label
            className="settings-check"
            title="If enabled, the desktop server binds to all network interfaces at its next start, so other devices on the LAN can reach it."
          >
            <input
              type="checkbox"
              checked={config.bindToAll}
              onChange={(e) => {
                if (config !== null) void save({ port: config.port, bindToAll: e.target.checked });
              }}
              data-testid="settings-bind-all"
              aria-label="Allow LAN access"
              title="Bind the desktop server to 0.0.0.0 — exposes it to other LAN devices."
            />
            <span>Allow LAN access (bind 0.0.0.0)</span>
          </label>
          {pending && (
            <p className="settings-hint" data-testid="settings-port-pending">
              Saved for the next start — this one is still serving on{' '}
              <strong data-testid="settings-serving-port">{config.servingPort}</strong>. A different
              port is a different origin, and the app would come up with your saved settings, library
              and run records missing.
            </p>
          )}
        </>
      )}
      {failure !== null && (
        <p className="settings-hint" data-testid="settings-server-error">
          {failure}
        </p>
      )}
    </>
  );
}

/**
 * One house depth margin (#345): a draft string, committed on blur.
 *
 * The draft is why this is its own component — half-typed text (`0.`) must not be parsed into a
 * setting on every keystroke, which is the lesson the old port field here taught. Non-numeric or
 * negative input commits nothing and the box snaps back to what the setting actually is, rather
 * than being silently replaced by a number the user did not type.
 */
function MarginRow({
  id,
  label,
  title,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  title: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // The setting can move under this box (the reset button, another window), so the draft follows it
  // — adjusted DURING the render that noticed the change rather than in an effect, which is the one
  // pattern React allows for state derived from props.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(String(value));
  }
  return (
    <div className="settings-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={0}
        step={0.01}
        value={draft}
        data-testid={id}
        title={title}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = Number(draft);
          if (draft.trim() === '' || !Number.isFinite(v) || v < 0) {
            setDraft(String(value));
            return;
          }
          // #345 review — commit only a REAL change. Tab-through used to call `onCommit` with the
          // value already in the box, and for a margin that stamped `source: 'user'`, stopping it
          // from following each blank's own layer height — the failure the comment above warns
          // about, reachable without typing a character.
          if (v !== value) onCommit(v);
        }}
      />
    </div>
  );
}

export function SettingsMenu({ onClose }: Props) {
  const exportLayout = useSettingsStore((s) => s.exportLayout);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const margins = useSettingsStore((s) => s.margins);
  const setExportLayout = useSettingsStore((s) => s.setExportLayout);
  const setExportFormat = useSettingsStore((s) => s.setExportFormat);
  const setMargins = useSettingsStore((s) => s.setMargins);
  const reset = useSettingsStore((s) => s.resetSettings);
  const ref = useRef<HTMLDivElement | null>(null);
  // #181 — the embedded-server controls are a desktop capability, not a runtime property of the
  // window. `canRunLocalServer` is a build-time constant, so the web build never even carries them.
  const showServerControls = canRunLocalServer;

  // #345 — a house margin the user has typed. Stamping the source here is what keeps the run sheet
  // honest: `'default'` means "one printed layer, read off the blank", `'user'` means "this number,
  // deliberately". A margin left on `'default'` keeps following each blank's own layer height.
  //
  // Only the two margins a job COPIES from this screen flip the source (#345 review). The four
  // "a new job starts from" fields seed a job's own per-job values and never enter
  // `effectiveMargins`, so retyping the minimum floor has said nothing about the boundary margin —
  // flipping the source for it would silently pin every future blank to the house 0.2 and stop a
  // 0.3-layer blank from moving its own boundary. The same goes for #362's jaw clearance: it seeds
  // a job's own number and is read off the document by the check.
  const commitMargin = (patch: Partial<MarginSettings>): void => {
    const copied = 'boundaryMargin' in patch || 'zTolerance' in patch;
    setMargins({ ...margins, ...patch, source: copied ? 'user' : margins.source });
  };

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    // Defer one tick so the click that opened the popover doesn't immediately
    // close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="settings-menu" ref={ref} role="dialog" aria-label="App settings" data-testid="settings-menu">
      <h3>App settings</h3>

      {showServerControls && <ServerSection />}

      <div className="settings-row">
        <label htmlFor="settings-export-format">Export format</label>
        <select
          id="settings-export-format"
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
          data-testid="settings-export-format"
          title="Default export file format used by the toolbar Export button."
        >
          <option value="stl-binary">STL (binary)</option>
          <option value="stl-ascii">STL (ASCII)</option>
          <option value="3mf">3MF</option>
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-export-layout">Export layout</label>
        <select
          id="settings-export-layout"
          value={exportLayout}
          onChange={(e) => setExportLayout(e.target.value as ExportLayoutMode)}
          data-testid="settings-export-layout"
          title="Print-ready flips the lid for the slicer. Assembled keeps both halves stacked for visualization."
        >
          <option value="print-ready">Print-ready (lid flipped)</option>
          <option value="assembled">Assembled (visualization)</option>
        </select>
      </div>

      {/* #345 — the house depth margins, the CNC's half of the settings. Behind `featureSim` like
          the rest of that surface: a build with no CNC in it shows no CNC knobs. */}
      {featureSim && (
        <>
          <div className="settings-subhead">Depth margins (CNC)</div>
          <MarginRow
            id="settings-margin-boundary"
            label="Boundary margin (mm)"
            title="How far every floor stays clear of a plane it must not cross — a void's ceiling, the colour split. The shipped 0.2 is one printed layer."
            value={margins.boundaryMargin}
            onCommit={(v) => commitMargin({ boundaryMargin: v })}
          />
          <MarginRow
            id="settings-margin-z"
            label="Z tolerance (mm)"
            title="How far this machine expects the blank and the registration to put it out in Z. Per-job values are recommended from this plus the blank's own dome."
            value={margins.zTolerance}
            onCommit={(v) => commitMargin({ zTolerance: v })}
          />
          <div className="settings-subhead">A new job starts from</div>
          <MarginRow
            id="settings-margin-floor"
            label="Minimum floor (mm)"
            title="Material that must remain under the deepest cut. Seeds each new job; every job owns its own value afterward."
            value={margins.minFloor}
            onCommit={(v) => commitMargin({ minFloor: v })}
          />
          <MarginRow
            id="settings-margin-edge"
            label="Edge margin (mm)"
            title="How close an item may come to a stock edge. Seeds each new job."
            value={margins.edgeMargin}
            onCommit={(v) => commitMargin({ edgeMargin: v })}
          />
          <MarginRow
            id="settings-margin-breakthrough"
            label="Breakthrough (mm)"
            title="How far a through-cut may pass below the part's underside. Seeds each new job."
            value={margins.breakthrough}
            onCommit={(v) => commitMargin({ breakthrough: v })}
          />
          <MarginRow
            id="settings-margin-jaw"
            label="Jaw clearance (mm)"
            title="How far a cut's floor must stay above the vise jaws' tops. Seeds each new job — and a job handed a thin blank gets a label depth recommended from it, so the wizard does not open on a finding."
            value={margins.jawClearance}
            onCommit={(v) => commitMargin({ jawClearance: v })}
          />
          <p className="settings-hint" data-testid="settings-margins-source">
            {margins.source === 'default' ? (
              <>
                Reading the shipped defaults: the boundary margin is one printed layer of each
                blank, so a badge with 0.3 mm layers gets 0.3 without anyone typing it.
              </>
            ) : (
              <>These are your own numbers. Every job that states none runs on them.</>
            )}{' '}
            <button
              type="button"
              data-testid="settings-margins-reset"
              title="Put the depth margins back to the shipped defaults — the rest of the settings are left alone"
              onClick={() => setMargins({ ...MARGIN_DEFAULTS })}
            >
              Restore the shipped margins
            </button>
          </p>
        </>
      )}

      <button
        onClick={reset}
        data-testid="settings-reset"
        className="settings-reset"
        title="Restore all settings to their defaults"
      >
        Reset to defaults
      </button>
    </div>
  );
}
