import { useProjectStore } from '@/store/projectStore';

export function PortsPanel() {
  const ports = useProjectStore((s) => s.project.ports);
  const setEnabled = useProjectStore((s) => s.setPortEnabled);
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
          <li key={p.id}>
            <label>
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => setEnabled(p.id, e.target.checked)}
                data-testid={`port-toggle-${p.sourceComponentId ?? p.id}`}
              />
              <span>{p.kind}</span>
              <span className="port-facing">[{p.facing}]</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
