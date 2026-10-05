import { useState, type CSSProperties, type DragEvent, type JSX } from 'react';
import { useSimSetupStore, buildSimSetup } from '@/store/simSetupStore';
import { isSimSceneActive, useSimStore } from '@/store/simStore';
import { TOOL_LIBRARY, Z1 } from '@/engine/cnc';
import { libraryTool } from '@/engine/cnc/toolLibrary';
import type { StartingTool } from '@/engine/cnc';
import type { DiagnosticSource, SimDiagnostic } from '@/workers/sim/session';
import { MAX_TEXT_FILE_BYTES, openTextFile } from '@/utils/openTextFile';
import { GcodePane } from '@/components/panels/GcodePane';
import { coverageDisclaimer, type SimRunOutcome } from '@/components/panels/simCoverage';

/**
 * The Simulate panel (#196): open a `.nc`, confirm the stock and the tool, run the sweep, and
 * read the diagnostics. The viewport (#197) and the transport bar (#198) are separate issues.
 *
 * All simulation state lives in `simStore` (never `jobStore`, whose `nodes` map is enumerated by
 * export, `FloatersBanner` and `PartsMenu`). The form's own state lives in `simSetupStore`.
 */

const EXTENSIONS = ['.nc', '.gcode', '.cnc', '.tap'];

const DISCLAIMER =
  'This simulation assumes a rigid, ideal machine: no deflection, no runout, no Z-chain error, no chatter.';

const STUB_TITLE = "The part's position on the bed is assumed, not measured.";

const SEVERITY_ORDER: Record<SimDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_COLOR: Record<SimDiagnostic['severity'], string> = {
  error: '#ffb4ab',
  warning: '#e0c07a',
  info: '#9aa4b0',
};

const SOURCES: DiagnosticSource[] = ['parser', 'runner', 'sweep'];

interface DiagRow {
  source: DiagnosticSource;
  code: string;
  severity: SimDiagnostic['severity'];
  message: string;
  line?: number;
  /** Number of records with this code; for runner codes this is the true, uncapped count. */
  count: number;
}

/**
 * One row per (source, code), errors first within each source. A runner code's count is the true
 * `summary.diagnosticCounts[code]`, not the length of the list that reached the UI: the runner
 * caps how many records it emits (#194), so the list is not the count.
 */
function groupDiagnostics(diagnostics: SimDiagnostic[], counts: Record<string, number>): Map<DiagnosticSource, DiagRow[]> {
  const groups = new Map<DiagnosticSource, DiagRow[]>(SOURCES.map((s) => [s, []]));
  const byKey = new Map<string, DiagRow>();
  for (const d of diagnostics) {
    const key = `${d.source}:${d.code}`;
    let row = byKey.get(key);
    if (!row) {
      row = { source: d.source, code: d.code, severity: d.severity, message: d.message, line: d.line, count: 0 };
      byKey.set(key, row);
      groups.get(d.source)?.push(row);
    }
    row.count++;
    if (SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[row.severity]) row.severity = d.severity;
    if (row.line === undefined && d.line !== undefined) row.line = d.line;
  }
  for (const row of byKey.values()) {
    if (row.source === 'runner') row.count = counts[row.code] ?? row.count;
  }
  for (const rows of groups.values()) rows.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return groups;
}

function severitySummary(rows: DiagRow[]): string {
  const parts: string[] = [];
  for (const sev of ['error', 'warning', 'info'] as const) {
    const n = rows.filter((r) => r.severity === sev).reduce((s, r) => s + r.count, 0);
    if (n > 0) parts.push(`${n} ${sev}${n === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const SUBHEAD: CSSProperties = { margin: '12px 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' };
const FIELD: CSSProperties = { width: 78 };
const TAG: CSSProperties = {
  fontSize: 10,
  color: '#9aa4b0',
  border: '1px solid #2a2f36',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
};
const DISCLAIM: CSSProperties = { ...MUTED, color: '#c8d3de', borderTop: '1px solid #2a2f36', paddingTop: 6 };
/** A diagnostic's line, clickable to reveal it in the G-code pane (#245). */
const LINELINK: CSSProperties = {
  font: 'inherit',
  color: '#8fb4ff',
  background: 'transparent',
  border: 0,
  padding: '0 2px',
  cursor: 'pointer',
  textDecoration: 'underline dotted',
};
/** Save a generated restart `.nc`. Plain text, unlike SettingsMenu's JSON export. */
function downloadNc(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SimPanel() {
  const fileName = useSimSetupStore((s) => s.fileName);
  const gcodeText = useSimSetupStore((s) => s.gcodeText);
  const stock = useSimSetupStore((s) => s.stock);
  const stockSource = useSimSetupStore((s) => s.stockSource);
  const toolKey = useSimSetupStore((s) => s.toolKey);
  const toolSource = useSimSetupStore((s) => s.toolSource);
  const headerDiagnostics = useSimSetupStore((s) => s.headerDiagnostics);
  const openFile = useSimSetupStore((s) => s.openFile);
  const setStock = useSimSetupStore((s) => s.setStock);
  const setTool = useSimSetupStore((s) => s.setTool);
  const resetSetup = useSimSetupStore((s) => s.reset);

  const status = useSimStore((s) => s.status);
  const error = useSimStore((s) => s.error);
  const diagnostics = useSimStore((s) => s.diagnostics);
  const info = useSimStore((s) => s.info);
  const progress = useSimStore((s) => s.progress);
  const phase = useSimStore((s) => s.phase);
  const pathOnly = useSimStore((s) => s.pathOnly);
  const meshes = useSimStore((s) => s.meshes);
  const step = useSimStore((s) => s.step);
  const stepCount = useSimStore((s) => s.stepCount);
  const restart = useSimStore((s) => s.restart);

  const [startingTool, setStartingTool] = useState<StartingTool>('unknown');
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** A diagnostic's line the user asked to reveal in the G-code pane (#245). */
  const [jump, setJump] = useState<{ line: number; seq: number } | null>(null);

  const tool = toolKey ? libraryTool(toolKey) : null;
  const loading = status === 'loading';
  const canSimulate = gcodeText !== null && tool !== null && !loading;

  // #243 — the blind-spot sentence, assembled from what this run actually carried: the fixture
  // obstacles it was given (#204), whether sacrificial material was modelled, the machine's own
  // holder (null on the Z1, so the collet nut is unmodelled), and the "cannot be proven" codes
  // the sweep raised. The physics caveat stays a constant; this half changes per run.
  const outcome: SimRunOutcome = status === 'ready' ? 'swept' : pathOnly ? 'path-only' : 'refused';
  const coverage = coverageDisclaimer({
    outcome,
    fixtureLabels: (meshes?.fixture ?? []).map((f) => f.label),
    fixtureSource: info?.fixtureSource,
    sacrificialModelled: meshes?.sacrificial != null,
    holderKnown: Z1.holder !== null,
    toolName: tool?.name ?? null,
    codes: diagnostics.map((d) => d.code),
  });

  function jumpToLine(line: number): void {
    setJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 }));
  }

  function loadFile(name: string, text: string): void {
    setFileError(null);
    setStartingTool('unknown');
    setJump(null);
    // A restart belongs to the program on screen: opening another one drops it.
    useSimStore.getState().clearRestart();
    openFile(name, text);
  }

  async function handleOpen(): Promise<void> {
    try {
      const file = await openTextFile({ description: 'G-code', extensions: EXTENSIONS });
      if (file) loadFile(file.name, file.text);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.size > MAX_TEXT_FILE_BYTES) {
      setFileError(`${file.name} is larger than the ${MAX_TEXT_FILE_BYTES / (1024 * 1024)} MB limit.`);
      return;
    }
    loadFile(file.name, await file.text());
  }

  async function simulate(): Promise<void> {
    if (!gcodeText || !tool) return;
    await useSimStore.getState().loadProgram(gcodeText, buildSimSetup(stock, startingTool), tool, Z1.id);
  }

  async function cancel(): Promise<void> {
    if (__FEATURE_SIM__) {
      const client = await import('@/engine/jobs/simClient');
      client.terminateSim();
    }
    await useSimStore.getState().dispose();
  }

  async function close(): Promise<void> {
    await useSimStore.getState().dispose();
    resetSetup();
    setStartingTool('unknown');
    setFileError(null);
    setJump(null);
  }

  const stockRow = (key: keyof typeof stock, label: string): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ minWidth: 62, fontSize: 12 }}>{label}</span>
      <input
        type="number"
        step="any"
        min={0}
        value={stock[key]}
        data-testid={`sim-stock-${key}`}
        aria-label={`Stock ${label}`}
        title={`Stock ${label} in mm. Z = 0 at the stock’s top face; material sits at negative Z.${
          stockSource[key] === 'header' ? ' Prefilled from the file’s STOCK record.' : ''
        }`}
        style={FIELD}
        onChange={(e) => setStock({ [key]: Number(e.target.value) } as Partial<typeof stock>)}
      />
      {stockSource[key] === 'header' && <span style={TAG}>from file header</span>}
    </div>
  );

  const diagRow = (row: DiagRow): JSX.Element => {
    const line = row.line;
    return (
      <div
        key={`${row.source}:${row.code}`}
        data-testid={`sim-diag-${row.source}-${row.code}`}
        style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, margin: '3px 0', color: '#d1d5db' }}
      >
        <span style={{ color: SEVERITY_COLOR[row.severity], flexShrink: 0 }}>●</span>
        <span>
          <code style={{ color: SEVERITY_COLOR[row.severity] }}>{row.code}</code>{' '}
          {row.count > 1 && <strong>{row.count} × </strong>}
          {row.message}
          {line !== undefined && (
            <button
              type="button"
              data-testid={`sim-diag-jump-${row.source}-${row.code}`}
              onClick={() => jumpToLine(line)}
              title={row.count > 1 ? 'Show the first of these lines in the G-code pane' : 'Show this line in the G-code pane'}
              style={LINELINK}
            >
              line {line}
            </button>
          )}
        </span>
      </div>
    );
  };

  const grouped = status === 'ready' ? groupDiagnostics(diagnostics, info?.summary.diagnosticCounts ?? {}) : null;

  return (
    <div
      className="panel-stack"
      data-testid="sim-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
      style={dragOver ? { outline: '1px dashed #3a5a7a', outlineOffset: 4 } : undefined}
    >
      {/* 1 — the file */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="sim-file-name">
          {fileName ?? 'No file open'}
        </span>
        <button type="button" data-testid="sim-open" onClick={() => void handleOpen()}>
          Open .nc…
        </button>
      </div>
      {!fileName && (
        <p style={MUTED} data-testid="sim-drop-hint">
          Drop a .nc, .gcode, .cnc or .tap file here (max 64 MB). The file is parsed, run and swept
          in the app — nothing is uploaded, and nothing is sent to a machine.
        </p>
      )}
      {fileError && (
        <p style={{ color: '#ffb4ab', fontSize: 11 }} data-testid="sim-file-error">
          {fileError}
        </p>
      )}

      {headerDiagnostics.length > 0 && (
        <>
          <h3 style={SUBHEAD}>File header</h3>
          {headerDiagnostics.map((d, i) => (
            <div key={i} style={{ fontSize: 11, color: d.severity === 'warning' ? SEVERITY_COLOR.warning : SEVERITY_COLOR.info, lineHeight: 1.45 }}>
              {d.message}
            </div>
          ))}
        </>
      )}

      {/* 2 — stock */}
      <h3 style={SUBHEAD}>Stock</h3>
      {stockRow('length', 'length X')}
      {stockRow('width', 'width Y')}
      {stockRow('thickness', 'thickness')}
      <p style={MUTED}>Z = 0 at the stock’s top face; material at negative Z.</p>

      {/* 3 — tool */}
      <h3 style={SUBHEAD}>Tool</h3>
      <select
        data-testid="sim-tool"
        aria-label="Tool"
        title="The tool this program was written for. The sweep is only valid for this cutting shape and diameter."
        value={toolKey ?? ''}
        onChange={(e) => setTool(e.target.value)}
        style={{
          width: '100%',
          ...(toolKey ? null : { borderColor: '#b4524c', boxShadow: '0 0 0 1px rgba(180,82,76,.4)' }),
        }}
      >
        <option value="" disabled>
          Choose the tool this program was written for…
        </option>
        {TOOL_LIBRARY.map((e) => (
          <option key={e.key} value={e.key} title={e.provenance}>
            {e.tool.name}
          </option>
        ))}
      </select>
      {!toolKey && (
        <p style={{ ...MUTED, color: '#e0a19b' }}>required — choose the tool this program was written for.</p>
      )}
      {toolKey && toolSource === 'header' && <p style={MUTED}>matched from the file’s TOOL record.</p>}

      {/* 4 — advanced: the starting tool */}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, color: '#9aa4b0', cursor: 'pointer' }}>Advanced</summary>
        <label style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          Tool in the spindle at start
          <select
            data-testid="sim-starting-tool"
            aria-label="Tool in the spindle at start"
            title="The tool the machine already holds when this program starts. A program cannot know it."
            value={startingTool === 'unknown' ? 'unknown' : startingTool === -1 ? 'empty' : String(startingTool)}
            onChange={(e) => {
              const v = e.target.value;
              setStartingTool(v === 'unknown' ? 'unknown' : v === 'empty' ? -1 : Number(v));
            }}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          >
            <option value="unknown">unknown</option>
            <option value="empty">empty</option>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                T{n}
              </option>
            ))}
          </select>
        </label>
        <p style={MUTED}>
          A program cannot know the machine’s starting tool. An unknown start is treated as one
          (the runner warns), which is wrong for a program whose first <code>T1 M6</code> is a
          no-op.
        </p>
      </details>

      {/* 4 — simulate / running */}
      <button
        type="button"
        data-testid="sim-simulate"
        disabled={!canSimulate}
        onClick={() => void simulate()}
        style={{ width: '100%', marginTop: 12, padding: 8 }}
      >
        Simulate
      </button>

      {loading && (
        <div data-testid="sim-running" style={{ marginTop: 10 }}>
          <div style={{ height: 6, background: '#1a1f25', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: phase === 'playback' ? '100%' : progress && progress.total > 0 ? `${Math.round((progress.done / progress.total) * 100)}%` : '40%',
                background: 'linear-gradient(90deg,#4d8eff,#8fb4ff)',
              }}
            />
          </div>
          <p style={{ ...MUTED, color: '#c8d3de' }}>
            {phase === 'playback'
              ? 'preparing playback…'
              : progress && progress.total > 0
                ? `sweeping ${progress.done} / ${progress.total} checkpoints`
                : 'sweeping…'}
          </p>
          <p style={MUTED}>
            {phase === 'playback'
              ? 'The sweep is done; the playback anchors are being built so scrubbing is instant afterwards. A few seconds on a dense job.'
              : 'Parsing and running are done; the sweep unions the cuts at each checkpoint. This is the slow part — a few seconds on a dense job.'}
          </p>
          <button type="button" data-testid="sim-cancel" onClick={() => void cancel()} style={{ width: '100%', padding: 8 }}>
            Cancel
          </button>
        </div>
      )}

      {/* 5 — result */}
      {status === 'ready' && info && (
        <div data-testid="sim-result">
          <h3 style={SUBHEAD}>
            Result{' '}
            <span data-testid="sim-placement-badge" title={STUB_TITLE} style={TAG}>
              placement: stub
            </span>
          </h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <b>{info.stats.removedVolume.toFixed(1)}</b> <span style={MUTED}>mm³ removed</span>
            </div>
            <div>
              <b>{info.count}</b> <span style={MUTED}>checkpoints</span>
            </div>
            <div>
              <b>{(info.stats.ms.total / 1000).toFixed(2)} s</b> <span style={MUTED}>sweep time</span>
            </div>
          </div>

          {/* 6 — diagnostics */}
          {grouped && diagnostics.length > 0 && (
            <div data-testid="sim-diagnostics">
              <h3 style={SUBHEAD}>Diagnostics</h3>
              {SOURCES.map((source) => {
                const rows = grouped.get(source) ?? [];
                if (rows.length === 0) return null;
                return (
                  <div key={source} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: '#c8d3de' }}>
                      {source} <span style={MUTED}>{severitySummary(rows)}</span>
                    </div>
                    {rows.map(diagRow)}
                  </div>
                );
              })}
            </div>
          )}

          {/* 7 — the disclaimer: the constant physics caveat, then the run's own blind spots (#243) */}
          <div data-testid="sim-disclaimer" style={DISCLAIM}>
            <div>{DISCLAIMER}</div>
            {coverage.map((sentence, i) => (
              <div key={i}>{sentence}</div>
            ))}
          </div>
        </div>
      )}

      {/* refusal / error — in place of the result */}
      {status === 'refused' && (
        <div
          data-testid="sim-refusal"
          style={{ marginTop: 10, border: '1px solid #7a2828', background: '#2a1416', borderRadius: 4, padding: 8 }}
        >
          <div style={{ fontSize: 12, color: '#f0b4ad', fontWeight: 600, marginBottom: 4 }}>refused</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {diagnostics.map((d, i) => (
              <li key={i} style={{ fontSize: 12, color: '#e8bcb6', lineHeight: 1.45 }}>
                <code>{d.code}</code> {d.message}
                {d.line !== undefined && (
                  <button
                    type="button"
                    data-testid={`sim-refusal-jump-${d.code}`}
                    onClick={() => jumpToLine(d.line as number)}
                    title="Show this line in the G-code pane"
                    style={{ ...LINELINK, color: '#f0b4ad' }}
                  >
                    line {d.line}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {/* #243 — a path-only or refused run says so in the same place as a ready one. */}
          <div data-testid="sim-disclaimer" style={{ ...DISCLAIM, color: '#e8bcb6', borderTopColor: '#5a2a2a' }}>
            {coverage.map((sentence, i) => (
              <div key={i}>{sentence}</div>
            ))}
          </div>
          {pathOnly && (
            <button type="button" data-testid="sim-retry" onClick={() => void useSimStore.getState().retryWithLongerBudget()} style={{ width: '100%', padding: 7, marginTop: 6 }}>
              Try again with a longer limit
            </button>
          )}
        </div>
      )}

      {/* 6b — restart from a step (#249): a generated, verified `.nc`, not a controller command. */}
      {isSimSceneActive({ status, pathOnly }) && gcodeText !== null && (
        <div data-testid="sim-restart" style={{ marginTop: 12 }}>
          <h3 style={SUBHEAD}>Restart from a step</h3>
          <p style={MUTED}>
            Generate a <code>.nc</code> that resumes at step {step} of {Math.max(0, stepCount - 1)}. It
            restores the spindle, air and position, approaches safely, then runs the file’s own remaining
            moves. It is checked by the same verifier as any other program — no exemption.
          </p>
          <button
            type="button"
            data-testid="sim-restart-generate"
            onClick={() => useSimStore.getState().generateRestart({ baseName: fileName ?? undefined })}
            style={{ width: '100%', padding: 7 }}
          >
            Generate restart .nc at step {step}
          </button>

          {restart && restart.ok && restart.nc !== null && (
            <div
              data-testid="sim-restart-result"
              style={{ marginTop: 8, border: '1px solid #2a4a2a', background: '#12200f', borderRadius: 4, padding: 8 }}
            >
              <div style={{ fontSize: 12, color: '#b6e0a8', fontWeight: 600, marginBottom: 4 }} data-testid="sim-restart-ok">
                restart ready — {restart.fileName}
              </div>
              <ul data-testid="sim-restart-runsheet" style={{ margin: 0, paddingLeft: 16 }}>
                {restart.runSheet.map((line, i) => (
                  <li key={i} style={{ fontSize: 11, color: '#cbe0c2', lineHeight: 1.45, margin: '3px 0' }}>
                    {line}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                data-testid="sim-restart-save"
                onClick={() => downloadNc(restart.nc as string, restart.fileName as string)}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
              >
                Save {restart.fileName}
              </button>
            </div>
          )}

          {restart && !restart.ok && (
            <div
              data-testid="sim-restart-refused"
              style={{ marginTop: 8, border: '1px solid #7a2828', background: '#2a1416', borderRadius: 4, padding: 8 }}
            >
              <div style={{ fontSize: 12, color: '#f0b4ad', fontWeight: 600, marginBottom: 4 }}>
                restart refused — do not run it
              </div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {restart.errors.map((m, i) => (
                  <li key={i} style={{ fontSize: 11, color: '#e8bcb6', lineHeight: 1.45 }}>
                    {m}
                  </li>
                ))}
                {(restart.verify?.findings ?? [])
                  .filter((f) => f.severity === 'error')
                  .map((f, i) => (
                    <li key={`v${i}`} style={{ fontSize: 11, color: '#e8bcb6', lineHeight: 1.45 }}>
                      <code>{f.code}</code> {f.message}
                      {f.line !== null && <span> (line {f.line})</span>}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div data-testid="sim-error" style={{ marginTop: 10, border: '1px solid #7a2828', background: '#2a1416', borderRadius: 4, padding: 8, color: '#f0b4ad', fontSize: 12 }}>
          {error ?? 'the simulation failed'}
        </div>
      )}

      {/* 9 — the read-only G-code pane (#245), synced to the transport */}
      {gcodeText !== null && (
        <div data-testid="sim-gcode-section" style={{ marginTop: 12 }}>
          <h3 style={SUBHEAD}>
            G-code <span style={TAG}>read-only</span>
          </h3>
          <GcodePane text={gcodeText} jumpLine={jump?.line ?? null} jumpSeq={jump?.seq ?? 0} />
        </div>
      )}

      {/* 8 — close */}
      {status !== 'idle' && status !== 'loading' && (
        <button type="button" data-testid="sim-close" onClick={() => void close()} style={{ width: '100%', marginTop: 8, padding: 7 }}>
          Close simulation
        </button>
      )}
    </div>
  );
}
