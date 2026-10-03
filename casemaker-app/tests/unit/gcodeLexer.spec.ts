// Lexing for the Z1's G-code dialect (#174).
//
// Every fixture here is HAND-WRITTEN. Makera's sample corpus is GPL-3.0 / unlicensed and
// is never committed (#186); a 20-line fixture of our own is both legally clean and a
// better test than a file nobody reads. Each case pins one dialect fact from
// /Z1-Firmware-Dialect.md, and says which.

import { describe, it, expect } from 'vitest';
import { splitCommands, stripComment, parseWords, classifyLine, splitLines } from '@/engine/cnc/gcode/lexer';
import type { Diagnostic } from '@/engine/cnc/gcode/types';
import { parseMkrRecord, mkrNumber } from '@/engine/cnc/gcode/mkrHeader';

const words = (s: string) => {
  const d: Diagnostic[] = [];
  const w = parseWords(s, 1, d);
  return { w: w.map((x) => `${x.letter}${x.text}`), d };
};

describe('splitCommands: the dispatcher cuts by LETTER, not whitespace (§1)', () => {
  it.each([
    ['T1M6', ['T1M6']], // T is a parameter of M6: ONE command
    ['T1 M6', ['T1 M6']],
    ['M3 S12000', ['M3 S12000']], // S is a parameter of M3
    ['G1X0.1F2000S0.8', ['G1X0.1F2000S0.8']], // LightBurn laser line: S rides along
    ['G00G53Z-3', ['G00', 'G53Z-3']], // no whitespace at all
    ['G0 X5 S12000 M3', ['G0 X5 ', 'S12000 M3']], // G + S + M on one line
    ['G90 G0 G53 Z-3', ['G90 ', 'G0 ', 'G53 Z-3']],
    ['M5 M9', ['M5 ', 'M9']],
  ])('%s', (line, expected) => {
    expect(splitCommands(line)).toEqual(expected);
  });

  it('is total: it terminates on any G/M/T/S-led input', () => {
    for (const s of ['G', 'M', 'T', 'S', 'GG', 'GMGMGM', 'T1T2T3', 'S1S2M3M4G5']) {
      const out = splitCommands(s);
      expect(out.join('')).toBe(s); // nothing is lost or invented
    }
  });
});

describe('stripComment: a "(" comment swallows the rest of the line (§6)', () => {
  it('cuts at the first ; or (', () => {
    expect(stripComment('G1 X5 ; note').code).toBe('G1 X5 ');
    expect(stripComment('G1 X5 (note)').code).toBe('G1 X5 ');
  });
  it('reports text after a ")" that RS274 would have executed but the firmware discards', () => {
    const r = stripComment('G0 (hop) X5');
    expect(r.code).toBe('G0 ');
    expect(r.droppedAfterParen).toBe('X5');
  });
  it('does not call a trailing comment "dropped text"', () => {
    expect(stripComment('G0 (a) (b)').droppedAfterParen).toBeNull();
    expect(stripComment('G0 (a) ; b').droppedAfterParen).toBeNull();
  });
  it('flags an unterminated paren', () => {
    expect(stripComment('G0 (oops').unterminatedParen).toBe(true);
  });
  it('handles an empty comment mid-line, as in `T1 M06()`', () => {
    expect(stripComment('T1 M06()').code).toBe('T1 M06');
  });
});

describe('classifyLine (§6)', () => {
  it('a lowercase first letter is a CONSOLE command, ignored by the G-code dispatcher', () => {
    expect(classifyLine('echo hello')).toEqual({ kind: 'shell', echo: true });
    expect(classifyLine('g1 x5')).toEqual({ kind: 'shell', echo: false });
    expect(classifyLine('$H')).toEqual({ kind: 'shell', echo: false });
  });
  it('recognises header, comment, percent and blank lines', () => {
    expect(classifyLine(';@MKR|BEGIN')).toEqual({ kind: 'comment', header: true });
    expect(classifyLine('; plain')).toEqual({ kind: 'comment', header: false });
    expect(classifyLine('(plain)')).toEqual({ kind: 'comment', header: false });
    expect(classifyLine('%')).toEqual({ kind: 'percent' });
    expect(classifyLine('   \t')).toEqual({ kind: 'blank' });
  });
  it('splits CRLF, LF and bare CR', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('parseWords: STRICTER than the firmware (§7)', () => {
  it('whitespace between words is optional', () => {
    expect(words('G1X0.1F2000S0.8').w).toEqual(['G1', 'X0.1', 'F2000', 'S0.8']);
  });
  it('accepts a trailing decimal point and a leading one', () => {
    expect(words('X6. Y.5 Z-.25').w).toEqual(['X6.', 'Y.5', 'Z-.25']);
    expect(words('X6.').d).toEqual([]);
  });
  it.each(['X1e61', 'X1E5', 'X-2.5e+3'])('REFUSES an exponent (%s): the firmware strtof would accept it', (src) => {
    const { d } = words(src);
    expect(d.some((x) => x.code === 'bad-number' && x.severity === 'error')).toBe(true);
  });
  it.each(['XNAN', 'Xinf', 'X-INFINITY'])('REFUSES %s, as ONE error (its letters do not cascade)', (src) => {
    const { d } = words(src);
    expect(d.filter((x) => x.code === 'bad-number')).toHaveLength(1);
    expect(d).toHaveLength(1);
  });
  it('does NOT mistake `G0X5` for a hex literal (it is on nearly every line of a real program)', () => {
    expect(words('G0X5').w).toEqual(['G0', 'X5']);
    expect(words('G0X5').d).toEqual([]);
  });
  it('refuses a letter with no number, and still parses what follows ("YY20" is not Y20)', () => {
    const { w, d } = words('YY20');
    expect(d.some((x) => x.code === 'stray-text')).toBe(true);
    expect(w).toEqual(['Y20']); // the second Y is a legitimate word; the first is the error
  });
  it('an exponent does not poison the rest of the command', () => {
    expect(words('X1e5 Y7').w).toEqual(['Y7']);
  });
});

describe('parseWords: trailing text is ONE warning per run, not one error per character (#174 review)', () => {
  it('a `#` remark is a single warning', () => {
    const { w, d } = words('M332 # close the dust collector');
    expect(w).toEqual(['M332']);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', code: 'ignored-text' });
  });
  it('non-ASCII remark text is one warning', () => {
    const { d } = words('M331 # 打开自动开集尘');
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe('warning');
  });
  it('a lowercase word that LOOKS meant is an error (the firmware silently drops it)', () => {
    const { d } = words('G1 x5');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'error', code: 'lowercase-word' });
  });
});

describe(';@MKR| header records', () => {
  it('splits tag and fields, and only the FIRST "=" splits a field', () => {
    const r = parseMkrRecord(';@MKR|TOOL|number=1|name=3.175*M4=odd|type=Flat End', 7);
    expect(r).toEqual({
      tag: 'TOOL',
      line: 7,
      fields: { number: '1', name: '3.175*M4=odd', type: 'Flat End' },
    });
  });
  it('keeps a field with no "=" visible rather than dropping it', () => {
    expect(parseMkrRecord(';@MKR|BEGIN|loose', 1)?.fields).toEqual({ loose: '' });
  });
  it('is not fooled by non-records or an empty tag', () => {
    expect(parseMkrRecord('; just a comment', 1)).toBeNull();
    expect(parseMkrRecord(';@MKR|', 1)).toBeNull();
  });
  it('interprets nothing: ORIGIN is carried as written (the semantics are a hypothesis)', () => {
    const r = parseMkrRecord(';@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=2.5', 1)!;
    expect(r.fields['type_name']).toBe('topFrontLeft');
    expect(mkrNumber(r, 'x')).toBe(-50);
    expect(mkrNumber(r, 'missing')).toBeNull();
    expect(mkrNumber({ ...r, fields: { x: 'abc' } }, 'x')).toBeNull();
  });
});
