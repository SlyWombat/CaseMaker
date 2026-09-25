// Issue #162 — "Board retention: Screws" must mean the board actually has
// somewhere to sit and somewhere for the screw to go. It used to mean
// neither: `boardRetention` reached the BOM and the UI but never the
// geometry, so three separate configurations shipped a board resting on
// nothing (or on a solid peg whose locator stub plugged its mounting hole)
// while the parts list still billed four board screws.
//
// The original bug was missed because the first probe only checked for
// SOLID MATERIAL under each hole. Solid material is not a seat you can
// screw into — the pilot check is the half that matters.

import { describe, it, expect } from 'vitest';
import { computeBossPlacements } from '@/engine/compiler/bosses';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';
import type { CaseParameters } from '@/types';

const JOINTS: CaseParameters['joint'][] = ['flat-lid', 'snap-fit', 'screw-down'];
const POSITIONS = ['bottom', 'top'] as const;

describe('boardRetention="screws" guarantees a seat with an open pilot (#162)', () => {
  for (const boardId of listBuiltinBoardIds()) {
    for (const joint of JOINTS) {
      for (const position of POSITIONS) {
        it(`${boardId} / ${joint} / bosses.position=${position}`, () => {
          const project = createDefaultProject(boardId);
          const holes = project.board.mountingHoles.length;
          const params: CaseParameters = {
            ...project.case,
            joint,
            boardRetention: 'screws',
            bosses: { ...project.case.bosses, position },
          };
          const placements = computeBossPlacements(project.board, params);
          const seats = placements.filter((b) => b.position === 'bottom');

          // A seat under every mounting hole...
          expect(seats.length).toBe(holes);
          // ...each with an open pilot for the board screw...
          expect(seats.every((b) => b.holeDiameter > 0)).toBe(true);
          // ...and a locator stub that cannot swallow the pilot (#124).
          for (const s of seats) {
            if (s.lockNotchDiameter > 0) {
              expect(s.lockNotchDiameter).toBeGreaterThan(s.holeDiameter);
            }
          }
          // IDs stay unique even when a hole yields a seat + lid pair.
          expect(new Set(placements.map((b) => b.id)).size).toBe(placements.length);

          // The BOM must bill exactly the screws the geometry can accept.
          const billed = hardwareForProject({ ...project, case: params }).find(
            (i) => i.id === 'board-screws',
          );
          expect(billed?.count ?? 0).toBe(seats.length);
        });
      }
    }
  }
});

describe('non-screw retention still seats the board (#162)', () => {
  for (const retention of ['snap', 'press-fit', 'none'] as const) {
    it(`retention=${retention} keeps the floor seat and bills no board screws`, () => {
      // Removing the seat would drop a board onto its own header pins —
      // the ESP32 DevKit sits 10 mm up precisely to clear them.
      const project = createDefaultProject('esp32-devkit-v1');
      const params: CaseParameters = { ...project.case, boardRetention: retention };
      const seats = computeBossPlacements(project.board, params).filter(
        (b) => b.position === 'bottom',
      );
      expect(seats.length).toBe(project.board.mountingHoles.length);
      const billed = hardwareForProject({ ...project, case: params }).find(
        (i) => i.id === 'board-screws',
      );
      expect(billed).toBeUndefined();
    });
  }
});

describe('boards with no mounting holes degrade cleanly (#162)', () => {
  it('a hole-less board yields no placements and no board screws', () => {
    const project = createDefaultProject('esp32-c61-devkitc-1');
    expect(project.board.mountingHoles.length).toBe(0);
    const params: CaseParameters = { ...project.case, boardRetention: 'screws' };
    expect(computeBossPlacements(project.board, params)).toEqual([]);
    const billed = hardwareForProject({ ...project, case: params }).find(
      (i) => i.id === 'board-screws',
    );
    expect(billed).toBeUndefined();
  });
});
