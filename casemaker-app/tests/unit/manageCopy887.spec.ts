/**
 * #887 — NO INTERNAL WORDS IN THE MANAGE AREA'S TEXT.
 *
 * The maintainer: "users dont know what a rail is." The side panel used to say "Nothing is edited
 * on this rail…", and other copy named a record, a claim, a ledger — the app's own vocabulary for
 * its bookkeeping, not anything the person using it configured. This lint reads the Manage
 * components' USER-VISIBLE text (quoted strings with a space in them, and JSX text) with comments
 * stripped, and fails on the banned words. It is deliberately about the words a person reads; an
 * identifier called `record` in code is not a sentence.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { timeOfDayWords } from '@/components/manage/display';

const COMPONENTS = join(process.cwd(), 'src', 'components');
const DIR = join(COMPONENTS, 'manage');
const BANNED = ['rail', 'write', 'record', 'claim', 'seam', 'ledger'];
/**
 * #1207 — the accepted All values copy names the shop's own copy of a value "this shop's record"
 * (it replaced the file name `location.json`). That is the analyst's approved OPERATOR wording, so
 * a sentence carrying that phrase is not an offender; "record" stays banned in every other
 * sentence.
 */
const SHOP_RECORD = /shop(?:’|')s record|\bshop record\b/i;
/**
 * #887 — a raw registry id is never text a person reads: `cat:<uuid>` (a catalogue row),
 * `user:<id>` (their own addition) and `inv:<id>` (an inventory row) are keys. The Cut panel
 * printed `program 1 (cat:019c049a-…)` after a simulation stopped; this is the rule that fails on
 * the class, wherever a component draws a sentence, not only in Manage.
 */
const RAW_ID = /\b(?:cat|user|inv):[0-9a-z][0-9a-z-]{5,}/i;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** The user-visible text a file carries: quoted strings with a space in them, and JSX text. */
export /** A sentence, not a code fragment: operators in the text mean the pattern crossed expressions. */
function sentenceLike(text: string): boolean {
  return /\s/.test(text) && /[a-z]/i.test(text) && !/[=;{}]/.test(text);
}

function visibleText(src: string): string[] {
  const out: string[] = [];
  // Single-line quotes: a literal cannot span a line break in this codebase's UI text, and
  // letting the pattern cross lines swallowed whole expressions between two quotes.
  for (const m of src.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const text = m[2]!;
    if (sentenceLike(text)) out.push(text);
  }
  // Template literals may span lines; their `${…}` is code, not text.
  for (const m of src.matchAll(/`((?:\\.|[^\\`])*)`/g)) {
    const text = m[1]!.replace(/\$\{[^}]*\}/g, ' ');
    if (sentenceLike(text)) out.push(text);
  }
  for (const m of src.matchAll(/>([^<>{}]+)</g)) {
    const text = m[1]!.trim();
    if (text.length > 0 && sentenceLike(text)) out.push(text);
  }
  return out;
}

describe('#887 — the Manage area’s visible text', () => {
  it('never says rail, write, record, claim, seam or ledger, nor “profile id”', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.tsx'))) {
      const text = visibleText(stripComments(readFileSync(join(DIR, file), 'utf8')));
      for (const s of text) {
        for (const word of BANNED) {
          if (word === 'record' && SHOP_RECORD.test(s)) continue;
          if (new RegExp(`\\b${word}\\b`, 'i').test(s)) offenders.push(`${file}: "${s.trim()}" (${word})`);
        }
        if (/profile id/i.test(s)) offenders.push(`${file}: "${s.trim()}" (profile id)`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/** Every component file under `dir`, recursively — the lint's own scope, not one folder. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('#887 — raw ids', () => {
  it('no component renders a registry id (cat:, user:, inv:)', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(COMPONENTS)) {
      const text = visibleText(stripComments(readFileSync(file, 'utf8')));
      for (const s of text) {
        if (RAW_ID.test(s)) offenders.push(`${relative(COMPONENTS, file)}: "${s.trim()}"`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('#887 — saying a time', () => {
  it('says today and yesterday in words, and a date only when older', () => {
    const now = new Date('2026-11-01T15:00:00');
    expect(timeOfDayWords(new Date('2026-11-01T14:17:00').toISOString(), now)).toBe('14:17 today');
    expect(timeOfDayWords(new Date('2026-10-31T09:02:00').toISOString(), now)).toBe('yesterday 09:02');
    expect(timeOfDayWords(new Date('2026-10-29T08:05:00').toISOString(), now)).toBe('2026-10-29 08:05');
    expect(timeOfDayWords(null, now)).toBeNull();
    expect(timeOfDayWords('not-a-date', now)).toBeNull();
  });
});
