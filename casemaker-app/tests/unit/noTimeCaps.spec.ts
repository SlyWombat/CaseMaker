/**
 * #916 — NO ARBITRARY TIME LIMITS IN THE CUTTING ENGINE.
 *
 * The maintainer's rule: a long job is bounded by MEMORY (priced, measured and stated) and by the
 * operator's Cancel — never by a hidden operation or wall-clock cap that silently degrades the
 * plan or refuses work that would have fit. The passes report progress instead (the finishing tip
 * field's rows, the scallop contours, the roughing levels), so a run is never a silent wait.
 *
 * This is a grep-guard: it scans the planning engine and the sim worker — the code that decides
 * what a job cuts — for cap-shaped identifiers and fails on any that is not in the ALLOW list
 * below. The list is deliberately small and each entry says WHY it is not a time cap:
 *
 *   - the memory budget and its rate constants (priced from measurement; the only refusal),
 *   - the heightfield's cell cap (a typed-array memory bound, stated in the grid finding),
 *   - progress-stall watchdogs (they report a stalled worker; they do not degrade a plan).
 *
 * Machine transport windows (`src/platform`'s `_MS` poll/reply constants) live in the machine I/O
 * layer, not the planning engine: a socket read has to give up eventually, and nothing there
 * changes what the CAM plans. Geometric termination clamps (a slope clamp that keeps a spacing
 * finite) are not work budgets either.
 *
 * A NEW entry needs one of those reasons in its line. "It was slow" is not one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN = ['src/engine/cnc', 'src/engine/jobs', 'src/workers/sim', 'src/workers/geometry'];

/** Tokens that name an operation/time budget rather than a memory bound or a termination rule. */
const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /^(?:DEFAULT_)?MAX_[A-Z0-9_]+$/, why: 'a cap on what a plan may do or hold' },
  { pattern: /^[A-Z0-9_]+_CAP$/, why: 'a count cap' },
  { pattern: /^[A-Z0-9_]+_(?:MS|SECONDS)$/, why: 'a wall-clock window' },
  { pattern: /(?:CellBudget|CellLevels|TipOps|TipBudget|ScallopContours|MaxContours|TimeBudget|BudgetMb|BudgetMs)$/, why: 'a work or time budget' },
  { pattern: /^[A-Z0-9_]*(?:Budget|Limit)[A-Z0-9_]*$/, why: 'a cap or budget' },
];

/**
 * The allowed exceptions, each with the reason it is not a time cap. Kept as identifier → reason.
 * Adding a name here is how a reviewer sees a new decision; the test fails until it is stated.
 * The categories #916 allows: the memory budget, progress-stall watchdogs, machine/device I/O
 * windows, readability/drawing bounds, document/input validation, and geometry resolution or
 * engagement numbers (fractions and distances — not work counts).
 */
const ALLOW = new Map<string, string>([
  // The memory budget: measured, priced, and the one honest refusal (#902).
  ['GOAL_MEMORY_BUDGET_MB', 'the stated memory budget'],
  ['GOAL_BUDGET_MARGIN', 'the memory budget’s stated safety margin'],
  ['goalMemoryBudgetMb', 'the stated memory budget’s reader'],
  ['DEFAULT_MAX_CELLS', 'the heightfield’s typed-array memory cap, stated in the grid finding'],
  ['MAX_CHECKPOINTS', 'memory: the packed checkpoint store'],
  ['MAX_AIR_CHECKS', 'memory: one Manifold boolean per check; skipped moves are reported'],
  ['MAX_EMBEDDED_SOURCE_BYTES', 'memory: how large an embedded source may be'],
  // Progress-stall watchdogs: they report a stalled worker; they never degrade a plan (#194/#895).
  ['SIM_LOAD_STALL_MS', 'a progress-stall watchdog'],
  ['SIM_PROJECTION_MIN_MS', 'a progress-projection floor for the stall estimate'],
  ['DEFAULT_SIM_STALL_MS', 'the stall watchdog’s labelled fallback'],
  ['stallWatchdog', 'a progress-stall watchdog'],
  ['stallMs', 'a progress-stall watchdog window'],
  ['sweepStallMessage', 'the stall watchdog’s sentence'],
  // Machine / device I/O windows: a wait has to give up eventually; it changes no plan.
  ['DEFAULT_TIMEOUT_MS', 'a camera capture I/O window'],
  ['MAX_IDLE_POLLS', 'a machine I/O wait window while probing'],
  // Readability and drawing: the run states everything and draws the first N.
  ['DIAGNOSTIC_CAP', 'readability: the first N diagnostics are kept'],
  ['MAX_GOUGES', 'drawing: gouges beyond this are reported, not drawn'],
  // Document and input validation: lengths and counts a document may state.
  ['MAX_CASE_COLOUR', 'input validation: a label’s length'],
  ['MAX_CASE_LABEL', 'input validation: a label’s length'],
  ['MAX_COPIES', 'a document bound (Rust’s tool_copy.rs), not a compute cap'],
  // Geometry: resolutions, distances and engagement fractions — not work counts.
  ['MAX_SEGMENTS', 'an arc tessellation resolution'],
  ['MAX_CENTRE_SEARCH_MM', 'a search distance in mm, not a time'],
  ['MAX_SCALLOP_CROWDING', 'a slope clamp that keeps the contour spacing finite'],
  ['ACCEPT_OF_CAP', 'an engagement fraction, not a cap'],
  ['TARGET_OF_CAP', 'an engagement fraction, not a cap'],
  // Domain thresholds and estimates, not caps.
  ['MAX_RUNTIME_MINUTES', 'a tool-wear threshold'],
  ['MAX_WARN_MINUTES', 'a tool-wear threshold'],
  ['TOOL_CHANGE_SECONDS', 'a planning cost estimate, not a cap'],
]);

/** `src/...` files under a tree, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Code with comments removed, so an explanation of #916 does not trip the guard. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The other shape of the same rule: a WALL-CLOCK COMPARISON that gates a result. A `now()` in the
 * planning engine is how a time limit hides after the constants are gone. Only the progress/stall
 * machinery may read the clock, and each file says why.
 */
const CLOCK_ALLOW = new Map<string, string>([
  ['src/engine/jobs/simClient.ts', 'the progress-stall watchdog'],
  ['src/workers/geometry.worker.ts', 'progress reports while the sweep runs'],
  ['src/workers/geometry/sweep.ts', 'progress pacing for the stall watch'],
  ['src/workers/geometry/columnEngine.ts', 'progress pacing for the stall watch'],
]);

describe('#916 — no arbitrary time limits', () => {
  const hits: { where: string; token: string; why: string }[] = [];
  for (const tree of SCAN) {
    for (const file of sourceFiles(join(ROOT, tree))) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const lines = text.split('\n');
      for (let ln = 0; ln < lines.length; ln++) {
        const tokens = lines[ln]!.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        for (const token of tokens) {
          if (ALLOW.has(token)) continue;
          const rule = BANNED.find((b) => b.pattern.test(token));
          if (rule !== undefined) hits.push({ where: `${relative(ROOT, file)}:${ln + 1}`, token, why: rule.why });
        }
      }
    }
  }

  it('no operation or wall-clock cap is declared outside the stated exceptions', () => {
    const report = hits
      .map((h) => `${h.where}  ${h.token} — ${h.why}`)
      .join('\n');
    expect(
      hits,
      hits.length === 0
        ? ''
        : `${hits.length} time-shaped cap(s) found:\n${report}\n\n` +
          'A long run is bounded by memory (priced and stated) and by Cancel, with progress — not by a cap. ' +
          'If one of these is a genuine memory bound, a progress-stall watchdog or a machine I/O window, ' +
          'add it to ALLOW with that reason.',
    ).toEqual([]);
  });

  it('no planning file reads the wall clock outside the stated progress and stall files', () => {
    const offenders: string[] = [];
    for (const tree of ['src/engine', 'src/workers']) {
      for (const file of sourceFiles(join(ROOT, tree))) {
        const rel = relative(ROOT, file);
        if (CLOCK_ALLOW.has(rel)) continue;
        if (/performance\.now\(\)|Date\.now\(\)/.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `wall-clock reads outside the allowed progress/stall files:\n${offenders.join('\n')}\n\n` +
          'A clock comparison that gates a result is a time limit. The planning engine reports progress ' +
          'and takes Cancel; if this file is progress/stall machinery, add it to CLOCK_ALLOW with the reason.',
    ).toEqual([]);
  });
});
