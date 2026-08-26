import { useEffect, useState, type JSX } from 'react';
import { useViewportStore, type SidebarSectionId } from '@/store/viewportStore';
import { SelectionPanel } from '@/components/viewport/SelectionPanel';
import { CasePanel } from '@/components/panels/CasePanel';
import { RackPanel } from '@/components/panels/RackPanel';
import { ExportPanel } from '@/components/panels/ExportPanel';
import { PortsPanel } from '@/components/panels/PortsPanel';
import { BoardEditorPanel } from '@/components/panels/BoardEditorPanel';
import { AssetsPanel } from '@/components/panels/AssetsPanel';
import { HatsPanel } from '@/components/panels/HatsPanel';
import { FeaturesPanel } from '@/components/panels/FeaturesPanel';

const SECTION_TITLES: Record<SidebarSectionId, string> = {
  board: 'Board',
  case: 'Case parameters',
  rack: 'Mini rack',
  ports: 'Port cutouts',
  hats: 'HATs',
  features: 'Features',
  assets: 'External assets',
  export: 'Export',
};

function renderSection(id: SidebarSectionId): JSX.Element {
  switch (id) {
    case 'board':    return <BoardEditorPanel />;
    case 'case':     return <CasePanel />;
    case 'rack':     return <RackPanel />;
    case 'ports':    return <PortsPanel />;
    case 'hats':     return <HatsPanel />;
    case 'features': return <FeaturesPanel />;
    case 'assets':   return <AssetsPanel />;
    case 'export':   return <ExportPanel />;
  }
}

/**
 * Right-rail context panel. Hosts (in priority order):
 *   1. Geometry selection editor (SelectionPanel) when something is
 *      selected in the 3D viewport.
 *   2. The active sidebar section's panel — opened by clicking a section
 *      button in the left rail.
 *   3. Empty-state placeholder.
 *
 * Selection and active section are MUTUALLY EXCLUSIVE in viewportStore;
 * setting one clears the other so the right rail only ever shows ONE thing.
 */
export function ContextPanel() {
  const selection = useViewportStore((s) => s.selection);
  const activeSection = useViewportStore((s) => s.activeSidebarSection);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 1366 : false,
  );

  useEffect(() => {
    function onResize() {
      setIsCompact(window.innerWidth < 1366);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Auto-open the drawer when EITHER a geometry selection OR a sidebar
  // section becomes active (compact viewports only).
  //
  // Adjusted during render rather than in an effect: this is state derived
  // from a *change* in selection/section, and an effect firing setState
  // synchronously costs an extra render pass on every selection change
  // (react-hooks/set-state-in-effect). Comparing against the previous values
  // keeps the original trigger condition exactly — the drawer re-opens only
  // when one of the three inputs actually changes, so a drawer the user
  // closed by hand stays closed until the next selection.
  const [prevInputs, setPrevInputs] = useState({ selection, activeSection, isCompact });
  if (
    prevInputs.selection !== selection ||
    prevInputs.activeSection !== activeSection ||
    prevInputs.isCompact !== isCompact
  ) {
    setPrevInputs({ selection, activeSection, isCompact });
    if (isCompact && (selection || activeSection)) setDrawerOpen(true);
  }

  const isOpen = !isCompact || drawerOpen;
  const className = [
    'context-panel',
    isCompact ? 'context-panel--drawer' : 'context-panel--rail',
    isOpen ? 'context-panel--open' : 'context-panel--closed',
  ].join(' ');

  return (
    <>
      {isCompact && (
        <button
          type="button"
          className="context-panel__handle"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={isOpen ? 'Close context panel' : 'Open context panel'}
          aria-expanded={isOpen}
          title={isOpen ? 'Close (▸)' : 'Open context panel (▸)'}
          data-testid="context-panel-handle"
        >
          {isOpen ? '◂' : '▸'}
        </button>
      )}
      <aside
        className={className}
        data-testid="context-panel"
        aria-label="Context panel"
      >
        {isCompact && (
          <button
            type="button"
            className="context-panel__close"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close context panel"
            title="Close"
          >
            ×
          </button>
        )}
        {selection ? (
          <SelectionPanel />
        ) : activeSection ? (
          <div data-testid={`context-section-${activeSection}`} style={{ padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15, color: '#d1d5db' }}>
                {SECTION_TITLES[activeSection]}
              </h3>
              <button
                type="button"
                onClick={() => setSection(null)}
                title="Close section editor"
                aria-label="Close section editor"
                style={{ background: 'transparent', border: 0, color: '#9ca3af', fontSize: 18, cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
            {renderSection(activeSection)}
          </div>
        ) : (
          <div className="context-panel__empty">
            <h3>Selection</h3>
            <p>
              Click a section in the left rail to edit it here, or click the
              host board, a HAT, or a feature in the viewport to edit its
              properties.
            </p>
            <p className="context-panel__empty-hint">
              Tip: with the Select tool active, hover the 3D scene to see what
              you can pick.
            </p>
          </div>
        )}
      </aside>
    </>
  );
}
