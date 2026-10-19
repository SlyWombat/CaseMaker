import { useEffect, type CSSProperties, type JSX } from 'react';
import { useEngraveJobFileStore } from '@/store/engraveJobFileStore';

/**
 * Save / Save as… / Open for the job document (#425 §6), at the top of the Design surface.
 *
 * The bar owns no document state of its own: the file name, the dirty marker and the notices are
 * the `engraveJobFileStore`'s, which serializes the open job on every write. The note below is the
 * point of the slice — the package, the run log and the sources travel in the file, not in this
 * browser's storage.
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: 0 };
const NOTICE_COLOR: Record<string, string> = {
  ok: '#a7d7a7',
  info: '#9aa4b0',
  warning: '#e0c07a',
  error: '#f0b4ad',
};

export function EngraveJobFileBar(): JSX.Element {
  const fileName = useEngraveJobFileStore((s) => s.fileName);
  const dirty = useEngraveJobFileStore((s) => s.dirty);
  const busy = useEngraveJobFileStore((s) => s.busy);
  const notice = useEngraveJobFileStore((s) => s.notice);
  const save = useEngraveJobFileStore((s) => s.save);
  const saveAs = useEngraveJobFileStore((s) => s.saveAs);
  const open = useEngraveJobFileStore((s) => s.open);

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

  return (
    <section
      aria-label="Job file"
      data-testid="engrave-job-file"
      style={{
        border: '1px solid #2c3540',
        borderRadius: 6,
        padding: '6px 8px',
        marginBottom: 8,
        display: 'grid',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          data-testid="engrave-job-save"
          disabled={busy}
          aria-busy={busy}
          title="Save the whole job — package, run log and sources — to its file. Writes in place once the job has a file (Ctrl+S)."
          style={{ flex: 1, padding: 5 }}
          onClick={() => void save()}
        >
          Save job
        </button>
        <button
          type="button"
          data-testid="engrave-job-save-as"
          disabled={busy}
          title="Write the job to a new .cutjob.json file (choose its name and folder)."
          style={{ flex: 1, padding: 5 }}
          onClick={() => void saveAs()}
        >
          Save job as…
        </button>
        <button
          type="button"
          data-testid="engrave-job-open"
          disabled={busy}
          title="Open a .cutjob.json file. The current job is replaced only if the file parses."
          style={{ flex: 1, padding: 5 }}
          onClick={() => void open()}
        >
          Open job…
        </button>
      </div>

      <div data-testid="engrave-job-file-name" title={fileName ?? 'This job has no file yet.'} style={{ ...MUTED, color: '#c8d3de' }}>
        {fileName ?? 'Not saved to a file yet'}
        {dirty && (
          <span data-testid="engrave-job-dirty" style={{ color: '#e0c07a' }}>
            {' '}
            · unsaved changes
          </span>
        )}
      </div>

      <p data-testid="engrave-job-owner-note" style={MUTED}>
        the job file is the owner — the package, the run log and the sources live in it, not in this
        browser.
      </p>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          data-testid="engrave-job-notice"
          data-kind={notice.kind}
          style={{ ...MUTED, color: NOTICE_COLOR[notice.kind] ?? MUTED.color }}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
