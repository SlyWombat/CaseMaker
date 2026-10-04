// `cnc-guide.md` is written for someone who owns a Makera Z1 and has never driven a
// CNC: it has to be true, and it has to say which parts are true *today*. The status
// lines carry that claim, and these four rules keep the guide honest mechanically
// (#210):
//
//   1. every diagnostic code the source can emit has a row in chapter 8;
//   2. every `##` / `###` section opens with a status line;
//   3. every "Planned" or "Partly available" status names an issue;
//   4. no issue named in a "Planned" status is closed — read offline from a checked-in
//      map, never the GitHub API.
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
const STATUS_MAP: { issues: Record<string, string> } = JSON.parse(
  readFileSync(join(ROOT, 'docs/cnc-guide-status.json'), 'utf8'),
);

const CAPTION = '*Design mockup — not the shipped screen.*';
const CHAPTER_8 = GUIDE.slice(GUIDE.indexOf('\n## 8 · '));

/** Every `.ts` under the given directories, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Every code the tree can raise.
 *
 * The engine emits them three ways, and a complete scan needs all three:
 *   - `code: 'kebab-case'` literals (`sweep.ts`, `engraveGeometry.ts`, `jobSetup.ts`, `fixture.ts`, `machine.ts`, `lexer.ts`);
 *   - `diag('severity', 'code', …)` calls, which in `interpreter.ts` frequently wrap
 *     onto several lines (hence `\s*` rather than spaces);
 *   - `warn(record, 'code', …)` calls in `setupFromHeader.ts`.
 *
 * `custom` is Zod's own issue code (`toolLibrary.ts`), not a diagnostic a user sees.
 */
function sourceCodes(): string[] {
  const codes = new Set<string>();
  const patterns = [
    /code:\s*'([a-z0-9-]+)'/g,
    /diag\(\s*'(?:error|warning|info)'\s*,\s*'([a-z0-9-]+)'/g,
    /warn\([^,()]+,\s*'([a-z0-9-]+)'/g,
  ];
  for (const dir of [join(APP, 'src/engine/cnc'), join(APP, 'src/workers')]) {
    for (const file of tsFiles(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const m of text.matchAll(pattern)) codes.add(m[1]!);
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

function plannedIssues(status: string): number[] {
  return [...status.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
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

  it('names an issue in every Planned or Partly available status', () => {
    for (const s of sections()) {
      if (/^> \*\*Status: (Planned|Partly available)\*\*/.test(s.status)) {
        expect(
          plannedIssues(s.status).length,
          `${s.heading} is not Available but names no issue (#N)`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('cnc-guide.md — a Planned issue is not silently closed', () => {
  it('has no issue named in a "Planned" status marked closed in docs/cnc-guide-status.json', () => {
    for (const s of sections()) {
      if (!/^> \*\*Status: Planned\*\*/.test(s.status)) continue;
      for (const n of plannedIssues(s.status)) {
        const state = STATUS_MAP.issues[String(n)];
        expect(
          state,
          `${s.heading} names #${n}, which is missing from docs/cnc-guide-status.json`,
        ).toBeDefined();
        expect(
          state,
          `${s.heading} still names #${n}, which is closed — flip the status or drop the issue`,
        ).not.toBe('closed');
      }
    }
  });
});

describe('cnc-guide.md — a mockup is never shown as the shipped screen', () => {
  it('captions every image, and keeps mockups out of Available sections', () => {
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
      if (line.startsWith('![')) {
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        // 1. the caption, verbatim
        expect(
          lines[j],
          `the image on line ${i + 1} must be captioned "${CAPTION}"`,
        ).toBe(CAPTION);
        // 2. never inside an Available section
        expect(
          statusByLine.get(i),
          `the image on line ${i + 1} is in a section marked Available (${current})`,
        ).toMatch(/^> \*\*Status: (Partly available|Planned)\*\*/);
      }
    }
  });
});
