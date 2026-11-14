/**
 * #1258 — THE STATED FIXTURE for the tab question's page: a 150 × 90 mm plate with 12 mm corners,
 * seven tabs placed along it, and three stretches the shop's 80 mm limit refuses (92, 86 and 84 mm),
 * each with the tab the first option would add. Every length is measured on the outline's own path,
 * so the picture and the numbers agree; the shape is the planner's `TabChoiceNeeded`.
 */
import type { TabChoiceNeeded } from '@/engine/cnc/cam/model/plan';
import { loopOf, type XY } from '@/engine/cnc/tabChoiceGeometry';

const R = 12;
const W = 150;
const H = 90;
export const TAB_WIDTH_MM = 4;

function arc(cx: number, cy: number, a0: number, a1: number): XY[] {
  const out: XY[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return out;
}

/** Counter-clockwise from the bottom edge's left end; work Y points up. */
export const FIXTURE_OUTLINE: XY[] = [
  [R, 0],
  [W - R, 0],
  ...arc(W - R, R, -Math.PI / 2, 0),
  [W, H - R],
  ...arc(W - R, H - R, 0, Math.PI / 2),
  [R, H],
  ...arc(R, H - R, Math.PI / 2, Math.PI),
  [0, R],
  ...arc(R, R, Math.PI, (3 * Math.PI) / 2),
];

const loop = loopOf(FIXTURE_OUTLINE);
const at = (s: number): [number, number] => {
  const p = loop.at(s);
  return [p.x, p.y];
};
const ARC_LEN = (Math.PI / 2) * R;
/** Arc length of each corner's straight-edge end, from the loop's start. */
const BOTTOM_END = W - 2 * R;
const PLACED_TABS_S = [20, 70, 113, 146, 196, 240, 275, 330, 420];

export const FIXTURE_NEEDED: TabChoiceNeeded = (() => {
  // Three stretches around the bottom-right, top-right and top-left corners.
  const mk = (index: number, a: number, b: number, cornerS: number, dist: number, margin: number) => {
    const cand = cornerS + dist;
    const left = cand - TAB_WIDTH_MM / 2 - (a + TAB_WIDTH_MM / 2);
    const right = b - TAB_WIDTH_MM / 2 - (cand + TAB_WIDTH_MM / 2);
    return {
      index,
      setupIndex: 0,
      cut: { id: 'setup-1-cut-1', name: 'Cut-out 1' },
      spanMm: b - a - TAB_WIDTH_MM,
      startXY: at(a + TAB_WIDTH_MM / 2),
      endXY: at(b - TAB_WIDTH_MM / 2),
      candidate: {
        atXY: at(cand),
        fromCornerMm: dist,
        cornerXY: at(cornerS),
        marginMm: margin,
        leavesSpansMm: [left, right] as [number, number],
      },
    };
  };
  const bottomRightCorner = BOTTOM_END + ARC_LEN; // end of the arc: the right edge begins
  return {
    limitMm: 80,
    marginMm: 8,
    fingerprint: 'fixture-1258',
    setups: [
      {
        setupIndex: 0,
        outline: [FIXTURE_OUTLINE.map((p) => [...p] as [number, number])],
        path: [FIXTURE_OUTLINE.map((p) => [...p] as [number, number])],
        tabsAt: PLACED_TABS_S.map((s) => at(s)),
        cuts: [{ cut: { id: 'setup-1-cut-1', name: 'Cut-out 1' }, path: [FIXTURE_OUTLINE.map((p) => [...p] as [number, number])], tabsAt: PLACED_TABS_S.map((s) => at(s)) }],
      },
    ],
    stretches: [
      mk(0, bottomRightCorner - 60, bottomRightCorner + 36, bottomRightCorner, 5, 8),
      mk(1, bottomRightCorner + 70, bottomRightCorner + 160, bottomRightCorner + 90 + ARC_LEN, 6, 12.6),
      mk(2, bottomRightCorner + 200, bottomRightCorner + 288, bottomRightCorner + 250 + ARC_LEN, 4, 8),
    ],
  };
})();

