import { useEffect, useState } from 'react';
import { useJobStore } from '@/store/jobStore';
import { useProjectStore } from '@/store/projectStore';
import { useSettingsStore, type ExportFormat } from '@/store/settingsStore';
import { partsForIds, partsByCategory, type PartCategory, type ProjectPart } from '@/engine/exporters/parts';
import { exportSinglePart, triggerExport } from '@/engine/exportTrigger';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import { PartThumbnail } from './PartThumbnail';

interface ExportModalProps {
  onClose: () => void;
}

const CATEGORY_LABELS: Record<PartCategory, string> = {
  case: 'Case',
  gasket: 'Gasket',
  fastener: 'Fasteners',
  accessory: 'Accessories',
};

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: 'stl-binary', label: 'STL (binary)' },
  { value: 'stl-ascii', label: 'STL (ASCII)' },
  { value: '3mf', label: '3MF' },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Issue #120 phase 3 — persistent export modal. Lists every part in the
 *  current BuildPlan with a per-part Save button, plus a "Save all in one"
 *  footer button that uses the existing layout-assembling export pipeline.
 *  Modal stays open until the user dismisses it (× / ESC / outside-click). */
export function ExportModal({ onClose }: ExportModalProps) {
  const nodes = useJobStore((s) => s.nodes);
  const project = useProjectStore((s) => s.project);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const setExportFormat = useSettingsStore((s) => s.setExportFormat);
  const hardware = hardwareForProject(project);
  const [busy, setBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ id: string; filename: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for ESC to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nodeIds = Array.from(nodes.keys());
  const parts = partsForIds(nodeIds);
  const grouped = partsByCategory(parts);

  // Estimated STL binary file size per part: 80-byte header + 4-byte tri
  // count + 50 bytes per triangle. Triangle count = indices.length / 3.
  const estBytes = (id: string): number => {
    const node = nodes.get(id);
    if (!node) return 0;
    const tris = node.buffer.indices.length / 3;
    return 84 + tris * 50;
  };

  const onSavePart = async (part: ProjectPart): Promise<void> => {
    setBusy(part.id);
    setError(null);
    try {
      const result = await exportSinglePart(part.id, exportFormat);
      if (result) setRecent({ id: part.id, ...result });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onSaveAll = async (): Promise<void> => {
    setBusy('__all__');
    setError(null);
    try {
      await triggerExport(exportFormat);
      setRecent({ id: '__all__', filename: 'all parts', bytes: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="export-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        className="export-modal"
        style={{
          background: '#14181c',
          color: '#d1d5db',
          border: '1px solid #2a2f36',
          borderRadius: 6,
          padding: 16,
          minWidth: 480,
          maxWidth: 640,
          maxHeight: '85vh',
          overflowY: 'auto',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 id="export-modal-title" style={{ margin: 0, fontSize: 16 }}>Export</h3>
          <button onClick={onClose} data-testid="export-modal-close" aria-label="Close" style={{ background: 'transparent', border: 0, color: '#d1d5db', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ color: '#9ca3af' }}>Format:</span>
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
            data-testid="export-modal-format"
          >
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {hardware.length > 0 && (
          <div
            data-testid="export-hardware-list"
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              background: '#1a1f25',
              border: '1px solid #2a4a6a',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#9ab0c2', letterSpacing: '0.05em', marginBottom: 6 }}>
              🔩 Hardware you'll need
            </div>
            {hardware.map((h) => (
              <div key={h.id} style={{ marginBottom: 4 }}>
                <span style={{ color: '#cfe', fontWeight: 500 }}>×{h.count}&nbsp;</span>
                <span>{h.label}</span>
                {h.note && (
                  <div style={{ color: '#9ca3af', fontSize: 11, marginLeft: 16 }}>↳ {h.note}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {parts.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>No parts available. Wait for the engine to finish rebuilding, then try again.</p>
        ) : (
          <>
            {grouped.map((g) => (
              <div key={g.category} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.05em', marginBottom: 4 }}>{CATEGORY_LABELS[g.category]}</div>
                {g.parts.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 6px',
                      borderTop: '1px solid #1c2026',
                    }}
                    data-testid={`export-row-${p.id}`}
                  >
                    {/* Live-rendered isometric thumbnail of the part. Falls back to
                        an empty colored square if WebGL is unavailable. */}
                    <PartThumbnail
                      partId={p.id}
                      size={56}
                      color={p.material === 'flex' ? '#c79252' : '#9aaeb8'}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13 }}>{p.displayName}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {p.material === 'flex' ? 'Flex (TPU 95A)' : 'Rigid'} · {formatBytes(estBytes(p.id))}
                      </div>
                    </div>
                    <button
                      onClick={() => onSavePart(p)}
                      disabled={busy !== null}
                      data-testid={`export-save-${p.id}`}
                      title={`Save ${p.displayName} as ${exportFormat}`}
                    >
                      {busy === p.id ? '⏳' : '💾 Save'}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            <div style={{ borderTop: '1px solid #2a2f36', marginTop: 12, paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Includes a print-optimized layout (lid flipped, parts spaced).</span>
              <button
                onClick={onSaveAll}
                disabled={busy !== null}
                data-testid="export-save-all"
                style={{
                  background: '#1f2530',
                  border: '1px solid #2a4a6a',
                  color: '#cfe',
                  padding: '6px 14px',
                  fontSize: 13,
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
              >
                {busy === '__all__' ? '⏳ Exporting…' : '💾 Save all in one'}
              </button>
            </div>
          </>
        )}

        {recent && (
          <p style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }} data-testid="export-recent">
            ✓ Saved {recent.id === '__all__' ? 'all parts' : recent.filename}
            {recent.bytes > 0 ? ` (${formatBytes(recent.bytes)})` : ''}
          </p>
        )}
        {error && (
          <p style={{ marginTop: 10, fontSize: 11, color: '#fca5a5' }} data-testid="export-error">
            Error: {error}
          </p>
        )}
      </div>
    </div>
  );
}
