/**
 * The machine card's file block's WORDS (#772): a listing's byte count and its controller stamp,
 * as the operator reads them. Kept out of `MachineFiles.tsx` so that module exports components
 * only — the Fast Refresh rule (`react-refresh/only-export-components`) — and so the formatting is
 * a plain function a test can call without rendering the card.
 */

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
