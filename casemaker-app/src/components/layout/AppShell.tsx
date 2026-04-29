import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { PlacementBanner } from './PlacementBanner';
import { WelcomeOverlay } from './WelcomeOverlay';
import { Viewport } from '@/components/viewport/Viewport';
import { useRebuildOnProjectChange } from '@/hooks/useRebuildOnProjectChange';
import { undoProject, redoProject, useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';

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
  const board = useProjectStore((s) => s.project.board);
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const boardVisualization = useViewportStore((s) => s.boardVisualization);
  const assets = board.visualAssets;
  const wantsAsset = boardVisualization === 'photo' || boardVisualization === '3d';
  const haveAsset =
    assets &&
    ((boardVisualization === 'photo' && assets.topImage) ||
      (boardVisualization === '3d' && assets.glb));
  const showFallback = wantsAsset && !haveAsset;
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__logo">
          <img src="logo-wordmark.svg" alt="Case Maker" height="36" />
        </h1>
        <Toolbar />
      </header>
      <main className="app-main">
        <Sidebar />
        <div className="viewport-pane">
          {showFallback && (
            <div
              data-testid="board-visualization-fallback"
              style={{
                position: 'absolute',
                top: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#2a3038',
                color: '#cbd5e1',
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 12,
                zIndex: 10,
              }}
            >
              No {boardVisualization} asset for {board.name}; rendering schematic.
            </div>
          )}
          {!welcomeMode && <PlacementBanner />}
          {!welcomeMode && <Viewport />}
          {welcomeMode && <WelcomeOverlay />}
        </div>
      </main>
      <StatusBar />
    </div>
  );
}
