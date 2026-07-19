import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { PlacementBanner } from './PlacementBanner';
import { FloatersBanner } from './FloatersBanner';
import { WelcomeOverlay } from '../welcome/WelcomeOverlay';
import { ContextPanel } from './ContextPanel';
import { Viewport } from '@/components/viewport/Viewport';
import { useRebuildOnProjectChange } from '@/hooks/useRebuildOnProjectChange';
import { undoProject, redoProject, useProjectStore } from '@/store/projectStore';

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
        {welcomeMode ? (
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
      </main>
      <StatusBar />
    </div>
  );
}
