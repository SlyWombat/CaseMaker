import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Viewport } from '@/components/viewport/Viewport';
import { useRebuildOnProjectChange } from '@/hooks/useRebuildOnProjectChange';

export function AppShell() {
  useRebuildOnProjectChange();
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Case Maker</h1>
      </header>
      <main className="app-main">
        <Sidebar />
        <div className="viewport-pane">
          <Viewport />
        </div>
      </main>
      <StatusBar />
    </div>
  );
}
