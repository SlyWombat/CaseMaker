import { CasePanel } from '@/components/panels/CasePanel';
import { ExportPanel } from '@/components/panels/ExportPanel';
import { PortsPanel } from '@/components/panels/PortsPanel';
import { BoardEditorPanel } from '@/components/panels/BoardEditorPanel';
import { AssetsPanel } from '@/components/panels/AssetsPanel';
import { SettingsPanel } from '@/components/panels/SettingsPanel';
import { HatsPanel } from '@/components/panels/HatsPanel';
import { TemplatesPanel } from '@/components/panels/TemplatesPanel';
import { FeaturesPanel } from '@/components/panels/FeaturesPanel';
import { useProjectStore } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';

export function Sidebar() {
  const board = useProjectStore((s) => s.project.board);
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const loadBoard = useProjectStore((s) => s.loadBuiltinBoard);
  const ids = listBuiltinBoardIds();
  if (welcomeMode) {
    // Issue #69 — hide all per-board panels until the user picks a board /
    // template via the WelcomeOverlay. Settings stays visible so users can
    // still tweak global preferences.
    return (
      <aside className="sidebar">
        <SettingsPanel />
      </aside>
    );
  }
  return (
    <aside className="sidebar">
      <TemplatesPanel />
      <div className="panel">
        <h3>Board</h3>
        <select
          value={board.id}
          onChange={(e) => loadBoard(e.target.value)}
          data-testid="board-select"
        >
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <p className="board-meta">
          {board.name} — {board.pcb.size.x} × {board.pcb.size.y} × {board.pcb.size.z} mm
        </p>
      </div>
      <BoardEditorPanel />
      <CasePanel />
      <PortsPanel />
      <HatsPanel />
      <FeaturesPanel />
      <AssetsPanel />
      <ExportPanel />
      <SettingsPanel />
    </aside>
  );
}
