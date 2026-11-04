/**
 * #964 — THE PAGE'S CARD ARTEFACTS AS A `ProgramScore`.
 *
 * The demo page's build writes, per card, a run directory: `goalcheck.json` (the checker's
 * geometry: coverage, cut-into, leftover bands), `receipt.json` (the app's own account of what it
 * posted and refused) and the posted `.nc` files. This module turns those files into the scorer's
 * input, so the page's numbers and the specs' numbers are read from ONE place — the page's own
 * measurement — and the scorer only applies the rules.
 *
 * The vendor side is the same shape from a Makerables reference: the multi-tool
 * `mkr_goal_check.py`'s `goalcheck.json` for the geometry and the vendor's `.nc` for the program
 * facts. Its cycle is the file's own `;@MKR|TIME` (Makera's number); #927 on the same file is
 * carried beside it as a calibration figure, never used as the vendor's line.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { combinePostedFacts, measurePostedProgram, type PostedFacts } from './postedFacts';
import type { CutIntoScore, PostsAsFiled, ProgramScore } from './sevenLines';

/** The subset of the page's `goalcheck.json` this adapter reads, with both checkpoint versions. */
export interface PageGoalCheck {
  /** Newer multi-tool checker (#955, E): 100 − leftover > 0.1 mm. */
  coverage0p1Pct?: number;
  /** Older single-tool checker's name for the same number. */
  coveragePct?: number;
  /**
   * E's cut-into line, after the checker has excluded edge break, wall cells and wall shadow:
   * the share of goal cells cut more than 0.1 mm below the goal that remain. A NEW-format file
   * carries at least one of the three exclusion shares below; an OLD-format file's
   * `cutInto0p1Pct` is the pre-exclusion column and is NOT judged.
   */
  cutInto0p1Pct?: number;
  /** The advisory 0.01 mm-floor figure before exclusions (`goal_check.py`'s old `CUT_INTO`). */
  cutIntoPct?: number;
  maxCutIntoMm?: number;
  /** The edge-break share the checker excluded. */
  edgeBreakPct?: number;
  /** The share of cells straddling a goal wall step, excluded. */
  wallNotScoredPct?: number;
  /** The share within the largest cutting tool's radius of a wall step, excluded. */
  shadowNotScoredPct?: number;
  goalCells?: number;
  pitchMm?: number;
}

/** The subset of a `casemaker cut --json` receipt this adapter reads. */
export interface PageReceipt {
  ok?: boolean;
  refusals?: { code?: string; reason?: string }[];
  diagnostics?: { severity?: string; code?: string; message?: string }[];
  details?: { programs?: { ncFile?: string; ok?: boolean }[] };
}

export interface CardArtefacts {
  dir: string;
  goalcheck: PageGoalCheck | null;
  receipt: PageReceipt | null;
  /** The `.nc` files this side posted, resolved to absolute paths. */
  ncFiles: string[];
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The page's goal check as the scorer's cut-into input.
 *
 * The judged number is `cutInto0p1Pct` — the 0.1 mm floor with edge break, wall cells and the
 * wall shadow excluded (#955, E's measured contract). It is only read as judged when the file
 * carries at least one of the three excluded shares; an OLD-format file's `cutInto0p1Pct` is the
 * pre-exclusion column, so the scorer STATES the line rather than passing a number the rule did
 * not produce. The 0.01-floor figure stays advisory.
 */
export function cutIntoFromPage(goalcheck: PageGoalCheck | null): CutIntoScore {
  if (goalcheck === null) {
    return {
      adjudicatedFraction: null,
      edgeBreakFraction: null,
      wallNotScoredFraction: null,
      shadowNotScoredFraction: null,
      rawFraction: null,
      maxMm: 0,
    };
  }
  const applied =
    goalcheck.edgeBreakPct !== undefined ||
    goalcheck.wallNotScoredPct !== undefined ||
    goalcheck.shadowNotScoredPct !== undefined;
  const share = (v: number | undefined): number | null => (v === undefined ? null : v / 100);
  return {
    adjudicatedFraction: applied && goalcheck.cutInto0p1Pct !== undefined ? goalcheck.cutInto0p1Pct / 100 : null,
    edgeBreakFraction: share(goalcheck.edgeBreakPct),
    wallNotScoredFraction: share(goalcheck.wallNotScoredPct),
    shadowNotScoredFraction: share(goalcheck.shadowNotScoredPct),
    rawFraction: share(goalcheck.cutIntoPct),
    maxMm: goalcheck.maxCutIntoMm ?? 0,
  };
}

/**
 * The page's coverage: `coverage0p1Pct` is the top-surface line; older files print `coveragePct`.
 * NULL when the file carries neither — a 2.5D card measured by the design check, or a run
 * directory without a goal check. The scorer STATES the line rather than reading a zero.
 */
export function coverageFromPage(goalcheck: PageGoalCheck | null): number | null {
  if (goalcheck === null) return null;
  const pct = goalcheck.coverage0p1Pct ?? goalcheck.coveragePct;
  return pct === undefined ? null : pct / 100;
}

/** Read a card's run directory into the artefacts, tolerating a missing receipt or goal check. */
export function readCardArtefacts(dir: string): CardArtefacts {
  const goalcheck = readJson<PageGoalCheck>(join(dir, 'goalcheck.json'));
  const receipt = readJson<PageReceipt>(join(dir, 'receipt.json'));
  const fromReceipt = (receipt?.details?.programs ?? [])
    .map((p) => p.ncFile)
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.nc'));
  const ncFiles = fromReceipt.map((name) => join(dir, name));
  return { dir, goalcheck, receipt, ncFiles };
}

/** Whether a receipt states a clean post: accepted, no refusal, no error diagnostic. */
export function postedAsFiledFromReceipt(
  receipt: PageReceipt | null,
  holding: string,
  pitchMm: number,
): PostsAsFiled {
  const errors = (receipt?.diagnostics ?? []).filter((d) => d.severity === 'error');
  const refusals = (receipt?.refusals ?? []).filter((r) => r.code !== 'stopped' && r.code !== 'nothing-written');
  // A receipt that names no program posted nothing, whatever its `ok` says: the cycle and air
  // lines would otherwise read a zero program as free time.
  const programs = receipt?.details?.programs ?? [];
  const posted = programs.length > 0 && programs.every((p) => p.ok !== false);
  const ok = receipt?.ok === true && posted && errors.length === 0 && refusals.length === 0;
  const note =
    errors[0]?.message ??
    refusals[0]?.reason ??
    (receipt?.ok === true && !posted ? 'the receipt names no posted program' : undefined);
  return { ok, holding, pitchMm, ...(note === undefined ? {} : { note }) };
}

export interface PageCardOptions {
  /** The card's id, as the page prints it. */
  card: string;
  /** The holding the card's job was filed in (e.g. `bed + tape`). */
  holding: string;
  /** The pitch the card states, mm. */
  pitchMm: number;
  /** FALSE when a bench card names a cutter the location does not own; NULL for a demo card. */
  cuttersOwned?: boolean | null;
}

/** Measure the programs a page card posted, as one side's program facts. */
export function measurePostedFiles(files: readonly string[], label: string): PostedFacts {
  const parts = files.map((file) => {
    const text = readFileSync(file, 'utf8');
    return measurePostedProgram(text, { label: file.split(/[\\/]/).pop() ?? file });
  });
  return { ...combinePostedFacts(parts), label };
}

/** A page card's run directory as the scorer's `ours` side. */
export function measurePageCard(dir: string, opts: PageCardOptions): ProgramScore {
  const artefacts = readCardArtefacts(dir);
  const facts = measurePostedFiles(artefacts.ncFiles, opts.card);
  const postsAsFiled = postedAsFiledFromReceipt(artefacts.receipt, opts.holding, opts.pitchMm);
  return {
    label: opts.card,
    coverage: coverageFromPage(artefacts.goalcheck),
    cutInto: cutIntoFromPage(artefacts.goalcheck),
    cycleSeconds: facts.cycleSeconds,
    airFraction: facts.airFraction,
    rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
    cutters: facts.cutters.length,
    cuttersOwned: opts.cuttersOwned ?? null,
    postsAsFiled,
    sources: {
      coverage: 'the page goal check (coverage0p1Pct)',
      cutInto: 'the page goal check (cutIntoPct at 0.01 mm)',
      cycle: '#927 estimate on the posted .nc',
      air: '#927 estimate on the posted .nc',
      rapids: 'parseGcode summary on the posted .nc',
      cutters: 'the posted .nc tool records',
    },
  };
}

export interface VendorCardOptions {
  /** The reference card's id. */
  card: string;
  /** The reference's `goalcheck.json` (the multi-tool checker's output). */
  goalcheckPath: string;
  /** The vendor's posted `.nc` files for the side this card scores. */
  ncFiles: readonly string[];
  /** The holding the vendor cut in, as the card states it. */
  holding?: string;
  /** The vendor's stock/vise pitch is not a Case Maker concept; the card states it for the record. */
  pitchMm?: number;
}

/**
 * A Makerables reference as the scorer's `vendor` side.
 *
 * The cycle is the vendor program's own `;@MKR|TIME|seconds=` when the file carries one — Makera's
 * estimate, the number #955's table quotes — and #927 on the same file is kept as a calibration
 * figure in `sources`. Air and rapids are computed from the file with the same functions ours use,
 * because the vendor publishes neither.
 */
export function measureVendorCard(opts: VendorCardOptions): ProgramScore {
  const goalcheck = readJson<PageGoalCheck>(opts.goalcheckPath);
  const facts = measurePostedFiles(opts.ncFiles, opts.card);
  const cycle = facts.headerTimeSeconds ?? facts.cycleSeconds;
  return {
    label: opts.card,
    coverage: coverageFromPage(goalcheck),
    cutInto: cutIntoFromPage(goalcheck),
    cycleSeconds: cycle,
    airFraction: facts.airFraction,
    rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
    cutters: facts.cutters.length,
    cuttersOwned: null,
    postsAsFiled: null,
    sources: {
      coverage: 'the reference goal check (coverage0p1Pct)',
      cutInto: 'the reference goal check (cutIntoPct at 0.01 mm)',
      cycle: facts.headerTimeSeconds === null ? '#927 estimate on the vendor .nc' : 'the vendor .nc’s own ;@MKR|TIME',
      air: '#927 estimate on the vendor .nc',
      rapids: 'parseGcode summary on the vendor .nc',
      cutters: 'the vendor .nc tool records',
    },
  };
}
