import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { useStartWizardStore } from '@/store/startWizardStore';
import { savedTimeText } from './engraveJobFileBarText';

/**
 * The ONE file bar (#686, design §1): the job's name, when it was last saved, the dirty marker,
 * and a `File ▾` menu holding Save / Save as… / Open… and the `.3mf` design read.
 *
 * The bar owns no document state of its own: the name is the job's, and the saved time, file name,
 * dirty marker and notices are the `engraveJobFileStore`'s, which serializes the open job on every
 * write. The old owner note is gone — the ownership fact ("the file is the owner: the package, the
 * run log and the sources travel with it") is the Save item's hover, where it belongs.
 *
 * The menu's first item starts the NEXT job (#686 follow-up): the toolbar's project New is hidden
 * on CNC pages, so without it a CNC page has no way to begin another cutting job short of leaving
 * for a print section. It opens the one wizard at step 1, and asks first only when the open job has
 * unsaved changes — the same rule the toolbar's New applies to the print project.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: 0 };
const NOTICE_COLOR: Record<string, string> = {
  ok: '#a7d7a7',
  info: '#9aa4b0',
  warning: '#e0c07a',
  error: '#f0b4ad',
};
const MENU_ITEM: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '5px 8px',
  background: 'none',
  border: 'none',
  color: '#d1d5db',
  fontSize: 12,
  cursor: 'pointer',
};


export interface EngraveJobFileBarProps {
  /**
   * The `.3mf` design read (#410) has no header button any more (#686): it is the File menu's
   * fourth item. Absent when the build has no simulation worker.
   */
  onReadDesign?: () => void;
  /** True while the picked design is being read: the item says so and is disabled. */
  designReading?: boolean;
  /**
   * #792 — THE RUN'S OWN FILES LIVE HERE. The Design footer holds ONE primary button (Generate /
   * Cut…), so Save .nc…, Run sheet… and Open run record… are the File menu's last three items —
   * the job's files and the run's files in the one place a file bar puts them. Their testids and
   * their availability rules are the panel's, handed in as props; each is absent when the panel
   * has nothing to offer.
   */
  onSaveProgram?: () => void;
  /** The sentence that keeps Save .nc… closed, or null when it may be pressed. */
  saveProgramBlocker?: string | null;
  onRunSheet?: () => void;
  runSheetReady?: boolean;
  runSheetBlocked?: boolean;
  onOpenRecord?: () => void;
}

export function EngraveJobFileBar({
  onReadDesign,
  designReading = false,
  onSaveProgram,
  saveProgramBlocker = null,
  onRunSheet,
  runSheetReady = false,
  runSheetBlocked = false,
  onOpenRecord,
}: EngraveJobFileBarProps): JSX.Element {
  const jobName = useEngraveJobStore((s) => s.job.name);
  const fileName = useEngraveJobFileStore((s) => s.fileName);
  const savedAt = useEngraveJobFileStore((s) => s.savedAt);
  const dirty = useEngraveJobFileStore((s) => s.dirty);
  const busy = useEngraveJobFileStore((s) => s.busy);
  const notice = useEngraveJobFileStore((s) => s.notice);
  const save = useEngraveJobFileStore((s) => s.save);
  const saveAs = useEngraveJobFileStore((s) => s.saveAs);
  const open = useEngraveJobFileStore((s) => s.open);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ctrl-S / Cmd-S from anywhere on the Design surface. Deliberately not skipped inside a field:
  // the operator is usually editing one when they press it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // An outside tap puts the menu away, the same pattern PartsMenu and the toolbar use.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const choose = (action: () => void): void => {
    setMenuOpen(false);
    action();
  };

  /**
   * The next job (#686 follow-up). Opening the wizard loses nothing by itself, but finishing it
   * replaces the open job — so the one moment worth a question is leaving unsaved changes behind,
   * and the question is the toolbar's New in the job's words.
   */
  function startNewJob(): void {
    if (dirty && !window.confirm('Start a new cutting job? Unsaved changes will be lost.')) return;
    useStartWizardStore.getState().openWizard();
  }

  return (
    <section
      aria-label="Job file"
      data-testid="engrave-job-file"
      style={{
        border: '1px solid #2c3540',
        borderRadius: 6,
        padding: '4px 8px',
        marginBottom: 8,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 6,
      }}
    >
      <span
        data-testid="engrave-job-file-name"
        title={fileName === null ? 'This job has no file yet.' : `File: ${fileName}`}
        style={{ fontSize: 12, fontWeight: 600, color: '#c8d3de' }}
      >
        {jobName}
      </span>
      <span data-testid="engrave-job-saved-time" style={MUTED}>
        {savedTimeText(savedAt)}
      </span>
      {dirty && (
        <span data-testid="engrave-job-dirty" style={{ ...MUTED, color: '#e0c07a' }}>
          · unsaved changes
        </span>
      )}

      <div ref={menuRef} style={{ marginLeft: 'auto', position: 'relative' }}>
        <button
          type="button"
          data-testid="engrave-file-menu-toggle"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="The job's own file — save it, save a copy, open another, or read a design file."
          style={{ padding: '2px 8px' }}
          onClick={() => setMenuOpen((v) => !v)}
        >
          File ▾
        </button>
        {menuOpen && (
          <div
            role="menu"
            data-testid="engrave-file-menu"
            style={{
              position: 'absolute',
              right: 0,
              top: '100%',
              zIndex: 20,
              minWidth: 190,
              padding: '2px 0',
              background: 'var(--cm-color-surface-container-low)',
              border: '1px solid #2c3540',
              borderRadius: 6,
              boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            }}
          >
            <button
              type="button"
              role="menuitem"
              data-testid="engrave-job-new"
              title="Start a new cutting job — the setup wizard opens at step 1. An unsaved job is asked about first."
              style={MENU_ITEM}
              onClick={() => choose(startNewJob)}
            >
              New cutting job…
            </button>
            <div role="separator" style={{ borderTop: '1px solid #2c3540', margin: '3px 0' }} />
            <button
              type="button"
              role="menuitem"
              data-testid="engrave-job-save"
              disabled={busy}
              aria-busy={busy}
              // The ownership fact the deleted note carried (#686): the whole job travels in the file.
              title="Save the whole job — package, run log and sources — to its file. The file is the owner; writes in place once the job has one (Ctrl+S)."
              style={MENU_ITEM}
              onClick={() => choose(() => void save())}
            >
              Save job
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="engrave-job-save-as"
              disabled={busy}
              title="Write the job to a new .cutjob.json file (choose its name and folder)."
              style={MENU_ITEM}
              onClick={() => choose(() => void saveAs())}
            >
              Save job as…
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="engrave-job-open"
              disabled={busy}
              title="Open a .cutjob.json file. The current job is replaced only if the file parses."
              style={MENU_ITEM}
              onClick={() => choose(() => void open())}
            >
              Open job…
            </button>
            {onReadDesign !== undefined && (
              <button
                type="button"
                role="menuitem"
                data-testid="engrave-design-import"
                disabled={designReading}
                title="Read a PrusaSlicer project (.3mf): its blank, its magnet pocket and every volume it cuts become this job. The cutter, the vise and the margins are left as they are."
                style={MENU_ITEM}
                onClick={() =>
                  choose(() => {
                    onReadDesign();
                  })
                }
              >
                {designReading ? 'Reading the design…' : 'Read a design (.3mf)…'}
              </button>
            )}
            {(onSaveProgram !== undefined || onRunSheet !== undefined || onOpenRecord !== undefined) && (
              <div role="separator" style={{ borderTop: '1px solid #2c3540', margin: '3px 0' }} />
            )}
            {onSaveProgram !== undefined && (
              <button
                type="button"
                role="menuitem"
                data-testid="engrave-save"
                disabled={saveProgramBlocker !== null}
                title={
                  saveProgramBlocker ??
                  'Save the generated program to carry it to the Cut step, or to open in Makera Studio.'
                }
                style={MENU_ITEM}
                onClick={() => choose(onSaveProgram)}
              >
                Save .nc…
              </button>
            )}
            {onRunSheet !== undefined && (
              <button
                type="button"
                role="menuitem"
                data-testid="engrave-run-sheet"
                disabled={!runSheetReady || runSheetBlocked}
                title={
                  runSheetBlocked
                    ? 'The job changed since it was generated; regenerate before opening the sheet.'
                    : runSheetReady
                      ? 'Open the printable run sheet for the machine.'
                      : 'Generate and verify the job first.'
                }
                style={MENU_ITEM}
                onClick={() => choose(onRunSheet)}
              >
                Run sheet…
              </button>
            )}
            {onOpenRecord !== undefined && (
              <button
                type="button"
                role="menuitem"
                data-testid="engrave-open-record"
                title="Open the run record saved beside a previous run's .nc, and show its measured wall clock beside the estimate."
                style={MENU_ITEM}
                onClick={() => choose(onOpenRecord)}
              >
                Open run record…
              </button>
            )}
          </div>
        )}
      </div>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          data-testid="engrave-job-notice"
          data-kind={notice.kind}
          style={{ ...MUTED, flexBasis: '100%', color: NOTICE_COLOR[notice.kind] ?? MUTED.color }}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
