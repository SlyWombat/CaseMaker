// `cnc-guide.md` is written for someone who owns a Makera Z1 and has never driven a
// CNC: it has to be true, and it has to say which parts are true *today*. The status
// lines carry that claim, and these rules keep the guide honest mechanically:
//
//   1. every diagnostic code the source can emit has a row in chapter 8;
//   2. every `##` / `###` section opens with a status line.
//
// The status line used to also have to name a tracker issue, checked against a checked-in
// map of issue states. The guide speaks to the operator, not to the tracker: issue numbers
// are not allowed in an end-user document (tests/unit/docsNoInternals.spec.ts holds that
// rule), so the issue-naming checks and their map are gone with the numbers.
//
// Plus the caption rule the mockups ship with: a design mockup may never be shown as if
// it were the shipped screen.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = join(ROOT, 'casemaker-app');
const GUIDE = readFileSync(join(APP, 'src/docs/cnc-guide.md'), 'utf8');

const CAPTION = '*Design mockup — not the shipped screen.*';
const CHAPTER_8 = GUIDE.slice(GUIDE.indexOf('\n## 8 · '));

/** Every `.ts` under the given directories, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Every code the tree can raise.
 *
 * The engine emits them six ways, and a complete scan needs all six:
 *   - `code: 'kebab-case'` literals (`sweep.ts`, `engraveGeometry.ts`, `jobSetup.ts`, `fixture.ts`, `machine.ts`, `lexer.ts`);
 *   - `diag('severity', 'code', …)` calls, which in `interpreter.ts` frequently wrap
 *     onto several lines (hence `\s*` rather than spaces);
 *   - `warn(record, 'code', …)` calls in `setupFromHeader.ts`;
 *   - `push('code', …)` calls in `verify.ts`, the verifier's own codes — every error the
 *     **Verified** row can report, `parse-error` and `runner-error` included. These wrap onto
 *     several lines too (the checker passes a `push` around), which the same `\s*` covers.
 *   - `refuse('code', …)` in `workers/sim/session.ts`, which wraps its code onto the next line
 *     when the message is long (`prior-removal-column`).
 *   - a code CHOSEN by a ternary (`code: wordLike ? 'lowercase-word' : 'ignored-text'`,
 *     `code: rotary ? 'rotary-stock' : 'flat-stock'`) — the literal pattern above cannot see
 *     either arm, so both are read by the last two (#470).
 *
 * Plus the ways a code is declared that the pattern above cannot see, which hid
 * `goal-mesh-unclosable` (a class field, `readonly code = '…'`) from this gate:
 *   - `code = '…'` assignments and class fields;
 *   - `const …CODE = '…'` constants, whether exported or not;
 *   - a union of codes (`code: 'a' | 'b'`, `type …Code = 'a' | 'b'`), every member read;
 *   - a code written as the head of a message (`` `goal-mesh-non-finite: …` ``), the form a
 *     refusal takes when the code travels inside its sentence.
 * The scan reads every `.ts` and `.tsx` under `src/`, minus `src/engine/compiler` (the case
 * geometry's own checks, which the CNC guide does not describe).
 *
 * `custom` is Zod's own issue code (`toolLibrary.ts`), not a diagnostic a user sees.
 */
function sourceCodes(): string[] {
  const codes = new Set<string>();
  // The call-shaped patterns (`push(`, `warn(`, …) are read in the engine and the workers only: in a
  // component or a store `push('x')` is a class list or a label list, not a diagnostic.
  const callPatterns = [
    /diag\(\s*'(?:error|warning|info)'\s*,\s*'([a-z0-9-]+)'/g,
    /warn\([^,()]+,\s*'([a-z0-9-]+)'/g,
    /push\(\s*'([a-z0-9-]+)'/g,
    /refuse\(\s*'([a-z0-9-]+)'/g,
    /refuse\(\s*\n\s*'([a-z0-9-]+)'/g,
  ];
  const patterns = [
    /code:\s*'([a-z0-9-]+)'/g,
    /code:\s*[^,;\n]*?\?\s*'([a-z0-9-]+)'/g,
    /code:\s*[^,;\n]*?\?\s*'[a-z0-9-]+'\s*:\s*'([a-z0-9-]+)'/g,
    /\bcode\s*=\s*'([a-z0-9]+(?:-[a-z0-9]+)+)'/g,
    /\b[A-Za-z_]*CODE\s*(?::[^=\n]+)?=\s*'([a-z0-9]+(?:-[a-z0-9]+)+)'/g,
  ];
  // The head of a message, read outside `src/components` (where `'flex-wrap: '` is a style, not a code).
  const messageHeads = [/[`'"]([a-z]+(?:-[a-z]+)+): /g];
  // A union: the whole `'a' | 'b' | 'c'` run after `code:` or `Code =` is captured, then split.
  const unions = [/\bcode\??:\s*((?:'[a-z0-9-]+'\s*\|\s*)+'[a-z0-9-]+')/g, /Code\s*=\s*((?:'[a-z0-9-]+'\s*\|\s*)+'[a-z0-9-]+')/g];
  for (const file of tsFiles(join(APP, 'src'))) {
    if (file.includes(join('src', 'engine', 'compiler'))) continue;
    const text = readFileSync(file, 'utf8');
    const callShaped = file.endsWith('.ts') && (file.includes(join('src', 'engine', 'cnc')) || file.includes(join('src', 'workers')));
    const inComponents = file.includes(join('src', 'components'));
    for (const pattern of [...patterns, ...(callShaped ? callPatterns : []), ...(inComponents ? [] : messageHeads)]) {
      for (const m of text.matchAll(pattern)) codes.add(m[1]!);
    }
    for (const pattern of unions) {
      for (const m of text.matchAll(pattern)) {
        for (const member of m[1]!.matchAll(/'([a-z0-9-]+)'/g)) codes.add(member[1]!);
      }
    }
  }
  codes.delete('custom');
  return [...codes].sort();
}

interface Section {
  heading: string;
  status: string;
  bodyLines: string[];
}

/** Split the guide into `##`/`###` sections, each with its status line (the next non-blank line). */
function sections(): Section[] {
  const lines = GUIDE.split('\n');
  const out: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^#{2,3} /.test(line)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    const status = j < lines.length ? lines[j]! : '';
    out.push({ heading: line, status, bodyLines: lines.slice(i + 1) });
  }
  return out;
}

describe('cnc-guide.md — the reference table is complete', () => {
  it('lists every diagnostic code the source can emit, in backticks, in chapter 8', () => {
    // Guard against a vacuous pass: if the scan ever reads the wrong directory it finds
    // no codes and this test would pass by accident.
    const codes = sourceCodes();
    expect(codes.length, 'the diagnostic scan found no codes — check the directory paths').toBeGreaterThan(50);
    const missing = codes.filter((code) => !CHAPTER_8.includes('`' + code + '`'));
    expect(
      missing,
      `cnc-guide.md chapter 8 is missing a row for: ${missing.join(', ')} — add one per code`,
    ).toEqual([]);
  });
});

describe('cnc-guide.md — every section says whether you can do it today', () => {
  it('opens every ## and ### section with a truthful status line', () => {
    for (const s of sections()) {
      expect(
        s.status,
        `${s.heading} has no "> **Status: …**" line`,
      ).toMatch(/^> \*\*Status: (Available|Partly available|Planned)\*\*/);
    }
  });
});

describe('cnc-guide.md — a mockup is never shown as the shipped screen', () => {
  it('captions every mockup, and keeps mockups out of Available sections', () => {
    const lines = GUIDE.split('\n');
    // Walk the document so each image is attributed to the last heading above it.
    const statusByLine = new Map<number, string>();
    let current = '';
    let currentStatus = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^#{2,3} /.test(line)) {
        current = line;
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        currentStatus = lines[j] ?? '';
      }
      statusByLine.set(i, currentStatus);
      if (line.startsWith('![') && line.includes('](img/cnc-mockup-')) {
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        // 1. the caption, verbatim
        expect(
          lines[j],
          `the mockup on line ${i + 1} must be captioned "${CAPTION}"`,
        ).toBe(CAPTION);
        // 2. never inside an Available section
        expect(
          statusByLine.get(i),
          `the mockup on line ${i + 1} is in a section marked Available (${current})`,
        ).toMatch(/^> \*\*Status: (Partly available|Planned)\*\*/);
      }
    }
  });
});
