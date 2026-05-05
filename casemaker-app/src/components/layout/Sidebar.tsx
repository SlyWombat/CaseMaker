import { useProjectStore } from '@/store/projectStore';
import { useViewportStore, type SidebarSectionId } from '@/store/viewportStore';

const SECTIONS: { id: SidebarSectionId; label: string; icon: string; hint: string }[] = [
  { id: 'board',    label: 'Board',           icon: '🟦', hint: 'Host PCB profile, mounting holes, components' },
  { id: 'case',     label: 'Case parameters', icon: '📦', hint: 'Walls, lid, joint, seal, latches, hinge, rugged exterior' },
  { id: 'ports',    label: 'Port cutouts',    icon: '🔌', hint: 'USB, HDMI, audio, custom port openings' },
  { id: 'hats',     label: 'HATs',            icon: '🎩', hint: 'HAT placements stacked above the host board' },
  { id: 'features', label: 'Features',        icon: '⚙️',  hint: 'Snap catches, mounting features, fans, antennas, displays, text labels' },
  { id: 'assets',   label: 'External assets', icon: '📎', hint: 'STL imports, custom cutouts' },
  { id: 'export',   label: 'Export',          icon: '⬇️',  hint: 'Per-part Save + Save All' },
];

export function Sidebar() {
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const activeSection = useViewportStore((s) => s.activeSidebarSection);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  if (welcomeMode) {
    return <aside className="sidebar" />;
  }
  // Sidebar is now an INDEX of sections. Clicking a section opens its
  // editor in the right rail (ContextPanel). Mutually exclusive with
  // viewport geometry selection — clicking either switches the right
  // rail to host that thing.
  return (
    <aside className="sidebar" style={{ padding: 8 }}>
      {SECTIONS.map((s) => {
        const isActive = activeSection === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(isActive ? null : s.id)}
            data-testid={`sidebar-button-${s.id}`}
            aria-pressed={isActive}
            title={s.hint}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '10px 12px',
              marginBottom: 4,
              background: isActive ? '#243042' : '#1a1f25',
              border: `1px solid ${isActive ? '#3a5a7a' : '#2a2f36'}`,
              borderRadius: 4,
              color: isActive ? '#cfe' : '#d1d5db',
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden style={{ fontSize: 16 }}>{s.icon}</span>
            <span>{s.label}</span>
          </button>
        );
      })}
    </aside>
  );
}
