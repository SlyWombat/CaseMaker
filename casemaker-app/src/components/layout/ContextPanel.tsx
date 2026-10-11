import { useEffect, useState, type JSX } from 'react';
import { useViewportStore, type SidebarSectionId } from '@/store/viewportStore';
import { SelectionPanel } from '@/components/viewport/SelectionPanel';
import { CasePanel } from '@/components/panels/CasePanel';
import { RackPanel } from '@/components/panels/RackPanel';
import { InsertPanel } from '@/components/panels/InsertPanel';
import { ToolboxPanel } from '@/components/panels/ToolboxPanel';
import { PartPanel } from '@/components/panels/PartPanel';
import { ExportPanel } from '@/components/panels/ExportPanel';
import { PortsPanel } from '@/components/panels/PortsPanel';
import { BoardEditorPanel } from '@/components/panels/BoardEditorPanel';
import { AssetsPanel } from '@/components/panels/AssetsPanel';
import { HatsPanel } from '@/components/panels/HatsPanel';
import { FeaturesPanel } from '@/components/panels/FeaturesPanel';
import { SimPanel } from '@/components/panels/SimPanel';
import { EngravePanel } from '@/components/panels/EngravePanel';

const SECTION_TITLES: Record<SidebarSectionId, string> = {
  board: 'Board',
  case: 'Case parameters',
  rack: 'Mini rack',
  insert: 'Tool insert',
  toolbox: 'Toolbox',
  part: 'Part',
  ports: 'Port cutouts',
  hats: 'HATs',
  features: 'Features',
  assets: 'External assets',
  export: 'Export',
  'cnc-sim': 'Simulate .nc',
  'cnc-engrave': 'Engrave text',
};

function renderSection(id: SidebarSectionId): JSX.Element {
  switch (id) {
    case 'board':    return <BoardEditorPanel />;
    case 'case':     return <CasePanel />;
    case 'rack':     return <RackPanel />;
    case 'insert':   return <InsertPanel />;
    case 'toolbox':  return <ToolboxPanel />;
    case 'part':     return <PartPanel />;
    case 'ports':    return <PortsPanel />;
    case 'hats':     return <HatsPanel />;
    case 'features': return <FeaturesPanel />;
    case 'assets':   return <AssetsPanel />;
    case 'export':   return <ExportPanel />;
    case 'cnc-sim':  return <SimPanel />;
    case 'cnc-engrave': return <EngravePanel />;
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
/**
 * Issue #355 — the narrowest window that still SHARES its width with the panel.
 *
 * The two rails take 680 px of it, so at 1024 the canvas keeps 344 and the panel stops covering
 * what it is describing; below that (measured at 900: a 220 px canvas) the overlay costs less than
 * the column would. It used to be 1366, which meant a laptop-width window got a 360 px drawer over
 * the viewport: the viewport toolbar sat clipped under it and the panel covered half the canvas.
 * The stylesheet's `.app-main` query (max-width: 1023px) is the same number from the other side.
 */
const RAIL_MIN_W = 1024;

export function ContextPanel() {
  const selection = useViewportStore((s) => s.selection);
  const activeSection = useViewportStore((s) => s.activeSidebarSection);
  const setSection = useViewportStore((s) => s.setActiveSidebarSection);
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < RAIL_MIN_W : false,
  );
  // Issue #280 — the auto-open rule below fires on a *change* of input, so a panel that MOUNTS
  // with a section already active (the startup wizard sets the section and then the shell swaps
  // this panel in) would leave the drawer shut on a compact viewport: a highlighted rail button
  // with nothing beside it, which is the #274 "no way in" complaint one step later. Start open in
  // that case, by the same condition.
  const [drawerOpen, setDrawerOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.innerWidth < RAIL_MIN_W &&
      (selection !== null || activeSection !== null),
  );

  useEffect(() => {
    function onResize() {
      setIsCompact(window.innerWidth < RAIL_MIN_W);
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
        {/* Issue #355 — there is no drawer × of its own here any more. It sat directly under the
            content's × (the section editor's, or the selection's) and the two read as one control
            duplicated; the handle tab on the right edge is the drawer's affordance, and it says so
            in its own label. Rail mode never had one, so this is also the two modes agreeing. */}
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
