import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, findDoc } from '@/docs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('docs registry', () => {
  it('exposes the seven core documents', () => {
    const ids = DOCS.map((d) => d.id);
    // Order matches DocsModal nav (#74): User Manual is the in-app default,
    // so it leads the list. The reader's own docs (User Manual, Getting
    // Started, Changelog) come first; the three "For developers" docs —
    // building from source, the module map, and contributing — follow as one
    // group (#880). The CNC guide is present because `__FEATURE_SIM__` is
    // true in the vitest config; it is withheld from the public build.
    expect(ids).toEqual([
      'user-manual',
      'getting-started',
      'changelog',
      'developers',
      'technical-reference',
      'contributing',
      'cnc-guide',
    ]);
  });

  it('every doc has a non-empty markdown source', () => {
    for (const d of DOCS) {
      expect(d.source.length).toBeGreaterThan(100);
      expect(d.source).toMatch(/^#\s+/m);
    }
  });

  it('User Manual contains the parameter dictionary table header', () => {
    const um = findDoc('user-manual')!;
    expect(um.source).toContain('| Parameter | Default |');
  });

  it('For developers mentions port 8000', () => {
    const dev = findDoc('developers')!;
    expect(dev.source).toContain('8000');
  });

  it('Technical Reference includes Module API section', () => {
    const tr = findDoc('technical-reference')!;
    expect(tr.source).toMatch(/##\s+Module API/);
  });

  it('findDoc returns undefined for unknown ids', () => {
    expect(findDoc('does-not-exist')).toBeUndefined();
  });
});

describe('the CNC planner’s 64-bit browser requirement is stated', () => {
  // #1124 — the bench died at the ball rank in a 32-bit Chrome under Windows ARM64 emulation.
  // The operator needs the requirement where they choose a browser, and the remedy for the one
  // platform where a 32-bit build is the common default.
  it('deployment and getting-started each name the requirement, Edge on Windows ARM and the check', () => {
    const texts = {
      deployment: readFileSync(join(ROOT, 'casemaker-app/src/docs/deployment.md'), 'utf8'),
      'getting-started': findDoc('getting-started')!.source,
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(text, `${name} must name a 64-bit browser`).toMatch(/64-bit browser/i);
      expect(text, `${name} must name Edge on Windows on ARM`).toMatch(/Edge/);
      expect(text, `${name} must say Windows on ARM`).toMatch(/Windows on ARM/i);
      expect(text, `${name} must name chrome://version as the check`).toMatch(/chrome:\/\/version/);
    }
  });
});
