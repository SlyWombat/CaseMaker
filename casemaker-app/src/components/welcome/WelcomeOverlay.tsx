import { featureSim } from '@/platform/features';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useProjectStore, clearHistory } from '@/store/projectStore';
import { useLibraryStore, refreshStaleSources, type ImportResult } from '@/store/libraryStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useRecentJobsStore } from '@/store/recentJobsStore';
import { useViewportStore } from '@/store/viewportStore';
import { openRecentJob } from '@/store/openRecentJob';
import { openDoorFile } from '@/store/openDoorFile';
import { enterCncWorkspace } from '@/store/enterCncWorkspace';
import { listBoards, type RegisteredBoard } from '@/library/registry';
import {
  listTemplates,
  findTemplateAcrossSources,
  findTemplateByBoardAcrossSources,
  type RegisteredTemplate,
} from '@/library/templateRegistry';
import { scheduleImmediate } from '@/engine/jobs/JobScheduler';
import { BoardPreviewSvg } from './BoardPreviewSvg';
import { BoardPreview3d } from './BoardPreview3d';
import { SourcesPanel } from './SourcesPanel';
import { CasesArt, CncArt, RacksArt, ToolboxesArt } from './CapabilityArt';
import type { BoardProfile, ComponentKind } from '@/types';

/**
 * Welcome / new-project screen (#69, #878). Above the fold, the front door: a hero line and the
 * four capability cards — Cases, Racks, Toolboxes, CNC cutting — each with its own illustration
 * and one primary action into that flow. Under them, quietly, the starters and the recent jobs.
 * Below: the catalog. Left: searchable, filterable catalog of every board the registry knows
 * about — builtin, locally-imported, and remote-source — rendered as live top-view previews
 * straight from the profile data. Right: a sticky detail rail with the full spec, connector
 * inventory, provenance links, and the create actions. Then the quick-start template cards
 * (testids consumed by tests/e2e/templates-smoke.spec.ts).
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

/**
 * #680 — the starter jobs, by the ids the wizard's `chooseJob` understands. The labels are the
 * door's words (the mockup's "Name badge" / "Bare blank" / "Name on a dowel"), not the templates'
 * long names. #716 R-UI-15 — `dowel` is not a project template: the wizard seeds a ⌀20 × 100 rod
 * in the rotary chuck and opens on Holding (see `chooseJob`).
 */
const STARTERS = [
  { id: 'badge-blank', label: 'Name badge' },
  { id: 'blank', label: 'Bare blank' },
  { id: 'dowel', label: 'Name on a dowel' },
] as const;

/** The anchor the Cases card scrolls to: the board catalog is the case designer's way in. */
const BOARDS_ANCHOR_ID = 'welcome-boards';

/**
 * The four capability cards' words (#878). A headline of a few words and one line that says what
 * the user gets; Canadian spelling; nothing about how it is built. The CNC line is the approved
 * copy from the door it replaces.
 */
const CAPABILITY_COPY = {
  cases: {
    eyebrow: 'Cases',
    title: 'Cases that fit the board',
    text: 'Pick a board and the shell grows around its ports, holes and standoffs.',
    action: 'Pick a board',
  },
  racks: {
    eyebrow: 'Racks',
    title: 'Racks sized to your gear',
    text: 'A snap-together 10-inch rack — shelves, faceplates, cable tray — resized to fit your printer.',
    action: 'Build a rack',
  },
  toolboxes: {
    eyebrow: 'Toolboxes',
    title: 'Toolboxes that stack',
    text: 'Bins and lids that register on each other with no connector, and inserts pocketed to your own tools.',
    action: 'Stack a toolbox',
  },
  cnc: {
    eyebrow: 'CNC cutting',
    title: 'Cut it on the CNC',
    text: 'Carve hardwood on the CNC — a name plate, a coaster, a pocket, an engraving.',
    action: 'Start a cutting job',
  },
} as const;

function fmtMm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * #1123 item 1 — THE WHOLE TILE IS THE CONTROL. The card itself is the button (a `<button>` may not
 * wrap the heading and the paragraph it must contain), and the primary action stays inside it as a
 * span, visually the same label. Pointer or Enter/Space, the same action fires.
 */
function tile(action: () => void): {
  role: 'button';
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        action();
      }
    },
  };
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

/**
 * One welcome-screen template card (#504). Both strips — board-less project
 * types and the board-bound Quick Start list — show the same card, so the
 * four-line description cut and its disclosure path live here once.
 *
 * The description is wrapped because the card is a flex column with a
 * min-height: if the clamped description is itself the flex item it also
 * carries `flex: 1`, flex-grow stretches it past four lines, and a fifth line
 * leaks out (which is exactly what the desktop cards did before #504). The
 * wrapper takes the growth; the inner element is an ordinary block child that
 * stays exactly four lines tall, which is what `-webkit-line-clamp` needs to
 * draw its native ellipsis.
 *
 * Clamping is deliberate (consistent card heights), so the full text must
 * still be reachable: `title` gives pointer users a hover tooltip and
 * `aria-describedby` hands the full, unclipped description to assistive tech
 * — the visual ellipsis is the cue that there is more, not the only copy.
 */
function TemplateCard({
  t,
  onApply,
}: {
  t: RegisteredTemplate;
  onApply: (id: string) => void;
}) {
  const descId = `welcome-template-desc-${t.id}`;
  return (
    <li>
      <button
        className="wb-card wb-card--tpl"
        onClick={() => onApply(t.id)}
        data-testid={`welcome-template-${t.id}`}
        aria-label={`Load ${t.name} template`}
        aria-describedby={descId}
        title={t.description}
      >
        <div className="wb-card__name">{t.name}</div>
        <div className="wb-card__desc-wrap">
          <div className="wb-card__desc" id={descId}>
            {t.description}
          </div>
        </div>
        <div className="wb-card__print">
          ~{t.estPrintMinutes} min print
          {t.sourceLabel ? ` · ⛁ ${t.sourceLabel}` : ''}
        </div>
      </button>
    </li>
  );
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
  const openWizard = useStartWizardStore((s) => s.openWizard);

  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [manufacturer, setManufacturer] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<ImportResult | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const recents = useRecentJobsStore((s) => s.jobs);
  const [openingRecent, setOpeningRecent] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  // #1122 — a dropped file that is neither a project nor a job, in one sentence.
  const [dropError, setDropError] = useState<string | null>(null);

  // Refresh week-old source caches in the background on first mount (#132).
  useEffect(() => {
    refreshStaleSources();
  }, []);

  // Store slices in deps: registry reads the store, re-list on change.
  // The slices are not read inside the callbacks: they are the signal that the registry changed.
  /* eslint-disable react-hooks/exhaustive-deps */
  const entries = useMemo(() => listBoards(), [localBoards, remoteSources]);
  const allTemplates = useMemo(() => listTemplates(), [remoteSources, localTemplates, localBoards]);
  /* eslint-enable react-hooks/exhaustive-deps */

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
    // No re-ordering: registry order is built-in, then local, then remote in
    // the order the sources were added. A board's origin is stated on its card
    // and in the rail; it is never a reason to rank one board above another
    // (#128 — provenance, not a quality verdict).
    return filteredList;
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

  /**
   * The Racks and Toolboxes cards: build the project type's template and land in its own editor,
   * so the card's promise ("Build a rack") is kept in one click. A template card below leaves the
   * section alone, as it always has.
   */
  const startProjectType = async (templateId: string, section: 'rack' | 'toolbox') => {
    await applyTemplate(templateId);
    if (!useProjectStore.getState().welcomeMode) {
      useViewportStore.getState().setActiveSidebarSection(section);
    }
  };

  /** The Cases card: bring the board catalog up and put the cursor in its search. */
  const goToBoards = () => {
    const anchor = document.getElementById(BOARDS_ANCHOR_ID);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    anchor?.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    searchRef.current?.focus({ preventScroll: true });
  };

  /** #1123 item 2 — the wizard is an overlay ON the CNC workspace, so ✕ leaves the operator there. */
  const enterCnc = () => {
    enterCncWorkspace();
    openWizard();
  };

  /** #1122 — a file dropped on the door takes Load's route: project, job, or one sentence. */
  const onDropFile = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    try {
      const result = await openDoorFile({ text: await f.text(), name: f.name, handle: null });
      setDropError(result.ok ? null : result.error);
    } catch (error) {
      setDropError(error instanceof Error ? error.message : String(error));
    }
  };

  /** #680 — reopen a recent job. On success the project flips welcome mode off, so this overlay goes. */
  const openRecent = async (recent: (typeof recents)[number]): Promise<void> => {
    if (openingRecent !== null) return;
    setOpeningRecent(recent.fileName);
    setRecentError(null);
    const result = await openRecentJob(recent);
    if (!result.ok) {
      setOpeningRecent(null);
      setRecentError(`${recent.name} was not opened: ${result.error}`);
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
    <div
      className="welcome-overlay"
      data-testid="welcome-overlay"
      onDragOver={(e) => {
        // #1122 — a file drop needs the default prevented; only files are taken.
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => void onDropFile(e)}
    >
      <div className="wb">
        {/* #878 — the front door. The hero names the product in one line; the four cards are the
            capabilities, each with its own picture and one way in. The library controls sit to
            the right of the hero, quieter: they are housekeeping, not a reason to be here. */}
        <header className="wb-hero" data-testid="welcome-hero">
          <div className="wb-hero__copy">
            <span className="wb-eyebrow">Case Maker</span>
            <h1>Design it. Print it. Cut it.</h1>
            <p>
              Enclosures, racks and toolboxes shaped around the hardware you own — and CNC jobs
              that run on your Carvera, simulated before a chip flies.
            </p>
          </div>
          <div className="wb-hero__actions">
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

        {/* #1122 — a file dropped on the door was neither a project nor a job: one sentence, and
            the schema/parse detail stayed in the console. */}
        {dropError !== null && (
          <div className="wb-notice wb-notice--err" data-testid="welcome-drop-error">
            <span>{dropError}</span>
            <button onClick={() => setDropError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {/* The four doors (#680, #878). The print cards build a project straight away or lead to
            the board catalog; the CNC card opens the cutting wizard over this page (`start-wizard`),
            so the operator is in the job and nowhere else. A build with no CNC section offers no
            cutting door (#343). */}
        <ul className="wb-caps" data-testid="welcome-doors" aria-label="What Case Maker makes">
          <li>
            <article
              className="wb-cap wb-cap--cases"
              data-testid="welcome-door-print"
              title="Jump to the board catalog below"
              {...tile(goToBoards)}
            >
              <div className="wb-cap__art">
                <CasesArt title="An open enclosure with a board inside and the port cut-outs in its wall" />
              </div>
              <span className="wb-eyebrow">{CAPABILITY_COPY.cases.eyebrow}</span>
              <h2>{CAPABILITY_COPY.cases.title}</h2>
              <p>{CAPABILITY_COPY.cases.text}</p>
              <span className="wb-btn wb-btn--primary wb-cap__action" data-testid="welcome-start-case">
                {CAPABILITY_COPY.cases.action}
              </span>
            </article>
          </li>
          <li>
            <article
              className="wb-cap wb-cap--racks"
              data-testid="welcome-door-racks"
              title="Open the rack designer with the 10-inch mini rack"
              {...tile(() => void startProjectType('mini-rack-10in', 'rack'))}
            >
              <div className="wb-cap__art">
                <RacksArt title="A 10-inch rack frame with U-rails, two shelves and a switch on the lower shelf" />
              </div>
              <span className="wb-eyebrow">{CAPABILITY_COPY.racks.eyebrow}</span>
              <h2>{CAPABILITY_COPY.racks.title}</h2>
              <p>{CAPABILITY_COPY.racks.text}</p>
              <span className="wb-btn wb-btn--primary wb-cap__action" data-testid="welcome-start-rack">
                {CAPABILITY_COPY.racks.action}
              </span>
            </article>
          </li>
          <li>
            <article
              className="wb-cap wb-cap--toolboxes"
              data-testid="welcome-door-toolboxes"
              title="Open the toolbox designer with the stacking toolbox"
              {...tile(() => void startProjectType('toolbox', 'toolbox'))}
            >
              <div className="wb-cap__art">
                <ToolboxesArt title="A stacked toolbox bin with a divided tray of sockets and bits, its lid lifted" />
              </div>
              <span className="wb-eyebrow">{CAPABILITY_COPY.toolboxes.eyebrow}</span>
              <h2>{CAPABILITY_COPY.toolboxes.title}</h2>
              <p>{CAPABILITY_COPY.toolboxes.text}</p>
              <span className="wb-btn wb-btn--primary wb-cap__action" data-testid="welcome-start-toolbox">
                {CAPABILITY_COPY.toolboxes.action}
              </span>
            </article>
          </li>
          {featureSim && (
            <li>
              <article
                className="wb-cap wb-cap--cnc"
                data-testid="welcome-door-cnc"
                title="Check for a machine, pick what you are making, then set up the cut"
                {...tile(enterCnc)}
              >
                <div className="wb-cap__art">
                  <CncArt title="A CNC spindle cutting a pocket in a block of stock, the toolpath on its floor" />
                </div>
                <span className="wb-eyebrow">{CAPABILITY_COPY.cnc.eyebrow}</span>
                <h2>{CAPABILITY_COPY.cnc.title}</h2>
                <p>{CAPABILITY_COPY.cnc.text}</p>
                <span className="wb-btn wb-btn--primary wb-cap__action" data-testid="welcome-start-cnc">
                  {CAPABILITY_COPY.cnc.action}
                </span>
              </article>
            </li>
          )}
        </ul>

        {/* The quiet row: ways back into cutting work. The last three files the app saved or
            opened — absent until there is one, no sentence says so — and the starter jobs. */}
        {featureSim && (
          <div className="wb-quiet" data-testid="welcome-quiet">
            {recents.length > 0 && (
              <div className="wb-door__links" data-testid="welcome-recent-jobs">
                <span className="wb-door__label">Recent:</span>
                {recents.map((recent, i) => (
                  <span key={recent.fileName}>
                    {i > 0 && ' · '}
                    <button
                      type="button"
                      className="wb-door__link"
                      data-testid={`welcome-recent-${i}`}
                      title={recent.fileName}
                      disabled={openingRecent !== null}
                      onClick={() => void openRecent(recent)}
                    >
                      {recent.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="wb-door__links" data-testid="welcome-starters">
              <span className="wb-door__label">Starters:</span>
              {STARTERS.map((starter, i) => (
                <span key={starter.id}>
                  {i > 0 && ' · '}
                  <button
                    type="button"
                    className="wb-door__link"
                    data-testid={`welcome-starter-${starter.id}`}
                    onClick={() => {
                      enterCncWorkspace();
                      openWizard('machine', starter.id);
                    }}
                  >
                    {starter.label}
                  </button>
                </span>
              ))}
            </div>
            {recentError !== null && (
              <p className="wb-door__text" data-testid="welcome-recent-error">
                {recentError}
              </p>
            )}
          </div>
        )}

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

        <div className="wb-toolbar" id={BOARDS_ANCHOR_ID}>
          <input
            ref={searchRef}
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
                    <TemplateCard
                      key={t.id}
                      t={t}
                      onApply={(id) => {
                        void applyTemplate(id);
                      }}
                    />
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
                            <BoardPreviewSvg board={board} variant="card" />
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
                              {/* Every card states its ORIGIN (#128): bundled with
                                  the app, added by you, or fetched from an online
                                  source. Provenance, never a verdict on quality. */}
                              <span
                                className={`wb-badge wb-badge--${origin.kind === 'builtin' ? 'builtin' : origin.kind}`}
                                data-testid={`welcome-origin-${board.id}`}
                                data-origin={origin.kind}
                                title={
                                  origin.kind === 'builtin'
                                    ? 'Bundled with the app'
                                    : origin.kind === 'local'
                                      ? 'Added by you — imported JSON, stored in this browser'
                                      : `From online source “${origin.sourceLabel}”`
                                }
                              >
                                {origin.kind === 'builtin'
                                  ? 'BUILT-IN'
                                  : origin.kind === 'local'
                                    ? 'LOCAL'
                                    : `⛁ ${origin.sourceLabel}`}
                              </span>
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
                  <TemplateCard
                    key={t.id}
                    t={t}
                    onApply={(id) => {
                      void applyTemplate(id);
                    }}
                  />
                ))}
              </ul>
            </section>
          </main>

          <aside className="wb-rail" aria-label="Board details">
            {selected ? (
              <div className="wb-detail" data-testid="welcome-detail">
                <div className="wb-detail__preview">
                  {selected.board.visualAssets?.glb ? (
                    <BoardPreview3d
                      board={selected.board}
                      fallback={<BoardPreviewSvg board={selected.board} variant="rail" />}
                    />
                  ) : (
                    <BoardPreviewSvg board={selected.board} variant="rail" />
                  )}
                </div>
                <h2 className="wb-detail__name">{selected.board.name}</h2>
                <div className="wb-detail__mfr" data-testid="welcome-detail-origin" data-origin={selected.origin.kind}>
                  {selected.board.manufacturer}
                  {selected.origin.kind === 'builtin' && ' · built in'}
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
                  selected.board.measurementMethod ||
                  selected.board.version !== undefined) && (
                  <>
                    <h3>Provenance</h3>
                    <ul className="wb-provenance">
                      {selected.board.version !== undefined && (
                        <li data-testid="welcome-board-version">
                          Profile version {String(selected.board.version)}
                        </li>
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

                {selected.board.notes && (
                  <>
                    <h3>Notes</h3>
                    <p className="wb-notes" data-testid="welcome-board-notes">
                      {selected.board.notes}
                    </p>
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
