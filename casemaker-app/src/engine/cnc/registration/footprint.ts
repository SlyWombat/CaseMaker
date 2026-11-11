/**
 * #1070 — REGISTRATION ON THE CUT REGION'S FOOTPRINT, for a bed-held job (the maintainer's rule:
 * "why does it need to find the edges, it only needs to find the edges of where it is going to
 * cut, if one edge is rough cut, that should not stop it").
 *
 * What a bed-held registration must prove: (1) material exists under and around the cut region —
 * the region's bounding box plus the job's edge margin — and (2) the XY relationship of that
 * material to the program, so the cut lands inside it. The blank's own corner proves neither by
 * itself; it was only ever a stand-in for them, and with the bracket placing the blank the corner
 * is not a datum at all.
 *
 * THE PLAN THIS BUILDS, in the wired V2's Z-only touches:
 *   - the two edges the program is referenced to (front and left for a bracket job): one scan at
 *     each END of the region's extent along that edge — two per edge, so the edge line AND its
 *     rotation are measured where the cut actually is;
 *   - one Z touch at each region corner, for the surface band the sheet already prints;
 *   - the far edges (right, back) once each, at the region's far extent: a material-exists proof.
 * The origin is then the intersection of the two touched edge lines, placed so the region keeps
 * the job's stated margin from the material that is really there.
 *
 * THE SOFT LIMITS ARE A CHECK, NOT A HOPE. Every planned position is put in MACHINE coordinates
 * here (the job's stock + mount geometry: the expected corner and the region), and any position
 * outside the machine's soft endstop is refused by name, with the coordinate and the limit —
 * before a line is sent. The executor is handed the same bounds so a later change cannot drift.
 *
 * PURE. No store, no machine, no wasm: a job's numbers in, a plan out, so the app and any executor
 * read one statement. The readings (where the material really is, the roughness between the two
 * touches on an edge, the found rotation) are the executor's; this module only says where each
 * touch is sent and what it is for.
 */

/** A box in WORK XY, mm — the region's own extents. */
export interface FootprintBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The machine's own travel floor, from the calibration read (`softEndstopOf`). */
export interface SoftLimits {
  xMin: number;
  yMin: number;
  zMin: number;
}

export interface FootprintObstacle {
  label: string;
  min: [number, number];
  max: [number, number];
}

/** The settings a Z-only scan needs, as the location states them. */
export interface FootprintScanSettings {
  /** How far inside the expected edge the scan starts (a point ON the stock). */
  scanInsideMm: number;
  /** How far past the expected edge the scan may run looking for the material. */
  scanReachMm: number;
  coarseStepMm: number;
  fineStepMm: number;
  /** A touch stays this far from the stock's corners: the roll-off reads low. */
  cornerClearanceMm: number;
  /** How far above the measured surface every sideways move is made. */
  parkAboveSurfaceMm: number;
  /** The surface band's half-width, for the Z the plan expects to find. */
  surfaceToleranceMm: number;
}

export interface FootprintInput {
  stock: { length: number; width: number; thickness: number; cornerRadius?: number };
  /** The cut region's extents in the job's work XY (the union of every cut's footprint). */
  region: FootprintBox;
  /** The job's own margin: the cut keeps this far inside the material it is registered on. */
  marginMm: number;
  /** Where the job expects the stock's front-left corner, MACHINE XY, and what that is from. */
  origin: { x: number; y: number; from: string };
  /**
   * The machine's soft endstop. `null` when the machine's frame has not been read — the plan then
   * says so in a note instead of pretending the moves were checked.
   */
  softLimits: SoftLimits | null;
  /** Where the job expects the stock's top, machine Z, and what that is from. */
  expectedSurface: { machineZ: number; from: string };
  /** The resolved machine's travel height, machine Z (the seek starts here). */
  seekFromMachineZ: number;
  /** The checked-out probe: the wired V2 only (a Z-only trigger). */
  probe: { instrument: 'z-only' | 'xyz'; tipRadiusMm: number; touches?: 'z-only' | 'all' };
  settings: FootprintScanSettings;
  /** What is in the way, in work XY — the clamps and the bracket's arms as the job places them. */
  obstacles?: readonly FootprintObstacle[];
}

export type FootprintScanEdge = 'front' | 'left' | 'right' | 'back';

export interface FootprintScan {
  edge: FootprintScanEdge;
  /** `extent` = one of the four touches that give the bounding edges; `presence` = a far-edge proof. */
  purpose: 'extent' | 'presence';
  /** The scan line's fixed coordinate along the edge, work XY. */
  along: number;
  /** Where the edge is expected, work XY. */
  expectedAt: number;
  /** Where the scan starts (on the stock) and where it may stop looking, work XY. */
  start: number;
  limit: number;
  /** The same two positions in MACHINE coordinates: the values the executor will send. */
  machineStart: [number, number];
  machineLimit: [number, number];
}

export interface FootprintCornerTouch {
  /** The region corner, work XY. */
  x: number;
  y: number;
  /** The same point, machine XY. */
  machine: [number, number];
  /** What this touch is for, in the operator's words. */
  why: string;
}

export interface FootprintBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
}

export interface FootprintPlan {
  stock: FootprintInput['stock'];
  region: FootprintBox;
  marginMm: number;
  scans: FootprintScan[];
  corners: FootprintCornerTouch[];
  /** The origin the touches derive: the touched corner, machine XY. */
  origin: { x: number; y: number; from: string; derivedFrom: string };
  /** Every planned position, machine — what the executor checks before its first line. */
  bounds: FootprintBounds;
  notes: string[];
}

export type FootprintResult = { ok: true; plan: FootprintPlan } | { ok: false; reason: string };

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const f = (n: number): string => String(Number.isInteger(n) ? n : Number(n.toFixed(3)));

/** One scan line, work and machine coordinates both, from the settings. */
function scanAt(
  edge: FootprintScanEdge,
  along: number,
  purpose: FootprintScan['purpose'],
  input: FootprintInput,
): FootprintScan {
  const { length, width } = input.stock;
  const outward: 1 | -1 = edge === 'right' || edge === 'back' ? 1 : -1;
  const expectedAt = edge === 'left' ? 0 : edge === 'right' ? length : edge === 'front' ? 0 : width;
  const start = r3(expectedAt - outward * input.settings.scanInsideMm);
  const limit = r3(expectedAt + outward * input.settings.scanReachMm);
  const machine = (workX: number, workY: number): [number, number] => [
    r3(input.origin.x + workX),
    r3(input.origin.y + workY),
  ];
  // A line on the left/right edge runs in X and is fixed in Y (and the reverse for front/back).
  const at = (value: number): [number, number] => (edge === 'left' || edge === 'right' ? machine(value, along) : machine(along, value));
  return {
    edge,
    purpose,
    along: r3(along),
    expectedAt: r3(expectedAt),
    start,
    limit,
    machineStart: at(start),
    machineLimit: at(limit),
  };
}

export function planFootprintRegistration(input: FootprintInput): FootprintResult {
  const { stock, region, marginMm, settings } = input;
  // #1200 — a 3D unit restricted to top touches plans the Z-only footprint routine and is
  // accepted; an unrestricted one keeps the refusal (the side-touch branch is unrun).
  if (input.probe.instrument !== 'z-only' && input.probe.touches !== 'z-only') {
    return {
      ok: false,
      reason:
        'the 3D probe is not a registration instrument on this machine yet — restrict it to top touches in Manage › Accessories, or fit the wired V2 probe and register again',
    };
  }
  if (!(settings.scanInsideMm > 0) || !(settings.scanReachMm > 0) || !(settings.coarseStepMm > 0) || !(settings.fineStepMm > 0)) {
    return { ok: false, reason: 'the scan settings are not usable: the steps and the inside/reach distances must be positive' };
  }
  if (!(region.maxX > region.minX) || !(region.maxY > region.minY)) {
    return { ok: false, reason: 'the cut region has no extent to register on' };
  }
  const { length, width } = stock;
  if (!(length > 0 && width > 0)) return { ok: false, reason: 'the stock has no size to register' };
  // THE REGION MUST FIT THE BLANK WITH THE JOB'S MARGIN. This is the job's own geometry, known
  // before any touch: a region closer to an edge than the margin is a document to fix.
  const edges: { edge: 'left' | 'right' | 'front' | 'back'; gap: number }[] = [
    { edge: 'left', gap: region.minX },
    { edge: 'front', gap: region.minY },
    { edge: 'right', gap: length - region.maxX },
    { edge: 'back', gap: width - region.maxY },
  ];
  const tight = edges.filter((e) => e.gap < marginMm - 1e-9);
  if (tight.length > 0) {
    const worst = tight.sort((a, b) => a.gap - b.gap)[0]!;
    return {
      ok: false,
      reason: `the cut region reaches within ${f(r3(worst.gap))} mm of the ${worst.edge} edge where the job keeps ${f(marginMm)} mm — the region would leave the material it is registered on`,
    };
  }
  // A scan line sits at the region's extent ALONG its edge, so it must lie on the stock: a line
  // outside the blank cannot touch material. (The region may sit close to the sides — the margin
  // check above is the one that governs how close.)
  if (!(region.minX > 0 && region.maxX < length && region.minY > 0 && region.maxY < width)) {
    return {
      ok: false,
      reason: 'the cut region reaches past the stock it is registered on — a touch there would be in the air',
    };
  }

  // THE FOUR EXTENT TOUCHES: two per bounding edge, AT the region's extents.
  const scans: FootprintScan[] = [
    scanAt('front', region.minX, 'extent', input),
    scanAt('front', region.maxX, 'extent', input),
    scanAt('left', region.minY, 'extent', input),
    scanAt('left', region.maxY, 'extent', input),
    // THE FAR EDGES, ONCE EACH: material must exist past the region there too.
    scanAt('right', region.maxY, 'presence', input),
    scanAt('back', region.maxX, 'presence', input),
  ];

  // THE SURFACE: one Z touch at each region corner.
  const corners: FootprintCornerTouch[] = (
    [
      [region.minX, region.minY, 'front-left of the region'],
      [region.maxX, region.minY, 'front-right of the region'],
      [region.minX, region.maxY, 'back-left of the region'],
      [region.maxX, region.maxY, 'back-right of the region'],
    ] as const
  ).map(([x, y, where]) => ({
    x: r3(x),
    y: r3(y),
    machine: [r3(input.origin.x + x), r3(input.origin.y + y)] as [number, number],
    why: `the surface at the ${where}`,
  }));

  // WHAT IS IN THE WAY, at the points the probe will visit.
  const obstacles = input.obstacles ?? [];
  const blocked = (x: number, y: number): FootprintObstacle | null =>
    obstacles.find(
      (o) =>
        x > o.min[0] - input.probe.tipRadiusMm &&
        x < o.max[0] + input.probe.tipRadiusMm &&
        y > o.min[1] - input.probe.tipRadiusMm &&
        y < o.max[1] + input.probe.tipRadiusMm,
    ) ?? null;
  for (const corner of corners) {
    const hit = blocked(corner.x, corner.y);
    if (hit !== null) return { ok: false, reason: `the surface touch at the ${corner.why} lands on ${hit.label} — move it, or move the cut` };
  }
  for (const scan of scans) {
    // The line's inside start is the point over material: (along, start) for a left/right line,
    // (start, along) for a front/back one.
    const x = scan.edge === 'left' || scan.edge === 'right' ? scan.start : scan.along;
    const y = scan.edge === 'left' || scan.edge === 'right' ? scan.along : scan.start;
    const hit = blocked(x, y);
    if (hit !== null) return { ok: false, reason: `the ${scan.edge}-edge scan starts on ${hit.label} — move the clamp, or register without that touch` };
  }

  // EVERY POSITION IN MACHINE TERMS, AND THE MACHINE'S OWN LIMITS.
  const xs = scans.flatMap((s) => [s.machineStart[0], s.machineLimit[0]]).concat(corners.map((c) => c.machine[0]));
  const ys = scans.flatMap((s) => [s.machineStart[1], s.machineLimit[1]]).concat(corners.map((c) => c.machine[1]));
  const zLow = r3(input.expectedSurface.machineZ - settings.surfaceToleranceMm);
  const zHigh = input.seekFromMachineZ;
  const bounds: FootprintBounds = {
    minX: r3(Math.min(...xs)),
    minY: r3(Math.min(...ys)),
    maxX: r3(Math.max(...xs)),
    maxY: r3(Math.max(...ys)),
    minZ: Math.min(zLow, zHigh),
  };
  const notes: string[] = [];
  if (input.softLimits === null) {
    notes.push('the machine’s soft endstop has not been read, so this plan’s machine positions could not be checked against it');
  } else {
    const { xMin, yMin, zMin } = input.softLimits;
    if (bounds.minX < xMin) {
      return { ok: false, reason: `a planned touch starts at machine X ${f(bounds.minX)}, past the machine's soft endstop X ${f(xMin)} — move the blank right, or register with a shorter approach` };
    }
    if (bounds.minY < yMin) {
      return { ok: false, reason: `a planned touch starts at machine Y ${f(bounds.minY)}, past the machine's soft endstop Y ${f(yMin)} — move the blank forward, or register with a shorter approach` };
    }
    if (bounds.minZ < zMin) {
      return { ok: false, reason: `the surface seek would reach machine Z ${f(bounds.minZ)}, past the machine's soft endstop Z ${f(zMin)} — check the stock's thickness and the mount` };
    }
  }

  notes.push(
    `the origin is the front-left corner the two bounding edges are measured at: ${input.origin.from}`,
    `the front edge is touched at X ${f(region.minX)} and X ${f(region.maxX)} (the region's extent), the left edge at Y ${f(region.minY)} and Y ${f(region.maxY)}; each pair gives the edge line and its rotation where the cut is`,
    `the right and back edges are touched once each (at Y ${f(region.maxY)} and X ${f(region.maxX)}) only to prove material exists past the region; a touch that finds none there stops the run`,
    `the region keeps ${f(marginMm)} mm from the material it is registered on; a rough or out-of-square edge is stated with the margin it leaves, never refused for its roughness alone`,
  );
  return {
    ok: true,
    plan: {
      stock,
      region: { minX: r3(region.minX), minY: r3(region.minY), maxX: r3(region.maxX), maxY: r3(region.maxY) },
      marginMm,
      scans,
      corners,
      origin: {
        x: r3(input.origin.x),
        y: r3(input.origin.y),
        from: input.origin.from,
        derivedFrom: 'the touched front and left edge lines, intersected — the program is placed so the region keeps its margin from the material that is there',
      },
      bounds,
      notes,
    },
  };
}
