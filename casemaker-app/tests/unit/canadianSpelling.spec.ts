// #812 — CANADIAN SPELLING IN EVERY USER-VISIBLE STRING.
//
// The app says "mould", "colour", "centre", "grey", "fibre", "behaviour", "metre", "aluminium";
// stored values, identifiers and testids keep their existing spelling (`goalMode: 'mold'`,
// `'centered'`, CSS `color`, three.js APIs) and the display layer maps to the Canadian word.
//
// This guard reads:
//   1. every STRING LITERAL and JSX TEXT node under `src/` (TypeScript's own AST, so comments and
//      identifiers are not text), and
//   2. the user guide chapters, and
//   3. messages the finding builders RENDER for a mould goal,
// and fails on any American spelling in the list. Vendor material names are proper names and are
// allowed by name (Makera writes `Carbon Fiber` and `6061 Aluminum`; the app's own material labels
// already say `Aluminium 6061`).
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { validateGoalObject } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** American spellings in scope, word-boundary and case-insensitive (a measuring "meter" is out of scope; no prose uses it). */
const AMERICAN = /\b(mold(?:s|ed|ing)?|color(?:s|ed|ing|ful)?|center(?:s|ed|ing)?|gray(?:s|ed)?|fiber(?:s)?|behavior(?:s)?|aluminum|liter(?:s)?)\b/gi;

/**
 * Single lowercase tokens are stored values, keys, testids or enum values (`'mold'`, `'centered'`,
 * `'goal-mold-rim'`, `'make-mold'`) — never prose, because prose has a space or a capital.
 */
const TOKEN = /^[a-z0-9][a-z0-9._-]*$/;

/** Vendor material names, quoted as Makera writes them (proper names, not the app's prose). */
const VENDOR = /Carbon Fiber|\b(?:6061|7075) Aluminum\b/;

/** CSS references and markup fragments in strings are code, not prose. */
const CSS_VALUE = /--cm-|color-mix\(|currentColor|style=/;

/** Module specifiers and paths (no spaces, a slash) are not prose. */
const PATHY = /^[^\s]*\/[^\s]*$/;

const SRC = path.join(process.cwd(), 'src');

/** Every string literal, template part and JSX text node, with the file and line it starts on. */
function literalsIn(file: string): { text: string; line: number }[] {
  const source = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: { text: string; line: number }[] = [];
  const push = (text: string, node: ts.Node): void => {
    out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push(node.text, node);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) push(node.text, node);
    else if (ts.isJsxText(node)) push(node.text, node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * The American spellings in one piece of text, after the allowances. Quoted single tokens are
 * stored values named in prose (the schema description says the `'mold'` value by name), so they
 * are removed before scanning; vendor material names are proper names.
 */
function offences(text: string): string[] {
  const found: string[] = [];
  const prose = text.replace(/(['"`])[a-z][a-z0-9_-]*\1/g, ' ');
  for (const match of prose.matchAll(AMERICAN)) {
    const at = match.index ?? 0;
    const around = text.slice(Math.max(0, at - 10), at + match[0].length + 6);
    if (VENDOR.test(around)) continue;
    found.push(match[0]);
  }
  return found;
}

describe('#812 — Canadian spelling', () => {
  it('every string literal and JSX text under src/ is Canadian (or a stored value)', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const { text, line } of literalsIn(file)) {
        if (text.trim() === '' || TOKEN.test(text.trim()) || CSS_VALUE.test(text) || PATHY.test(text.trim())) continue;
        const hits = offences(text);
        if (hits.length > 0) bad.push(`${path.relative(process.cwd(), file)}:${line} — ${hits.join(', ')} in ${JSON.stringify(text)}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the user guide chapters are Canadian', () => {
    const bad: string[] = [];
    for (const name of ['cnc-guide.md', 'getting-started.md']) {
      const file = path.join(SRC, 'docs', name);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        const hits = offences(text);
        if (hits.length > 0) bad.push(`src/docs/${name}:${i + 1} — ${hits.join(', ')} in ${JSON.stringify(text.trim().slice(0, 120))}`);
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the findings a mould goal renders say mould', () => {
    // A mould smaller than the blank's edge margin and deeper than its floor: the two sentences
    // the goal checks render, taken from the builder rather than the source.
    const target: EngraveTargetObject = {
      id: 'goal-guard',
      name: 'guard.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      size: { x: 10, y: 10, z: 5 },
      position: { x: 2, y: 2, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
      goalMode: 'mold',
    };
    const findings = validateGoalObject(target, { length: 100, width: 60, thickness: 12 }, {
      mixed: true,
      minFloor: 1,
      edgeMargin: 3,
    });
    expect(findings.length, 'the fixture renders the rim and floor sentences').toBeGreaterThanOrEqual(2);
    const messages = findings.map((finding) => finding.message);
    const bad = messages.flatMap((message) =>
      offences(message).map((hit) => `${hit} in ${JSON.stringify(message)}`),
    );
    expect(bad, bad.join('\n')).toEqual([]);
    expect(messages.join('\n')).toContain('mould');
  });
});
