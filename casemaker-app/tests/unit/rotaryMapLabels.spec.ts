// #716 review — the map drops the labels that would collide, in a stated priority order.
import { describe, expect, it } from 'vitest';
import {
  boxesOverlap,
  hiddenMapLabels,
  mapLabelBox,
  type MapLabelRect,
} from '@/components/viewport/rotaryMapLabels';

function rect(
  id: string,
  priority: number,
  cx: number,
  cy: number,
  width = 40,
  height = 14,
): MapLabelRect {
  return { id, priority, cx, cy, width, height };
}

describe('#716 map label collision layout', () => {
  it('a box is centred on its anchor and grown by the pad', () => {
    expect(mapLabelBox(rect('a', 0, 100, 50, 40, 14))).toEqual({
      left: 80,
      top: 43,
      right: 120,
      bottom: 57,
    });
    expect(mapLabelBox(rect('a', 0, 100, 50, 40, 14), 2)).toEqual({
      left: 78,
      top: 41,
      right: 122,
      bottom: 59,
    });
  });

  it('boxes that only share an edge do not overlap', () => {
    expect(boxesOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(boxesOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 9, top: 5, right: 20, bottom: 15 })).toBe(true);
  });

  it('labels that do not collide are all kept', () => {
    const hidden = hiddenMapLabels([rect('a', 0, 0, 0), rect('b', 0, 100, 0)], 0);
    expect([...hidden]).toEqual([]);
  });

  it('the higher-priority label is kept and the other dropped', () => {
    // The band's words beat the ruler end's when they share a corner.
    const hidden = hiddenMapLabels([rect('ruler-0', 20, 0, 0), rect('band-jaws', 5, 20, 8)], 0);
    expect([...hidden]).toEqual(['ruler-0']);
  });

  it('equal priorities resolve by id, so a re-layout hides the same label', () => {
    const hidden = hiddenMapLabels([rect('b', 10, 100, 0), rect('a', 10, 100, 0)], 0);
    expect([...hidden]).toEqual(['b']);
    const reversed = hiddenMapLabels([rect('a', 10, 100, 0), rect('b', 10, 100, 0)], 0);
    expect([...reversed]).toEqual(['b']);
  });

  it('an end tick survives a crowded neighbour (the along ruler keeps its last value)', () => {
    // 80 and 85 are 14 px apart on a phone; the ruler's END (85) has the priority.
    const hidden = hiddenMapLabels([rect('along-80', 30, 100, 0, 20), rect('along-85', 10, 114, 0, 20)], 0);
    expect([...hidden]).toEqual(['along-80']);
  });

  it('greedy: a dropped label reserves no space, so a third label can still fit beside it', () => {
    // A overlaps B; C overlaps B only. A is kept, B is dropped, C survives.
    const hidden = hiddenMapLabels(
      [rect('a', 0, 0, 0), rect('b', 10, 30, 0), rect('c', 20, 60, 0)],
      0,
    );
    expect([...hidden]).toEqual(['b']);
  });
});
