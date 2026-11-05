/**
 * #964 / the maintainer's 11-05 order (C2): THE FULL MAKERA CATALOGUE IS THE DEFAULT OF EVERY
 * ACCEPTANCE RUN, WITH NO ENV VAR.
 *
 * The acceptance and figure specs plan the real reference parts. Left to the compiled starting
 * table, every cutter above 3.2 mm is fed from the material's largest covered row (F400 in
 * hardwood) — a conservative placeholder, not the vendor's number. An earlier door required
 * `CM_CATALOGUE`, so a run with the licensed STEPs set silently skipped the real parts (E's first
 * 389ed57e run). This helper searches the machine's own catalogue locations with NOTHING set:
 *
 *   1. the app's own data directory, beside `location.json` (where the sync writes
 *      `catalogue.json`): `$APPDATA/casemaker` on Windows, `$XDG_DATA_HOME/casemaker` (or
 *      `~/.local/share/casemaker`) elsewhere;
 *   2. the MAIN checkout's `.scratch/makerables` when this run is inside a git worktree — the
 *      worktree shares the common git dir, and that is where the licensed data lives on dave-1,
 *      so an acceptance run in a worktree finds the catalogue with nothing set;
 *   3. the Makerables root (`CM_MAKERABLES`, else `<repo>/.scratch/makerables`);
 *   4. the directory of any `CM_CATALOGUE` path a caller states explicitly (a test knob, not a
 *      requirement).
 *
 * The ONLY environment variable that changes the behaviour is `CM_NO_CATALOGUE` (1/true), which
 * opts OUT for a stated reason — and a run that opts out must print that on the card
 * (`CatalogueStatus.optedOut`). A machine with the STEPs set and no catalogue found, without the
 * opt-out, is a harness FAILURE, not a silent skip; the specs assert it.
 *
 * A job whose cutter really has no catalogue row still takes the largest-covered-row fallback in
 * `resolvedCutParams` — this helper only makes the rows available; it does not change that rule.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FeedCatalogueSchema,
  clearFeedCatalogue,
  setFeedCatalogue,
  withCatalogueGeometry,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import type { Tool } from '@/engine/cnc/tool';

import { makerablesRoot } from './makerables';

export interface CatalogueDoor {
  /** TRUE when the rows are installed in the resolver. */
  installed: boolean;
  /** TRUE when the run explicitly opted out (`CM_NO_CATALOGUE`), so the card must say so. */
  optedOut: boolean;
  /** Rows installed (0 when absent/refused/opted out). */
  rows: number;
  /** The file read, when one was. */
  path: string | null;
  /** A sentence for the card: where the rows came from, or why this run has none. */
  note: string;
}

/** The app's own data directory (the sync's home), where `catalogue.json` sits beside `location.json`. */
function appDataDirs(): string[] {
  const env = process.env;
  const base =
    process.platform === 'win32'
      ? env.APPDATA
      : env.XDG_DATA_HOME ?? (env.HOME === undefined ? undefined : path.join(env.HOME, '.local', 'share'));
  return base === undefined ? [] : [path.join(base, 'casemaker')];
}

/**
 * The MAIN checkout beside a git worktree: `git rev-parse --git-common-dir` answers the common
 * `.git`, whose parent is the main checkout. Silent when git is absent or this is not a repo —
 * the remaining candidates still answer.
 */
function mainCheckoutDirs(): string[] {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common === '') return [];
    return [path.resolve(common, '..')];
  } catch {
    return [];
  }
}

/** Every place the machine may already hold the full catalogue — no environment required. */
export function makeraCatalogueCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.CM_CATALOGUE !== undefined) candidates.push(process.env.CM_CATALOGUE);
  for (const dir of appDataDirs()) candidates.push(path.join(dir, 'catalogue.json'));
  for (const dir of mainCheckoutDirs()) candidates.push(path.join(dir, '.scratch', 'makerables', 'catalogue.json'));
  candidates.push(path.join(makerablesRoot(), 'catalogue.json'));
  const seen = new Set<string>();
  return candidates.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}

function optedOut(): boolean {
  const value = (process.env.CM_NO_CATALOGUE ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Install the full catalogue from the first candidate that exists and parses. Never throws: a
 * missing or unreadable catalogue is answered as a closed door with the reason the spec prints.
 */
export function installMakeraCatalogue(): CatalogueDoor {
  if (optedOut()) {
    return {
      installed: false,
      optedOut: true,
      rows: 0,
      path: null,
      note: 'the full Makera catalogue is OPTED OUT (CM_NO_CATALOGUE): compiled/location feed rows only — a card measured in this run says so',
    };
  }
  const tried: string[] = [];
  for (const file of makeraCatalogueCandidates()) {
    tried.push(file);
    if (!existsSync(file)) continue;
    try {
      const document = JSON.parse(readFileSync(file, 'utf8')) as {
        feeds?: unknown;
        tools?: { tool?: Tool }[];
        syncedAt?: string;
      };
      const rows = FeedCatalogueSchema.parse(document.feeds) as FeedCatalogueRow[];
      const cutters = (document.tools ?? [])
        .map((entry) => entry.tool)
        .filter((tool): tool is Tool => tool !== undefined);
      setFeedCatalogue(withCatalogueGeometry(rows, cutters), document.syncedAt);
      return {
        installed: true,
        optedOut: false,
        rows: rows.length,
        path: file,
        note: `Makera catalogue ${file} (${rows.length} feed rows, synced ${document.syncedAt ?? 'unknown'})`,
      };
    } catch (error) {
      return {
        installed: false,
        optedOut: false,
        rows: 0,
        path: file,
        note: `${file} exists but was refused: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return {
    installed: false,
    optedOut: false,
    rows: 0,
    path: null,
    note: `no full Makera catalogue found (tried ${tried.join(', ')}); set CM_NO_CATALOGUE=1 to opt out explicitly, or put catalogue.json beside the app's location.json`,
  };
}

/** Drop the catalogue again, so a spec file cannot leak it into another one in the same worker. */
export function clearMakeraCatalogue(): void {
  clearFeedCatalogue();
}
