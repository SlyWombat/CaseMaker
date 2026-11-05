/**
 * #964 — THE LOCAL MAKERABLES REFERENCES, injected by sha256.
 *
 * Makera's NC files, the Studio projects and the models are published under CC BY-NC-SA /
 * CC BY-NC-ND / CC BY-ND / CC0 at makerables.com. They are EVALUATION-ONLY and never committed:
 * the 215 MB lives in `.scratch/makerables/` on dave-1. What IS committed is this manifest — the
 * slugs, the licence of each card, every file's role and sha256, and the numbers the page measured
 * from them — so a spec can prove it read the same bytes the page did and SKIP (with the reason)
 * on a machine that does not hold them.
 *
 * This is the same door the figures' meshes (`samples/3d`, `CM_MESHES`) and the demo location use:
 * a local input resolved by environment override, a committed hash, and an honest skip.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/** One file a reference card needs, with the bytes' identity. */
export interface MakerablesFile {
  /** What the file is for: `nc` (the program scored), `model` (the STEP), `goalcheck` (the numbers). */
  role: 'nc' | 'model' | 'goalcheck' | 'other';
  /** Path relative to the injection root (`.scratch/makerables`). */
  path: string;
  sha256: string;
}

/** The vendor's cut-into block, as the page prints it (E's three excluded shares + the judged number). */
export interface MakerablesVendorCutInto {
  /** `cutInto0p1Pct / 100` after the exclusions; null when the new checker has not scored this card. */
  adjudicatedFraction: number | null;
  edgeBreakFraction: number | null;
  wallNotScoredFraction: number | null;
  shadowNotScoredFraction: number | null;
  /** Advisory: the 0.01 mm-floor figure before exclusions. */
  rawFraction: number | null;
  maxMm: number;
}

/** The vendor's measured numbers for one reference side, as the page printed them. */
export interface MakerablesVendorScore {
  /** Top-surface coverage, 0..1 (page `coverage0p1Pct / 100`). */
  coverage: number;
  cutInto: MakerablesVendorCutInto;
  /**
   * OUR #927 estimator on the vendor program, s — the cycle line's BASIS since the maintainer's
   * #943 ruling (2026-11-05). Before that ruling this field carried the page's `;@MKR|TIME`.
   */
  cycleSeconds: number;
  /**
   * The vendor program's own `;@MKR|TIME`, s — Makera's estimate, printed beside the line as a
   * fact, never the reference (#943). Null only for a card whose file states no TIME.
   */
  headerTimeSeconds: number | null;
  /** Rapids per 1,000 feed moves in the vendor NC, as our parser counts them. */
  rapidsPer1000FeedLines: number;
  /** Distinct cutting tools in the vendor NC. */
  cutters: number;
}

export interface MakerablesCard {
  /** The card id the page prints and the specs name. */
  card: string;
  /** The Makerables project slug. */
  slug: string;
  licence: string;
  /** Which side of the model this card scores (`top`, `bottom`, …). */
  side: string;
  /** The holding the vendor cut in, as the page states it. */
  holding: string;
  /** The page's `goalcheck.json`, relative to the injection root. */
  goalcheck: string;
  /** The vendor `.nc` file(s) this side's program is scored from. */
  files: MakerablesFile[];
  vendorScore: MakerablesVendorScore;
  /** #927 on the vendor's own file, kept for the page's calibration column (3 dp). Since the
   * maintainer's #943 ruling the same estimator is the cycle line's basis; `vendorScore.cycleSeconds`
   * stores it at full precision. */
  vendorEstimateSeconds: number | null;
  /** Where the numbers came from, in words. */
  source: string;
}

/** Case Maker's own attempt at the same reference, when one is kept locally (scratch, not a gate). */
export interface MakerablesOurs {
  card: string;
  label: string;
  /** Run directory under the injection root, with `goalcheck.json`. */
  runDir: string;
  /** Posted `.nc` files, relative to the injection root. */
  ncFiles: string[];
  holding: string;
  pitchMm: number;
  cuttersOwned: boolean | null;
  /** Whether the run's own record states it posted as filed, and the words. */
  postsAsFiled: { ok: boolean; note?: string };
  source: string;
}

export interface MakerablesManifest {
  version: 1;
  injection: { env: string; default: string; note: string };
  cards: MakerablesCard[];
  ours: MakerablesOurs[];
}

/** The manifest path, beside this module's fixtures. */
export const MAKERABLES_MANIFEST = resolve(REPO, 'casemaker-app', 'tests', 'unit', 'fixtures', 'parity', 'makerables.json');

/** Where the vendor files live: `CM_MAKERABLES`, or the dave-1 scratch directory. */
export function makerablesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['CM_MAKERABLES'] ?? resolve(REPO, '.scratch', 'makerables');
}

export function readMakerablesManifest(path: string = MAKERABLES_MANIFEST): MakerablesManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as MakerablesManifest;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface ResolvedCard {
  card: MakerablesCard;
  goalcheckPath: string;
  ncFiles: string[];
}

export type CardResolution =
  | { ok: true; resolved: ResolvedCard }
  | { ok: false; reason: string; missing: string[] };

/**
 * Resolve a card's files under the injection root. Missing files are named, not thrown: a spec
 * skips with the reason, exactly as the figure specs skip without `samples/3d`.
 */
export function resolveMakerablesCard(card: MakerablesCard, root: string = makerablesRoot()): CardResolution {
  const missing: string[] = [];
  const goalcheckPath = join(root, card.goalcheck);
  if (!existsSync(goalcheckPath)) missing.push(card.goalcheck);
  const ncFiles: string[] = [];
  for (const file of card.files) {
    if (file.role !== 'nc') continue;
    const path = join(root, file.path);
    if (!existsSync(path)) missing.push(file.path);
    ncFiles.push(path);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `the Makerables reference is not on this machine (${missing.join(', ')}); set CM_MAKERABLES to its directory — evaluation-only files are never committed`,
    };
  }
  return { ok: true, resolved: { card, goalcheckPath, ncFiles } };
}

/** Verify every file's sha256 against the manifest. Returns the paths that do not match. */
export function mismatchedShas(card: MakerablesCard, root: string = makerablesRoot()): string[] {
  const bad: string[] = [];
  const check = (relative: string, expected: string): void => {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    if (sha256File(path) !== expected) bad.push(relative);
  };
  for (const file of card.files) check(file.path, file.sha256);
  return bad;
}
