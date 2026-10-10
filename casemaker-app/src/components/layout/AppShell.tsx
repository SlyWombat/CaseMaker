import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { PlacementBanner } from './PlacementBanner';
import { FloatersBanner } from './FloatersBanner';
import { WelcomeOverlay } from '../welcome/WelcomeOverlay';
import { StartWizard } from '../welcome/StartWizard';
import { ContextPanel } from './ContextPanel';
import { Viewport } from '@/components/viewport/Viewport';
import { ManageMode } from '@/components/manage/ManageMode';
import { useRebuildOnProjectChange } from '@/hooks/useRebuildOnProjectChange';
import { undoProject, redoProject, useProjectStore } from '@/store/projectStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useManageModeStore } from '@/store/manageModeStore';

function useUndoRedoShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoProject();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redoProject();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function AppShell() {
  useRebuildOnProjectChange();
  useUndoRedoShortcuts();
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  // #280 — the wizard mounts HERE, not inside the welcome overlay: its step 2 creates the project,
  // which flips `welcomeMode` off and unmounts the overlay the wizard was launched from.
  const wizardOpen = useStartWizardStore((s) => s.open);
  // #311 — the Manage surface is a THIRD mode beside the project shell and the welcome overlay. It
  // comes first because it is the one surface that has to be reachable with nothing else open, and
  // it does not disturb either of the other two: `welcomeMode` and the project are left alone, so
  // closing it puts the user back exactly where they were.
  //
  // Gated on `__FEATURE_SIM__` with the rest of the CNC UI: the house is a CNC notion and the web
  // deployment switches that off wholesale (`Sidebar`, `docs/index.ts`).
  const manageRequested = useManageModeStore((s) => s.open);
  const manageOpen = __FEATURE_SIM__ && manageRequested;
  // Issue #59 — board visualization cycle removed; no fallback banner needed.
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__logo">
          <img src="logo-wordmark.svg" alt="Case Maker" height="36" />
        </h1>
        <Toolbar />
      </header>
      <main className="app-main">
        {/* Welcome mode owns the full main area — the board-picker catalog
            needs the width; sidebar/context panels are project UI anyway. */}
        {manageOpen ? (
          <ManageMode />
        ) : welcomeMode ? (
          <WelcomeOverlay />
        ) : (
          <>
            <Sidebar />
            <div className="viewport-pane">
              <PlacementBanner />
              <FloatersBanner />
              <Viewport />
            </div>
            <ContextPanel />
          </>
        )}
        {wizardOpen && <StartWizard />}
      </main>
      <StatusBar />
    </div>
  );
}
