import { create } from 'zustand';
import { z } from 'zod';
import type { BoardProfile } from '@/types';
import { localBoardProfileSchema, unknownBoardKeys } from '@/library/schema';
import { getBuiltinBoard } from '@/library';
import { templateSpecSchema, type TemplateSpec } from '@/library/templates/templateSchema';

/**
 * Board library store — every board source that isn't bundled with the app:
 *
 *   localBoards    — profiles the user imported from JSON files (or saved
 *                    from the board editor). Fully user-owned.
 *   remoteSources  — online sources: a URL serving a board index (either a
 *                    bare JSON array of board profiles, or
 *                    `{ name?, boards: [...] }`). Fetched on add / refresh,
 *                    cached here so the picker works offline afterwards.
 *
 * Both persist to localStorage under one key. The registry
 * (library/registry.ts) merges these with the builtins; resolution order is
 * builtin → local → remote (first enabled source wins on id collision).
 */

const LIBRARY_KEY = 'casemaker.library.v1';

export interface RemoteSource {
  id: string;
  url: string;
  label: string;
  enabled: boolean;
  boards: BoardProfile[];
  /** Quickstart template specs the source ships alongside its boards (#126). */
  templates: TemplateSpec[];
  fetchedAt: string | null;
  /** Last fetch failure, if any (cached boards stay usable). */
  error?: string;
  /** Boards in the last fetched index that failed validation. */
  invalidCount?: number;
}

const storedLibrarySchema = z.object({
  boards: z.array(z.unknown()).default([]),
  templates: z.array(z.unknown()).default([]),
  remoteSources: z
    .array(
      z.object({
        id: z.string().min(1),
        url: z.string().min(1),
        label: z.string().min(1),
        enabled: z.boolean(),
        boards: z.array(z.unknown()),
        templates: z.array(z.unknown()).default([]),
        fetchedAt: z.string().nullable(),
        error: z.string().optional(),
        invalidCount: z.number().optional(),
      }),
    )
    .default([]),
});

/** Remote index document: bare array, or { name?, boards, templates? }. */
const remoteIndexSchema = z.union([
  z.array(z.unknown()),
  z.object({
    name: z.string().optional(),
    boards: z.array(z.unknown()),
    templates: z.array(z.unknown()).optional(),
  }),
]);

/** Community template specs: `order` optional — remote templates list after
 * the bundled ones in whatever order the index ships them. */
const remoteTemplateSchema = templateSpecSchema.extend({
  order: z.number().optional(),
});

function validateTemplates(raw: unknown[]): { templates: TemplateSpec[]; invalid: number } {
  const templates: TemplateSpec[] = [];
  let invalid = 0;
  for (const [i, entry] of raw.entries()) {
    const result = remoteTemplateSchema.safeParse(entry);
    if (result.success) templates.push({ ...result.data, order: result.data.order ?? 1000 + i });
    else invalid += 1;
  }
  return { templates, invalid };
}

export interface ImportResult {
  ok: boolean;
  kind?: 'board' | 'template';
  board?: BoardProfile;
  template?: TemplateSpec;
  /** Set when the imported id collided and the board was auto-renamed. */
  renamedFrom?: string;
  /** Soft warnings (e.g. missing source URL) — import still succeeded. */
  warnings: string[];
  error?: string;
}

function validateBoards(raw: unknown[]): { boards: BoardProfile[]; invalidCount: number } {
  const boards: BoardProfile[] = [];
  let invalidCount = 0;
  for (const entry of raw) {
    const result = localBoardProfileSchema.safeParse(entry);
    if (result.success) boards.push(result.data as BoardProfile);
    else invalidCount += 1;
  }
  return { boards, invalidCount };
}

function loadLibrary(): {
  localBoards: BoardProfile[];
  localTemplates: TemplateSpec[];
  remoteSources: RemoteSource[];
} {
  if (typeof localStorage === 'undefined')
    return { localBoards: [], localTemplates: [], remoteSources: [] };
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return { localBoards: [], localTemplates: [], remoteSources: [] };
    const parsed = storedLibrarySchema.parse(JSON.parse(raw));
    // Re-validate everything on load; drop entries a future schema no longer
    // accepts rather than wedging the whole library.
    const localBoards = validateBoards(parsed.boards).boards;
    const localTemplates = validateTemplates(parsed.templates).templates;
    const remoteSources: RemoteSource[] = parsed.remoteSources.map((s) => {
      const { boards, invalidCount } = validateBoards(s.boards);
      const { templates } = validateTemplates(s.templates);
      return { ...s, boards, templates, invalidCount: (s.invalidCount ?? 0) + invalidCount };
    });
    return { localBoards, localTemplates, remoteSources };
  } catch {
    return { localBoards: [], localTemplates: [], remoteSources: [] };
  }
}

function persist(
  localBoards: BoardProfile[],
  localTemplates: TemplateSpec[],
  remoteSources: RemoteSource[],
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      LIBRARY_KEY,
      JSON.stringify({ boards: localBoards, templates: localTemplates, remoteSources }),
    );
  } catch {
    // quota exceeded — keep the in-memory copy working
  }
}

/** First free id: base, base-2, base-3, … across builtins + locals. */
function freeId(base: string, locals: BoardProfile[]): string {
  const taken = (id: string) => Boolean(getBuiltinBoard(id)) || locals.some((b) => b.id === id);
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function sourceIdFromUrl(url: string, existing: RemoteSource[]): string {
  let host = 'source';
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'source';
  } catch {
    // keep fallback
  }
  const base = host.replace(/[^a-z0-9.-]/gi, '').toLowerCase() || 'source';
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export interface AddSourceResult {
  ok: boolean;
  source?: RemoteSource;
  error?: string;
}

export interface LibraryState {
  localBoards: BoardProfile[];
  /** User-imported template specs (#126) — quickstarts from JSON files. */
  localTemplates: TemplateSpec[];
  remoteSources: RemoteSource[];
  /** Source ids with a fetch in flight (transient, not persisted). */
  refreshing: string[];
  /** Validate and add a parsed-JSON value to the local library. */
  addLocalBoard: (raw: unknown) => ImportResult;
  removeLocalBoard: (id: string) => void;
  /** Validate and add a template spec JSON to the local library. */
  addLocalTemplate: (raw: unknown) => ImportResult;
  removeLocalTemplate: (id: string) => void;
  /** Serialized JSON for a local board, for export/share. */
  exportLocalBoard: (id: string) => string | undefined;
  /** Register an online source and fetch its index immediately. */
  addRemoteSource: (url: string) => Promise<AddSourceResult>;
  refreshRemoteSource: (id: string) => Promise<void>;
  removeRemoteSource: (id: string) => void;
  setRemoteSourceEnabled: (id: string, enabled: boolean) => void;
}

/** Hard caps so a hostile/misconfigured URL can't blow the localStorage
 * quota (#132): 5 MB of JSON, 500 boards per source. */
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_BOARDS_PER_SOURCE = 500;

async function fetchIndex(url: string): Promise<{
  boards: BoardProfile[];
  templates: TemplateSpec[];
  invalidCount: number;
  name?: string;
}> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_INDEX_BYTES) {
    throw new Error(`index too large (${(text.length / 1e6).toFixed(1)} MB > 5 MB cap)`);
  }
  const doc: unknown = JSON.parse(text);
  const parsed = remoteIndexSchema.safeParse(doc);
  if (!parsed.success) throw new Error('index is not a board array or {boards: [...]} document');
  const isBare = Array.isArray(parsed.data);
  const rawBoards = isBare ? (parsed.data as unknown[]) : (parsed.data as { boards: unknown[] }).boards;
  const name = isBare ? undefined : (parsed.data as { name?: string }).name;
  const rawTemplates = isBare ? [] : ((parsed.data as { templates?: unknown[] }).templates ?? []);
  if (rawBoards.length > MAX_BOARDS_PER_SOURCE) {
    throw new Error(`index lists ${rawBoards.length} boards (> ${MAX_BOARDS_PER_SOURCE} cap)`);
  }
  const { boards, invalidCount } = validateBoards(rawBoards);
  const { templates, invalid: invalidTpl } = validateTemplates(rawTemplates);
  if (boards.length === 0) {
    throw new Error(
      invalidCount > 0
        ? `no valid board profiles (${invalidCount} failed validation)`
        : 'index contains no boards',
    );
  }
  return { boards, templates, invalidCount: invalidCount + invalidTpl, name };
}

/** Refresh enabled sources whose cache is older than 7 days (#132).
 * Fire-and-forget from app mount; failures leave the cache usable. */
export function refreshStaleSources(): void {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const { remoteSources, refreshRemoteSource } = useLibraryStore.getState();
  for (const s of remoteSources) {
    if (!s.enabled) continue;
    if (s.fetchedAt && Date.now() - Date.parse(s.fetchedAt) < WEEK_MS) continue;
    void refreshRemoteSource(s.id);
  }
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  ...loadLibrary(),
  refreshing: [],

  addLocalBoard: (raw) => {
    const parsed = localBoardProfileSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first && first.path.length ? ` at "${first.path.join('.')}"` : '';
      return {
        ok: false,
        warnings: [],
        error: `Not a valid board profile${where}: ${first?.message ?? 'unknown error'}`,
      };
    }
    const board = parsed.data as BoardProfile;
    board.schemaVersion = board.schemaVersion ?? 1;

    const warnings: string[] = [];
    const unknown = unknownBoardKeys(raw);
    if (unknown.length > 0) {
      warnings.push(
        `Unrecognized field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} ignored — authored for a newer Case Maker?`,
      );
    }
    if (!board.source) {
      warnings.push('No source URL — consider recording where the dimensions came from.');
    }
    if (!board.measurementMethod) {
      warnings.push('No measurementMethod (datasheet / open-source-cad / physical-measurement).');
    }

    const { localBoards, remoteSources } = get();
    const id = freeId(board.id, localBoards);
    const renamedFrom = id === board.id ? undefined : board.id;
    board.id = id;

    const next = [...localBoards, board];
    set({ localBoards: next });
    persist(next, get().localTemplates, remoteSources);
    return { ok: true, kind: 'board', board, renamedFrom, warnings };
  },

  removeLocalBoard: (id) => {
    const { localBoards, remoteSources } = get();
    const next = localBoards.filter((b) => b.id !== id);
    set({ localBoards: next });
    persist(next, get().localTemplates, remoteSources);
  },

  exportLocalBoard: (id) => {
    const board = get().localBoards.find((b) => b.id === id);
    return board ? JSON.stringify(board, null, 2) : undefined;
  },

  addLocalTemplate: (raw) => {
    const parsed = remoteTemplateSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first && first.path.length ? ` at "${first.path.join('.')}"` : '';
      return {
        ok: false,
        warnings: [],
        error: `Not a valid template spec${where}: ${first?.message ?? 'unknown error'}`,
      };
    }
    const template: TemplateSpec = { ...parsed.data, order: parsed.data.order ?? 1000 };
    const warnings: string[] = [];
    if (template.boardId) {
      const { localBoards, remoteSources } = get();
      const known =
        Boolean(getBuiltinBoard(template.boardId)) ||
        localBoards.some((b) => b.id === template.boardId) ||
        remoteSources.some((s) => s.enabled && s.boards.some((b) => b.id === template.boardId));
      if (!known) {
        warnings.push(
          `Its board "${template.boardId}" isn't in your library yet — the template stays hidden until it is.`,
        );
      }
    }
    const locals = get().localTemplates;
    if (locals.some((t) => t.id === template.id)) {
      let n = 2;
      const base = template.id;
      while (locals.some((t) => t.id === `${base}-${n}`)) n += 1;
      template.id = `${base}-${n}`;
    }
    const next = [...locals, template];
    set({ localTemplates: next });
    persist(get().localBoards, next, get().remoteSources);
    return { ok: true, kind: 'template', template, warnings };
  },

  removeLocalTemplate: (id) => {
    const next = get().localTemplates.filter((t) => t.id !== id);
    set({ localTemplates: next });
    persist(get().localBoards, next, get().remoteSources);
  },

  addRemoteSource: async (url) => {
    const trimmed = url.trim();
    try {
      // Validate URL shape before fetching.
      new URL(trimmed);
    } catch {
      return { ok: false, error: 'Not a valid URL.' };
    }
    if (get().remoteSources.some((s) => s.url === trimmed)) {
      return { ok: false, error: 'That source is already added.' };
    }
    try {
      const { boards, templates, invalidCount, name } = await fetchIndex(trimmed);
      const sources = get().remoteSources;
      const source: RemoteSource = {
        id: sourceIdFromUrl(trimmed, sources),
        url: trimmed,
        label: name ?? sourceIdFromUrl(trimmed, sources),
        enabled: true,
        boards,
        templates,
        fetchedAt: new Date().toISOString(),
        invalidCount,
      };
      const next = [...sources, source];
      set({ remoteSources: next });
      persist(get().localBoards, get().localTemplates, next);
      return { ok: true, source };
    } catch (err) {
      return {
        ok: false,
        error: `Could not load index: ${err instanceof Error ? err.message : String(err)}. The server must allow cross-origin (CORS) requests.`,
      };
    }
  },

  refreshRemoteSource: async (id) => {
    const source = get().remoteSources.find((s) => s.id === id);
    if (!source || get().refreshing.includes(id)) return;
    set({ refreshing: [...get().refreshing, id] });
    try {
      const { boards, templates, invalidCount, name } = await fetchIndex(source.url);
      const next = get().remoteSources.map((s) =>
        s.id === id
          ? {
              ...s,
              boards,
              templates,
              invalidCount,
              label: name ?? s.label,
              fetchedAt: new Date().toISOString(),
              error: undefined,
            }
          : s,
      );
      set({ remoteSources: next });
      persist(get().localBoards, get().localTemplates, next);
    } catch (err) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const msg = offline
        ? 'offline — using the cached copy'
        : err instanceof Error
          ? err.message
          : String(err);
      const next = get().remoteSources.map((s) => (s.id === id ? { ...s, error: msg } : s));
      set({ remoteSources: next });
      persist(get().localBoards, get().localTemplates, next);
    } finally {
      set({ refreshing: get().refreshing.filter((r) => r !== id) });
    }
  },

  removeRemoteSource: (id) => {
    const next = get().remoteSources.filter((s) => s.id !== id);
    set({ remoteSources: next });
    persist(get().localBoards, get().localTemplates, next);
  },

  setRemoteSourceEnabled: (id, enabled) => {
    const next = get().remoteSources.map((s) => (s.id === id ? { ...s, enabled } : s));
    set({ remoteSources: next });
    persist(get().localBoards, get().localTemplates, next);
  },
}));
