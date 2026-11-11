// #1109 rule 3 — ONE COMPONENT SET. The machine step's action buttons wear `sw-btn`; a fold toggle
// is not an action and says `data-fold`. A new raw button without either fails here, so the next
// control added to the step cannot quietly keep its own styling.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('#1109 the wizard’s component set', () => {
  it('every action button in the machine step wears sw-btn; a fold says data-fold', () => {
    const source = readFileSync(join(HERE, '../../src/components/welcome/MachineStep.tsx'), 'utf8');
    const buttons = source.match(/<button\b[\s\S]*?>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) {
      if (/data-fold="true"/.test(tag)) continue;
      expect(tag, `raw <button> without sw-btn:\n${tag}`).toContain('className="sw-btn');
    }
  });
});
