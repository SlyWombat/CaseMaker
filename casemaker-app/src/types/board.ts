import type { Mm } from './units';

export type ComponentKind =
  | 'usb-c'
  | 'usb-a'
  | 'usb-b'
  | 'micro-usb'
  | 'hdmi'
  | 'micro-hdmi'
  | 'barrel-jack'
  | 'ethernet-rj45'
  | 'gpio-header'
  | 'sd-card'
  | 'flat-cable'
  | 'fan-mount'
  | 'text-label'
  | 'antenna-connector'
  | 'custom';

export type CutoutShape = 'rect' | 'round';

export type Facing = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export interface MountingHole {
  id: string;
  x: Mm;
  y: Mm;
  diameter: Mm;
}

export interface BoardComponent {
  id: string;
  kind: ComponentKind;
  position: { x: Mm; y: Mm; z: Mm };
  size: { x: Mm; y: Mm; z: Mm };
  facing?: Facing;
  cutoutMargin?: Mm;
  cutoutShape?: CutoutShape;
  /** Optional procedural-fixture id (e.g. 'xlr-3', 'audio-jack-3-5'). When
   * absent, the placeholder falls back to the component's `kind`-based shape. */
  fixtureId?: string;
}

/** A thin cantilever snap clip that retains a secondary board's edge. */
export interface BoardClip {
  /** Which board edge the clip sits just outboard of and hooks inward over. */
  edge: '+x' | '-x' | '+y' | '-y';
  /** Position along that edge, measured from the board's min corner (mm). */
  offset: Mm;
  /** Clip width along the edge (mm). Defaults to a nominal ~6 mm; set small to
   * squeeze into a narrow gap between edge components. */
  width?: Mm;
  /** 'clip' (default): two-jaw catch — shelf + snap finger over the board.
   * 'shelf': support tab only — a solid pedestal from the wall to `reach`
   * under the board, floor to board underside, NO finger. For an end with
   * no room above the board (e.g. the C61's overhanging PCB antenna). */
  style?: 'clip' | 'shelf';
  /** How far the bottom jaw reaches in under the board (mm). Defaults to the
   * snap-finger overhang (~1.2); support tabs want more (C61 antenna end: 10). */
  reach?: Mm;
}

/**
 * A second PCB held above the case floor by thin snap clips (no screws). Used
 * for daughterboards that co-locate in the same case — e.g. SlyTherm's MSR-2
 * mmWave module, held 10 mm up with its radar facing the floor/front.
 */
export interface SecondaryBoardMount {
  id: string;
  /** Origin-relative XY of the board's min corner (mm). */
  position: { x: Mm; y: Mm };
  /** Board footprint + thickness (mm). */
  size: { x: Mm; y: Mm; z: Mm };
  /** Gap from the case floor top to the board's underside (mm). */
  standoffHeight: Mm;
  /** How far each clip hooks inward over the board top (mm). */
  overhang?: Mm;
  clips: BoardClip[];
}

/**
 * A finished module in a vendor shell, described well enough to mount it.
 *
 * Z convention matches the physical stack, measured from the FRONT face
 * (glass) backwards:
 *   0 .. flangeThickness                     front flange (= pcb.size x/y outline)
 *   flangeThickness .. + body.depth          rear body (smaller, centred-ish)
 * Mounting bosses stand on the flange's REAR face, inside the rim left over
 * around the rear body, and are `bossHeight` tall — so they usually sit
 * recessed relative to the rear body's back face.
 */
export interface EnclosureModule {
  /** Thickness of the front flange plate (the full outline). */
  flangeThickness: Mm;
  /** Raised rear body, origin-relative to the module outline's min corner. */
  body: { x: Mm; y: Mm; width: Mm; height: Mm; depth: Mm };
  /** Outer diameter of each mounting boss (positions come from mountingHoles). */
  bossDiameter: Mm;
  /** How far each boss stands proud of the flange's rear face. */
  bossHeight: Mm;
}

export type MeasurementMethod =
  | 'datasheet'
  | 'open-source-cad'
  | 'physical-measurement';

export interface BoardVisualAssets {
  /** Path under public/ to a glTF/GLB 3D model. */
  glb?: string;
  /** Path under public/ to a top-down PNG/JPG. */
  topImage?: string;
  /** Path under public/ to a side-view PNG/JPG. */
  sideImage?: string;
  /** SPDX expression or URL to manufacturer license. */
  license?: string;
  /** Source of the assets (e.g. manufacturer doc URL). */
  sourceUrl?: string;
}

export interface BoardProfile {
  id: string;
  name: string;
  manufacturer: string;
  pcb: { size: { x: Mm; y: Mm; z: Mm } };
  mountingHoles: MountingHole[];
  components: BoardComponent[];
  defaultStandoffHeight: Mm;
  recommendedZClearance: Mm;
  /** Board-retention seat shoulder. When true AND boardRetention='snap', the
   * snap compiler adds a raised perimeter rim that brings the cavity walls in
   * to the PCB/glass footprint over the seat height, so a face-down panel
   * seats in a snug pocket instead of floating in the internal-clearance gap.
   * Needed when clearance/side exceeds the finger overhang (e.g. the
   * ESP32-S3-Touch-LCD-4.3B glass would otherwise slip past the fingers). */
  retentionShoulder?: boolean;
  /** Scope board-retention (snap fingers + seat shoulder) to this sub-rectangle
   * of the PCB (origin-relative mm) instead of the full footprint. Used when the
   * board is extended past the retained panel (e.g. SlyTherm extends +X for the
   * MSR-2 bay) so the screen's rim/fingers stay on the screen and don't wrap the
   * extension. On a side whose footprint edge is far from the cavity wall, the
   * shoulder becomes a standalone internal rib instead of filling to the wall. */
  retentionFootprint?: { x: Mm; y: Mm; width: Mm; height: Mm };
  /** Explicit board-retention clip placements (edge + offset from the
   * retention footprint's min corner along that edge). Overrides the default
   * one-clip-per-wall-center layout when the edge centers are occupied —
   * headers flush to the edge, USB stacks, an antenna overhang. Each clip is
   * a two-jaw catch: a shelf the board rests on plus the ramped finger above,
   * separated by the PCB thickness, carried on a spine grounded to the floor
   * (so a clip far from a wall never floats in free space). */
  retentionClips?: BoardClip[];
  /** Secondary boards held on snap clips above the floor (e.g. SlyTherm MSR-2). */
  secondaryBoardMounts?: SecondaryBoardMount[];
  source?: string;
  /** Independent confirmation of dimensions (e.g., open-source CAD repo). */
  crossReference?: string;
  /** Datasheet revision string, e.g. "Rev 1.4 — 2023-08". */
  datasheetRevision?: string;
  /** Set when this "board" is not a bare PCB but a FINISHED module in its own
   * shell (e.g. the Guition JC4880P443C touch panel). The case archetypes that
   * hold such a module — the desk stand — need its shell geometry, not a
   * cavity: pcb.size is the module's overall outline, and this block describes
   * the shell's front flange, the rear body that must pass through a frame's
   * opening, and the mounting bosses that `mountingHoles` locates. */
  enclosure?: EnclosureModule;
  measurementMethod?: MeasurementMethod;
  visualAssets?: BoardVisualAssets;
  builtin: boolean;
  /** Issue #71 — set when this profile is a clone of a built-in. HAT
   * compatibility checks accept the clonedFrom id as well as `id` so users
   * don't lose shield compatibility just by cloning the board for editing. */
  clonedFrom?: string;
}
