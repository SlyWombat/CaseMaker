/**
 * #1261 — THE GATE: no personal data in tracked files.
 *
 * Two kinds of line fail the suite: a Windows (or WSL-mounted) user-profile path that names a
 * real account, and an e-mail address outside the short list of non-personal ones. The text is
 * never printed back in a failure (file and line only), so a failing run does not republish what
 * it found.
 *
 * Out of scope on purpose: the licence texts that must stay byte-exact (NOTICE and the Windows
 * installer's licence file), lock files, and binary files. History is not rewritten; this gate
 * keeps the tree clean from here on.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(process.cwd(), '..');

const EXEMPT_FILES = new Set([
  'NOTICE',
  'casemaker-app/src-tauri/windows/license.txt',
  'casemaker-app/package-lock.json',
  'casemaker-app/src-tauri/Cargo.lock',
]);

/** `C:\Users\<name>`, `C:\\Users\\<name>` (JSON-escaped) or `/mnt/c/Users/<name>`. */
const PROFILE_PATH = /(?:[A-Za-z]:\\{1,2}|\/mnt\/[a-z]\/)Users[\\/]+([^\\/\s"'`<>]+)/g;
/** A name that is a placeholder or a system profile, not an account. */
const PLACEHOLDER = /^(?:<[^>]*>|\*|…|\.{3}|%[A-Za-z]+%|Public|Default|Default User|All Users)$/;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/** Domains whose addresses are not personal: reserved, no-reply, or a third party's public contact. */
const EMAIL_DOMAIN_OK = /^(?:example\.(?:com|org|net|invalid)|[a-z0-9.-]*\.invalid|users\.noreply\.github\.com|anthropic\.com|electricrv\.ca|grabcad\.com|grid\.space)$/i;
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|svg|avif|css|js|ts|mjs|woff2?)$/i;

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p && !EXEMPT_FILES.has(p));
}

function findings(): string[] {
  const hits: string[] = [];
  for (const rel of trackedTextFiles()) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(REPO, rel));
    } catch {
      continue; // a tracked file deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PROFILE_PATH)) {
        if (!PLACEHOLDER.test(m[1] ?? '')) hits.push(`${rel}:${i + 1} profile path`);
      }
      for (const m of line.matchAll(EMAIL)) {
        const domain = m[1] ?? '';
        if (IMAGE_SUFFIX.test(domain) || EMAIL_DOMAIN_OK.test(domain)) continue;
        hits.push(`${rel}:${i + 1} e-mail address`);
      }
    });
  }
  return hits;
}

describe('#1261 no personal data in tracked files', () => {
  it('no tracked file names a real user profile or carries a personal e-mail address', () => {
    expect(findings()).toEqual([]);
  });

  it('the patterns do catch what they are for', () => {
    // Built from pieces so that this file does not itself contain what the gate looks for.
    const name = ['Some', 'one'].join('');
    const win = ['C:', 'Users', name, 'AppData'].join('\\');
    const wsl = ['/mnt/c', 'Users', name, 'Documents'].join('/');
    const json = ['C:', 'Users', name, 'AppData'].join('\\\\');
    for (const s of [win, wsl, json]) {
      const m = [...s.matchAll(PROFILE_PATH)];
      expect(m.length).toBe(1);
      expect(PLACEHOLDER.test(m[0]?.[1] ?? '')).toBe(false);
    }
    expect(PLACEHOLDER.test('<user>')).toBe(true);
    expect(PLACEHOLDER.test('Public')).toBe(true);
    const e = [...[name, '@', 'personal', '.test'].join('').matchAll(EMAIL)];
    expect(EMAIL_DOMAIN_OK.test(e[0]?.[1] ?? '')).toBe(false);
    expect(EMAIL_DOMAIN_OK.test('users.noreply.github.com')).toBe(true);
  });
});
