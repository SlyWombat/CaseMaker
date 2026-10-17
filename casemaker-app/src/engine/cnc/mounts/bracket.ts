/**
 * The anchor bracket and its top clamps as a modelled mount (#427, decision Q10: "plate default: anchor
 * bracket + clamps, the bracket's XY as the datum; a confirming touch is offered, optional").
 *
 * HOW IT IS HELD (Makera's Z1 QuickStart, cached at docs/market-research/raw/makera/Z1-QuickStart.txt):
 * the L-bracket is pinned at the anchor with two 4 mm dowels and three M5 screws; the stock is pushed into
 * its inside corner — the stock's FRONT-LEFT corner — and the top clamps hold the far side. Makera sets the
 * work origin "relative to Anchor 1, X Offset = 0, Y Offset = 0" for exactly that.
 *
 * THE FRAMES. Work frame as everywhere in the CAM (`setup.ts`'s `ObstacleBox`): origin at the stock's
 * top-front-left corner — the corner in the bracket — X to the right, Y away from you, Z0 on the top.
 * The bracket's two arms are therefore at X < 0 (the LEFT arm, along the stock's left edge) and Y < 0 (the
 * FRONT arm, along the front edge, nearest you). Clamps go on the free edges: the back and the right.
 *
 * NOTHING HERE IS A MEASUREMENT YET. Every size is a shop default (`location.json`'s `defaults`, seeded
 * with a note that says "not measured"), read with its provenance; {@link BRACKET_CALIPER_LIST} says, in
 * physical words, what to caliper to replace each one. Only the anchor itself is this machine's own
 * reading (the calibration read, #279) — and without that read, the datum is refused, not guessed: the
 * bench machine's anchor 1 sits 1.51 mm off Makera's default on X (#208 B6/B7).
 */

import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { FixtureEnvelope, ObstacleBox } from '@/engine/cnc/setup';
import { readDefault, readMeasured, type DefaultSource, type ShopDefaults } from '@/platform/defaultsClient';

export interface ClampSize {
  /** Along its own length, pointing onto the stock. */
  length: number;
  /** Along the edge it holds. */
  width: number;
  /** Its highest point (screw head included) above the stock's top. */
  height: number;
  /** How far its nose reaches in over the stock from the edge. */
  reach: number;
  /** The default placement: a clamp's side this far in from the corner of its edge. */
  inFromCorner: number;
}

export interface BracketSettings {
  /** The stock's corner in the bracket, from the anchor, machine XY. */
  originOffset: { x: number; y: number };
  /** How closely a corner pushed into the bracket repeats, mm. */
  fitMm: number;
  /** The front arm (along the stock's front edge) and the left arm, from the inside corner to their ends. */
  armLengthX: number;
  armLengthY: number;
  /** Each arm's thickness, from the face the stock touches to its outside. */
  armWidth: number;
  /** The bracket's top (and its screw heads) above the surface the stock sits on. */
  height: number;
  clamp: ClampSize;
}

export interface SettingRead {
  key: string;
  value: number;
  source: DefaultSource | 'fallback';
  note: string | null;
}

const KEYS = {
  originOffsetX: 'bracket.originOffsetXMm',
  originOffsetY: 'bracket.originOffsetYMm',
  fitMm: 'bracket.fitMm',
  armLengthX: 'bracket.armLengthXMm',
  armLengthY: 'bracket.armLengthYMm',
  armWidth: 'bracket.armWidthMm',
  height: 'bracket.heightMm',
  clampLength: 'clamps.topLengthMm',
  clampWidth: 'clamps.topWidthMm',
  clampHeight: 'clamps.topHeightMm',
  clampReach: 'clamps.topReachMm',
  clampInFromCorner: 'clamps.topInFromCornerMm',
} as const;

/**
 * What to caliper, in physical words, one line per stored number (#427). `bracket.seatMachineZ` is the one
 * with no default at all: it is touched, not calipered.
 */
export const BRACKET_CALIPER_LIST: readonly { key: string; what: string }[] = [
  { key: KEYS.originOffsetX, what: 'with the bracket pinned at anchor 1: jog the probe to the bracket’s inside corner and compare with anchor 1’s X — the left arm’s inside face (where the stock’s left edge touches) from anchor 1, along X' },
  { key: KEYS.originOffsetY, what: 'the same for the front arm’s inside face (where the stock’s front edge touches), along Y' },
  { key: KEYS.fitMm, what: 'push the same calipered plate into the corner five times and read its far corner each time: the spread is the fit' },
  { key: KEYS.armLengthX, what: 'the front arm (nearest you): from the inside corner to the arm’s right-hand end' },
  { key: KEYS.armLengthY, what: 'the left arm: from the inside corner to the arm’s back end' },
  { key: KEYS.armWidth, what: 'either arm’s thickness: from the face the stock touches to its outside face' },
  { key: KEYS.height, what: 'the bracket’s top above the bed it sits on — to the top of the two M5 screw heads in its slots if they stand higher (both bracket variants: the QuickStart says the thick one takes longer screws)' },
  { key: KEYS.clampLength, what: 'a top clamp’s length, nose to heel' },
  { key: KEYS.clampWidth, what: 'a top clamp’s width, across' },
  { key: KEYS.clampHeight, what: 'with a clamp tightened on a plate: from the plate’s top up to the clamp’s highest point, screw head included' },
  { key: KEYS.clampReach, what: 'with a clamp tightened on a plate: how far its nose reaches in over the plate from the plate’s edge' },
  { key: 'bracket.seatMachineZ', what: 'no caliper: one probe touch on the bed (or the board the stock sits on) beside the bracket, read as machine Z' },
];

export interface BracketSettingsRead {
  settings: BracketSettings;
  /** Each number with where it came from. */
  read: SettingRead[];
  /** The keys that are not a measurement (seeded or a fallback): what the plan must say is assumed. */
  unmeasured: string[];
}

/** The bracket's and the clamps' sizes, from the location's shop defaults, each with its provenance. */
export function bracketSettings(map: ShopDefaults | null): BracketSettingsRead {
  const read: SettingRead[] = [];
  const v = (key: string): number => {
    const d = readDefault(map, key);
    read.push({ key, value: d.value, source: d.source, note: map?.[key]?.note ?? null });
    return d.value;
  };
  const settings: BracketSettings = {
    originOffset: { x: v(KEYS.originOffsetX), y: v(KEYS.originOffsetY) },
    fitMm: v(KEYS.fitMm),
    armLengthX: v(KEYS.armLengthX),
    armLengthY: v(KEYS.armLengthY),
    armWidth: v(KEYS.armWidth),
    height: v(KEYS.height),
    clamp: {
      length: v(KEYS.clampLength),
      width: v(KEYS.clampWidth),
      height: v(KEYS.clampHeight),
      reach: v(KEYS.clampReach),
      inFromCorner: v(KEYS.clampInFromCorner),
    },
  };
  return { settings, read, unmeasured: read.filter((r) => r.source !== 'measured').map((r) => r.key) };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------
// The datum: G54 XY from the bracket.

export interface AnchorRead {
  x: number;
  y: number;
  from: string;
}

/**
 * The anchor the bracket is pinned at, from THIS machine's calibration read — never the vendor default:
 * the bench machine's anchor 1 is 1.51 mm off it on X (#208 B6/B7), and a datum that far out is a
 * wrong cut, not an approximation.
 */
export function anchorFrom(
  calibration: MachineCalibration | null | undefined,
  machineId: string,
  anchor: 1 | 2 = 1,
): { ok: true; anchor: AnchorRead } | { ok: false; reason: string } {
  if (!calibration) {
    return { ok: false, reason: 'the bracket’s position comes from this machine’s anchor, and the machine’s calibration has not been read — read it (Machine ▸ calibration) first' };
  }
  if (calibration.machineId !== machineId) {
    return { ok: false, reason: `the calibration on file was read on ${calibration.machineId}, not ${machineId}` };
  }
  const [a1x, a1y] = calibration.frame.anchor1;
  const [ox, oy] = anchor === 2 ? calibration.frame.anchor2Offset : [0, 0];
  const date = calibration.measuredAt.slice(0, 10);
  return {
    ok: true,
    anchor: {
      x: r3(a1x + ox),
      y: r3(a1y + oy),
      from: anchor === 1 ? `anchor 1 read from the machine (${calibration.source}, ${date})` : `anchor 2 = anchor 1 + its offset, read from the machine (${calibration.source}, ${date})`,
    },
  };
}

export interface BracketDatum {
  /** The work origin (the stock's front-left corner) in machine XY — the planner's `bracketOrigin`. */
  x: number;
  y: number;
  /** Both provenances: the anchor's and the bracket offset's. */
  from: string;
  /** The fit, mm: how far the corner may sit from here. */
  uncertainty: number;
  /** Whether the bracket's offset from the anchor is measured. While it is not, the confirming touch is required. */
  offsetMeasured: boolean;
}

/** G54 XY from the bracket: the anchor plus the bracket's offset. */
export function bracketDatum(anchor: AnchorRead, b: BracketSettingsRead): BracketDatum {
  const s = b.settings;
  const offsetMeasured = !b.unmeasured.includes(KEYS.originOffsetX) && !b.unmeasured.includes(KEYS.originOffsetY);
  return {
    x: r3(anchor.x + s.originOffset.x),
    y: r3(anchor.y + s.originOffset.y),
    from: `${anchor.from} + the bracket’s offset (${s.originOffset.x}, ${s.originOffset.y})${offsetMeasured ? ', measured' : ' — a default, not measured'}`,
    uncertainty: s.fitMm,
    offsetMeasured,
  };
}

/**
 * Where the surface touch expects the stock's top, machine Z: the surface it sits on beside the bracket
 * (MEASURED only — `bracket.seatMachineZ`) + anything under it + its thickness. Refused without the
 * measurement: the touch is bounded to this ± the tolerance (#430), and a guessed seat would either
 * refuse every real reading or let a wrong one through.
 */
export function bracketExpectedSurface(
  map: ShopDefaults | null,
  stockThickness: number,
  underMm = 0,
): { ok: true; expectedSurface: { machineZ: number; from: string } } | { ok: false; reason: string } {
  const seat = readMeasured(map, 'bracket.seatMachineZ');
  if (seat === null) {
    return {
      ok: false,
      reason: 'where the stock sits beside the bracket has not been measured (bracket.seatMachineZ): touch the bed beside the bracket once with the probe and save its machine Z',
    };
  }
  const under = underMm > 0 ? ` + ${underMm} mm under the stock` : '';
  return {
    ok: true,
    expectedSurface: {
      machineZ: r3(seat.value + underMm + stockThickness),
      from: `the surface beside the bracket at machine Z ${seat.value} (${seat.source}${seat.setAt ? `, ${seat.setAt.slice(0, 10)}` : ''})${under} + the stock’s ${stockThickness} mm`,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The obstacles: the bracket's arms and the clamps, in the work frame.

/** The stock's size: X left→right, Y front→back, Z its thickness. Work frame 0..x, 0..y, top at Z0. */
export interface StockSize {
  x: number;
  y: number;
  z: number;
}

/** Clamps go on the free edges — the bracket holds the front and the left. */
export type ClampEdge = 'back' | 'right';

export interface ClampPlacement {
  edge: ClampEdge;
  /** The clamp's centre along its edge, mm from the edge's LEFT end (back edge) or FRONT end (right edge). */
  at: number;
}

export interface MountObstacle {
  id: string;
  kind: 'clamp' | 'bracket';
  /** In landmark words: "the clamp on the back edge, 15 mm in from the right-hand corner". */
  label: string;
  /** What to do about a toolpath that crosses it, in physical words. */
  fix: string;
  /** Its footprint, work XY. */
  min: [number, number];
  max: [number, number];
  /** Its highest point, work Z. */
  topZ: number;
}

/** Makera's QuickStart: the top clamps hold the far corner. Two on the back edge, each in from a corner. */
export function defaultClampPlacements(stock: StockSize, s: BracketSettings): ClampPlacement[] {
  const half = s.clamp.width / 2;
  return [
    { edge: 'back', at: r3(s.clamp.inFromCorner + half) },
    { edge: 'back', at: r3(stock.x - s.clamp.inFromCorner - half) },
  ];
}

function clampLabel(p: ClampPlacement, stock: StockSize, width: number): string {
  const len = p.edge === 'back' ? stock.x : stock.y;
  const fromLow = r3(p.at - width / 2);
  const fromHigh = r3(len - p.at - width / 2);
  const [lowCorner, highCorner] = p.edge === 'back' ? ['left-hand', 'right-hand'] : ['front', 'back'];
  const near = fromLow <= fromHigh ? `${fromLow} mm in from the ${lowCorner} corner` : `${fromHigh} mm in from the ${highCorner} corner`;
  return `the clamp on the ${p.edge} edge, ${near}`;
}

/** Each clamp's footprint and top, work frame. */
export function clampObstacles(stock: StockSize, placements: ClampPlacement[], s: BracketSettings): MountObstacle[] {
  const c = s.clamp;
  return placements.map((p, i) => {
    const across: [number, number] = [r3(p.at - c.width / 2), r3(p.at + c.width / 2)];
    const onto: [number, number] = p.edge === 'back' ? [r3(stock.y - c.reach), r3(stock.y - c.reach + c.length)] : [r3(stock.x - c.reach), r3(stock.x - c.reach + c.length)];
    const [min, max]: [[number, number], [number, number]] =
      p.edge === 'back' ? [[across[0], onto[0]], [across[1], onto[1]]] : [[onto[0], across[0]], [onto[1], across[1]]];
    return {
      id: `clamp-${i + 1}`,
      kind: 'clamp' as const,
      label: clampLabel(p, stock, c.width),
      fix: `slide it along the ${p.edge} edge, or move it to the other free edge (${p.edge === 'back' ? 'the right' : 'the back'}), clear of the cut — the bracket holds the front and left`,
      min,
      max,
      topZ: c.height,
    };
  });
}

/**
 * The bracket's two arms, work frame. `underMm` is anything the stock stands on inside the bracket (a
 * sacrificial board): it lifts the stock, not the bracket, so the arms' tops come down by that much.
 */
export function bracketObstacles(stock: StockSize, s: BracketSettings, underMm = 0): MountObstacle[] {
  const top = r3(-stock.z - underMm + s.height);
  const w = s.armWidth;
  const keep = 'keep the cut inside the stock’s edge on that side — the bracket does not move';
  return [
    { id: 'bracket-front-arm', kind: 'bracket', label: 'the bracket’s front arm (along the front edge, nearest you)', fix: keep, min: [-w, -w], max: [s.armLengthX, 0], topZ: top },
    { id: 'bracket-left-arm', kind: 'bracket', label: 'the bracket’s left arm (along the left edge)', fix: keep, min: [-w, -w], max: [0, s.armLengthY], topZ: top },
  ];
}

/**
 * The same obstacles as the sweep's fixture envelope (#203/#204: `Setup.fixture`), so the simulation
 * checks them as solids too. The source is `default` until every size behind it is measured.
 */
export function mountEnvelope(obstacles: MountObstacle[], b: BracketSettingsRead, floorZ: number): FixtureEnvelope {
  const boxes: ObstacleBox[] = obstacles.map((o) => ({
    id: o.id,
    label: o.label,
    min: [o.min[0], o.min[1], floorZ],
    max: [o.max[0], o.max[1], o.topZ],
  }));
  return { boxes, source: b.unmeasured.length === 0 ? 'measured' : 'default', uncertainty: b.settings.fitMm };
}

/**
 * The mount's obstacles, as a program on this mount is checked against (#427): the two arms and
 * the clamps, in the work frame, with the fit as their uncertainty — plus the same boxes as the
 * sweep's fixture envelope (#203), so the verifier and the simulation read ONE statement.
 */
export interface MountObstacles {
  obstacles: MountObstacle[];
  /** The fit, mm: how far the stock's corner may sit from the bracket's datum. */
  uncertainty: number;
  /** The same boxes as solids, for `Setup.fixture`. */
  fixture: FixtureEnvelope;
}

/**
 * The obstacles a job is checked against, or `null` when it is held some other way (#442's #427
 * item, decision Q10: a plate's default mount is the anchor bracket plus clamps).
 *
 * `null` for the vise and the tape is not an omission. A blank in the vise is nowhere near the
 * bracket, and handing its program the arms would refuse every cut within the arms' reach of the
 * front and left edges — a false refusal is as destructive as a missed one, because it teaches an
 * operator to ignore the verifier.
 *
 * `underMm` is the board the stock stands on (#213): it lifts the stock, so the bracket's own top
 * stands that much further below the stock's top. The clamps sit on the stock and do not move.
 */
export function bracketMount(
  stock: StockSize,
  mount: 'vise' | 'bracket' | 'tape',
  defaults: ShopDefaults | null,
  underMm = 0,
): MountObstacles | null {
  if (mount !== 'bracket') return null;
  const b = bracketSettings(defaults);
  const obstacles: MountObstacle[] = [
    ...bracketObstacles(stock, b.settings, underMm),
    ...clampObstacles(stock, defaultClampPlacements(stock, b.settings), b.settings),
  ];
  return {
    obstacles,
    uncertainty: b.settings.fitMm,
    // The bracket stands on the bed the stock sits on (under the board when there is one), and its
    // top is `height` above that; the boxes run from the bed up to each obstacle's own top.
    fixture: mountEnvelope(obstacles, b, -stock.z - underMm),
  };
}

// ---------------------------------------------------------------------------------------------------
// The mount's own checks.

export interface MountFinding {
  code: 'clamp-off-stock' | 'clamps-overlap' | 'stock-past-arm' | 'mount-unmeasured';
  severity: 'error' | 'warning' | 'info';
  text: string;
}

/** What is wrong with this bracket + clamps mount before any toolpath is looked at. */
export function validateBracketMount(stock: StockSize, placements: ClampPlacement[], b: BracketSettingsRead): MountFinding[] {
  const s = b.settings;
  const out: MountFinding[] = [];
  const obstacles = clampObstacles(stock, placements, s);
  placements.forEach((p, i) => {
    const len = p.edge === 'back' ? stock.x : stock.y;
    if (p.at - s.clamp.width / 2 < 0 || p.at + s.clamp.width / 2 > len) {
      out.push({ code: 'clamp-off-stock', severity: 'error', text: `${obstacles[i]!.label} hangs past the end of the ${len} mm edge — it would not hold` });
    }
  });
  for (let i = 0; i < obstacles.length; i++) {
    for (let j = i + 1; j < obstacles.length; j++) {
      const a = obstacles[i]!;
      const c = obstacles[j]!;
      if (a.min[0] < c.max[0] && c.min[0] < a.max[0] && a.min[1] < c.max[1] && c.min[1] < a.max[1]) {
        out.push({ code: 'clamps-overlap', severity: 'error', text: `${a.label} and ${c.label} sit on top of each other` });
      }
    }
  }
  for (const [edge, len, arm] of [
    ['front', stock.x, s.armLengthX],
    ['left', stock.y, s.armLengthY],
  ] as const) {
    if (len > arm) {
      out.push({
        code: 'stock-past-arm',
        severity: 'warning',
        text: `the stock’s ${edge} edge is ${len} mm and the bracket’s ${edge} arm ${arm} mm: the edge is squared only along the arm, so the ${s.fitMm} mm fit can grow to ${r3((s.fitMm * len) / arm)} mm at the far end`,
      });
    }
  }
  if (b.unmeasured.length > 0) {
    out.push({
      code: 'mount-unmeasured',
      severity: 'info',
      text: `the bracket and clamp sizes are defaults, not measured (${b.unmeasured.join(', ')}): the clearances are only as good as those`,
    });
  }
  return out;
}
