/**
 * #1168 — THE BIT CHANGE, AS A CARD INSIDE STEP 3 (mockup 7's left card).
 *
 * Not a dialog, not a fold: the operator is standing at the machine and the one press they need is
 * on the screen where they are looking. The card is shown by the Cut surface for as long as the
 * release is paused between programs (`phase === 'bit-change'`).
 *
 * WHAT IT DOES IS WHAT THE EXPERT PANEL DOES. The press calls the same release action
 * (`confirmChange`) the release step's own button calls, so the lines that go out — the status
 * reads, the vacuum span and `play <file>` — are the same bytes; nothing new is sent and no new
 * sequence is invented. What the card adds is the reading: cap colour first, the bit to take out,
 * the collet answer, and two ticks that must both be given.
 *
 * THE TICK COUNTS AS THE BIT'S 'LOCATED' for this run (#1168): pressing writes the checklist entry
 * for the fit bit before the program starts, so the step-3 checklist and this card never disagree
 * about whether the operator has the bit in hand.
 */
import { useMemo, useState } from 'react';
import type { JSX } from 'react';

import { bitChangeCardFacts } from '@/engine/cnc/engrave/bitChangeCard';
import type { ReleaseRecord } from '@/store/engraveReleaseStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const MUTED = { color: '#9aa4b0' } as const;
const CHIP = {
  padding: '4px 8px',
  borderRadius: 6,
  background: '#1b2531',
  fontSize: 12,
  color: '#c9d4e2',
} as const;

export function CutBitChangeCard({
  record,
  onConfirm,
}: {
  record: ReleaseRecord;
  /** The same store action the release step's change panel calls (`confirmChange`). */
  onConfirm: () => void;
}): JSX.Element | null {
  const items = useToolRegistryStore((s) => s.items);
  const openManage = useManageModeStore((s) => s.openManage);
  const facts = useMemo(() => bitChangeCardFacts(record, items), [record, items]);
  const [bitIn, setBitIn] = useState(false);
  const [handsClear, setHandsClear] = useState(false);
  if (record.phase !== 'bit-change' || record.next === null || facts.sameCutter) return null;

  const ready = bitIn && handsClear;
  const press = (): void => {
    // The tick is the bit's 'located' for this run — before the program starts, so the checklist
    // and the card cannot disagree.
    const hash = record.job.package?.hash;
    if (hash !== undefined && hash !== '') {
      useEngraveJobStore
        .getState()
        .setCutterChecklistEntry(hash, facts.fit.toolKey, { state: 'located', at: new Date().toISOString() });
    }
    onConfirm();
  };

  return (
    <section
      data-testid="cut-bit-change-card"
      style={{ border: '1px solid #4f8ef7', borderRadius: 12, background: '#161d27', margin: '8px 0', display: 'flex', flexDirection: 'column' }}
    >
      <div
        data-testid="cut-bit-change-header"
        style={{ padding: '12px 14px', borderBottom: '1px solid #222c38', display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}
      >
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#152238', color: '#8ab4f8', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>
          3
        </span>
        <span style={{ flex: '1 1 auto' }}>
          <strong style={{ fontWeight: 600 }}>Cut</strong>{' '}
          <span style={MUTED}>
            · {facts.done} of {facts.total} done · bit change
          </span>
        </span>
        <span style={{ fontSize: 12, color: '#5fc27f' }}>machine homed · idle</span>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div
            data-testid="cut-bit-change-fit"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}
          >
            <span style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9aa4b8', fontWeight: 600 }}>
              Fit this bit for program {facts.nextIndex}
            </span>
            <span style={{ fontSize: 20, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              {facts.fit.colourHex !== null && (
                <span
                  data-testid="cut-bit-change-swatch"
                  aria-hidden="true"
                  style={{ width: 14, height: 14, borderRadius: 3, background: facts.fit.colourHex, display: 'inline-block' }}
                />
              )}
              <span data-testid="cut-bit-change-fit-name">
                {facts.fit.colourWord !== null ? `${facts.fit.colourWord} cap · ` : ''}
                {facts.fit.name}
              </span>
            </span>
            {facts.fit.printed !== null && (
              <span style={{ fontSize: 13 }} data-testid="cut-bit-change-printed">
                Printed on the tube: “{facts.fit.printed}”.
              </span>
            )}
            {facts.fit.chips.length > 0 && (
              <div data-testid="cut-bit-change-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {facts.fit.chips.map((chip) => (
                  <span key={chip} style={CHIP}>
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {facts.colourMissing !== null && (
              <span style={{ fontSize: 13, color: '#e0a84a' }} data-testid="cut-bit-change-colour-missing">
                The colour of the {facts.colourMissing.name} is not recorded —{' '}
                <button
                  type="button"
                  data-testid="cut-bit-change-colour-link"
                  onClick={() => openManage('tools')}
                  style={{ font: 'inherit', padding: 0, border: 0, background: 'none', color: '#8ab4f8', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  set it on the bit’s row
                </button>
                .
              </span>
            )}
            <span style={{ fontSize: 13, color: '#9aa4b8' }} data-testid="cut-bit-change-take-out">
              {facts.takeOut !== null ? (
                <>
                  Take out the{' '}
                  <strong style={{ fontWeight: 600, color: '#e6ebf1' }}>
                    {facts.takeOut.colourWord !== null ? `${facts.takeOut.colourWord.toLowerCase()} cap · ` : ''}
                    {facts.takeOut.name}
                  </strong>{' '}
                  first. {facts.colletLine ?? ''}
                </>
              ) : (
                facts.colletLine ?? 'Fit the bit before the next program.'
              )}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
          <div
            data-testid="cut-bit-change-facts"
            style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: '#173224', color: '#c9f0d4' }}
          >
            <span style={{ color: '#5fc27f' }}>✓</span> {facts.facts.join(' · ')}
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
            <input
              type="checkbox"
              data-testid="cut-bit-change-tick-in"
              checked={bitIn}
              onChange={(e) => setBitIn(e.target.checked)}
            />
            {facts.fit.colourWord !== null ? `The ${facts.fit.colourWord.toLowerCase()} cap · ${facts.fit.name}` : `The ${facts.fit.name}`} is in and the collet nut is tight
          </label>
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: '#1b2531' }}>
            <input
              type="checkbox"
              data-testid="cut-bit-change-tick-hands"
              checked={handsClear}
              onChange={(e) => setHandsClear(e.target.checked)}
            />
            Hands out, door closed, the blank has not moved
          </label>
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            data-testid="cut-bit-change-go"
            disabled={!ready}
            onClick={press}
            style={{ padding: 12, borderRadius: 8, border: 0, background: ready ? '#4f8ef7' : '#2b3f63', color: ready ? '#0b1220' : '#9fb6da', font: 'inherit', fontWeight: 600, fontSize: 15 }}
          >
            Measure the bit and run program {facts.nextIndex} of {facts.total}
          </button>
          <span style={{ fontSize: 12, color: '#9aa4b8' }} data-testid="cut-bit-change-note">
            The machine measures the bit at its sensor and records it as tool {facts.nextIndex} itself, so the
            program’s tool line is a formality. Vacuum and air go on with the first move.
          </span>
        </div>
      </div>
    </section>
  );
}
