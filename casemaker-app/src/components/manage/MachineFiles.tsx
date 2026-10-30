/**
 * The card's files (#772) — what is on the machine's SD card, and deleting a file this app put
 * there. Drawn as a collapsed block at the foot of the machine card, where the console sits and
 * for the same reason: it is a fact about the machine on this bench, not about the job on screen.
 *
 * WHAT THE VIEW IS ALLOWED TO DELETE is the seam's rule, not this panel's
 * (`platform/machineFiles.ts`): a file this browser recorded uploading, and never while a job is
 * running. The panel decides only how to SAY that — a file that was not uploaded here is listed
 * read-only with the sentence, and the Delete press is a two-step confirmation that names the file
 * before the second press sends anything.
 *
 * THE WORDS ON THE WIRE ARE MAKERA'S. `ls -e -s` and `rm <file> -e` are the Carvera Controller's
 * own, cited in `platform/desktop/protocol.ts`; this app talks them over the machine channel, not
 * the operator console, whose gate deliberately refuses `rm`.
 */

import { useState } from 'react';
import { canDriveMachine } from '@/platform/capabilities';
import {
  deleteMachineFile,
  isUploadedFile,
  listMachineFiles,
  type DeleteFileResult,
  type ListFilesResult,
  type SdFileEntry,
} from '@/platform/machineFiles';
import { machineKey } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import type { ReleasePhase } from '@/store/engraveReleaseStore';

/** The phases in which a release is armed or running: a delete then would pull a file out of it. */
const ACTIVE_PHASES: ReadonlySet<ReleasePhase> = new Set<ReleasePhase>([
  'uploading',
  'ready',
  'starting',
  'running',
  'retouch',
  'bit-change',
  'closing',
]);

/** `1.4 kB` — the listing's byte count, in the card's own words. */
export function fileSizeWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-10-29 14:03` from the listing's `YYYYMMDDHHMMSS`, or the raw stamp when it is not one. */
export function fileStampWords(stamp: string | null): string {
  if (stamp === null) return '—';
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  return m === null ? stamp : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

export interface MachineFilesProps {
  host: string;
  port: number;
  /** The machine's own busy fact from its last check; a release's phase is read here as well. */
  busy: boolean;
}

/** The panel, or nothing at all in a build that cannot open a socket. */
export function MachineFiles(props: MachineFilesProps) {
  return canDriveMachine ? <FilesPanel {...props} /> : null;
}

function FilesPanel({ host, port, busy }: MachineFilesProps) {
  const target = { host, port };
  const phase = useEngraveReleaseStore((s) => s.records[machineKey({ host, port })]?.phase ?? null);
  const jobRunning = busy || (phase !== null && ACTIVE_PHASES.has(phase));

  const [listing, setListing] = useState<ListFilesResult | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** The file waiting for its second press — the named confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function read(): Promise<void> {
    if (reading) return;
    setReading(true);
    try {
      setListing(await listMachineFiles(target));
    } finally {
      setReading(false);
    }
  }

  async function remove(name: string): Promise<void> {
    if (deleting !== null) return;
    setDeleting(name);
    setNote(null);
    let result: DeleteFileResult;
    try {
      result = await deleteMachineFile(target, name, { busy: jobRunning });
    } finally {
      setDeleting(null);
      setConfirming(null);
    }
    // The list is read again either way: a delete that went through is only believed once the
    // card says so, and a refusal may still have changed nothing the person needs to see. The
    // sentence is set AFTER the read, which does not touch it.
    await read();
    setNote(result.kind === 'deleted' ? result.detail : `"${name}" was not deleted: ${result.detail}`);
  }

  const listed = listing?.kind === 'listed' ? listing.entries : null;

  return (
    <details
      className="mconsole"
      data-testid="manage-files"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && listing === null && !reading) void read();
      }}
    >
      <summary data-testid="manage-files-summary">
        Files on the card
        {listed !== null && (
          <span className="dim">
            {' '}
            · {listed.length} {listed.length === 1 ? 'entry' : 'entries'}
          </span>
        )}
      </summary>

      <p className="hint" data-testid="manage-files-hint">
        The SD card's job directory. This view deletes only a file Case Maker uploaded, and never
        while a job is running; anything else is listed read-only — remove it at the machine or in
        Makera Studio.
      </p>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="manage-files-refresh"
          onClick={() => {
            setNote(null);
            void read();
          }}
          disabled={reading}
        >
          {reading ? 'Reading…' : 'Read the card'}
        </button>
      </div>

      {note !== null && (
        <p className="hint" data-testid="manage-files-note" data-status={note.includes('was not deleted') ? 'refused' : 'ok'}>
          {note}
        </p>
      )}

      {listing !== null && listing.kind !== 'listed' && (
        <p className="hint" data-testid="manage-files-error" data-status={listing.kind}>
          The card's files could not be read: {listing.detail}
        </p>
      )}

      {listed !== null && (
        <table className="ro" data-testid="manage-files-table">
          <tbody>
            {listed.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  Nothing in this directory.
                </td>
              </tr>
            )}
            {listed.map((entry: SdFileEntry, i: number) => (
              <tr key={`${entry.name}:${i}`} data-testid="manage-files-row">
                <td data-testid="manage-files-name">
                  {entry.name}
                  {entry.directory && <span className="dim"> (folder)</span>}
                </td>
                <td>{entry.directory ? '—' : fileSizeWords(entry.size)}</td>
                <td>{fileStampWords(entry.modified)}</td>
                <td>
                  {entry.directory ? (
                    <span className="dim">folder</span>
                  ) : jobRunning ? (
                    <span className="dim" data-testid="manage-files-busy">
                      a job is running
                    </span>
                  ) : !isUploadedFile(host, entry.name) ? (
                    <span className="dim" data-testid="manage-files-foreign">
                      not uploaded here
                    </span>
                  ) : confirming === entry.name ? (
                    <span data-testid="manage-files-confirm">
                      Delete “{entry.name}”? This cannot be undone.{' '}
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        data-testid={`manage-files-confirm-${i}`}
                        onClick={() => void remove(entry.name)}
                        disabled={deleting === entry.name}
                      >
                        {deleting === entry.name ? 'Deleting…' : 'Delete the file'}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid={`manage-files-cancel-${i}`}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--sm"
                      data-testid={`manage-files-delete-${i}`}
                      onClick={() => setConfirming(entry.name)}
                    >
                      Delete…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
