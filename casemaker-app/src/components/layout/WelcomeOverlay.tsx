import { useState } from 'react';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { listBuiltinBoardIds, getBuiltinBoard } from '@/library';
import { TEMPLATES, findTemplate } from '@/library/templates';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';

/**
 * Issue #69 — first-run welcome screen. App no longer auto-renders a
 * default board; the user picks a board OR a template before the
 * viewport / sidebar gets populated. The underlying project still
 * initializes to a valid state so the engine never sees null, but
 * `welcomeMode: true` suppresses rendering until dismissed.
 */
export function WelcomeOverlay() {
  const loadBoard = useProjectStore((s) => s.loadBuiltinBoard);
  const setProject = useProjectStore((s) => s.setProject);
  const dismiss = useProjectStore((s) => s.dismissWelcome);
  const [boardChoice, setBoardChoice] = useState('');

  const boardIds = listBuiltinBoardIds();

  const applyBoard = (id: string) => {
    if (!id) return;
    loadBoard(id); // also flips welcomeMode off
  };

  const applyTemplate = async (id: string) => {
    const t = findTemplate(id);
    if (!t) return;
    const project = t.build();
    setProject(project); // also flips welcomeMode off
    clearHistory();
    await scheduleImmediate(project);
  };

  return (
    <div className="welcome-overlay" data-testid="welcome-overlay">
      <div className="welcome-overlay__card">
        <h2>Case Maker</h2>
        <p className="welcome-overlay__lede">
          Pick a board to start a blank case, or a template for a one-click recipe.
        </p>

        <h3>Start from a board</h3>
        <div className="welcome-overlay__row">
          <select
            value={boardChoice}
            onChange={(e) => setBoardChoice(e.target.value)}
            data-testid="welcome-board-select"
          >
            <option value="">— pick a board —</option>
            {boardIds.map((id) => {
              const b = getBuiltinBoard(id);
              return (
                <option key={id} value={id}>
                  {b?.name ?? id}
                </option>
              );
            })}
          </select>
          <button
            disabled={!boardChoice}
            onClick={() => applyBoard(boardChoice)}
            data-testid="welcome-board-go"
          >
            Use this board
          </button>
        </div>

        <h3>Or start from a template</h3>
        <ul className="welcome-overlay__templates">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => {
                  void applyTemplate(t.id);
                }}
                data-testid={`welcome-template-${t.id}`}
              >
                <div className="welcome-overlay__tpl-name">{t.name}</div>
                <div className="welcome-overlay__tpl-desc">
                  {t.description} · ~{t.estPrintMinutes} min
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="welcome-overlay__footer">
          <button
            className="welcome-overlay__skip"
            onClick={dismiss}
            data-testid="welcome-skip"
          >
            Skip — I'll pick later
          </button>
        </div>
      </div>
    </div>
  );
}
