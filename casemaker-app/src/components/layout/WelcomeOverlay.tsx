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
        <header className="welcome-overlay__hero">
          <h1>Start a New Project</h1>
          <p>
            Select a base microcontroller board to drop into a blank parametric
            enclosure, or pick a quick-start template for a one-click recipe.
          </p>
        </header>

        <section className="welcome-overlay__section">
          <h2>Target Hardware</h2>
          <div className="welcome-overlay__row">
            <select
              value={boardChoice}
              onChange={(e) => setBoardChoice(e.target.value)}
              data-testid="welcome-board-select"
              aria-label="Target hardware"
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
              Generate Shell
            </button>
          </div>
        </section>

        <section className="welcome-overlay__section">
          <h2>Quick Start Templates</h2>
          <ul className="welcome-overlay__templates">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => {
                    void applyTemplate(t.id);
                  }}
                  data-testid={`welcome-template-${t.id}`}
                  aria-label={`Load ${t.name} template`}
                >
                  <div className="welcome-overlay__tpl-name">{t.name}</div>
                  <div className="welcome-overlay__tpl-desc">{t.description}</div>
                  <div className="welcome-overlay__tpl-meta">
                    ~{t.estPrintMinutes} min print
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

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
