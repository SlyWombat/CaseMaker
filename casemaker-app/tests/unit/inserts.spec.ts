import { describe, it, expect } from 'vitest';
import { resolveInsertSpec, computeBossPlacements } from '@/engine/compiler/bosses';
import { createDefaultProject } from '@/store/projectStore';

describe('boss insert variants', () => {
  it('self-tap honors the user-configured hole diameter', () => {
    const r = resolveInsertSpec('self-tap', 5, 2.5);
    expect(r.holeDiameter).toBe(2.5);
    expect(r.outerDiameter).toBeGreaterThanOrEqual(4.5);
  });

  it('heat-set-m2.5 forces a 3.6mm hole regardless of user config', () => {
    const r = resolveInsertSpec('heat-set-m2.5', 5, 2.5);
    expect(r.holeDiameter).toBe(3.6);
    expect(r.outerDiameter).toBeGreaterThanOrEqual(5.6);
  });

  it('heat-set-m3 forces a 4.2mm hole', () => {
    const r = resolveInsertSpec('heat-set-m3', 5, 2.5);
    expect(r.holeDiameter).toBe(4.2);
    expect(r.outerDiameter).toBeGreaterThanOrEqual(6.2);
  });

  it('outer diameter always provides at least 1mm wall around the hole', () => {
    const r = resolveInsertSpec('heat-set-m3', 4, 2);
    expect(r.outerDiameter - r.holeDiameter).toBeGreaterThanOrEqual(2 - 0.0001);
  });

  it('boss placements use the resolved diameters when joint=screw-down', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'screw-down';
    project.case.bosses.insertType = 'heat-set-m3';
    const placements = computeBossPlacements(project.board, project.case);
    expect(placements.every((b) => b.holeDiameter === 4.2)).toBe(true);
  });

  it('boss placements drop the pilot hole only when NEITHER screw path exists (issue #27, revised by #162)', () => {
    // #27 made non-screw-down bosses solid retention pegs. #162: that was
    // gated on the LID joint alone, so the default flat-lid case emitted a
    // solid peg whose locator stub plugged the board's mounting hole — while
    // the BOM still billed four board screws. The pilot now follows whichever
    // screw actually drives into the boss.
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.boardRetention = 'none';
    project.case.bosses.insertType = 'heat-set-m3';
    const placements = computeBossPlacements(project.board, project.case);
    expect(placements.every((b) => b.holeDiameter === 0)).toBe(true);
  });

  it('flat-lid + boardRetention=screws still pilots the boss for the board screw (#162)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.boardRetention = 'screws';
    project.case.bosses.insertType = 'heat-set-m3';
    const placements = computeBossPlacements(project.board, project.case);
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every((b) => b.holeDiameter > 0)).toBe(true);
  });
});
