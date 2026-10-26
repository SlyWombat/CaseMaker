/**
 * #681 — step 2 of the one cutting-job wizard: the stock.
 *
 * The step's questions and every rule stay with `StartStockStep` (and the engine behind it); this
 * wrapper adds the two starter templates the app already shipped and gives wave 2's stock-step
 * slice (#683) one file to rewrite. The templates are NOT a second flow: choosing one answers this
 * step and the wizard keeps its counter, exactly as picking a shelf piece does.
 */

import type { JSX } from 'react';
import { findTemplateAcrossSources } from '@/library/templateRegistry';
import { StartStockStep, type PendingStock, type StartStockSeed } from './StartStockStep';

/**
 * Step 2's project types: ONLY what the CNC cuts (#346 — "no way a rack mount is being carved").
 * The printed archetypes (protective case, mini rack, tool insert, toolbox) have the welcome
 * screen; a cutting job is a blank. Each id is an existing template — nothing here invents a
 * second way to make a project, and a spec that is renamed or missing simply drops out of the
 * list rather than breaking the wizard.
 */
const JOB_TYPE_IDS = ['badge-blank', 'blank'] as const;

const MUTED = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' } as const;

export interface StockStepProps {
  /** The job's own stock when the step is re-opened to edit it (#681). */
  seed?: StartStockSeed;
  onPending: (pending: PendingStock | null) => void;
  /** A starter template: its blank becomes the stock and its item the job's first operation. */
  onTemplate: (id: string) => void;
}

export function StockStep({ seed, onPending, onTemplate }: StockStepProps): JSX.Element {
  const jobTypes = JOB_TYPE_IDS.map((id) => findTemplateAcrossSources(id)).filter(
    (t): t is NonNullable<typeof t> => t !== undefined,
  );

  return (
    <>
      <StartStockStep onChange={onPending} seed={seed} />
      <div data-testid="start-wizard-step-job" style={{ marginTop: 10, borderTop: '1px solid #2a2f36', paddingTop: 6 }}>
        <p style={MUTED}>
          Or start from a template — its blank becomes the stock, and the setup asks the rest.
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {jobTypes.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                data-testid={`start-wizard-job-${t.id}`}
                style={{ width: '100%', textAlign: 'left', padding: 6 }}
                onClick={() => onTemplate(t.id)}
              >
                <div style={{ fontSize: 12, color: '#cfe' }}>{t.name}</div>
                <div style={MUTED}>{t.description}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
