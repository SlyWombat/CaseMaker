/**
 * The ONE resolver for cutting tools (#305, tracking #212).
 *
 * Before this, three things answered "which tool is this?" and could disagree: three pickers read
 * `TOOL_LIBRARY` inline, everything else went through `jobSetup.jobTool` → `libraryTool`, and the
 * sim workers resolved inside their own realm, where no store is visible. Every consumer asks
 * here now, and gets the same answer.
 *
 * **Two tiers, and the built-ins are permanent.** `TOOL_LIBRARY` is the `builtin` tier and is
 * never replaced: the shipped default job names `flat-1.0` (`engrave/defaults.ts:120`), so a job
 * has to resolve with no service, no file and no network at all. `setRegistry` adds the tiers
 * ABOVE it — a Studio catalogue clone (`cat:`), the user's own cutters (`user:`), the physical
 * inventory (`inv:`) — and `getTools()` returns the built-ins first, then those. An empty
 * registry is therefore not "no tools": it is "no service yet", which is the V1 default.
 *
 * **Plain data, web-safe, no React.** One module-level snapshot, deliberately: the sim workers
 * are long-lived and reached over Comlink, so a `localStorage` or Zustand registry is invisible
 * inside them. `Tool` is plain data and crosses by structured clone — the pattern `simLoad` uses
 * — so the workers are handed the list as an argument and read `toolForJob` themselves
 * (`engravePreview(job, tools, gen)`), and nothing under `src/workers/` touches this module's
 * state at all.
 *
 * **A job names its cutter twice.** `job.toolKey` is the key (unchanged, so no saved document
 * needs migrating), and `job.tool` is the materialised `Tool` the job was written with (#305
 * design point 2). `toolForJob` prefers the snapshot, so a job reopened while the service is
 * absent still generates, verifies and simulates — the same provenance discipline the fixture
 * obstacles use (`/Fabrication.md` decision 28).
 */

import type { Tool } from './tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from './toolLibrary';

/** The two fields a job names its cutter with — `EngraveJob`, structurally. */
export interface ToolNamingJob {
  /** `flat-1.0` (builtin), `cat:…`, `user:…` or `inv:…`. */
  toolKey: string;
  /**
   * The tool this job was written with (#305 design point 2). OPTIONAL, and absent on a job
   * whose cutter has never been picked: a pre-#305 document must round-trip byte-for-byte.
   */
  tool?: Tool | null;
}

/**
 * What `getTools()` returns. Held rather than rebuilt so the identity is stable between calls —
 * `useSyncExternalStore` re-renders forever if its snapshot is a fresh array each time.
 */
let snapshot: readonly ToolLibraryEntry[] = TOOL_LIBRARY;

const listeners = new Set<() => void>();

/**
 * The resolved list every picker lists and every measurement ranks: the built-ins, then whatever
 * `setRegistry` last supplied.
 */
export function getTools(): readonly ToolLibraryEntry[] {
  return snapshot;
}

/**
 * Replace the tiers ABOVE the built-ins (`[]` = no service). Empties back to `TOOL_LIBRARY`
 * itself, so the default is one object and not a copy of it.
 */
export function setRegistry(entries: readonly ToolLibraryEntry[]): void {
  snapshot = entries.length === 0 ? TOOL_LIBRARY : [...TOOL_LIBRARY, ...entries];
  for (const listener of listeners) listener();
}

/** Back to the built-ins only. */
export function resetRegistry(): void {
  setRegistry([]);
}

/** Notified whenever the snapshot is replaced. Returns the unsubscribe. */
export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The entry for a key, or null. Keys are namespaced (`flat-1.0` builtin, `cat:`/`user:`/`inv:`
 * above it), so a registry entry cannot collide with a built-in and the search order is moot.
 */
export function entryFor(key: string): ToolLibraryEntry | null {
  return entryForIn(getTools(), key);
}

/** The tool for a key, or null. A COPY — the library and the registry are not a caller's to edit. */
export function resolveTool(key: string): Tool | null {
  const entry = entryFor(key);
  return entry ? { ...entry.tool } : null;
}

/**
 * The tool a JOB names, against a list handed in: the job's own snapshot first, then the entry
 * its key names, then null. Pure and module-state-free, so the sim workers call it with the
 * list they were sent.
 *
 * The snapshot wins over the registry on purpose: a cutter re-collared or re-measured after the
 * job was written must not silently re-prove the job at a new stick-out (design point 1, #305).
 */
export function toolForJob(job: ToolNamingJob, entries: readonly ToolLibraryEntry[]): Tool | null {
  if (job.tool) return { ...job.tool };
  return toolForIn(entries, job.toolKey);
}

/** `resolveTool` against a list handed in, for a caller that has one (the workers). */
export function toolForIn(entries: readonly ToolLibraryEntry[], key: string): Tool | null {
  const entry = entryForIn(entries, key);
  return entry ? { ...entry.tool } : null;
}

function entryForIn(entries: readonly ToolLibraryEntry[], key: string): ToolLibraryEntry | null {
  return entries.find((e) => e.key === key) ?? null;
}
