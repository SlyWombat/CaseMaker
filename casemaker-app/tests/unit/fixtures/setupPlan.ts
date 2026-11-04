/**
 * #963 — a fixture `SetupPlan` in the shape `cam/model/plan.ts` publishes (#956 §3.0): the tray's
 * counts on the Makerables card (#955), four cutters priced by `CycleCost`, 384 rapids, 12 hops,
 * 3.2 % air. The panel and run-sheet specs read it; the engine's own stub throws, so this is the
 * only plan a UI test can be handed until #957/#959/#960 land.
 */
import type { SetupPlan, CycleCost } from '@/engine/cnc/cam/model/plan';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';

const RING: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const pocket = (id: string, floorZ: number, children: PocketNode[] = []): PocketNode => ({
  id,
  floorZ,
  mouthZ: 0,
  open: false,
  region: [RING],
  islands: [],
  children,
  remainder: [],
  narrowest: 3,
});

const tree = (): FeatureTree => ({
  frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: -6 },
  levels: [-6],
  contour: { outline: [RING], zTo: -6, frees: true, shoulders: [] },
  pockets: Array.from({ length: 6 }, (_, i) => pocket(`p${i}`, -6)),
  rims: [],
  remainder: [
    {
      id: 'r1',
      footprint: [RING],
      zTop: 0,
      zBottom: -6,
      triangles: new Uint32Array(),
      slopeDeg: [0, 70],
      in: 'top',
    },
  ],
  unreachable: [],
  report: {
    source: 'mesh',
    patches: 12,
    planarArea: 90,
    remainderArea: 10,
    tolerances: { planarityMm: 0.005, clusterAngleDeg: 0.5, deflectionMm: 0.01 },
    notes: [],
  },
});

const cost = (totalSeconds: number): CycleCost => ({
  terms: { movesSeconds: totalSeconds - 5, entrySeconds: 5, spinUpSeconds: 0, totalSeconds },
  toolChangeSeconds: 0,
  totalSeconds,
});

/** The tray's plan, as the card and the panel would show it. Overridable per test. */
export function fixtureSetupPlan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  const sequence = [
    { cutterKey: 'flat-6', cost: cost(18 * 60), pinned: false, house: true },
    { cutterKey: 'flat-3.175', cost: cost(11 * 60), pinned: false, house: true },
    { cutterKey: 'ball-6', cost: cost(15 * 60), pinned: false, house: true },
    { cutterKey: 'v-90', cost: cost(3 * 60), pinned: false, house: true },
  ];
  return {
    setupIndex: 0,
    features: tree(),
    clGrid: sequence.map((s) => ({ cutterKey: s.cutterKey, toleranceMm: 0.01, minSpacingMm: 0.2, maxSpacingMm: 0.5 })),
    ops: [],
    sequence,
    linking: { rapidsCount: 384, hopsCount: 12, airFractionPct: 3.2 },
    programs: [],
    totalCostSeconds: 47 * 60 + 30,
    ...overrides,
  };
}
