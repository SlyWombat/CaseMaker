/**
 * #964 ruling (2026-11-04): THE GATE VALIDATES ON THE FULL MAKERA CATALOGUE.
 *
 * The acceptance and figure specs plan the real reference parts. Left to the compiled starting
 * table, every cutter above 3.2 mm is fed from the material's largest covered row (F400 in
 * hardwood) — a conservative placeholder, not the vendor's number. The ruling is that the gate
 * installs Makera's own catalogue (`setFeedCatalogue`) so a ⌀6 flat is fed from 111031606032 at
 * F1000 and a ⌀6 ball from its own row, and the owned set matters only at the real cut.
 *
 * The catalogue is local-only vendor data (never committed, the same door as `CM_MAKERABLES` and
 * the licensed STEPs): `CM_CATALOGUE`, default `<Makerables root>/catalogue.json`. When it is
 * absent the real-part cases SKIP with the reason rather than silently planning on the fallback.
 *
 * A job whose cutter really has no catalogue row still takes the largest-covered-row fallback in
 * `resolvedCutParams` — this helper only makes the rows available; it does not change that rule.
 */
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
  /** Where the catalogue was looked for. */
  path: string;
  /** TRUE when the rows are installed in the resolver. */
  installed: boolean;
  /** Rows installed (0 when the file is absent or refused). */
  rows: number;
  /** Why it is absent or refused; null when installed. */
  reason: string | null;
}

/** The catalogue file this run reads: `CM_CATALOGUE`, else `<Makerables root>/catalogue.json`. */
export function makeraCataloguePath(): string {
  return process.env.CM_CATALOGUE ?? path.join(makerablesRoot(), 'catalogue.json');
}

/**
 * Install Makera's catalogue into the feeds resolver, joined to its cutters' geometry the same way
 * the app's store does (`withCatalogueGeometry`). Never throws: a missing or unreadable file is
 * answered as a door that is closed, with the reason the spec prints.
 */
export function installMakeraCatalogue(): CatalogueDoor {
  const file = makeraCataloguePath();
  if (!existsSync(file)) {
    return { path: file, installed: false, rows: 0, reason: `no Makera catalogue at ${file} (CM_CATALOGUE or <Makerables root>/catalogue.json)` };
  }
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
    return { path: file, installed: true, rows: rows.length, reason: null };
  } catch (error) {
    return { path: file, installed: false, rows: 0, reason: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Drop the catalogue again, so a spec file cannot leak it into another one in the same worker. */
export function clearMakeraCatalogue(): void {
  clearFeedCatalogue();
}
