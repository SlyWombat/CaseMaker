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
  /** Secondary boards held on snap clips above the floor (e.g. SlyTherm MSR-2). */
  secondaryBoardMounts?: SecondaryBoardMount[];
  source?: string;
  /** Independent confirmation of dimensions (e.g., open-source CAD repo). */
  crossReference?: string;
  /** Datasheet revision string, e.g. "Rev 1.4 — 2023-08". */
  datasheetRevision?: string;
  measurementMethod?: MeasurementMethod;
  visualAssets?: BoardVisualAssets;
  builtin: boolean;
  /** Issue #71 — set when this profile is a clone of a built-in. HAT
   * compatibility checks accept the clonedFrom id as well as `id` so users
   * don't lose shield compatibility just by cloning the board for editing. */
  clonedFrom?: string;
}
