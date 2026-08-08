import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { useLibraryStore, refreshStaleSources, type ImportResult } from '@/store/libraryStore';
import { listBoards, type RegisteredBoard } from '@/library/registry';
import {
  listTemplates,
  findTemplateAcrossSources,
  findTemplateByBoardAcrossSources,
} from '@/library/templateRegistry';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { BoardPreviewSvg } from './BoardPreviewSvg';
import { SourcesPanel } from './SourcesPanel';
import type { BoardProfile, ComponentKind } from '@/types';

/**
 * Welcome / new-project screen (#69, redesigned). Left: searchable,
 * filterable catalog of every board the registry knows about — builtin,
 * locally-imported, and remote-source — rendered as live top-view previews
 * straight from the profile data. Right: a sticky detail rail with the full
 * spec, connector inventory, provenance links, and the create actions.
 * Below: quick-start template cards (testids consumed by
 * tests/e2e/templates-smoke.spec.ts).
 */

const KIND_LABELS: Record<ComponentKind, string> = {
  'usb-c': 'USB-C',
  'usb-a': 'USB-A',
  'usb-b': 'USB-B',
  'micro-usb': 'micro-USB',
  hdmi: 'HDMI',
  'micro-hdmi': 'micro-HDMI',
  'barrel-jack': 'barrel jack',
  'ethernet-rj45': 'Ethernet RJ45',
  'gpio-header': 'GPIO header',
  'sd-card': 'SD card',
  'flat-cable': 'flat cable',
  'fan-mount': 'fan mount',
  'text-label': 'label',
  'antenna-connector': 'antenna',
  custom: 'custom part',
};

const MEASUREMENT_BADGES: Record<string, { label: string; title: string }> = {
  'open-source-cad': { label: 'CAD-verified', title: 'Dimensions measured from vendor/open-source CAD' },
  datasheet: { label: 'Datasheet', title: 'Dimensions taken from the datasheet drawing' },
  'physical-measurement': { label: 'Hand-measured', title: 'Dimensions measured from a physical board' },
};

/** 'all' | 'quickstart' | 'local' | 'remote:<sourceId>' */
type SourceFilter = string;

function fmtMm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function connectorInventory(board: BoardProfile): Array<{ label: string; count: number }> {
  const counts = new Map<ComponentKind, number>();
  for (const c of board.components) {
    if (c.kind === 'text-label') continue;
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ label: KIND_LABELS[kind] ?? kind, count }));
}

export function WelcomeOverlay() {
  const loadBoard = useProjectStore((s) => s.loadBuiltinBoard);
  const setProject = useProjectStore((s) => s.setProject);
  const localBoards = useLibraryStore((s) => s.localBoards);
  const localTemplates = useLibraryStore((s) => s.localTemplates);
  const remoteSources = useLibraryStore((s) => s.remoteSources);
  const addLocalBoard = useLibraryStore((s) => s.addLocalBoard);
  const addLocalTemplate = useLibraryStore((s) => s.addLocalTemplate);
  const removeLocalBoard = useLibraryStore((s) => s.removeLocalBoard);
  const exportLocalBoard = useLibraryStore((s) => s.exportLocalBoard);

  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [manufacturer, setManufacturer] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<ImportResult | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refresh week-old source caches in the background on first mount (#132).
  useEffect(() => {
    refreshStaleSources();
  }, []);

  // Store slices in deps: registry reads the store, re-list on change.
  const entries = useMemo(() => listBoards(), [localBoards, remoteSources]);
  const allTemplates = useMemo(() => listTemplates(), [remoteSources, localTemplates, localBoards]);

  const manufacturers = useMemo(() => {
    const set = new Set(entries.map((e) => e.board.manufacturer));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filteredList = entries.filter(({ board, origin }) => {
      if (sourceFilter === 'local' && origin.kind !== 'local') return false;
      if (sourceFilter === 'quickstart' && !findTemplateByBoardAcrossSources(board.id)) return false;
      if (sourceFilter.startsWith('remote:')) {
        if (origin.kind !== 'remote' || origin.sourceId !== sourceFilter.slice('remote:'.length))
          return false;
      }
      if (manufacturer !== 'all' && board.manufacturer !== manufacturer) return false;
      if (!q) return true;
      return (
        board.name.toLowerCase().includes(q) ||
        board.manufacturer.toLowerCase().includes(q) ||
        board.id.toLowerCase().includes(q)
      );
    });
    // Verified tier (#128): unverified remote boards list after everything
    // else; builtins/locals/verified-remotes keep their relative order.
    return filteredList.sort(
      (a, b) => Number(a.origin.kind === 'remote' && !a.board.verified) -
        Number(b.origin.kind === 'remote' && !b.board.verified),
    );
  }, [entries, search, sourceFilter, manufacturer]);

  const selected: RegisteredBoard | null = useMemo(
    () => entries.find((e) => e.board.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTemplates;
    return allTemplates.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [search, allTemplates]);

  // Board-less project types (mini rack, large box, protective case) have no
  // card in the board grid to discover them from — surface them in their own
  // strip ABOVE the boards, and keep the board-bound quickstarts below.
  const projectTypeTemplates = useMemo(
    () => filteredTemplates.filter((t) => !t.boardId),
    [filteredTemplates],
  );
  const boardTemplates = useMemo(
    () => filteredTemplates.filter((t) => t.boardId),
    [filteredTemplates],
  );

  const applyTemplate = async (id: string) => {
    const t = findTemplateAcrossSources(id);
    if (!t) return;
    const project = t.build();
    setProject(project); // also flips welcomeMode off
    clearHistory();
    await scheduleImmediate(project);
  };

  /** Board's curated quickstart when it has one, else a blank default shell. */
  const applyBoard = (id: string, opts?: { forceBlank?: boolean }) => {
    const tpl = opts?.forceBlank ? undefined : findTemplateByBoardAcrossSources(id);
    if (tpl) {
      void applyTemplate(tpl.id);
      return;
    }
    loadBoard(id); // also flips welcomeMode off
  };

  const onImportFile = async (file: File) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setImportNotice({ ok: false, warnings: [], error: `${file.name} is not valid JSON.` });
      return;
    }
    // Auto-detect what the file is: try board first, then template spec.
    // A template file has no pcb block, so the board parse fails fast.
    let result = addLocalBoard(raw);
    if (!result.ok && typeof raw === 'object' && raw !== null && !('pcb' in raw)) {
      const asTemplate = addLocalTemplate(raw);
      if (asTemplate.ok) result = asTemplate;
    }
    setImportNotice(result);
    if (result.ok && result.board) {
      setSourceFilter('all');
      setManufacturer('all');
      setSearch('');
      setSelectedId(result.board.id);
    }
  };

  const onExport = (id: string) => {
    const json = exportLocalBoard(id);
    if (!json) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `${id}.board.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const selectedTpl = selected ? findTemplateByBoardAcrossSources(selected.board.id) : undefined;
  const selectedTemplates = selected
    ? allTemplates.filter((t) => t.boardId === selected.board.id)
    : [];

  return (
    <div className="welcome-overlay" data-testid="welcome-overlay">
      <div className="wb">
        <header className="wb-header">
          <div>
            <h1>Start a New Project</h1>
            <p>
              Pick a board — its enclosure generates around the real connector and
              mounting-hole geometry. Import board JSON or add online sources to grow the
              library.
            </p>
          </div>
          <div className="wb-header__actions">
            <button
              className={`wb-btn wb-btn--ghost ${sourcesOpen ? 'wb-btn--toggled' : ''}`}
              onClick={() => setSourcesOpen((v) => !v)}
              data-testid="welcome-sources-toggle"
              aria-expanded={sourcesOpen}
              title="Manage board sources (local library, online sources)"
            >
              ⛁ Sources
              {remoteSources.length > 0 && ` · ${remoteSources.length}`}
              <span className="wb-btn__chevron" aria-hidden="true">
                {sourcesOpen ? ' ▾' : ' ▸'}
              </span>
            </button>
            <button
              className="wb-btn wb-btn--ghost"
              onClick={() => fileInputRef.current?.click()}
              data-testid="welcome-import-board"
              title="Add a board profile (.json) to your local library"
            >
              ⤓ Import board JSON
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            data-testid="welcome-import-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onImportFile(f);
            }}
          />
        </header>

        {sourcesOpen && <SourcesPanel />}

        {importNotice && (
          <div
            className={`wb-notice ${importNotice.ok ? 'wb-notice--ok' : 'wb-notice--err'}`}
            data-testid="welcome-import-notice"
          >
            <span>
              {importNotice.ok ? (
                <>
                  Imported {importNotice.kind === 'template' ? 'template ' : ''}
                  <strong>{(importNotice.board ?? importNotice.template)?.name}</strong>
                  {importNotice.renamedFrom &&
                    ` (id "${importNotice.renamedFrom}" was taken — saved as "${importNotice.board?.id}")`}
                  {importNotice.warnings.length > 0 && ` — ${importNotice.warnings.join(' ')}`}
                </>
              ) : (
                importNotice.error
              )}
            </span>
            <button onClick={() => setImportNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        <div className="wb-toolbar">
          <input
            className="wb-search"
            type="search"
            placeholder="Search boards & templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="welcome-search"
            aria-label="Search boards and templates"
          />
          <div className="wb-chips" role="group" aria-label="Board filters">
            {(
              [
                ['all', `All · ${entries.length}`],
                ['quickstart', '★ Quickstart'],
                ['local', `My library · ${localBoards.length}`],
                ...remoteSources
                  .filter((s) => s.enabled)
                  .map((s): [string, string] => [`remote:${s.id}`, `⛁ ${s.label} · ${s.boards.length}`]),
              ] as Array<[SourceFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                className={`wb-chip ${sourceFilter === key ? 'wb-chip--active' : ''}`}
                onClick={() => setSourceFilter(key)}
                data-testid={`welcome-filter-${key}`}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            className="wb-mfr"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            aria-label="Filter by manufacturer"
            data-testid="welcome-manufacturer"
          >
            <option value="all">All manufacturers</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="wb-layout">
          <main className="wb-main">
            {projectTypeTemplates.length > 0 && (
              <section className="wb-templates" aria-label="Project types without a board">
                <h2>No board? Start from a project type</h2>
                <ul className="wb-grid wb-grid--templates">
                  {projectTypeTemplates.map((t) => (
                    <li key={t.id}>
                      <button
                        className="wb-card wb-card--tpl"
                        onClick={() => {
                          void applyTemplate(t.id);
                        }}
                        data-testid={`welcome-template-${t.id}`}
                        aria-label={`Load ${t.name} template`}
                      >
                        <div className="wb-card__name">{t.name}</div>
                        <div className="wb-card__desc">{t.description}</div>
                        <div className="wb-card__print">
                          ~{t.estPrintMinutes} min print
                          {t.sourceLabel ? ` · ⛁ ${t.sourceLabel}` : ''}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section aria-label="Boards">
              {filtered.length === 0 ? (
                <div className="wb-empty" data-testid="welcome-no-boards">
                  No boards match{search ? ` “${search}”` : ''}.
                  {sourceFilter === 'local' && localBoards.length === 0 && (
                    <>
                      {' '}
                      Your local library is empty — import a board JSON, or open a project's
                      Board editor and “Save to library”.
                    </>
                  )}
                </div>
              ) : (
                <ul className="wb-grid">
                  {filtered.map(({ board, origin }) => {
                    const tpl = findTemplateByBoardAcrossSources(board.id);
                    const badge = board.measurementMethod
                      ? MEASUREMENT_BADGES[board.measurementMethod]
                      : undefined;
                    return (
                      <li key={board.id}>
                        <button
                          className={`wb-card ${selectedId === board.id ? 'wb-card--selected' : ''}`}
                          onClick={() => setSelectedId(board.id)}
                          onDoubleClick={() => applyBoard(board.id)}
                          data-testid={`welcome-board-${board.id}`}
                          aria-pressed={selectedId === board.id}
                        >
                          <div className="wb-card__preview">
                            <BoardPreviewSvg board={board} />
                          </div>
                          <div className="wb-card__name">{board.name}</div>
                          <div className="wb-card__mfr">{board.manufacturer}</div>
                          <div className="wb-card__meta">
                            <span className="wb-dims">
                              {fmtMm(board.pcb.size.x)} × {fmtMm(board.pcb.size.y)} mm
                            </span>
                            <span className="wb-card__badges">
                              {tpl && (
                                <span className="wb-badge wb-badge--tpl" title="Has a curated quickstart template">
                                  ★
                                </span>
                              )}
                              {origin.kind === 'local' && (
                                <span className="wb-badge wb-badge--local" title="From your local library">
                                  LOCAL
                                </span>
                              )}
                              {origin.kind === 'remote' && (
                                <span
                                  className="wb-badge wb-badge--remote"
                                  title={`From online source “${origin.sourceLabel}”`}
                                >
                                  ⛁ {origin.sourceLabel}
                                </span>
                              )}
                              {board.verified && (
                                <span
                                  className="wb-badge wb-badge--verified"
                                  title="A case printed from this profile has been physically verified to fit"
                                >
                                  ✓ printed
                                </span>
                              )}
                              {badge && (
                                <span className="wb-badge" title={badge.title}>
                                  {badge.label}
                                </span>
                              )}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="wb-templates" aria-label="Quick start templates">
              <h2>Quick Start Templates</h2>
              <ul className="wb-grid wb-grid--templates">
                {boardTemplates.map((t) => (
                  <li key={t.id}>
                    <button
                      className="wb-card wb-card--tpl"
                      onClick={() => {
                        void applyTemplate(t.id);
                      }}
                      data-testid={`welcome-template-${t.id}`}
                      aria-label={`Load ${t.name} template`}
                    >
                      <div className="wb-card__name">{t.name}</div>
                      <div className="wb-card__desc">{t.description}</div>
                      <div className="wb-card__print">
                        ~{t.estPrintMinutes} min print
                        {t.sourceLabel ? ` · ⛁ ${t.sourceLabel}` : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </main>

          <aside className="wb-rail" aria-label="Board details">
            {selected ? (
              <div className="wb-detail" data-testid="welcome-detail">
                <div className="wb-detail__preview">
                  <BoardPreviewSvg board={selected.board} />
                </div>
                <h2 className="wb-detail__name">{selected.board.name}</h2>
                <div className="wb-detail__mfr">
                  {selected.board.manufacturer}
                  {selected.origin.kind === 'remote' && ` · via ${selected.origin.sourceLabel}`}
                  {selected.origin.kind === 'local' && ' · your library'}
                </div>

                <div className="wb-actions">
                  {selectedTpl ? (
                    <>
                      <button
                        className="wb-btn wb-btn--primary"
                        onClick={() => applyBoard(selected.board.id)}
                        data-testid="welcome-generate"
                        title={`Applies the "${selectedTpl.name}" quickstart recipe`}
                      >
                        ★ Create from quickstart
                      </button>
                      <button
                        className="wb-btn"
                        onClick={() => applyBoard(selected.board.id, { forceBlank: true })}
                        data-testid="welcome-generate-blank"
                      >
                        Blank shell
                      </button>
                    </>
                  ) : (
                    <button
                      className="wb-btn wb-btn--primary"
                      onClick={() => applyBoard(selected.board.id)}
                      data-testid="welcome-generate"
                    >
                      Generate shell
                    </button>
                  )}
                </div>

                <dl className="wb-specs">
                  <dt>PCB</dt>
                  <dd>
                    {fmtMm(selected.board.pcb.size.x)} × {fmtMm(selected.board.pcb.size.y)} ×{' '}
                    {fmtMm(selected.board.pcb.size.z)} mm
                  </dd>
                  <dt>Mounting holes</dt>
                  <dd>
                    {selected.board.mountingHoles.length === 0
                      ? selected.board.retentionClips?.length
                        ? 'none — snap-clip retention'
                        : 'none'
                      : selected.board.mountingHoles.length}
                  </dd>
                  <dt>Standoff</dt>
                  <dd>{fmtMm(selected.board.defaultStandoffHeight)} mm</dd>
                  <dt>Z clearance</dt>
                  <dd>{fmtMm(selected.board.recommendedZClearance)} mm</dd>
                  {selected.board.enclosure && (
                    <>
                      <dt>Form</dt>
                      <dd>finished module (vendor shell)</dd>
                    </>
                  )}
                </dl>

                {connectorInventory(selected.board).length > 0 && (
                  <>
                    <h3>Connectors & features</h3>
                    <ul className="wb-connectors">
                      {connectorInventory(selected.board).map(({ label, count }) => (
                        <li key={label}>
                          {count > 1 ? `${count}× ` : ''}
                          {label}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {selectedTemplates.length > 0 && (
                  <>
                    <h3>Templates for this board</h3>
                    <ul className="wb-detail-templates">
                      {selectedTemplates.map((t) => (
                        <li key={t.id}>
                          <button
                            onClick={() => {
                              void applyTemplate(t.id);
                            }}
                            title={t.description}
                          >
                            {t.name} <span>~{t.estPrintMinutes} min</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {(selected.board.source ||
                  selected.board.crossReference ||
                  selected.board.measurementMethod) && (
                  <>
                    <h3>Provenance</h3>
                    <ul className="wb-provenance">
                      {selected.board.verified && (
                        <li>✓ A printed case from this profile has been verified to fit.</li>
                      )}
                      {selected.board.measurementMethod && (
                        <li>{MEASUREMENT_BADGES[selected.board.measurementMethod]?.title}</li>
                      )}
                      {selected.board.source && (
                        <li>
                          <a href={selected.board.source} target="_blank" rel="noreferrer">
                            Spec source ↗
                          </a>
                        </li>
                      )}
                      {selected.board.crossReference && (
                        <li>
                          <a href={selected.board.crossReference} target="_blank" rel="noreferrer">
                            CAD cross-reference ↗
                          </a>
                        </li>
                      )}
                    </ul>
                  </>
                )}

                {selected.origin.kind === 'local' && (
                  <div className="wb-local-actions">
                    <button className="wb-btn" onClick={() => onExport(selected.board.id)} data-testid="welcome-export-board">
                      Export JSON
                    </button>
                    <button
                      className="wb-btn wb-btn--danger"
                      data-testid="welcome-remove-board"
                      onClick={() => {
                        removeLocalBoard(selected.board.id);
                        setSelectedId(null);
                      }}
                    >
                      Remove from library
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="wb-detail wb-detail--empty">
                <p>Select a board to see its specs, connector inventory, and provenance.</p>
                <p className="wb-hint">
                  Double-click a card to create the project straight away. Boards marked ★ apply
                  their curated quickstart recipe.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
