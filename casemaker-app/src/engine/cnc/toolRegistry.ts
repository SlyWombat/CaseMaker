/**
 * The ONE resolver for cutting tools (#305, tracking #212).
 *
 * Before this, three things answered "which tool is this?" and could disagree: three pickers read
 * `TOOL_LIBRARY` inline, everything else went through `jobSetup.jobTool` → `libraryTool`, and the
 * sim workers resolved inside their own realm, where no store is visible. Every consumer asks
 * here now, and gets the same answer.
 *
 * **Three tiers, and the built-ins are permanent.** `TOOL_LIBRARY` is the `builtin` tier and is
 * never replaced: the shipped default job names `flat-1.0` (`engrave/defaults.ts:120`), so a job
 * has to resolve with no service, no file and no network at all. Above it come the house service's
 * two documents, each with its own setter: its tool list — Studio catalogue clones (`cat:`) and the
 * user's own definitions (`user:`) — through `setRegistry`, and the physical inventory (`inv:`)
 * through `setInventoryEntries` (#309). `getTools()` returns the built-ins first, then those. An
 * empty registry is therefore not "no tools": it is "no service yet", which is the V1 default.
 *
 * **Plain data, web-safe, no React.** One module-level snapshot, deliberately: the sim workers
 * are long-lived and reached over Comlink, so a `localStorage` or Zustand registry is invisible
 * inside them. `Tool` is plain data and crosses by structured clone — the pattern `simLoad` uses
 * — so the workers are handed the list as an argument and read `toolForJob` themselves
 * (`engravePreview(job, tools, catalogue, gen)` since #324), and nothing under `src/workers/`
 * touches this module's state at all.
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

/** The house service's tool list (`cat:` + `user:`), and its inventory (`inv:`). Two documents. */
let houseEntries: readonly ToolLibraryEntry[] = [];
let inventoryEntries: readonly ToolLibraryEntry[] = [];

const listeners = new Set<() => void>();

/**
 * The resolved list every picker lists and every measurement ranks: the built-ins, then whatever
 * `setRegistry` last supplied, then `setInventoryEntries`'.
 */
export function getTools(): readonly ToolLibraryEntry[] {
  return snapshot;
}

function publish(): void {
  snapshot =
    houseEntries.length === 0 && inventoryEntries.length === 0
      ? TOOL_LIBRARY
      : [...TOOL_LIBRARY, ...houseEntries, ...inventoryEntries];
  for (const listener of listeners) listener();
}

/**
 * Replace the service's tool list (`[]` = no service, or none read yet). The built-ins stay
 * underneath, and so does the inventory — the two are separate documents and one going away must
 * not take the other with it.
 */
export function setRegistry(entries: readonly ToolLibraryEntry[]): void {
  houseEntries = entries;
  publish();
}

/**
 * Replace the physical cutters the user has registered (#309). Their `inv:` keys are the job's
 * way of naming a possession rather than a definition: the same cutter can be re-registered with
 * a new count, or removed, without the key a saved job holds changing meaning.
 */
export function setInventoryEntries(entries: readonly ToolLibraryEntry[]): void {
  inventoryEntries = entries;
  publish();
}

/** Back to the built-ins only: both documents released. */
export function resetRegistry(): void {
  houseEntries = [];
  inventoryEntries = [];
  publish();
}

/** The key a physical cutter is named by, minted in one place so no caller spells `inv:` itself. */
export function inventoryKey(id: string): string {
  return `inv:${id}`;
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
