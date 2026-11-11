// #1123-48 (analyst's ruling on the land18 walk, row 2a) — THE CONTINUE LINE'S WORDS.
// `<name> · <what> · changed <when>`, plus ` · not saved to a file yet` for a job never saved to a
// file. `<when>` is relative to now: under a minute "just now"; under an hour "N min ago"; under a
// day "N h ago"; the previous calendar day "yesterday"; older "9 Nov".
import { describe, it, expect } from 'vitest';
import { relativeWhen, continueLine } from '@/components/welcome/continueLine';

// Local-time constructor so the calendar-day rules do not depend on the machine's zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number => new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 11, 11, 9, 30);

describe('relativeWhen', () => {
  it('says "just now" under a minute', () => {
    expect(relativeWhen(NOW, NOW)).toBe('just now');
    expect(relativeWhen(NOW - 59_000, NOW)).toBe('just now');
  });
  it('counts minutes under an hour', () => {
    expect(relativeWhen(NOW - 60_000, NOW)).toBe('1 min ago');
    expect(relativeWhen(NOW - 12 * 60_000, NOW)).toBe('12 min ago');
    expect(relativeWhen(NOW - 59 * 60_000, NOW)).toBe('59 min ago');
  });
  it('counts hours under a day', () => {
    expect(relativeWhen(NOW - 60 * 60_000, NOW)).toBe('1 h ago');
    expect(relativeWhen(NOW - 9 * 3_600_000, NOW)).toBe('9 h ago');
    expect(relativeWhen(NOW - 23 * 3_600_000 - 59 * 60_000, NOW)).toBe('23 h ago');
  });
  it('says "yesterday" for the previous calendar day beyond 24 h', () => {
    expect(relativeWhen(at(2026, 11, 10, 8, 0), NOW)).toBe('yesterday'); // 25.5 h ago
    expect(relativeWhen(at(2026, 11, 10, 0, 5), NOW)).toBe('yesterday');
  });
  it('gives older changes as day and short month', () => {
    expect(relativeWhen(at(2026, 11, 9, 12), NOW)).toBe('9 Nov');
    expect(relativeWhen(at(2026, 1, 2), NOW)).toBe('2 Jan');
    expect(relativeWhen(at(2025, 12, 31, 23), NOW)).toBe('31 Dec');
  });
  it('treats a clock that ran backwards as just now', () => {
    expect(relativeWhen(NOW + 5 * 60_000, NOW)).toBe('just now');
  });
});

describe('continueLine', () => {
  it('names the job, what it is and when it changed, and that it was never saved to a file', () => {
    expect(
      continueLine({ name: 'Untitled job', what: 'a CNC job', changedAt: NOW - 12 * 60_000, savedToFile: false, now: NOW }),
    ).toBe('Untitled job · a CNC job · changed 12 min ago · not saved to a file yet');
  });
  it('drops the unsaved clause once the job is saved to a file', () => {
    expect(
      continueLine({ name: 'Tray', what: 'a CNC job', changedAt: NOW - 3 * 3_600_000, savedToFile: true, now: NOW }),
    ).toBe('Tray · a CNC job · changed 3 h ago');
  });
  it('a project has no file clause and an unknown change time leaves the "changed" part out', () => {
    expect(continueLine({ name: 'Pi case', what: 'a project', changedAt: NOW - 60_000, savedToFile: null, now: NOW })).toBe(
      'Pi case · a project · changed 1 min ago',
    );
    expect(continueLine({ name: 'Pi case', what: 'a project', changedAt: null, savedToFile: null, now: NOW })).toBe('Pi case · a project');
  });
});
