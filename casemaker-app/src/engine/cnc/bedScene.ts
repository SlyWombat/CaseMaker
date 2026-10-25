/**
 * #511 — the bed scene's geometry, PURE and testable.
 *
 * `docs/design/bed-profiles.md` §4: one picture of the machine's bed, drawn in MACHINE
 * coordinates (the mill's envelope, X/Y in [-200, 0], Z in [-100, 0], down negative): the
 * 200 × 200 bed plate with its anchor holes and the locating pin pair at the machine's own read,
 * the surface slab at its stated size/position (solid where its top is measured, dashed "top not
 * measured" where it is not), every placement from its fixture's constants (#508's vise, the
 * bracket's arms at the anchor, clamp footprints, the rotary's chuck and axis), unmeasured
 * dimensions dashed + "provisional", provenance by colour, and datums as labelled points.
 *
 * NOTHING HERE INVENTS A NUMBER. What the record does not carry is drawn dashed from a LABELLED
 * PROVISIONAL figure — never a value that could be read as a measurement. The machine's own frame
 * (anchors, sensor, clearance) comes from the RESOLVED mill profile (`calibration.ts`), which is
 * the same reader the rest of the app uses, so the picture agrees with the checks.
 *
 * The returned boxes are in the same `{min, max}` shape `viewportCamera.ts`'s `SceneBox` uses, so
 * the viewport (and the Machines card's picture) frame exactly what is drawn. The bbox is the union
 * of the boxes, which is what pins "scene bbox per placement" in `bedScene.spec.ts`.
 */

import type { FixtureRecord, BedProfile } from '@/platform/locationClient';
import type { MillProfile } from './machine';
import { LEDGE_STEP, LEDGE_WIDTH, VISE_BAR_HEIGHT, VISE_BODY_DEPTH } from './fixture';

/** A box in machine coordinates, with how it is drawn. */
export interface BedSceneBox {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
  /** `solid` = a measured/vendor/default figure; `dashed` = unmeasured, drawn "provisional". */
  kind: 'solid' | 'dashed';
  color: string;
  /** A short annotation the picture may print (e.g. "top not measured", "provisional"). */
  label?: string;
}

/** A datum drawn as a labelled point. */
export interface BedSceneDatum {
  id: string;
  position: [number, number, number];
  label: string;
}

export interface BedScene {
  boxes: BedSceneBox[];
  datums: BedSceneDatum[];
  /** The union of every box — what the camera frames. */
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface BedSceneInput {
  /** The machine RESOLVED against its own calibration read (`calibration.ts`). */
  mill: MillProfile;
  /** `machine.bedFixtures` — the accessory records a placement's shape comes from. */
  fixtures: FixtureRecord[];
  /** The profile being drawn. */
  profile: BedProfile;
}

// ── Provenance colour ──────────────────────────────────────────────────────────────────────────
//
// The design's four words, plus `unmeasured` for the dashed "provisional" case. A provenance string
// is `<word>[:<detail>]` (e.g. `measured:2026-10-13`); only the word before the first `:` decides.

/** The provenance word (everything before the first `:`), or `undefined` for no provenance. */
export function provenanceWord(provenance: string | undefined): string | undefined {
  if (provenance === undefined || provenance.length === 0) return undefined;
  const colon = provenance.indexOf(':');
  return colon === -1 ? provenance : provenance.slice(0, colon);
}

/** Whether a provenance word is a real statement (solid) or an absence (dashed "provisional"). */
export function provenanceKind(provenance: string | undefined): 'solid' | 'dashed' {
  const word = provenanceWord(provenance);
  return word === 'unmeasured' || word === undefined ? 'dashed' : 'solid';
}

/** The colour a provenance word draws in. Measured green, vendor blue, default grey, typed amber. */
export function provenanceColor(provenance: string | undefined): string {
  const word = provenanceWord(provenance);
  if (word === 'measured') return '#30a46c';
  if (word === 'vendor') return '#4cc3ff';
  if (word === 'typed') return '#f5a524';
  if (word === 'default') return '#9aa8c0';
  return '#8b8b94'; // unmeasured / none — the dashed provisional grey
}

// ── Provisional figures ─────────────────────────────────────────────────────────────────────────
//
// Each of these is an UNMEASURED, LABELLED assumption — revisit at the bench (#444's calipers list).
// They exist only so the picture can be drawn before the datum exists; none of them may feed a gate.

/** PROVISIONAL (#511): the bare aluminium bed's top, machine Z. Consistent with the fixture's
 * measured bracket seat (−70.2) on a 10 mm wasteboard (−80 + 10 ≈ −70). Revisit at the bench. */
export const BED_TOP_Z = -80;
/** PROVISIONAL (#511): the machine bed plate's thickness, mm. Revisit at the bench. */
export const BED_PLATE_THICKNESS = 10;
/** The bed plate's drawn colour — the machine frame, not a fixture. */
export const BED_COLOR = '#5b6470';
/** The anchor slot's size: "anchors 100 × 15" (`bed-profiles.md` §3 S0), the bracket's own arm. */
export const ANCHOR_SLOT_LENGTH = 100;
export const ANCHOR_SLOT_WIDTH = 15;
/** The anchor HOLE as drawn on the bed — a small point marker (the 100 × 15 arm is the bracket's). */
export const ANCHOR_HOLE = 8;
/** The locating pins' diameter: the vise sits on "its two 4×11 pins". */
export const PIN_DIAMETER = 4;
/** PROVISIONAL (#511): where the shared pin pair sits, machine XY. Revisit at the bench. */
export const PIN_PAIR: readonly [number, number][] = [
  [-100, -40],
  [-100, -160],
];
/** PROVISIONAL (#511): a top clamp's footprint defaults, until the calipers list replaces them. */
export const CLAMP_LENGTH = 30;
export const CLAMP_WIDTH = 15;
export const CLAMP_HEIGHT_ABOVE_PLATE = 12;

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

/** A number from a fixture's open map, or the labelled fallback (which the caller marks dashed). */
function num(map: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = map?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function box(
  id: string,
  min: [number, number, number],
  max: [number, number, number],
  kind: 'solid' | 'dashed',
  color: string,
  label?: string,
): BedSceneBox {
  return { id, min, max, kind, color, label };
}

/** The union of a list of boxes, or the empty box when there are none. */
export function boxesBounds(boxes: readonly BedSceneBox[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a]! < min[a]!) min[a] = b.min[a]!;
      if (b.max[a]! > max[a]!) max[a] = b.max[a]!;
    }
  }
  if (!Number.isFinite(min[0]!)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

// ── The surface ─────────────────────────────────────────────────────────────────────────────────

/** The machine Z of the top the fixtures stand on, and whether that is a measurement. */
export function surfaceTop(profile: BedProfile): { z: number; measured: boolean } {
  const surface = profile.surface;
  const datum = profile.datums.surfaceTopZ;
  if (datum !== null) return { z: datum.value, measured: true };
  // Nominal: the bed top, plus the surface's thickness when it is a board (open question E: the
  // bare bed has no thickness). PROVISIONAL — the caller draws it dashed, "top not measured".
  const thickness = surface.thickness ?? 0;
  return { z: BED_TOP_Z + thickness, measured: false };
}

/** How many of the surface's four unmeasured fields (material, length, width, position) are null. */
export function surfaceUnmeasuredCount(profile: BedProfile): number {
  const s = profile.surface;
  if (s.kind === 'bare-bed') return 0;
  let n = 0;
  if (s.material === null) n += 1;
  if (s.length === null) n += 1;
  if (s.width === null) n += 1;
  if (s.position === null) n += 1;
  return n;
}

// ── The scene ───────────────────────────────────────────────────────────────────────────────────

/**
 * The bed as drawn, in machine coordinates. The order of the boxes is the draw order (bed first,
 * then anchors and pins, the surface, then each placement on top), so a later box can sit on an
 * earlier one without hiding it.
 */
export function bedScene(input: BedSceneInput): BedScene {
  const { mill, fixtures, profile } = input;
  const boxes: BedSceneBox[] = [];

  const xMin = mill.envelope.x.min;
  const xMax = mill.envelope.x.max;
  const yMin = mill.envelope.y.min;
  const yMax = mill.envelope.y.max;

  // 1. The 200 × 200 bed plate.
  boxes.push(
    box('bed-plate', [xMin, yMin, BED_TOP_Z - BED_PLATE_THICKNESS], [xMax, yMax, BED_TOP_Z], 'solid', BED_COLOR),
  );

  // 2. The two anchor holes at the machine's own anchor positions (vendor) — small point markers;
  //    the 100 × 15 arm that seats there is the bracket placement's shape, not the hole.
  for (const [i, a] of [[1, mill.anchor1], [2, mill.anchor2]] as const) {
    const [ax, ay] = a;
    boxes.push(
      box(
        `anchor-${i}`,
        [ax - ANCHOR_HOLE / 2, ay - ANCHOR_HOLE / 2, BED_TOP_Z],
        [ax + ANCHOR_HOLE / 2, ay + ANCHOR_HOLE / 2, BED_TOP_Z + 1],
        'solid',
        provenanceColor('vendor'),
      ),
    );
  }

  // 3. The locating pin pair (provisional position).
  for (const [px, py] of PIN_PAIR) {
    boxes.push(
      box(
        `pin-${px}-${py}`,
        [px - PIN_DIAMETER / 2, py - PIN_DIAMETER / 2, BED_TOP_Z],
        [px + PIN_DIAMETER / 2, py + PIN_DIAMETER / 2, BED_TOP_Z + PIN_DIAMETER * 2.75],
        'dashed',
        provenanceColor(undefined),
        'provisional',
      ),
    );
  }

  // 4. The surface slab (nothing for the bare bed: the plate IS the surface, open question E).
  const surface = profile.surface;
  if (surface.kind !== 'bare-bed') {
    const top = surfaceTop(profile);
    const thickness = surface.thickness ?? 0;
    const length = surface.length ?? xMax - xMin; // nominal: the whole work area
    const width = surface.width ?? yMax - yMin;
    const [fx, fy] = surface.position?.frontLeft ?? [xMin, yMin];
    const fullySized = surface.length !== null && surface.width !== null && surface.position !== null;
    const kind: 'solid' | 'dashed' = top.measured && fullySized ? 'solid' : 'dashed';
    const label = top.measured ? (fullySized ? undefined : 'provisional size/position') : 'top: no reading';
    boxes.push(
      box(
        'surface',
        [fx, fy, top.z - thickness],
        [fx + length, fy + width, top.z],
        kind,
        top.measured ? '#8a93a3' : provenanceColor(undefined),
        label,
      ),
    );
  }

  // 5. Each placement, from its fixture's constants.
  for (const placement of profile.placements) {
    const fixture = fixtures.find((f) => f.id === placement.fixture);
    if (fixture === undefined) continue;
    switch (fixture.kind) {
      case 'vise':
        drawVise(boxes, placement, fixture, profile);
        break;
      case 'bracket':
        drawBracket(boxes, placement, fixture, profile, mill);
        break;
      case 'top-clamp':
        drawClamps(boxes, placement, fixture, profile);
        break;
      case 'rotary-module':
        drawRotary(boxes, profile);
        break;
      default:
        // Another accessory is additive; the picture draws what it can name and skips what it cannot.
        break;
    }
  }

  const datums = datumPoints(profile);

  return { boxes, datums, bbox: boxesBounds(boxes) };
}

// ── The vise (#508's drawn shape, in machine coordinates) ───────────────────────────────────────

function drawVise(
  boxes: BedSceneBox[],
  placement: BedProfile['placements'][number],
  fixture: FixtureRecord,
  profile: BedProfile,
): void {
  const jawBarWidth = num(fixture.constants, 'jawBarWidth', 10);
  const jawLength = num(fixture.constants, 'jawLength', 100);
  const barHeight = num(fixture.unit, 'jawBarHeight', VISE_BAR_HEIGHT);
  const frame = placement.frame;
  const surfaceZ = surfaceTop(profile).z;

  // The jaw tops: measured when the datum exists, else nominal (surface + bar height) — provisional.
  const jawTop = profile.datums.viseJawTopZ;
  const jawTopZ = jawTop !== null ? jawTop.value : surfaceZ + barHeight;
  const jawBottomZ = jawTopZ - barHeight;

  // The fixed jaw face X, measured by the registration (#475/#495) or provisional at the pins.
  const frameX = frame?.fixedJawFaceX ?? null;
  const frameY = frame?.jawStartY ?? null;
  const fixedJawFaceX = frameX ?? PIN_PAIR[0]![0];
  const jawStartY = frameY ?? PIN_PAIR[0]![1] - jawLength / 2;
  const placed = frameX !== null && frameY !== null && jawTop !== null;
  const jawKind: 'solid' | 'dashed' = placed ? 'solid' : 'dashed';
  const jawColor = provenanceColor(placement.provenance.fixedJawFaceX);

  // Fixed jaw bar (left).
  boxes.push(
    box(
      'pl-vise-fixed-jaw',
      [fixedJawFaceX - jawBarWidth, jawStartY, jawBottomZ],
      [fixedJawFaceX, jawStartY + jawLength, jawTopZ],
      jawKind,
      jawColor,
      placed ? undefined : 'provisional',
    ),
  );
  // The soft-jaw ledge (#208): a thin strip facing inward, `LEDGE_STEP` below the top.
  boxes.push(
    box(
      'pl-vise-fixed-ledge',
      [fixedJawFaceX, jawStartY, jawTopZ - LEDGE_STEP - LEDGE_STEP],
      [fixedJawFaceX + LEDGE_WIDTH, jawStartY + jawLength, jawTopZ - LEDGE_STEP],
      jawKind,
      jawColor,
    ),
  );

  // The moving jaw: where the operator left it. No stock, so the opening is the fixture's unmeasured
  // `maxOpening` when present, else a PROVISIONAL 60 mm opening — drawn dashed either way.
  const maxOpening = typeof fixture.unit?.maxOpening === 'number' ? fixture.unit.maxOpening : null;
  const opening = maxOpening ?? 60;
  const movingInnerX = fixedJawFaceX + opening;
  boxes.push(
    box(
      'pl-vise-moving-jaw',
      [movingInnerX, jawStartY, jawBottomZ],
      [movingInnerX + jawBarWidth, jawStartY + jawLength, jawTopZ],
      'dashed',
      jawColor,
      'provisional opening',
    ),
  );

  // The body below the bars — unmeasured height, drawn dashed "provisional".
  const bodyBottomZ = jawBottomZ - VISE_BODY_DEPTH;
  boxes.push(
    box(
      'pl-vise-body',
      [fixedJawFaceX - jawBarWidth - 5, jawStartY, bodyBottomZ],
      [movingInnerX + jawBarWidth + 5, jawStartY + jawLength, jawBottomZ],
      'dashed',
      provenanceColor(undefined),
      'provisional',
    ),
  );
}

// ── The bracket ─────────────────────────────────────────────────────────────────────────────────

function drawBracket(
  boxes: BedSceneBox[],
  placement: BedProfile['placements'][number],
  fixture: FixtureRecord,
  profile: BedProfile,
  mill: MillProfile,
): void {
  // The bracket's arms come from the fixture's constants (vendor: "config.anchor_length/width").
  const armLength = num(fixture.constants, 'armLength', ANCHOR_SLOT_LENGTH);
  const armWidth = num(fixture.constants, 'armWidth', ANCHOR_SLOT_WIDTH);
  const height = typeof fixture.constants?.height === 'number' ? fixture.constants.height : null;

  // The anchor is the machine's own read; the placement's `where.anchor` says which (1 or 2).
  const anchor = placement.where.anchor === 2 ? mill.anchor2 : mill.anchor1;
  const [ax, ay] = anchor;
  const seat = profile.datums.bracketSeatZ;
  const topZ = seat !== null ? seat.value : BED_TOP_Z + (height ?? 12);
  const heightKind: 'solid' | 'dashed' = height !== null && seat !== null ? 'solid' : 'dashed';
  const color = provenanceColor('vendor');

  // Two arms crossing at the inside corner (the anchor): one along X, one along Y.
  boxes.push(
    box(
      'pl-bracket-arm-x',
      [ax - armLength / 2, ay - armWidth / 2, BED_TOP_Z],
      [ax + armLength / 2, ay + armWidth / 2, topZ],
      heightKind,
      color,
      heightKind === 'dashed' ? 'provisional' : undefined,
    ),
  );
  boxes.push(
    box(
      'pl-bracket-arm-y',
      [ax - armWidth / 2, ay - armLength / 2, BED_TOP_Z],
      [ax + armWidth / 2, ay + armLength / 2, topZ],
      heightKind,
      color,
      heightKind === 'dashed' ? 'provisional' : undefined,
    ),
  );
}

// ── The top clamps ──────────────────────────────────────────────────────────────────────────────

function drawClamps(
  boxes: BedSceneBox[],
  placement: BedProfile['placements'][number],
  fixture: FixtureRecord,
  profile: BedProfile,
): void {
  const length = num(fixture.constants, 'length', CLAMP_LENGTH);
  const width = num(fixture.constants, 'width', CLAMP_WIDTH);
  const height = num(fixture.constants, 'heightAbovePlate', CLAMP_HEIGHT_ABOVE_PLATE);
  const count = placement.count ?? 1;
  const topZ = surfaceTop(profile).z + height;
  const color = provenanceColor('default');
  const kind: 'solid' | 'dashed' = provenanceKind(fixture.provenance.length);

  // Free placement: a row of `count` footprints across the back edge of the work area (PROVISIONAL
  // position until the wizard places them properly).
  for (let i = 0; i < count; i++) {
    const cx = -200 + ((i + 1) * 200) / (count + 1);
    boxes.push(
      box(
        `pl-clamp-${i + 1}`,
        [cx - length / 2, -200 + 5, surfaceTop(profile).z],
        [cx + length / 2, -200 + 5 + width, topZ],
        kind,
        color,
        kind === 'dashed' ? 'provisional' : undefined,
      ),
    );
  }
}

// ── The 4th-axis module ─────────────────────────────────────────────────────────────────────────

function drawRotary(
  boxes: BedSceneBox[],
  profile: BedProfile,
): void {
  // The axis is the machine's rotary offset (#238), the chuck body is unmeasured.
  const axis = profile.datums.rotaryAxis;
  const surfaceZ = surfaceTop(profile).z;
  const axisZ = axis !== null ? axis.value : surfaceZ + 40; // PROVISIONAL axis height
  const kind: 'solid' | 'dashed' = axis !== null ? 'solid' : 'dashed';
  const color = provenanceColor(axis !== null ? 'measured' : undefined);

  // A chuck body centred on the shared pins' midpoint, plus the axis as a thin bar along Y.
  const cy = (PIN_PAIR[0]![1] + PIN_PAIR[1]![1]) / 2;
  boxes.push(
    box(
      'pl-rotary-chuck',
      [PIN_PAIR[0]![0] - 20, cy - 40, surfaceZ],
      [PIN_PAIR[0]![0] + 20, cy + 40, axisZ],
      kind,
      color,
      kind === 'dashed' ? 'provisional' : undefined,
    ),
  );
  boxes.push(
    box(
      'pl-rotary-axis',
      [PIN_PAIR[0]![0], -200, axisZ - 2],
      [PIN_PAIR[0]![0] + 4, 0, axisZ + 2],
      kind,
      color,
      'rotary axis',
    ),
  );
}

// ── Datums ─────────────────────────────────────────────────────────────────────────────────────

/** Each measured datum as a labelled point, with its machine Z (and its date in the caller's words). */
function datumPoints(profile: BedProfile): BedSceneDatum[] {
  const out: BedSceneDatum[] = [];
  const d = profile.datums;
  if (d.surfaceTopZ !== null) {
    out.push({
      id: 'datum-surface',
      position: [d.surfaceTopZ.at?.[0] ?? 0, d.surfaceTopZ.at?.[1] ?? 0, d.surfaceTopZ.value],
      label: `surface ${fmt(d.surfaceTopZ.value)}`,
    });
  }
  if (d.viseJawTopZ !== null) {
    out.push({
      id: 'datum-jaw',
      position: [d.viseJawTopZ.at?.[0] ?? 0, d.viseJawTopZ.at?.[1] ?? 0, d.viseJawTopZ.value],
      label: `jaw top ${fmt(d.viseJawTopZ.value)}`,
    });
  }
  if (d.bracketSeatZ !== null) {
    out.push({
      id: 'datum-bracket',
      position: [d.bracketSeatZ.at?.[0] ?? 0, d.bracketSeatZ.at?.[1] ?? 0, d.bracketSeatZ.value],
      label: `bracket seat ${fmt(d.bracketSeatZ.value)}`,
    });
  }
  if (d.rotaryAxis !== null) {
    out.push({
      id: 'datum-rotary',
      position: [d.rotaryAxis.at?.[0] ?? 0, d.rotaryAxis.at?.[1] ?? 0, d.rotaryAxis.value],
      label: `rotary axis ${fmt(d.rotaryAxis.value)}`,
    });
  }
  return out;
}

/** `-70.2` — trailing zeros dropped, like every other printed figure (`fixture.ts`'s `fmtMm`). */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}
