import type { Project } from '@/types';

/** A bill of materials for the user-supplied hardware needed to assemble
 *  the printed parts. Surfaced in the export modal so the user knows what
 *  to grab from the parts drawer before sliding the lid on. */
export interface HardwareItem {
  /** Stable id for React keying. */
  id: string;
  /** Human label shown in the modal. */
  label: string;
  /** How many of this item the project consumes. */
  count: number;
  /** Optional second-line note (e.g. "M3 × 8 mm pan-head"). */
  note?: string;
}

/** Enumerate every screw / pin / threaded insert / pre-formed gasket the
 *  project's currently-enabled features depend on. Returns an empty list
 *  when the case is bolt-free. Length-only recommendations follow common
 *  hobbyist FDM / Pi-case conventions. */
export function hardwareForProject(project: Project): HardwareItem[] {
  const items: HardwareItem[] = [];
  const c = project.case;

  // ----- Lid screws (joint='screw-down') -----
  if (c.joint === 'screw-down') {
    const insert = c.bosses?.insertType ?? 'self-tap';
    const numHoles = project.board.mountingHoles?.length ?? 0;
    if (numHoles > 0) {
      const screwLabel = insertScrewLabel(insert);
      const screwLength = recommendedScrewLength(insert, c.lidThickness);
      items.push({
        id: 'lid-screws',
        label: `${screwLabel} × ${screwLength} mm pan-head — lid → boss`,
        count: numHoles,
        note: noteForInsert(insert),
      });
      if (insert === 'heat-set-m2.5' || insert === 'heat-set-m3') {
        items.push({
          id: 'heat-set-inserts',
          label: `${insertHeatLabel(insert)} brass heat-set inserts`,
          count: numHoles,
          note: 'Press into the bosses with a soldering iron at 200 °C — see your insert manufacturer for exact temperature.',
        });
      }
    }
  }

  // ----- Hinge pin (only when the user picked an external pin) -----
  if (c.hinge?.enabled) {
    const h = c.hinge;
    if (h.style === 'external-pin' || h.pinMode === 'separate') {
      items.push({
        id: 'hinge-pin',
        label: `${h.pinDiameter.toFixed(1)} mm pin or threaded rod — hinge axle`,
        count: 1,
        note: `Length ≥ ${Math.ceil(h.hingeLength + 4)} mm. M3 set-screw or 3 mm brass rod is the common pick at pinDiameter=3.`,
      });
    }
  }

  // ----- Latch pins (PRINT-IN-PLACE so usually no separate hardware) -----
  // Listed only as a heads-up: the pin is part of the print, but the user
  // may want a paperclip / 1.5 mm rod handy to pop it out for service.

  // ----- Gasket: source pre-formed when material isn't TPU print -----
  if (c.seal?.enabled) {
    const mat = c.seal.gasketMaterial;
    if (mat === 'eva' || mat === 'epdm') {
      items.push({
        id: 'gasket-pre-formed',
        label: `Pre-formed ${mat.toUpperCase()} gasket`,
        count: 1,
        note: `Closed-loop ring sized to the case — see the *-gasket-print-instructions.txt sidecar in the export bundle for exact dimensions.`,
      });
    }
  }

  return items;
}

function insertScrewLabel(insert: string): string {
  if (insert === 'heat-set-m3' || insert === 'pass-through') return 'M3';
  if (insert === 'heat-set-m2.5') return 'M2.5';
  if (insert === 'self-tap') return 'M3 self-tapping';
  return 'M3';
}

function insertHeatLabel(insert: string): string {
  if (insert === 'heat-set-m2.5') return 'M2.5';
  if (insert === 'heat-set-m3') return 'M3';
  return 'M3';
}

function recommendedScrewLength(insert: string, lidThickness: number): number {
  // Lid thickness + ~6 mm of engagement into the boss is the common rule
  // for self-tap; heat-set gets the engagement length stamped on the
  // insert (typically 4–5 mm).
  const engagement = insert === 'self-tap' ? 6 : 5;
  // Round UP to the nearest 2 mm — that's the granularity off-the-shelf
  // pan-head screws ship in.
  const raw = lidThickness + engagement;
  return Math.ceil(raw / 2) * 2;
}

function noteForInsert(insert: string): string | undefined {
  if (insert === 'self-tap') return 'No insert — screw cuts its own thread in the printed boss.';
  if (insert === 'heat-set-m3' || insert === 'heat-set-m2.5') return undefined;  // covered by separate insert row
  if (insert === 'pass-through') return 'Boss is unthreaded; use a nut on the inside if needed.';
  if (insert === 'none') return undefined;
  return undefined;
}
