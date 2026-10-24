/**
 * #528 — the dock's Transcript tab reads here; the three rail components that used to render the
 * transcripts now WRITE here instead.
 *
 * Each field holds the text EXACTLY as the old rail `<pre>` rendered it, joined and ready to drop
 * into the dock's `<pre>` untouched. Storing the rendered text (rather than the raw lines) keeps
 * the dock free of every source's own shape — the registration's `Transcript[]` objects, the run
 * entry's `lines`, the release record's `notes` — and makes "unchanged content" a property of the
 * write, not of a re-derivation at the other end.
 *
 * Session state, like `machineRunStore` and `engraveReleaseStore`: it is what the machine said, and
 * closing the rail (or the app) does not erase it — the dock "stays as the operator left it".
 */

import { create } from 'zustand';

export interface MachineTranscriptState {
  /** The registration transcript, joined exactly as the old rail `<pre>` rendered it. */
  registration: string | null;
  /** The run lines (the machine-run log), joined exactly as the old rail `<pre>` rendered them. */
  runLines: string | null;
  /** The release notes, joined exactly as the old rail `<pre>` rendered them. */
  releaseNotes: string | null;
  /** #604 — the transcript header (the machine, the probe, the mount, the found position), or null. */
  header: string | null;
  setRegistration: (text: string | null) => void;
  setRunLines: (text: string | null) => void;
  setReleaseNotes: (text: string | null) => void;
  setHeader: (text: string | null) => void;
  reset: () => void;
}

const EMPTY = { registration: null, runLines: null, releaseNotes: null, header: null } as const;

export const useMachineTranscriptStore = create<MachineTranscriptState>()((set) => ({
  ...EMPTY,
  setRegistration: (registration) => set({ registration }),
  setRunLines: (runLines) => set({ runLines }),
  setReleaseNotes: (releaseNotes) => set({ releaseNotes }),
  setHeader: (header) => set({ header }),
  reset: () => set({ ...EMPTY }),
}));

/** Test seam. */
export function resetMachineTranscriptStore(): void {
  useMachineTranscriptStore.setState({ ...EMPTY });
}
