import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { PortEditorRow } from './PortEditorRow';

export function PortsPanel() {
  // Issue #94 — host-board ports use click-to-select. Row stays compact;
  // detail form (position / size / margin / shape) renders in the right
  // rail via SelectionPanel.
  const ports = useProjectStore((s) => s.project.ports);
  const setEnabled = useProjectStore((s) => s.setPortEnabled);
  const setSelection = useViewportStore((s) => s.setSelection);
  if (ports.length === 0) {
    return (
      <div className="panel">
        <h3>Ports</h3>
        <p className="board-meta">This board defines no side-facing ports.</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <h3>Port cutouts</h3>
      <ul className="port-list">
        {ports.map((p) => (
          <PortEditorRow
            key={p.id}
            port={p}
            onSetEnabled={(v) => setEnabled(p.id, v)}
            onSelect={(portId) => setSelection({ kind: 'port', portId })}
            testIdPrefix={`port-${p.sourceComponentId ?? p.id}`}
          />
        ))}
      </ul>
    </div>
  );
}
