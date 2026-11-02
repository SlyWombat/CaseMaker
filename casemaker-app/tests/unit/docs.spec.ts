import { describe, it, expect } from 'vitest';
import { DOCS, findDoc } from '@/docs';

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
