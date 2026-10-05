// Issue #74 — Gear-icon settings menu in the title bar.
// Replaces the sidebar SettingsPanel. Hides port + LAN-bind on web (those
// only affect the Tauri desktop build's embedded HTTP server).

import { useEffect, useRef, useState } from 'react';
import { useSettingsStore, type ExportFormat, type ExportLayoutMode } from '@/store/settingsStore';
import {
  MY_MACHINE_FILENAME,
  parseMyMachineFile,
  serializeMyMachineFile,
} from '@/store/myMachineFile';

function isTauri(): boolean {
  // Tauri 2 injects __TAURI_INTERNALS__ into window.
  return typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

/** Anchor-tag download for the "my machine" JSON — the same fallback the project save uses. */
function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  onClose: () => void;
}

export function SettingsMenu({ onClose }: Props) {
  const port = useSettingsStore((s) => s.port);
  const bindAll = useSettingsStore((s) => s.bindToAll);
  const exportLayout = useSettingsStore((s) => s.exportLayout);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const setPort = useSettingsStore((s) => s.setPort);
  const setBindAll = useSettingsStore((s) => s.setBindToAll);
  const setExportLayout = useSettingsStore((s) => s.setExportLayout);
  const setExportFormat = useSettingsStore((s) => s.setExportFormat);
  const reset = useSettingsStore((s) => s.resetSettings);
  const replaceFixtures = useSettingsStore((s) => s.replaceFixtures);
  const [draftPort, setDraftPort] = useState<string>(String(port));
  const [transfer, setTransfer] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  const showServerControls = isTauri();

  const onExportMachine = () => {
    const text = serializeMyMachineFile(useSettingsStore.getState().fixtures);
    downloadText(text, MY_MACHINE_FILENAME);
    setTransfer({ kind: 'ok', message: `Exported ${MY_MACHINE_FILENAME}` });
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

      <div className="settings-section">
        <h4>My machine</h4>
        <p className="settings-hint">
          Export the saved vise and sacrificial setup as one JSON, or restore it on another
          machine. A file that does not validate is refused whole.
        </p>
        <div className="settings-row settings-row-buttons">
          <button
            onClick={onExportMachine}
            data-testid="settings-machine-export"
            title="Download the measured machine setup as JSON"
          >
            Export…
          </button>
          <button
            onClick={() => importInput.current?.click()}
            data-testid="settings-machine-import"
            title="Restore the machine setup from a 'my machine' JSON file"
          >
            Import…
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            onChange={onImportMachineFile}
            data-testid="settings-machine-import-input"
            style={{ display: 'none' }}
          />
        </div>
        {transfer && (
          <p
            className={`settings-hint settings-transfer settings-transfer-${transfer.kind}`}
            data-testid="settings-machine-status"
            data-status={transfer.kind}
          >
            {transfer.message}
          </p>
        )}
      </div>

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
