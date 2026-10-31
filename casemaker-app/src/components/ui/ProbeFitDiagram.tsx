import type { JSX } from 'react';
import {
  PROBE_FIT_ALL,
  PROBE_FIT_LINE,
  PROBE_FIT_WIRED_LINE,
  probeFitDiagramSvg,
  type ProbeFitDiagramSize,
  type ProbeFitInstrument,
} from '@/engine/cnc/probeFitDiagram';

/**
 * #788 — the drawn head diagram shown wherever the app asks the operator to fit a probe.
 *
 * The drawing is `probeFitDiagramSvg`, the same standalone SVG the run sheet prints, so the panel
 * and the paper cannot disagree about which connector the probe cable goes into. It is drawn for
 * the probe the JOB will use (the machine's checked-out instrument): the 3D probe gets Makera's
 * "unplug the wired probe… connect the 3D probe cable" line, the wired probe V2 gets "plug the
 * wired probe in here", and a job with no probe gets NO diagram at all — a job that registers
 * with the V2 must never be told to unplug it.
 */
export interface ProbeFitDiagramProps {
  /** The job's probe: `xyz` = the Makera 3D probe, `z-only` = the wired probe V2. None = no diagram. */
  instrument: ProbeFitInstrument | null;
  size?: ProbeFitDiagramSize;
  /** The panel mount: the drawing under a sentence, with the one line the instrument needs. */
  compact?: boolean;
  testId?: string;
}

export function ProbeFitDiagram({
  instrument,
  size = 'panel',
  compact = false,
  testId = 'probe-fit-diagram',
}: ProbeFitDiagramProps): JSX.Element | null {
  if (instrument === null) return null;
  const caption = instrument === 'xyz' ? PROBE_FIT_LINE : PROBE_FIT_WIRED_LINE;
  return (
    <figure data-testid={testId} style={{ margin: compact ? '4px 0 0' : '8px 0', maxWidth: 460 }}>
      <div dangerouslySetInnerHTML={{ __html: probeFitDiagramSvg(size, instrument) }} />
      <figcaption style={{ fontSize: 12, color: '#c8d3df', lineHeight: 1.45, marginTop: 4 }}>
        <strong>{caption}</strong>
        {compact || instrument !== 'xyz' ? null : (
          <span style={{ display: 'block', color: '#93a1b1' }}>{PROBE_FIT_ALL}</span>
        )}
      </figcaption>
    </figure>
  );
}
