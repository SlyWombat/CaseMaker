import { describe, it, expect } from 'vitest';
import { DOCS, findDoc } from '@/docs';

describe('docs registry', () => {
  it('exposes the five core documents', () => {
    const ids = DOCS.map((d) => d.id);
    expect(ids).toEqual([
      'getting-started',
      'user-manual',
      'technical-reference',
      'changelog',
      'contributing',
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

  it('Getting Started mentions port 8000', () => {
    const gs = findDoc('getting-started')!;
    expect(gs.source).toContain('8000');
  });

  it('Technical Reference includes Module API section', () => {
    const tr = findDoc('technical-reference')!;
    expect(tr.source).toMatch(/##\s+Module API/);
  });

  it('findDoc returns undefined for unknown ids', () => {
    expect(findDoc('does-not-exist')).toBeUndefined();
  });
});
