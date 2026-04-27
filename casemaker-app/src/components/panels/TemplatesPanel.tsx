import { useProjectStore } from '@/store/projectStore';
import { TEMPLATES, findTemplate } from '@/library/templates';

export function TemplatesPanel() {
  const setProject = useProjectStore((s) => s.setProject);
  const apply = (id: string) => {
    const t = findTemplate(id);
    if (!t) return;
    if (
      !window.confirm(
        `Replace the current project with template "${t.name}"? Unsaved changes will be lost.`,
      )
    )
      return;
    setProject(t.build());
  };
  return (
    <div className="panel">
      <h3>Templates</h3>
      <p className="settings-hint">One-click starter projects.</p>
      <ul className="port-list">
        {TEMPLATES.map((t) => (
          <li key={t.id} style={{ marginBottom: 6 }}>
            <button
              onClick={() => apply(t.id)}
              data-testid={`template-${t.id}`}
              style={{ width: '100%', textAlign: 'left', padding: 6 }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{t.name}</div>
              <div style={{ fontSize: 11, color: '#8a94a4' }}>
                {t.description} · ~{t.estPrintMinutes} min
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
