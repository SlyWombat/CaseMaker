import { useProjectStore } from '@/store/projectStore';
import { PortEditorRow } from './PortEditorRow';

export function PortsPanel() {
  const ports = useProjectStore((s) => s.project.ports);
  const setEnabled = useProjectStore((s) => s.setPortEnabled);
  const patchPort = useProjectStore((s) => s.patchPort);
  const resetPort = useProjectStore((s) => s.resetPortToDefault);
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
            onPatch={(patch) => patchPort(p.id, patch)}
            onReset={p.sourceComponentId ? () => resetPort(p.id) : undefined}
            testIdPrefix={`port-${p.sourceComponentId ?? p.id}`}
          />
        ))}
      </ul>
    </div>
  );
}
