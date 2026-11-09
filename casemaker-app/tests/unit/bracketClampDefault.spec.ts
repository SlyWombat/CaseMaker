// @vitest-environment node
/**
 * #1123 item 13 — THE DEFAULT CLAMPS MUST FIT THE BLANK THEY ARE DRAWN ON.
 *
 * Before a file is opened the Holding step draws the default clamp pair on whatever stock the job
 * store persisted. `defaultClampPlacements` placed two clamps in from the back corners with no
 * minimum-width guard: on a blank too narrow for both, the right clamp landed at or behind the
 * left one, and both labels read the same corner word — the bench saw "1 mm in from the
 * left-hand corner" twice. A blank wide enough keeps the pair; a narrower one gets one clamp.
 */
import { describe, expect, it } from 'vitest';
import { bracketSettings, clampObstacles, defaultClampPlacements } from '@/engine/cnc/mounts';

const B = bracketSettings(null).settings;
const { width, inFromCorner } = B.clamp;

describe('#1123 item 13 — default clamp placements on the persisted blank', () => {
  it('a blank wide enough carries the two clamps, and their labels name different corners', () => {
    const stock = { x: 2 * inFromCorner + width + 30, y: 60, z: 6 };
    const placements = defaultClampPlacements(stock, B);
    expect(placements).toHaveLength(2);
    expect(placements[0]!.at).not.toBe(placements[1]!.at);
    const labels = clampObstacles(stock, placements, B).map((o) => o.label);
    expect(new Set(labels).size).toBe(2);
  });

  it('the width where the two would meet gets ONE clamp, not two at one point with one label', () => {
    // At exactly 2·inFromCorner + width the two `at` values are the same number.
    const stock = { x: 2 * inFromCorner + width, y: 60, z: 6 };
    const placements = defaultClampPlacements(stock, B);
    expect(placements).toHaveLength(1);
    expect(clampObstacles(stock, placements, B)).toHaveLength(1);
  });

  it('the acceptance walk’s badge blank (38.1 mm) gets one clamp, not an overlapping pair', () => {
    const stock = { x: 38.1, y: 76.2, z: 3.81 };
    expect(defaultClampPlacements(stock, B)).toHaveLength(1);
  });
});
