// @vitest-environment jsdom
// #1178 — NO STORE SELECTOR MAY BUILD A FRESH SNAPSHOT. zustand v5 + React 19 read a store through
// `useSyncExternalStore`, whose getSnapshot must be STABLE between store changes. A selector that
// returns a new object/array per call (a literal, or `?? []` / `?? {}`) is React's "The result of
// getSnapshot should be cached to avoid an infinite loop", and the first store change then
// re-renders forever. The fix is the store's own reference, a module-level EMPTY, or `useShallow`
// where a derived object is genuinely needed (LiveSwath, #1141).
//
// Two guards:
//  1. A source scan of `src/` — every `use*Store(...)` call's selector must not return a fresh
//     literal or fall back to `[]` / `{}`. `useShallow(...)`-wrapped selectors and calls with an
//     equality second argument are exempt (that is the sanctioned shape).
//  2. Renders under a changing store: the two components that had the bad selectors take five
//     location-store ticks without looping (a loop throws React's "Maximum update depth exceeded"
//     from inside act, so the loop completing IS the assertion — the LiveSwath pattern).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocationCard } from '@/components/manage/LocationCard';
import { BedWizard } from '@/components/bed-wizard/BedWizard';
import { LocationViewSchema } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { useBedWizardStore } from '@/store/bedWizardStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../src');

const VIEW = LocationViewSchema.parse(
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')),
);

afterEach(cleanup);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The text inside the parentheses that open at `open`, with strings/comments skipped. */
function callText(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** The selector part of a hook call: before a top-level comma (a second arg is an equality fn). */
function selectorOf(call: string): string | null {
  const trimmed = call.trim();
  if (trimmed.startsWith('useShallow(')) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < call.length; i++) {
    const ch = call[i]!;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return call.slice(0, i);
  }
  return call;
}

const FRESH: { name: string; re: RegExp }[] = [
  { name: 'returns a fresh object literal', re: /=>\s*\(\s*\{/ },
  { name: 'returns a fresh array literal', re: /=>\s*\(\s*\[/ },
  { name: 'returns a fresh array literal', re: /=>\s*\[/ },
  { name: 'returns a fresh object literal', re: /\breturn\s*\{/ },
  { name: 'returns a fresh array literal', re: /\breturn\s*\[/ },
  { name: 'falls back to a fresh array', re: /\?\?\s*\[\s*\]/ },
  { name: 'falls back to a fresh object', re: /\?\?\s*\{\s*\}/ },
  { name: 'falls back to a fresh array', re: /\|\|\s*\[\s*\]/ },
  { name: 'falls back to a fresh object', re: /\|\|\s*\{\s*\}/ },
];

describe('#1178 the store-selector guard', () => {
  it('no selector builds a fresh snapshot', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const hook = /\buse[A-Z]\w*Store\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = hook.exec(source)) !== null) {
        const open = source.indexOf('(', match.index);
        const call = callText(source, open);
        if (call === null) continue;
        const selector = selectorOf(call);
        if (selector === null) continue;
        const line = source.slice(0, match.index).split('\n').length;
        for (const rule of FRESH) {
          if (rule.re.test(selector)) {
            violations.push(`${relative(SRC, file)}:${line} — ${rule.name}: ${selector.trim().split('\n')[0]}`);
          }
        }
      }
    }
    expect(violations, `unstable store selectors:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe('#1178 render under a changing store', () => {
  it('the location card takes five location-store ticks with no location, without a fresh snapshot', () => {
    resetLocationStore();
    useLocationStore.setState({ location: null });
    render(<LocationCard location={VIEW} writeNote={null} />);
    for (let i = 1; i <= 5; i++) {
      // A looping getSnapshot throws "Maximum update depth exceeded" inside act; settling is the proof.
      act(() => {
        useLocationStore.setState({ etag: `e${i}` });
      });
    }
    expect(useLocationStore.getState().etag).toBe('e5');
  });

  it('the bed wizard takes five location-store ticks while the location is being read', () => {
    resetLocationStore();
    useBedWizardStore.setState({ open: true, machineId: VIEW.machines[0]!.id, session: 1 });
    useLocationStore.setState({ location: null });
    render(<BedWizard />);
    for (let i = 1; i <= 5; i++) {
      act(() => {
        useLocationStore.setState({ etag: `e${i}` });
      });
    }
    expect(useLocationStore.getState().etag).toBe('e5');
  });
});
