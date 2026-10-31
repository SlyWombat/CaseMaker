// #788 — THE HEAD DIAGRAM: which connector the probe cable goes into.
//
// The bench's first 3D-probe fitting plugged the probe cable into the 3-pin ionizer port; the
// probe input stayed at 0 and nothing told the operator which port was which. The diagram is a
// drawing (no photograph), generated once as a standalone SVG so the panel and the printed run
// sheet cannot show different pictures: the probe connector marked "plug here", the ionizer port
// marked "not this one".

import { describe, expect, it } from 'vitest';
import { PROBE_FIT_ALL, PROBE_FIT_LINE, probeFitDiagramSvg } from '@/engine/cnc/probeFitDiagram';

describe('#788 the head diagram names the probe connector', () => {
  it('draws both ports, marks the ionizer as not this one, and carries the Makera line', () => {
    const svg = probeFitDiagramSvg('panel');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 460 236"');
    expect(svg).toContain('probe connector');
    expect(svg).toContain('plug the cable in here');
    expect(svg).toContain('3-pin ionizer port');
    expect(svg).toContain('not this one');
    expect(svg).toContain(PROBE_FIT_LINE);
    // Drawn, not a photograph or an embedded raster.
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('data:image');
    expect(svg).toContain('role="img"');
  });

  it('prints in monochrome and draws on screen in the app palette', () => {
    const panel = probeFitDiagramSvg('panel');
    const print = probeFitDiagramSvg('print');
    expect(panel).toContain('probe-fit-svg--panel');
    expect(print).toContain('probe-fit-svg--print');
    // The screen drawing uses the good/bad colours; the paper carries the words alone.
    expect(panel).toContain('#49d17d');
    expect(print).not.toContain('#49d17d');
    expect(print).toContain('#111111');
  });

  it('says every Makera probe for the Z1 uses the one connector', () => {
    expect(PROBE_FIT_ALL).toContain('wired probe V2');
    expect(PROBE_FIT_ALL).toContain('3D probe');
    expect(PROBE_FIT_ALL).toContain('3D Probe Rod');
  });
});
