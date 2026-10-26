import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';

/**
 * The ONE file bar (#686, design §1): the job's name, when it was last saved, the dirty marker,
 * and a `File ▾` menu holding Save / Save as… / Open… and the `.3mf` design read.
 *
 * The bar owns no document state of its own: the name is the job's, and the saved time, file name,
 * dirty marker and notices are the `engraveJobFileStore`'s, which serializes the open job on every
 * write. The old owner note is gone — the ownership fact ("the file is the owner: the package, the
 * run log and the sources travel with it") is the Save item's hover, where it belongs.
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

/** The last-saved time as the mockup prints it (`saved 09:14`), or the unsaved line. */
export function savedTimeText(savedAt: number | null): string {
  if (savedAt === null) return 'Not saved yet';
  const d = new Date(savedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `saved ${hh}:${mm}`;
}

export interface EngraveJobFileBarProps {
  /**
   * The `.3mf` design read (#410) has no header button any more (#686): it is the File menu's
   * fourth item. Absent when the build has no simulation worker.
   */
  onReadDesign?: () => void;
  /** True while the picked design is being read: the item says so and is disabled. */
  designReading?: boolean;
}

export function EngraveJobFileBar({ onReadDesign, designReading = false }: EngraveJobFileBarProps): JSX.Element {
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
