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
