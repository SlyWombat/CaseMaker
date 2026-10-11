// Issue #74 — Gear-icon settings menu in the title bar.
// Replaces the sidebar SettingsPanel. Hides port + LAN-bind on web (those
// only affect the Tauri desktop build's embedded HTTP server).

// #311 — the "My machine" block that used to live here MOVED. The `casemaker-my-machine.json`
// round trip (vise and sacrificial measurements, #247) is a fact about a machine, so it now sits on
// the Machines pane of the Manage surface, beside the machine it describes. Settings keeps the
// settings.

import { useEffect, useRef, useState } from 'react';
import { useSettingsStore, type ExportFormat, type ExportLayoutMode } from '@/store/settingsStore';
import { MARGIN_DEFAULTS, type MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import { featureSim } from '@/platform/features';
import { canRunLocalServer } from '@/platform/capabilities';

interface Props {
  onClose: () => void;
}

/**
 * One house depth margin (#345): a draft string, committed on blur.
 *
 * The draft is why this is its own component — half-typed text (`0.`) must not be parsed into a
 * setting on every keystroke, and `setPort` above already learned that lesson. Non-numeric or
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
          if (draft.trim() !== '' && Number.isFinite(v) && v >= 0) onCommit(v);
          else setDraft(String(value));
        }}
      />
    </div>
  );
}

export function SettingsMenu({ onClose }: Props) {
  const port = useSettingsStore((s) => s.port);
  const bindAll = useSettingsStore((s) => s.bindToAll);
  const exportLayout = useSettingsStore((s) => s.exportLayout);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const margins = useSettingsStore((s) => s.margins);
  const setPort = useSettingsStore((s) => s.setPort);
  const setBindAll = useSettingsStore((s) => s.setBindToAll);
  const setExportLayout = useSettingsStore((s) => s.setExportLayout);
  const setExportFormat = useSettingsStore((s) => s.setExportFormat);
  const setMargins = useSettingsStore((s) => s.setMargins);
  const reset = useSettingsStore((s) => s.resetSettings);
  const [draftPort, setDraftPort] = useState<string>(String(port));
  const ref = useRef<HTMLDivElement | null>(null);
  // #181 — the embedded-server controls are a desktop capability, not a runtime property of the
  // window. `canRunLocalServer` is a build-time constant, so the web build never even carries them.
  const showServerControls = canRunLocalServer;

  // #345 — a house margin the user has typed. Stamping the source here is what keeps the run sheet
  // honest: `'default'` means "one printed layer, read off the blank", `'user'` means "this number,
  // deliberately". A margin left on `'default'` keeps following each blank's own layer height.
  const commitMargin = (patch: Partial<MarginSettings>): void =>
    setMargins({ ...margins, ...patch, source: 'user' });

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

      {showServerControls && (
        <>
          <div className="settings-row">
            <label htmlFor="settings-port">App port</label>
            <input
              id="settings-port"
              type="number"
              min={1024}
              max={65535}
              value={draftPort}
              onChange={(e) => setDraftPort(e.target.value)}
              onBlur={() => {
                setPort(Number(draftPort));
                setDraftPort(String(useSettingsStore.getState().port));
              }}
              data-testid="settings-port"
              title="HTTP port the embedded server binds to (desktop only). 1024–65535."
            />
          </div>
          <p className="settings-hint">
            Active port: <strong data-testid="settings-port-active">{port}</strong>. Range 1024–65535. Restart the desktop app to apply.
          </p>
          <label className="settings-check" title="If enabled, the desktop server binds to all network interfaces so other devices on the LAN can reach it.">
            <input
              type="checkbox"
              checked={bindAll}
              onChange={(e) => setBindAll(e.target.checked)}
              data-testid="settings-bind-all"
              aria-label="Allow LAN access"
              title="Bind the desktop server to 0.0.0.0 — exposes it to other LAN devices."
            />
            <span>Allow LAN access (bind 0.0.0.0)</span>
          </label>
        </>
      )}

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
