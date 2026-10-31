import type { JSX } from 'react';
import {
  PROBE_FIT_ALL,
  PROBE_FIT_LINE,
  probeFitDiagramSvg,
  type ProbeFitDiagramSize,
} from '@/engine/cnc/probeFitDiagram';

/**
 * #788 — the drawn head diagram shown wherever the app asks the operator to fit a probe.
 *
 * The drawing is `probeFitDiagramSvg`, the same standalone SVG the run sheet prints, so the panel
 * and the paper cannot disagree about which connector the probe cable goes into. The caption is
 * the Makera 3D Probe quick start's own step 3; the compact mount keeps only that line.
 */
export interface ProbeFitDiagramProps {
  size?: ProbeFitDiagramSize;
  /** The panel mount: the drawing under a sentence, with the one Makera line only. */
  compact?: boolean;
  testId?: string;
}

export function ProbeFitDiagram({
  size = 'panel',
  compact = false,
  testId = 'probe-fit-diagram',
}: ProbeFitDiagramProps): JSX.Element {
  return (
    <figure data-testid={testId} style={{ margin: compact ? '4px 0 0' : '8px 0', maxWidth: 460 }}>
      <div dangerouslySetInnerHTML={{ __html: probeFitDiagramSvg(size) }} />
      <figcaption style={{ fontSize: 12, color: '#c8d3df', lineHeight: 1.45, marginTop: 4 }}>
        <strong>{PROBE_FIT_LINE}</strong>
        {compact ? null : <span style={{ display: 'block', color: '#93a1b1' }}>{PROBE_FIT_ALL}</span>}
      </figcaption>
    </figure>
  );
}
