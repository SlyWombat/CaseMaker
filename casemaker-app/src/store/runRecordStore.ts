/**
 * The run records this browser has OPENED (#277).
 *
 * The record's home is the file beside the `.nc` — this store is not a second home, it is a view
 * of files the operator handed the app. It exists because the estimate's "last measured" line has
 * to be reachable without a rebuild: `scripts/run-readback.ts` folds a record into
 * `runHistory.ts`'s region for the archived, travels-by-git case, and this is the same round trip
 * done now, in the browser, by opening the file you just filled in.
 *
 * Every entry has been through `parseRunRecord`, which refuses a reading that carries no date
 * (#277's rule), so nothing here can present itself as measured without a person's date behind it.
 * A file that does not parse changes nothing at all — whole-or-nothing, as #247's import is.
 *
 * Persisted to `localStorage` beside the settings, so the line is still there after a reload.
 * `runHistory.MEASURED_RUNS` is deliberately NOT persisted: it is rebuilt from the source on every
 * load, and a cached copy of it would shadow a newer readback.
 */

import { create } from 'zustand';
import { parseRunRecordText, type RunRecord } from '@/engine/cnc/engrave/runRecord';
import { mergeMeasuredRuns } from '@/engine/cnc/engrave/runHistory';

const RUNS_KEY = 'casemaker.runs.v1';

/** What opening a record file did: the record it added, or why the file was refused. */
export type OpenRunResult = { ok: true; run: RunRecord } | { ok: false; reason: string };

/** Read the stored records back, dropping any entry this build no longer accepts. */
function loadImported(): RunRecord[] {
  if (typeof localStorage === 'undefined') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const runs: RunRecord[] = [];
  for (const entry of raw) {
    const parsed = parseRunRecordText(JSON.stringify(entry));
    if (parsed.ok) runs.push(parsed.run);
  }
  return runs;
}

function persist(runs: readonly RunRecord[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    // ignore quota errors
  }
}

export interface RunRecordState {
  /** Records opened in this browser, one per `.nc` — the latest open wins. */
  imported: RunRecord[];
  /**
   * Open a filled run record's text. Refuses (with a reason to show) anything that is not a whole
   * record, and a record whose readings carry no date.
   */
  openText: (text: string) => OpenRunResult;
  /** Forget what was opened here. The files beside the `.nc`s are untouched. */
  clear: () => void;
}

export const useRunRecordStore = create<RunRecordState>()((set, get) => ({
  imported: loadImported(),
  openText: (text) => {
    const parsed = parseRunRecordText(text);
    if (!parsed.ok) return parsed;
    const imported = mergeMeasuredRuns(get().imported, parsed.run);
    set({ imported });
    persist(imported);
    return { ok: true, run: parsed.run };
  },
  clear: () => {
    set({ imported: [] });
    persist([]);
  },
}));
