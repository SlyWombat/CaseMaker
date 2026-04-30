import { CasePanel } from '@/components/panels/CasePanel';
import { ExportPanel } from '@/components/panels/ExportPanel';
import { PortsPanel } from '@/components/panels/PortsPanel';
import { BoardEditorPanel } from '@/components/panels/BoardEditorPanel';
import { AssetsPanel } from '@/components/panels/AssetsPanel';
import { HatsPanel } from '@/components/panels/HatsPanel';
import { FeaturesPanel } from '@/components/panels/FeaturesPanel';
import { SidebarFooter } from './SidebarFooter';
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
  return (
    <aside className="sidebar">
      <BoardEditorPanel />
      <CasePanel />
      <PortsPanel />
      <HatsPanel />
      <FeaturesPanel />
      <AssetsPanel />
      <ExportPanel />
      <SidebarFooter />
    </aside>
  );
}
