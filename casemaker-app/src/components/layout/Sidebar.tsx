import { CasePanel } from '@/components/panels/CasePanel';
import { ExportPanel } from '@/components/panels/ExportPanel';
import { PortsPanel } from '@/components/panels/PortsPanel';
import { BoardEditorPanel } from '@/components/panels/BoardEditorPanel';
import { AssetsPanel } from '@/components/panels/AssetsPanel';
import { HatsPanel } from '@/components/panels/HatsPanel';
import { FeaturesPanel } from '@/components/panels/FeaturesPanel';
import { SidebarFooter } from './SidebarFooter';
import { CollapsibleSidebarSection } from './CollapsibleSidebarSection';
import { useProjectStore } from '@/store/projectStore';

export function Sidebar() {
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  if (welcomeMode) {
    // Issue #69 — hide all per-board panels until the user picks a board /
    // template via the WelcomeOverlay. Settings now live in the title-bar
    // gear menu (issue #74); board + templates live in the title-bar
    // pull-down (issue #75), so the sidebar is empty in welcome mode.
    return <aside className="sidebar" />;
  }
  // All sections start COLLAPSED — click the header to expand. State per
  // section persists to localStorage so the user keeps their chosen open
  // panels across reloads. Inline styles on `.sidebar` add a CSS rule
  // suppressing each wrapped panel's own h3 (the section header is the
  // title now, so a second h3 inside the body would double up).
  return (
    <aside className="sidebar">
      <style>{`
        .sidebar-section__body > .panel > h3 { display: none; }
        .sidebar-section__body > .panel { margin-top: 0; padding-top: 4px; }
      `}</style>
      <CollapsibleSidebarSection title="Board" storageKey="board">
        <BoardEditorPanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="Case parameters" storageKey="case">
        <CasePanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="Port cutouts" storageKey="ports">
        <PortsPanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="HATs" storageKey="hats">
        <HatsPanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="Features" storageKey="features">
        <FeaturesPanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="External assets" storageKey="assets">
        <AssetsPanel />
      </CollapsibleSidebarSection>
      <CollapsibleSidebarSection title="Export" storageKey="export" defaultOpen>
        <ExportPanel />
      </CollapsibleSidebarSection>
      <SidebarFooter />
    </aside>
  );
}
