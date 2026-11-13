/**
 * #1207 — NO CHOSEN LIMIT WITHOUT THE REGISTRY.
 *
 * The maintainer's standing rule (2026-11-10): "there should be a standing rule of no hardcoded
 * values in the software, any limits etc are editable in some buried menu." The analyst's ruling
 * on this issue's thresholds is the test of what counts: if changing a number changes *what the
 * product accepts or does*, it is a chosen value; if it only changes *how accurately we compute
 * the same answer*, it is numerical and stays in code, named and commented.
 *
 * This gate walks the CNC engine (`src/engine/cnc/**`) for **module-level numeric constants whose
 * names are in the limit family** — limit, threshold, margin, tolerance, clearance, band, cap,
 * inset, overshoot, max, min, step, pitch, cell, and the `_RAD` / `_DEG` angle suffixes. It
 * ignores the issue's own trivial values (0, ±1, 2) and any constant whose initializer reads the
 * registry (`readDefault(…)`): those are the registry's own numbers, not literals in logic.
 *
 * EVERYTHING ELSE must be explained in {@link ALLOWED}: one entry per `file:NAME`, each with the
 * one-line reason it is not a shop decision (a geometry constant, a numeric epsilon, a sampling
 * step, a compute cap, a drawing constant, a labelled registry fallback). The list is the honest
 * part of the rule: nothing is exempt silently, and the list may only shrink — a stale entry
 * fails, and a new constant fails until it is either moved to the registry or explained.
 *
 * THE FIRST FAILING RUN (empty allow-list) IS THE OFFENDER CHECKLIST: `file:line NAME = value`
 * per row, posted on #1207 for the analyst's ruling before anything is converted (2026-11-13).
 *
 * The issue's acceptance is the red test: adding `const LIMIT = 7;` to an engine file fails this
 * spec — pinned by the synthetic-source case below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { readDefault } from '@/platform/defaultsClient';
import { SCAN_FALLBACK } from '@/engine/cnc/engrave/materialScan';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const CNC_ENGINE = join(APP, 'src', 'engine', 'cnc');

/**
 * The limit family the gate watches. `max`/`min` are the plainest limit names; `step`/`pitch`/
 * `cell` are the sampling family the ruling names (they are allowed, but only with a stated
 * reason — a sampling step can never be silently exempt). `rad(?![a-z])`/`deg(?![a-z])` take the
 * `_RAD`/`_DEG` angle suffixes without swallowing RADIUS/RADIAN.
 */
const LIMIT_NAME = /(limit|threshold|margin|toleran|tol(?![a-z])|clearance|band|cap(?![a-z])|inset|overshoot|max|min|step|pitch|cell|rad(?![a-z])|deg(?![a-z]))/i;

/** The issue's own rule: 0, ±1 and 2 are never a shop decision. */
const TRIVIAL = new Set([0, 1, -1, 2]);

/**
 * #1207 — THE EXPLICIT EXEMPTIONS, each with its reason (the analyst's ruling of 2026-11-13
 * accepted these groups). A `fallbackOf` entry names the registry key the constant is the labelled
 * fallback for, and the test below asserts the two agree — a fallback that differs from its key is
 * a second opinion, posted as a finding and never silently kept. The list may only shrink.
 *
 * NOT on this list, deliberately: the feature-recognition rows (awaiting the analyst's per-row
 * ruling) and the compute caps whose breach may be operator-visible (awaiting the cap split).
 */
interface AllowEntry {
  reason: string;
  /** The registry key this constant is the labelled fallback for, when it is one. */
  fallbackOf?: string;
}

const ALLOWED: Readonly<Record<string, AllowEntry>> = {
  'src/engine/cnc/cam/model/features/rims.ts:MODELLED_CHAMFER_MAX_LEG_MM': { reason: 'feature-recognition geometry: the longest leg of a modelled chamfer (analyst-ruled allow-list)' },
  'src/engine/cnc/engrave/goalFlipPlan.ts:FLAT_DEG': { reason: 'feature classification: how far a face may tilt and still count as flat (analyst-ruled allow-list)' },
  'src/engine/cnc/engrave/goalFlipSetups.ts:STOCK_BOTTOM_FLAT_DEG': { reason: 'feature classification: the stock bottom’s own flatness test (analyst-ruled allow-list)' },
  'src/engine/cnc/cam/adaptive.ts:ACCEPT_OF_CAP': { reason: "a planner method constant; the code itself says it is about the method, not the cut" },
  'src/engine/cnc/cam/adaptive.ts:TARGET_OF_CAP': { reason: "a planner method constant; the code itself says it is about the method, not the cut" },
  'src/engine/cnc/cam/adaptive.ts:WALL_MARGIN_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/drill.ts:PECK_CLEARANCE_FALLBACK_MM': { reason: "labelled fallback for `drill.peckClearanceMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'drill.peckClearanceMm' },
  'src/engine/cnc/cam/facing.ts:FACING_EDGE_CLEARANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/ir.ts:JUNCTION_CORNER_DEG': { reason: "a planner method constant; the code itself says it is about the method, not the cut" },
  'src/engine/cnc/cam/ir.ts:TOUR_BOUND_MAX_POINTS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/cam/model/clsurface.ts:MIN_SAMPLE_SPACING_CAP_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/cam/model/features/patches.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/cam/model/ops/finish.ts:FOOTPRINT_EDGE_INSET_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/model/plan.ts:RIM_CLOSE_TOL_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/model/rowDropper.ts:MAX_BISECT_DEPTH': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/cam/model/setups.ts:COLLINEAR_TOL_RAD': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/model/setups.ts:OFFSET_CONSISTENCY_TOL_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/moveStore.ts:GOAL_MERGE_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/profile.ts:TAB_COLLINEAR_RAD': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/cam/tabSettings.ts:TAB_MAX_SPAN_FALLBACK_MM': { reason: "labelled fallback for `tabs.maxSpanMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'tabs.maxSpanMm' },
  'src/engine/cnc/camera/calibrate.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/camera/targetSpec.ts:CAMERA_CHECKER_MARGIN': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/camera/targetSpec.ts:CAMERA_FIDUCIAL_PITCH': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/camera/targetSpec.ts:CAMERA_TARGET_MARGIN': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/caseColour.ts:MAX_CASE_COLOUR': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/caseColour.ts:MAX_CASE_LABEL': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/cutterProfile.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/drawnRotary.ts:ROTARY_REVERSE_STEP': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/drawnVise.ts:VISE_BASE_LEFT_MARGIN': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/drawnVise.ts:VISE_BASE_Y_MARGIN': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/emulator/timeline.ts:DIAGNOSTIC_CAP': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/blankLabelSeed.ts:BLANK_BAND_FILL_FALLBACK': { reason: "labelled fallback for `engrave.blankBandFill`; the gate asserts it equals that key’s recommendation", fallbackOf: 'engrave.blankBandFill' },
  'src/engine/cnc/engrave/cutMap.ts:CUT_MAP_MAX_STREAM': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/cutMap.ts:CUT_MAP_PITCHES': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/cutMap.ts:CUT_MAP_STEP_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/depthBounds.ts:DEFAULT_BOUNDARY_MARGIN_MM': { reason: "labelled fallback for `margins.boundaryMarginMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'margins.boundaryMarginMm' },
  'src/engine/cnc/engrave/depthBounds.ts:DEFAULT_Z_TOLERANCE_MM': { reason: "labelled fallback for `margins.zToleranceMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'margins.zToleranceMm' },
  'src/engine/cnc/engrave/depthBounds.ts:DEPTH_STEPS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/depthBounds.ts:MEASURED_THICKNESS_TOLERANCE_MM': { reason: "labelled fallback for `margins.measuredThicknessToleranceMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'margins.measuredThicknessToleranceMm' },
  'src/engine/cnc/engrave/designCheck.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/engrave/designCheck.ts:DESIGN_CHECK_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/designCheck.ts:GOAL_EDGE_STEP_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/designCheck.ts:LEVEL_STEP_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/designCheck.ts:MAX_LEVEL_STEPS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/flipSilhouette.ts:FRONT_SILHOUETTE_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/flipSilhouette.ts:FRONT_STRAIGHT_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/flute.ts:FLUTE_RAMP_STEPS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/goalFlipFindings.ts:FLIP_CACHE_MAX': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/goalFlipFindings.ts:RING_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/goalFlipSetups.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/engrave/goalFlipSetups.ts:HOLD_PIN_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/goalHeightfield.ts:DEFAULT_GRID_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/goalPlacement.ts:GOAL_FIT_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/goalTopFace.ts:FACE_CACHE_MAX': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/goalTopFace.ts:FACE_KEEP_TOL_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/goalTopFace.ts:FACE_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/goalUnderside.ts:OFFER_CACHE_MAX': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/goalUnderside.ts:PROPOSAL_PITCH_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/engrave/goalUnderside.ts:UNDERSIDE_TOL_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/materialScan.ts:DEPTH_TOLERANCE_MM': { reason: "labelled fallback for `registration.readingResolutionMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'registration.readingResolutionMm' },
  'src/engine/cnc/engrave/materialScan.ts:SCAN_COARSE_STEP_MM': { reason: "labelled fallback for `registration.coarseStepMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'registration.coarseStepMm' },
  'src/engine/cnc/engrave/materialScan.ts:SCAN_MISS_MARGIN_MM': { reason: "labelled fallback for `registration.scanMissMarginMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'registration.scanMissMarginMm' },
  'src/engine/cnc/engrave/oracleTypes.ts:ORACLE_AREA_FLOOR_CELLS': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/runProgress.ts:MIN_ELAPSED_FOR_ESTIMATE_S': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/engrave/runStatusLog.ts:STATUS_LOG_MAX_LINES': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/engrave/targetScale.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/engrave/texture.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/engrave/texture.ts:MIN_STROKE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/threadFit.ts:PITCH_EPS': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/engrave/throughMask.ts:SPAN_END_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/feeds.ts:LABEL_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/fixture.ts:GRIP_MIN': { reason: "labelled fallback for `setups.minGripMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'setups.minGripMm' },
  'src/engine/cnc/fixture.ts:LEDGE_STEP': { reason: "the Z1 vise accessory record’s ledge step (Z1_VISE.ledgeStep)" },
  'src/engine/cnc/fixture.ts:VISE_MIN_COVERAGE_FRACTION_FALLBACK': { reason: "labelled fallback for `vise.minCoverageFraction`; the gate asserts it equals that key’s recommendation", fallbackOf: 'vise.minCoverageFraction' },
  'src/engine/cnc/gcode/arcs.ts:MAX_SEGMENTS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/headerMatch.ts:TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/post/thumbnail.ts:MARGIN_FRACTION': { reason: "a drawing or sheet-layout constant" },
  'src/engine/cnc/post/thumbnail.ts:THUMBNAIL_MAX_BYTES': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/probePlan.ts:DEFAULT_FLAT_TOL_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/registration/centreFind.ts:MIN_CENTRE_DEPTH_MM': { reason: "the probe ball’s physical feasibility floor" },
  'src/engine/cnc/registration/execute.ts:MAX_IDLE_POLLS': { reason: "labelled fallback for `registration.idlePollLimit`; the gate asserts it equals that key’s recommendation", fallbackOf: 'registration.idlePollLimit' },
  'src/engine/cnc/registration/flipAttempt.ts:PIN_REFLECTION_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/registration/placing.ts:GRID_MATCH_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/registration/probe3d.ts:MIN_SIDE_DEPTH_MM': { reason: "the probe ball’s physical feasibility floor" },
  'src/engine/cnc/registration/rotaryTap.ts:ROTARY_CHORD_TOLERANCE_MM': { reason: "a sampling or measurement pitch/step (the ready gate’s numeric-method exemption)" },
  'src/engine/cnc/registration/settings.ts:CUT_BLANK_ABOVE_BAND_FALLBACK_MM': { reason: "labelled fallback for `registration.cutBlankAboveBandMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'registration.cutBlankAboveBandMm' },
  'src/engine/cnc/rotary/neck.ts:ROTARY_NECK_DEFAULT_CLEARANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/rotary/neck.ts:ROTARY_NECK_MIN_LENGTH_MM': { reason: "derived geometry: the saw kerf plus the two side clearances" },
  'src/engine/cnc/rotary/tipDrop.ts:TIP_BISECTION_STEPS': { reason: "an internal compute/loop cap the operator never sees breached" },
  'src/engine/cnc/rotary/wrap.ts:ROTARY_MAX_DIAMETER_MM': { reason: "Makera’s 4th-axis module envelope (⌀80 × 150 mm) — the vendor’s own limit" },
  'src/engine/cnc/rotary/wrap.ts:ROTARY_MAX_LENGTH_MM': { reason: "Makera’s 4th-axis module envelope (⌀80 × 150 mm) — the vendor’s own limit" },
  'src/engine/cnc/rotaryClock.ts:FIRMWARE_A_MAX_DEG_PER_MIN': { reason: "the Z1 firmware’s own A ceiling (3,600 °/min)" },
  'src/engine/cnc/setups/flip.ts:PIN_RULE_TOLERANCE_MM': { reason: "a numeric epsilon or rounding guard" },
  'src/engine/cnc/stockStart.ts:FACING_RETOUCH_TOLERANCE_FALLBACK_MM': { reason: "labelled fallback for `facing.retouchToleranceMm`; the gate asserts it equals that key’s recommendation", fallbackOf: 'facing.retouchToleranceMm' },
  'src/engine/cnc/stockStart.ts:ROD_VISE_MAX_LENGTH_MM': { reason: "derived geometry: Z1_VISE’s floor depth" },
  'src/engine/cnc/threadTable.ts:EXTERNAL_MINOR_COEFF': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/threadTable.ts:INTERNAL_MINOR_COEFF': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/tool.ts:DRILL_POINT_FALLBACK_DEG': { reason: "a tool geometry default (the standard 118° twist-drill point)" },
  'src/engine/cnc/toolCondition.ts:MAX_COPIES': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/toolCondition.ts:MAX_RUNTIME_MINUTES': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/toolCondition.ts:MAX_WARN_MINUTES': { reason: "a UI field/display bound, not a cut decision" },
  'src/engine/cnc/vCarveGeometry.ts:V_CARVE_STEPOVER_FALLBACK': { reason: "labelled fallback for `vcarve.stepoverRatio`; the gate asserts it equals that key’s recommendation", fallbackOf: 'vcarve.stepoverRatio' },
  'src/engine/cnc/vProfile.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
  'src/engine/cnc/vProfile.ts:DEG': { reason: "a maths constant (π/180 or a standard thread coefficient), not a shop decision" },
};

/** One row of the checklist. `key` is `src/engine/cnc/<path>:<NAME>`, stable across edits. */
export interface LimitConstant {
  key: string;
  file: string;
  line: number;
  name: string;
  /** The initializer as written, trimmed to one line. */
  text: string;
}

/** Every `.ts` under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** The initializer text when it can be a numeric constant, else null. */
function numericInitializer(init: ts.Expression, source: ts.SourceFile): string | null {
  if (ts.isNumericLiteral(init)) return init.text;
  if (
    ts.isPrefixUnaryExpression(init) &&
    init.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(init.operand)
  ) {
    return `-${init.operand.text}`;
  }
  // An array of numbers (`GOAL_LEFTOVER_BANDS_MM = [0.1, 0.3, 1]`), optionally `as const`.
  const array = ts.isAsExpression(init) ? init.expression : init;
  if (ts.isArrayLiteralExpression(array)) {
    if (array.elements.length === 0) return null;
    if (array.elements.every((element) => ts.isNumericLiteral(element))) {
      return `[${array.elements.map((element) => (element as ts.NumericLiteral).text).join(', ')}]`;
    }
    return null;
  }
  // A number carried by an expression (`(20 * Math.PI) / 180`, `0.05 + 1e-9`, `4 * 1024 * 1024`)
  // or by another constant (`STEP = Z1.ledgeStep`, `SCAN_MISS_MARGIN_MM = SCAN_FALLBACK.missMarginMm`).
  // Function-valued and object-valued declarations are not constants: excluded.
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isObjectLiteralExpression(init)) return null;
  const text = init.getText(source).replace(/\s+/g, ' ').trim();
  if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return text;
  if ((ts.isBinaryExpression(init) || ts.isParenthesizedExpression(init)) && /\d/.test(text)) return text;
  return null;
}

/** True when the initializer reads the registry — then the number is the registry's, not a literal. */
function readsRegistry(text: string): boolean {
  return /\breadDefault\s*\(|\bliveShopDefaults\s*\(|\breadFlag\s*\(/.test(text);
}

/** The candidate constants in one source text. Exported for the synthetic-source case below. */
export function limitConstants(source: string, file: string): LimitConstant[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: LimitConstant[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      if (!LIMIT_NAME.test(declaration.name.text)) continue;
      const text = numericInitializer(declaration.initializer, sf);
      if (text === null || readsRegistry(text)) continue;
      // The issue's trivial values; a single number only (an array's members are its own list).
      const plain = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
      if (plain !== null && TRIVIAL.has(plain)) continue;
      const line = sf.getLineAndCharacterOfPosition(declaration.getStart(sf)).line + 1;
      out.push({
        key: `${relative(APP, file).split('\\').join('/')}:${declaration.name.text}`,
        file: relative(APP, file).split('\\').join('/'),
        line,
        name: declaration.name.text,
        text,
      });
    }
  }
  return out;
}

/** The checklist rows the scan finds on main, in file/line order. */
function scanTree(): LimitConstant[] {
  return sourceFiles(CNC_ENGINE)
    .flatMap((file) => limitConstants(readFileSync(file, 'utf8'), file))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** How a failure prints: one line per row, ready to paste into the issue. */
function checklist(rows: readonly LimitConstant[]): string {
  return rows.map((row) => `${row.file}:${row.line}  ${row.name} = ${row.text}`).join('\n');
}

describe('#1207 the engine declares no chosen limit outside the registry', () => {
  it('every limit-family constant is registry-backed or on the explicit allow-list', () => {
    const rows = scanTree();
    const unexplained = rows.filter((row) => ALLOWED[row.key] === undefined);
    expect(
      unexplained,
      `#1207 — the first failing run is the offender checklist:\n${checklist(unexplained)}`,
    ).toEqual([]);
  });

  it('every labelled fallback equals the recommendation of the key it names', () => {
    const rows = scanTree();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // The three scan fallbacks are property reads of SCAN_FALLBACK; the rest are numeric literals.
    const scanValue: Record<string, number> = {
      SCAN_COARSE_STEP_MM: SCAN_FALLBACK.coarseStepMm,
      SCAN_MISS_MARGIN_MM: SCAN_FALLBACK.missMarginMm,
      DEPTH_TOLERANCE_MM: SCAN_FALLBACK.readingResolutionMm,
    };
    const mismatches: string[] = [];
    for (const [key, entry] of Object.entries(ALLOWED)) {
      if (entry.fallbackOf === undefined) continue;
      const row = byKey.get(key);
      if (row === undefined) continue; // the stale-entry test names it
      const literal = /^-?\d+(?:\.\d+)?$/.test(row.text) ? Number(row.text) : scanValue[row.name];
      const recommendation = readDefault(null, entry.fallbackOf).value;
      if (literal === undefined || Math.abs(literal - recommendation) > 1e-9) {
        mismatches.push(`${key}: ${row.text} vs ${entry.fallbackOf} recommendation ${recommendation}`);
      }
    }
    expect(
      mismatches,
      '#1207 — a fallback that differs from its key\'s recommendation is a finding: post it and stop',
    ).toEqual([]);
  });

  it('the allow-list may only shrink — every entry still names a constant the scan finds', () => {
    const keys = new Set(scanTree().map((row) => row.key));
    const stale = Object.keys(ALLOWED).filter((key) => !keys.has(key));
    expect(stale, `#1207 — remove the allow-list entries whose constant is gone:\n${stale.join('\n')}`).toEqual([]);
  });

  it('the scanner has teeth: `const LIMIT = 7` is found, and the trivial values are not', () => {
    const source = [
      'const LIMIT = 7;',
      'export const SAFE_MARGIN_MM = 1.5;',
      'const NOTHING = 0;',
      'const ONE = 1;',
      'const TWO = 2;',
      'const FROM_REGISTRY = readDefault(null, "plan.shortlistSize").value;',
      'const NAME = "not a number";',
    ].join('\n');
    const found = limitConstants(source, join(CNC_ENGINE, 'synthetic.ts'));
    expect(found.map((row) => row.name)).toEqual(['LIMIT', 'SAFE_MARGIN_MM']);
  });
});
