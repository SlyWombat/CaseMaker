import { create } from 'zustand';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { defaultEngraveJob, newEngraveLabelId } from '@/engine/cnc/engrave/defaults';
import { todayISODate, viseForNewJob } from '@/engine/cnc/fixture';
import type { EngraveJob, EngraveLabel, ViseParams } from '@/types/engraveJob';
import { parseEngraveJob, type ParseEngraveJobResult } from './engraveJobSchema';
import { useSettingsStore } from './settingsStore';

/**
 * The `EngraveJob` store (#200). Persists to localStorage on every change, hydrates through
 * `parseEngraveJob` on load, and never silently loses a payload it could not parse.
 *
 * The persistence is the plain `persist()` helper pattern of `settingsStore.ts` — a function
 * that writes, not the zustand `persist` middleware — so the store's public shape stays the
 * explicit `job` field the rest of the CNC-2 work reads.
 */

export const ENGRAVE_JOB_KEY = 'casemaker.engraveJob.v1';
/** Where a payload that failed validation is parked so it is not silently lost. */
export const ENGRAVE_JOB_REJECTED_KEY = `${ENGRAVE_JOB_KEY}.rejected`;

function persist(job: EngraveJob): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ENGRAVE_JOB_KEY, JSON.stringify(job));
  } catch {
    // ignore quota / private-mode errors
  }
}

/**
 * A brand-new job, with its vise taken from the saved measurement in settings when one exists
 * (#203, decision 28). The reading of `settings.fixtures.vise` happens HERE, in the store, so
 * `defaultEngraveJob` stays a pure function of its argument (#203 review).
 */
function newDefaultJob(): EngraveJob {
  return defaultEngraveJob(viseForNewJob(useSettingsStore.getState().fixtures.vise));
}

function loadJob(): EngraveJob {
  if (typeof localStorage === 'undefined') return newDefaultJob();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ENGRAVE_JOB_KEY);
  } catch {
    return newDefaultJob();
  }
  if (!raw) return newDefaultJob();

  let json: unknown;
  let parsed: ParseEngraveJobResult;
  try {
    json = JSON.parse(raw);
    parsed = parseEngraveJob(json);
  } catch {
    parsed = { ok: false, errors: ['stored payload is not valid JSON'] };
  }
  if (parsed.ok) return parsed.job;

  // Fall back to the default, but keep the bad payload under `.rejected` so a hand-edited
  // file or a newer-minor job is recoverable rather than gone.
  try {
    localStorage.setItem(ENGRAVE_JOB_REJECTED_KEY, raw);
  } catch {
    // ignore quota errors
  }
  return newDefaultJob();
}

function newLabel(job: EngraveJob): EngraveLabel {
  return {
    id: newEngraveLabelId(),
    text: 'New text',
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    size: 10,
    // Centre of the stock; the caller moves it. Depth must be > 0 or the schema rejects it.
    position: { x: job.stock.length / 2, y: job.stock.width / 2 },
    rotation: 0,
    depth: 0.5,
    enabled: true,
  };
}

export interface EngraveJobState {
  job: EngraveJob;
  setStock: (patch: Partial<EngraveJob['stock']>) => void;
  /** Add a default label and return its id. */
  addLabel: () => string;
  updateLabel: (id: string, patch: Partial<EngraveLabel>) => void;
  removeLabel: (id: string) => void;
  setTool: (key: string) => void;
  setVise: (patch: Partial<ViseParams>) => void;
  replace: (job: EngraveJob) => void;
  reset: () => void;
}

export const useEngraveJobStore = create<EngraveJobState>()((set, get) => {
  const apply = (mutate: (job: EngraveJob) => EngraveJob): void => {
    set((s) => ({ job: mutate(s.job) }));
    persist(get().job);
  };

  return {
    job: loadJob(),

    setStock: (patch) => apply((job) => ({ ...job, stock: { ...job.stock, ...patch } })),

    addLabel: () => {
      const label = newLabel(get().job);
      apply((job) => ({ ...job, labels: [...job.labels, label] }));
      return label.id;
    },

    updateLabel: (id, patch) =>
      apply((job) => ({
        ...job,
        labels: job.labels.map((l) =>
          l.id === id
            ? {
                ...l,
                ...patch,
                // Merge a partial position rather than replacing the whole object.
                position: patch.position ? { ...l.position, ...patch.position } : l.position,
              }
            : l,
        ),
      })),

    removeLabel: (id) => apply((job) => ({ ...job, labels: job.labels.filter((l) => l.id !== id) })),

    setTool: (key) => apply((job) => ({ ...job, toolKey: key })),

    // Any edit to the vise makes it a SAVED value, unless the patch states its own source
    // (e.g. a re-probe writing `measured`). A default is not a measurement (decision 28).
    // A non-default value records the day it was asserted ("I just measured these", #203),
    // unless the patch already carries a date.
    setVise: (patch) =>
      apply((job) => {
        const source = patch.source ?? 'saved';
        const vise: ViseParams = {
          ...job.workholding.vise,
          ...patch,
          source,
          ...(source !== 'default' && !patch.measuredAt ? { measuredAt: todayISODate() } : {}),
        };
        return { ...job, workholding: { ...job.workholding, vise } };
      }),

    replace: (job) => apply(() => job),

    reset: () => apply(() => newDefaultJob()),
  };
});
