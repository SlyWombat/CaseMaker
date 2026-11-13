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
const LIMIT_NAME = /(limit|threshold|margin|toleran|clearance|band|cap(?![a-z])|inset|overshoot|max|min|step|pitch|cell|rad(?![a-z])|deg(?![a-z]))/i;

/** The issue's own rule: 0, ±1 and 2 are never a shop decision. */
const TRIVIAL = new Set([0, 1, -1, 2]);

/**
 * #1207 — THE EXPLICIT EXEMPTIONS, each with its reason. Empty on the first failing run: every
 * row the scan finds is an offender until the analyst rules and the conversion lands.
 */
const ALLOWED: Readonly<Record<string, string>> = {};

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
