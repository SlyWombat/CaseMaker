import { featureSim } from '@/platform/features';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useProjectStore,
  undoProject,
  redoProject,
  clearHistory,
} from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  downloadProjectJson,
  fileSystemAccessAvailable,
  openTextFileViaPicker,
  saveProjectViaPicker,
  type ProjectFileHandle,
} from '@/store/persistence';
import { JOB_FILE_TYPE } from '@/engine/cnc/engrave/jobFile';
import { DOOR_FILE_TYPE, openDoorFile } from '@/store/openDoorFile';
import { DocsModal } from '@/components/docs/DocsModal';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { PartsMenu } from '@/components/layout/PartsMenu';
import { ExportModal } from '@/components/panels/ExportModal';
import { useManageModeStore } from '@/store/manageModeStore';
import { useFlightRecorderStore } from '@/store/flightRecorderStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { ConfirmDialog } from './ConfirmDialog';
import { useViewportStore } from '@/store/viewportStore';

const FORMAT_LABEL: Record<string, string> = {
  'stl-binary': 'STL (binary)',
  'stl-ascii': 'STL (ASCII)',
  '3mf': '3MF',
};

/** Tablet breakpoint — the widest window the full row does NOT fit cleanly in
 *  (#134). Measured: the row plus the wordmark needs ~848px before it even
 *  stops overflowing, and the buttons only stop wrapping their labels (52px
 *  tall instead of 71px) from 900px. Below it the toolbar collapses. */
const COMPACT_MAX_W = 900;

/**
 * Issue #134 — below this breakpoint the header toolbar collapses its
 * secondary controls behind a ⋯ overflow menu. The full row is ~890px of
 * content; at 390px that left Save / Save as / Load / Export / Parts / Docs /
 * settings off-screen behind a silent horizontal swipe, and at 641–900px the
 * header became a scroll container, which clipped the settings popover to the
 * 48px bar and hid the same controls just as silently. Phones (≤640px) also
 * drop the wordmark — see the .app-header__logo rule in index.css.
 *
 * This deliberately sits a little above the 848px the row needs to stop
 * overflowing: between 848 and 900 nothing is hidden, but every button label
 * wraps to two lines inside a 48px bar.
 */
function useIsCompactBar(): boolean {
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= COMPACT_MAX_W : false,
  );
  useEffect(() => {
    function onResize(): void {
      setIsCompact(window.innerWidth <= COMPACT_MAX_W);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isCompact;
}

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const showWelcome = useProjectStore((s) => s.showWelcome);
  const showHome = useProjectStore((s) => s.showHome);
  // #1123-48 — a machine RUN disables Home with its reason; Generate may carry on behind Home.
  const machineRunning = useMachineRunStore((s) => Object.values(s.runs).some((r) => r.running === true));
  const [confirmNewOpen, setConfirmNewOpen] = useState(false);
  // While the welcome overlay is up, the store still holds the LAST project
  // (or the createDefaultProject placeholder) — Save / Save as / Export
  // would silently operate on that stale state, which is what the user hits
  // when they click "Export" after returning to the welcome screen and see
  // the previous project's STL come down. Disable those entry points until
  // a board / template is picked. Load stays enabled — it's another valid
  // way out of welcome mode.
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // #1122 — the door's dedicated job picker, beside Load.
  const jobFileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Issue #134 — the ⋯ overflow menu, phone widths only.
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const isCompactBar = useIsCompactBar();
  // Issue #70 — remember the last file handle so subsequent saves overwrite
  // in place. Reset whenever the user picks "Save as…" or loads a new file.
  const fileHandleRef = useRef<ProjectFileHandle>(null);
  const fsaAvailable = fileSystemAccessAvailable();
  // #311 — the house surface. Entered from here because the toolbar is the one chrome the app draws
  // in every mode, including with no project open — which is exactly when someone sets up cutters.
  const manageOpen = useManageModeStore((s) => s.open);
  const openManage = useManageModeStore((s) => s.openManage);
  const closeManage = useManageModeStore((s) => s.closeManage);
  // #686 — the project's New / Save / Save as / Load / Export belong to the PRINT project. On a CNC
  // page they would write or replace a case that has nothing to do with the job on screen, so they
  // are hidden there — the same signal the machine status strip uses. Undo/Redo, Manage and the rest
  // stay: they are app chrome, not project file actions.
  const activeSidebarSection = useViewportStore((s) => s.activeSidebarSection);
  const cncSection = activeSidebarSection === 'cnc-engrave' || activeSidebarSection === 'cnc-sim';

  // L-key shortcut for lid show/hide is now part of the view-mode picker
  // (#91 — Shift+1..4 cycles Complete / Exploded / Base / Lid). The
  // legacy single toggle is retired alongside the toolbar button.

  // Dismiss the ⋯ menu on an outside tap (same pattern as PartsMenu).
  useEffect(() => {
    if (!overflowOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [overflowOpen]);

  const onSave = useCallback(async () => {
    if (!fsaAvailable) {
      downloadProjectJson(project);
      return;
    }
    try {
      const handle = await saveProjectViaPicker(project, fileHandleRef.current ?? undefined);
      fileHandleRef.current = handle;
      setError(null);
    } catch (err) {
      // AbortError from a cancelled picker is harmless; ignore it.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project, fsaAvailable]);

  const onSaveAs = useCallback(async () => {
    if (!fsaAvailable) {
      downloadProjectJson(project);
      return;
    }
    try {
      const handle = await saveProjectViaPicker(project); // no existing handle → picker
      fileHandleRef.current = handle;
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project, fsaAvailable]);

  /**
   * #1122 — one file from the door, routed by kind. A project opens as today; a cutting job opens
   * through its own sequence (blank, job, Job panel). A refusal is one sentence in the bar, never a
   * schema dump.
   */
  const openDoorPicked = useCallback(
    async (picked: {
      text: string;
      name: string;
      handle: ProjectFileHandle | null;
    }): Promise<void> => {
      const result = await openDoorFile(picked);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // A project's picker handle is what Save writes back through; a job's handle is recorded by
      // its own file store inside `openDoorFile`.
      fileHandleRef.current = result.kind === 'project' ? picked.handle : null;
      setError(null);
      // #311 — a file was opened: the Manage surface is left, so what was just loaded is what is
      // drawn. Both entry points into a project do this, and a job takes the same exit.
      closeManage();
    },
    [closeManage],
  );

  const onLoadClick = useCallback(async () => {
    if (!fsaAvailable) {
      fileInput.current?.click();
      return;
    }
    try {
      const picked = await openTextFileViaPicker(DOOR_FILE_TYPE);
      if (picked === null) return;
      await openDoorPicked(picked);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fsaAvailable, openDoorPicked]);

  const onOpenJobClick = useCallback(async () => {
    if (!fsaAvailable) {
      jobFileInput.current?.click();
      return;
    }
    try {
      const picked = await openTextFileViaPicker(JOB_FILE_TYPE);
      if (picked === null) return;
      await openDoorPicked(picked);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fsaAvailable, openDoorPicked]);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        await openDoorPicked({ text: await f.text(), name: f.name, handle: null });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [openDoorPicked],
  );

  const onJobFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        await openDoorPicked({ text: await f.text(), name: f.name, handle: null });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (jobFileInput.current) jobFileInput.current.value = '';
      }
    },
    [openDoorPicked],
  );

  // #1123-48 — NEW ASKS IN THE APP'S OWN DIALOG, in honest words: the open work IS saved (the
  // stores persist it), so "unsaved changes will be lost" was only true when something really was
  // unsaved. The dialog says which, and the press then does the old work.
  const doNew = useCallback(() => {
    setConfirmNewOpen(false);
    // #311 — New returns to the board picker, so the Manage surface has to come down first: left
    // open on top of the overlay it would hide the very thing New just asked for, and the button
    // would look like it did nothing.
    closeManage();
    showWelcome();
    clearHistory();
    // #890 — a new job is being started: the previous session's crash prompt belongs to the
    // session that died, and it goes with the project rather than sitting over the new job.
    useFlightRecorderStore.getState().dismiss();
  }, [showWelcome, closeManage]);
  const onNew = useCallback(() => setConfirmNewOpen(true), []);
  /** What New replaces, in the operator's words, read at press time. */
  const newSentence = ((): string => {
    const file = useEngraveJobFileStore.getState();
    const name = file.fileName ?? useEngraveJobStore.getState().job.name;
    return file.dirty
      ? `Unsaved changes in "${name}" will be lost. The project and its job are replaced by a fresh one.`
      : `"${name}" will be replaced by a fresh project. Its job is not kept — save it first if you need it back.`;
  })();
  /**
   * #1123-48 — HOME: the main page over the work that is open. It resets nothing (the project and
   * the CNC job stay in their stores), and the main page's Continue row returns to them.
   */
  const onHome = useCallback(() => {
    closeManage();
    showHome();
  }, [showHome, closeManage]);

  // Open the multi-part export modal — per-part Save buttons + thumbnails
  // + a Save All footer that lays everything flat for printing. The old
  // direct-trigger behavior bypassed that workflow.
  const onExport = useCallback(() => {
    setExportOpen(true);
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // One node per control, rendered in exactly one place per layout. Desktop
  // keeps the original left-to-right order; below the breakpoint the primary
  // controls stay inline and the rest move into the ⋯ menu.
  // #1123-48 — HOME, FIRST IN THE TOOLBAR, always present. During a machine run it is disabled and
  // says why: a run is not something to navigate away from (the analyst's fields).
  const homeBtn = (
    <button
      type="button"
      data-testid="home"
      onClick={onHome}
      disabled={machineRunning}
      aria-disabled={machineRunning}
      // #134 (2026-11-10) — on a phone the word drops and the icon stays (index.css), so the
      // control needs a name of its own: a screen reader would otherwise read only the emoji.
      aria-label="Home"
      title={machineRunning ? 'a program is running — Home is available when it ends' : 'The main page — nothing is discarded, and Continue brings you back here'}
    >
      🏠 <span className="btn-label">Home</span>
    </button>
  );
  const newBtn = (
    <button
      onClick={onNew}
      data-testid="new-project"
      title="Start a new project (returns to the board / template picker)"
    >
      ✨ New
    </button>
  );
  // #311 — the Manage toggle, and the reason it sits beside New: both leave the project behind and
  // go somewhere that is not the viewport. Gated on `featureSim` (#343) with the rest of the CNC UI
  // (the web deployment switches the house off wholesale), and `aria-pressed` is how the toolbar
  // shows it is up — the app's toolbar buttons carry no class of their own, so the state has to hang
  // off an attribute that means exactly this (`.toolbar-buttons button[aria-pressed="true"]`).
  const manageBtn = featureSim ? (
    <button
      type="button"
      aria-pressed={manageOpen}
      data-testid="manage-open"
      title={
        manageOpen
          ? 'Leave the house — back to what you had open'
          : 'The house and its machines — your cutters, the Makera catalogue, and what the bench answered'
      }
      onClick={() => (manageOpen ? closeManage() : openManage())}
    >
      🧰 Manage
    </button>
  ) : null;
  // #355 — five of these carry their word in a `btn-label` span, which the stylesheet hides on a
  // laptop-width window (901–1199px): at that size the full row is wider than the bar and every
  // label wrapped to a second line inside the 48px header. The icons that survive alone (↶ ↷ 📂 ⬇
  // 👁 📖) are the ones that already say what the button does; New, Manage, Save and Save as… keep
  // their words, because ✨ and 🧰 carry less and 💾 is shared by the two save buttons.
  const undoBtn = (
    <button onClick={undoProject} data-testid="undo-btn" title="Undo (Ctrl+Z)">
      ↶ <span className="btn-label">Undo</span>
    </button>
  );
  const redoBtn = (
    <button onClick={redoProject} data-testid="redo-btn" title="Redo (Ctrl+Shift+Z)">
      ↷ <span className="btn-label">Redo</span>
    </button>
  );
  const saveBtn = (
    <button
      onClick={onSave}
      data-testid="save-project"
      disabled={welcomeMode}
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : fsaAvailable
            ? 'Save project (.caseproj.json) — overwrites the open file after first Save As'
            : 'Save project — downloads .caseproj.json to your Downloads folder'
      }
    >
      💾 Save
    </button>
  );
  const saveAsBtn = fsaAvailable ? (
    <button
      onClick={onSaveAs}
      data-testid="save-project-as"
      disabled={welcomeMode}
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : 'Save the project to a new .caseproj.json file (pick filename + folder)'
      }
    >
      💾 Save as…
    </button>
  ) : null;
  const loadBtn = (
    <button
      onClick={onLoadClick}
      data-testid="load-project"
      title="Load a project or a cutting job (.caseproj.json or .cutjob.json)"
    >
      📂 <span className="btn-label">Load</span>
    </button>
  );
  // #1122 — the door's second file door: a returning user with a job file never meets the wizard.
  // It is a CNC door, so it is gated with the CNC card and the rest of the house (#343).
  const openJobBtn = featureSim ? (
    <button
      onClick={onOpenJobClick}
      data-testid="open-job-door"
      title="Open a cutting job from a .cutjob.json file"
    >
      📄 <span className="btn-label">Open a job</span>
    </button>
  ) : null;
  const exportBtn = (
    <button
      onClick={onExport}
      disabled={welcomeMode}
      data-testid="export-default"
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : `Open the export modal — per-part thumbnails + Save All (current format: ${FORMAT_LABEL[exportFormat] ?? exportFormat}, change in ⚙)`
      }
    >
      ⬇ <span className="btn-label">Export…</span>
    </button>
  );
  const docsBtn = (
    <button
      onClick={() => setDocsOpen(true)}
      data-testid="docs-open"
      title="Open the User Manual"
    >
      📖 <span className="btn-label">Docs</span>
    </button>
  );
  const settingsMenu = settingsOpen ? <SettingsMenu onClose={closeSettings} /> : null;

  const settingsBtn = (
    <div className="toolbar-settings-wrap">
      <button
        onClick={() => setSettingsOpen((v) => !v)}
        data-testid="settings-open"
        title="App settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
      >
        ⚙
      </button>
      {settingsMenu}
    </div>
  );
  const fileInputEl = (
    <input
      ref={fileInput}
      type="file"
      accept=".json,.caseproj.json,.cutjob.json,application/json"
      onChange={onFileChange}
      data-testid="load-project-input"
    />
  );
  const jobFileInputEl = featureSim ? (
    <input
      ref={jobFileInput}
      type="file"
      accept=".cutjob.json,.json,application/json"
      onChange={onJobFileChange}
      data-testid="open-job-door-input"
    />
  ) : null;

  // The welcome page (#878): nothing has been chosen yet, so the job's chrome — Undo, Redo, Save,
  // Save as, Export, Parts, and the ⋯ menu that holds them on a phone — has nothing to act on and
  // is not drawn. What stays is what makes sense before any work exists: Manage (the house and its
  // cutters), Load, Docs and settings, in one short row that fits every width without a menu.
  // The full toolbar is back the moment `welcomeMode` flips off, which every way into a flow does
  // (`setProject`, `loadBuiltinBoard`, the wizard) — and on MANAGE, which is not the welcome page
  // even while no project exists: its controls sit there disabled, as they always did, and the
  // slim row must not follow the operator into it.
  if (welcomeMode && !manageOpen) {
    return (
      <div className="toolbar-buttons toolbar-buttons--welcome" data-testid="toolbar-welcome">
        {manageBtn}
        {loadBtn}
        {openJobBtn}
        {docsBtn}
        {settingsBtn}
        {fileInputEl}
        {jobFileInputEl}
        {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
        {docsOpen && <DocsModal initialId="user-manual" onClose={() => setDocsOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="toolbar-buttons">
      {isCompactBar ? (
        <>
          {homeBtn}
          {undoBtn}
          {redoBtn}
          {!cncSection && saveBtn}
          {/* Issue #120 — Parts keeps its own popover; it stays inline rather
              than nesting a popover inside the ⋯ menu. */}
          <PartsMenu compact />
          <div className="toolbar-overflow" ref={overflowRef}>
            <button
              type="button"
              className="toolbar-overflow__toggle"
              onClick={() => setOverflowOpen((v) => !v)}
              data-testid="toolbar-overflow-toggle"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="More actions — New, Manage, Save as, Load, Export, Docs, settings"
            >
              ⋯
            </button>
            {overflowOpen && (
              <div
                className="toolbar-overflow__panel"
                role="menu"
                data-testid="toolbar-overflow-panel"
                // #503 — choosing a command must put the menu away. The outside-tap handler below
                // cannot do it: a click ON a command is inside `overflowRef`, so the menu stayed up
                // over whatever the command opened — the Manage rail, the Export dialog's backdrop,
                // the Docs reader. Any click on one of the panel's buttons is a choice; close on the
                // way out. (Settings keeps its own handler and is unaffected.)
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button') !== null) setOverflowOpen(false);
                }}
              >
                {!cncSection && newBtn}
                {manageBtn}
                {!cncSection && saveAsBtn}
                {!cncSection && loadBtn}
                {!cncSection && exportBtn}
                {docsBtn}
                <button
                  type="button"
                  onClick={() => {
                    setOverflowOpen(false);
                    setSettingsOpen(true);
                  }}
                  data-testid="settings-open"
                  aria-haspopup="dialog"
                  aria-expanded={settingsOpen}
                  title="App settings"
                >
                  ⚙ Settings
                </button>
              </div>
            )}
            {settingsMenu}
          </div>
        </>
      ) : (
        <>
          {homeBtn}
          {!cncSection && newBtn}
          {manageBtn}
          {undoBtn}
          {redoBtn}
          {!cncSection && saveBtn}
          {!cncSection && saveAsBtn}
          {!cncSection && loadBtn}
          {!cncSection && exportBtn}
          {/* Issue #120 — Parts pulldown replaces the Show-board toggle. Lists
              every top-level node in the current BuildPlan (case, lid, gasket,
              fasteners, accessories) with per-part visibility checkboxes. The
              host-board visibility is no longer split out — it's a separate
              rendering layer that the view-mode picker covers via base-only
              mode. */}
          <PartsMenu />
          {docsBtn}
          {settingsBtn}
        </>
      )}
      {fileInputEl}
      {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
      {docsOpen && <DocsModal initialId="user-manual" onClose={() => setDocsOpen(false)} />}
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
      {confirmNewOpen && (
        <ConfirmDialog
          title="Start a new project?"
          body={newSentence}
          confirmLabel="Start a new project"
          onConfirm={doNew}
          onCancel={() => setConfirmNewOpen(false)}
          testId="new-project-confirm"
        />
      )}
    </div>
  );
}
