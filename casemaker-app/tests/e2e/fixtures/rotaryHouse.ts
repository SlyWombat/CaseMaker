// A house whose machine carries the 4th-axis module on its pins, with the bed's axis datum read —
// so the Holding step offers the rotary chuck and its fields (the neck for parting among them).
// The same house #782's geometry spec builds; kept here so a spec can borrow it without importing
// another spec's tests. #1180 S2 — the handler is `serveHouse`, the one house.
import type { Page } from '@playwright/test';
import { locationDocument, locationView, serveHouse } from './fakeHouse';

const NOW = '2026-10-30T10:00:00.000Z';

/** The house with the module on the pins and the bed's axis datum read at machine (−155, −135, −40). */
export async function fakeRotaryHouse(page: Page): Promise<void> {
  const raw = locationDocument();
  const machine = raw.machines[0]!;
  machine.bedProfiles = [
    {
      id: 'bp-rotary-measured',
      name: '4th axis on the pins, bare bed',
      createdAt: NOW,
      basedOn: null,
      surface: {
        kind: 'bare-bed',
        material: null,
        length: null,
        width: null,
        thickness: null,
        position: null,
        provenance: {},
        scars: [],
        lastResurfacedAt: null,
      },
      datums: {
        surfaceTopZ: null,
        viseJawTopZ: null,
        bracketSeatZ: null,
        rotaryAxis: { value: -40, measuredAt: NOW, by: 'wired-probe', at: [-155, -135] },
      },
      placements: [
        {
          id: 'pl-rotary',
          fixture: 'fx-rotary',
          where: { kind: 'pins', pins: 'rotary', anchor: null },
          count: null,
          frame: null,
          provenance: {},
        },
      ],
      preferredMounting: [],
      consumables: null,
      history: [{ at: NOW, what: 'the 4th-axis module went on the pins' }],
    },
  ];
  machine.activeBedProfileId = 'bp-rotary-measured';
  raw.accessories = [
    {
      id: 'fx-rotary',
      kind: 'rotary-module',
      product: 'makera-4th-axis',
      variant: null,
      constants: {},
      unit: {},
      provenance: {},
      whereabouts: { kind: 'machine', machineId: 'machine-1a2b3c', since: NOW },
      history: [],
    },
  ];

  await serveHouse(page, {
    location: locationView(raw, { defaults: true }),
    fromSharedDocument: true,
  });
}
