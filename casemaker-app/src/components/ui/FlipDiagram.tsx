/**
 * #1073 — THE FLIP, DRAWN (the React wrapper). The drawing itself is `flipDiagramSvg` in the
 * engine — one string, the same one the run sheet prints — so the app and the paper cannot show
 * different pictures. This component adds the two costs, with the chosen method's line emphatic.
 */

import type { JSX } from 'react';

import { flipCostLines, flipDiagramSvg, type FlipDiagramProps } from '@/engine/cnc/engrave/flipDiagram';

export type { FlipDiagramProps };

const MUTED = '#9aa4b0';
const INK = '#d1d5db';

export function FlipDiagram(props: FlipDiagramProps): JSX.Element {
  const costs = flipCostLines(props);
  const frame = props.flip.method === 'tabs-in-blank';
  return (
    <div data-testid="flip-diagram" style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
      {/* The engine's own SVG, injected — the same markup the run sheet prints. */}
      <div style={{ display: 'inline-block' }} dangerouslySetInnerHTML={{ __html: flipDiagramSvg(props) }} />
      <p data-testid="flip-cost-frame" style={{ margin: '2px 0', color: frame ? INK : MUTED, fontWeight: frame ? 600 : 400 }}>
        {costs.frame}
      </p>
      <p data-testid="flip-cost-vendor" style={{ margin: '2px 0', color: frame ? MUTED : INK, fontWeight: frame ? 400 : 600 }}>
        {costs.vendor}
      </p>
    </div>
  );
}
