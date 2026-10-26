import { featureSim } from '@/platform/features';
import { useEffect, type CSSProperties } from 'react';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { PlacementBanner } from './PlacementBanner';
import { FloatersBanner } from './FloatersBanner';
import { WelcomeOverlay } from '../welcome/WelcomeOverlay';
import { StartWizard } from '../welcome/StartWizard';
import { MachineChangeWizard } from '../machine-change';
import { ContextPanel } from './ContextPanel';
import { useContextPanelWidth } from './useContextPanelWidth';
import { PanelResizeHandle } from './PanelResizeHandle';
import { Viewport } from '@/components/viewport/Viewport';
import { ManageMode } from '@/components/manage/ManageMode';
import { CameraPanel } from '@/components/panels/CameraPanel';
import { useRebuildOnProjectChange } from '@/hooks/useRebuildOnProjectChange';
import { undoProject, redoProject, useProjectStore } from '@/store/projectStore';
// Static rather than lazy: `EngravePanel` imports this store from `ContextPanel`, which is in the
// eager bundle already, so reaching for it here costs nothing and the shortcut needs it at keypress.
import { undoEngraveRemoval } from '@/store/engraveJobStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { startRecentJobTracking } from '@/store/recentJobsStore';
import { useManageModeStore } from '@/store/manageModeStore';

function useUndoRedoShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        // #411: a pending engrave removal outranks the project's undo — the person's last press was
        // a `✕` on an item, and Ctrl-Z has to take that back. Empty stack, the key is the project's
        // again (the precedence rule and its reasoning live in `undoEngraveRemoval`).
        if (!undoEngraveRemoval()) undoProject();
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
  // #680 — record the last three job files the app opens or saves for the welcome door's card.
  // Started here, once: the record must be kept whether or not the welcome overlay is on screen.
  useEffect(() => {
    startRecentJobTracking();
  }, []);
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  // #280 — the wizard mounts HERE, not inside the welcome overlay: its step 2 creates the project,
  // which flips `welcomeMode` off and unmounts the overlay the wizard was launched from.
  const wizardOpen = useStartWizardStore((s) => s.open);
  // #311 — the Manage surface is a THIRD mode beside the project shell and the welcome overlay. It
  // comes first because it is the one surface that has to be reachable with nothing else open, and
  // it does not disturb either of the other two: `welcomeMode` and the project are left alone, so
  // closing it puts the user back exactly where they were.
  //
  // Gated on `featureSim` (#343) with the rest of the CNC UI: the house is a CNC notion and the web
  // deployment switches that off wholesale (`Sidebar`, `docs/index.ts`).
  const manageRequested = useManageModeStore((s) => s.open);
  const manageOpen = featureSim && manageRequested;
  // #558 — the right rail's width is the operator's, persisted and handed to `.app-main` as a CSS
  // custom property the grid column and the drag handle both read.
  const { width: contextPanelWidth, resizeBy: resizeContextPanel } = useContextPanelWidth();
  // Issue #59 — board visualization cycle removed; no fallback banner needed.
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__logo">
          <img src="logo-wordmark.svg" alt="Case Maker" height="36" />
        </h1>
        <Toolbar />
      </header>
      <main
        className="app-main"
        style={{ '--context-panel-width': `${contextPanelWidth}px` } as CSSProperties}
      >
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
            <PanelResizeHandle onResize={resizeContextPanel} />
            <ContextPanel />
          </>
        )}
        {wizardOpen && <StartWizard />}
        {/* #693 — the change-the-machine wizard, mounted here so it outlives whatever surface opened
            it (Manage's pane is replaced, not covered). It renders itself null while closed. */}
        <MachineChangeWizard />
      </main>
      <StatusBar />
      {/* #530 — the machine's camera, opened from the Cut step or the strip's popover and mounted
          once here: it renders itself null while closed, so no guard is needed. */}
      <CameraPanel />
    </div>
  );
}
