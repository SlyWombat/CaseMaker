// @vitest-environment jsdom
// #1109 — the copy pass's first rule: help is VISIBLE, not a hover title, and every glossary term
// the steps use has its plain line. The checked-in list is the test's source, so a new term without
// an entry fails here.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { OperationPicker } from '@/components/panels/OperationPicker';
import { OPERATION_TYPES } from '@/components/panels/operationTypes';
import { GLOSSARY } from '@/components/welcome/glossary';

const APPROVED_TERMS = [
  'v-carve',
  'variable-depth',
  'inlay',
  'prism',
  'flute',
  'texture',
  'medial-axis',
  'relief',
  'gerber',
  'boss',
  'helixed',
  'simulate-only',
  'proud',
  'jaw-ledge',
  'stick-out',
  'neck-for-parting',
  'self-centring-scroll',
  'run-out',
  'anchor-1',
  'reverse-teeth',
  'broadcasts',
  'recorded-address',
  'homed',
  'house-stock',
] as const;

afterEach(() => cleanup());

describe('#1109 the copy pass', () => {
  it('renders every operation blurb as visible text, not as a title', () => {
    render(<OperationPicker mode="select" testidFor={(id) => `chip-${id}`} onPick={() => undefined} surfaceAllowed />);
    for (const type of OPERATION_TYPES) {
      const chip = screen.getByTestId(`chip-${type.id}`);
      expect(chip.getAttribute('title'), `${type.id} title-only help`).toBeNull();
      expect(chip.textContent, `${type.id} blurb`).toContain(type.blurb);
    }
  });

  it('the glossary covers the approved term list', () => {
    for (const term of APPROVED_TERMS) {
      expect(GLOSSARY, term).toHaveProperty(term);
      expect(GLOSSARY[term].length, term).toBeGreaterThan(3);
    }
  });

  it('the boss is the raised post or stud, not a pocket island', () => {
    expect(GLOSSARY.boss).toContain('raised post or stud');
    expect(GLOSSARY.boss).not.toContain('island');
  });
});
