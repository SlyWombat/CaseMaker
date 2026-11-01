// #894 — NO DEAD PRESSES AND NO GENERIC LABEL. On k3 the Cut panel's simulation-budget line ended
// in "Open the control", and the press did nothing: the fix it carried named no target the Cut
// panel has (the retry lives on Simulate). This enumerates every finding code that carries a fix
// and asserts the fix has a real name for something the panel showing it can open.
import { describe, expect, it } from 'vitest';

import {
  HOLD_FIX_CODES,
  PROGRAM_DEFECT_CODES,
  findingFix,
  fixActionLabel,
  fixIsOffered,
  type PanelFix,
} from '@/components/panels/findingFix';

/** Codes with their own rule, beside the two families the module keeps as sets. */
const NAMED_CODES = [
  'rotary-stock',
  'tool-missing',
  'cutter-substituted',
  'no-items',
  'goal-object-too-tall',
  'facing-too-deep',
  'vise-too-tall',
  'setup-out-of-stock',
  'sacrificial-missing',
  'side-strip-thin',
  'strip-too-narrow',
  'under-cut',
  'sweep-budget-exceeded',
];

/** The fix names something a panel can actually open or focus — the "does something" half. */
function namesATarget(fix: PanelFix): boolean {
  return (
    fix.openSection !== undefined ||
    fix.openWizardStep !== undefined ||
    fix.itemId !== undefined ||
    fix.focusTestid !== undefined ||
    fix.openDetails !== undefined
  );
}

describe('#894 — every fix a finding can carry is a real press', () => {
  it('a program defect of ours offers no press at all', () => {
    for (const code of PROGRAM_DEFECT_CODES) {
      expect(findingFix({ code }), code).toBeNull();
    }
  });

  it('every code that carries a fix names what it opens, and never “Open the control”', () => {
    const codes = [...HOLD_FIX_CODES, ...NAMED_CODES, 'an-item-finding'];
    for (const code of codes) {
      // `labelId` is the item row's own id: the majority of item-level findings carry one.
      const fix = findingFix({ code, labelId: code === 'an-item-finding' ? 'row-1' : undefined });
      expect(fix, code).not.toBeNull();
      const label = fixActionLabel(fix!);
      expect(label, code).not.toBeNull();
      expect(label, code).not.toBe('Open the control');
      expect(namesATarget(fix!), code).toBe(true);
      expect(fixIsOffered(fix), code).toBe(true);
    }
  });

  it('a code this panel has no target for renders no press, rather than a dead one', () => {
    const fix = findingFix({ code: 'a-code-no-rule-covers' });
    // The finding still lands on the Job group (its row states it)…
    expect(fix).not.toBeNull();
    // …but there is no control to open, so no press is offered.
    expect(fixActionLabel(fix!)).toBeNull();
    expect(fixIsOffered(fix)).toBe(false);
    expect(fixIsOffered(null)).toBe(false);
  });

  it('#894 item 3 — the simulation budget stop opens Simulate by name', () => {
    const fix = findingFix({ code: 'sweep-budget-exceeded' })!;
    expect(fix.openSection).toBe('cnc-sim');
    expect(fixActionLabel(fix)).toBe('Open Simulate');
  });
});
