import { z } from 'zod';
import { boardProfileSchema } from '@/library/schema';
import { hatProfileSchema } from '@/library/hatSchema';
import { displayProfileSchema } from '@/library/displaySchema';

const xyzSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Issue #148 — the bed, shared by `Project.printer` (the new home) and the
 *  deprecated `case.rack.printer` (the old one). Both must parse. */
const printerVolumeSchema = z.object({
  preset: z.string().optional(),
  x: z.number().positive(),
  y: z.number().positive(),
  z: z.number().positive(),
});

/** Issue #153 — print-fit variant (see `types/snap.ts`). Shared by the
 *  case-level default, the per-catch override, and the rack. */
const fitVariantSchema = z.enum(['tight', 'standard', 'loose']);

export const caseParamsSchema = z.object({
  wallThickness: z.number().positive(),
  floorThickness: z.number().positive(),
  lidThickness: z.number().positive(),
  cornerRadius: z.number().nonnegative(),
  internalClearance: z.number().nonnegative(),
  clearanceTweaks: z
    .object({
      xMin: z.number().nonnegative(),
      xMax: z.number().nonnegative(),
      yMin: z.number().nonnegative(),
      yMax: z.number().nonnegative(),
    })
    .optional(),
  zClearance: z.number().nonnegative(),
  joint: z.preprocess(
    (v) => (v === 'sliding' ? 'flat-lid' : v),
    z.enum(['snap-fit', 'screw-down', 'flat-lid']),
  ),
  lidRecess: z.boolean().optional(),
  /** Pelican shell-lid cavity height (mm). 0 / undefined = flat-plate lid (legacy). */
  lidCavityHeight: z.number().nonnegative().optional(),
  /** How the board is retained — independent of the lid's `joint`. */
  boardRetention: z.enum(['screws', 'snap', 'press-fit', 'none']).optional(),
  extraCavityZ: z.number().nonnegative().optional(),
  snapType: z.enum(['barb', 'full-lid']).optional(),
  // Issue #153 — project-level print-fit variant for the snap interfaces
  // (snap catches + board snap clips). Optional so legacy projects load
  // unchanged (v7 hinge precedent); absent resolves to 'tight' (the
  // as-designed number) at the compiler boundary.
  fit: fitVariantSchema.optional(),
  ventilation: z.object({
    // Issue #75 — surfaces the vent pattern is cut into. Optional so legacy
    // projects load with no migration; compiler defaults to ['back'].
    surfaces: z
      .array(z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']))
      .optional(),
    enabled: z.boolean(),
    pattern: z.enum(['none', 'slots', 'hex', 'chevron']),
    coverage: z.number().min(0).max(1),
  }),
  bosses: z.object({
    enabled: z.boolean(),
    insertType: z.enum(['self-tap', 'heat-set-m2.5', 'heat-set-m3', 'pass-through', 'none']),
    outerDiameter: z.number().positive(),
    holeDiameter: z.number().positive(),
    // Issue #104 — 'bottom' (default) anchors bosses to the case floor;
    // 'top' anchors them to the lid underside, with a tapered support
    // column on the inside wall providing material continuity. Optional
    // so legacy projects load as 'bottom' without a migration.
    position: z.enum(['bottom', 'top']).optional(),
  }),
  // Issue #107 — waterproof gasket. Closed-loop channel cut into the rim
  // top face plus a matching tongue on the lid underside. Optional so
  // legacy projects load with no seal geometry. Forces lidRecess=true at
  // the UI layer when enabled.
  // Desk-stand archetype: frame + tilted foot, no lid. Optional so legacy
  // projects load unchanged; absent/disabled = normal shell+lid box.
  // Mini-rack archetype (types/rack.ts): parametric rack ASSEMBLY — side
  // panels + top/bottom + accessories — replacing the shell+lid pipeline.
  // Optional so legacy projects load with no migration (v7 hinge precedent).
  rack: z
    .object({
      enabled: z.boolean(),
      width: z.number().positive(),
      depth: z.number().positive(),
      slots: z.number().int().min(2).max(40),
      // Deprecated home (#148) — the bed now lives on the project; still parsed
      // so pre-#148 files load, and `resolvePrinter` reads it as a fallback.
      printer: printerVolumeSchema.optional(),
      wallMount: z.enum(['none', 'ears', 'cleat', 'keyhole']).optional(),
      assembledExport: z.boolean().optional(),
      floorRibs: z.boolean().optional(),
      cableNotches: z
        .object({
          plate: z.enum(['top', 'bottom', 'both']),
          count: z.number().int().min(1).max(12),
          width: z.number().positive(),
          depth: z.number().positive(),
        })
        .optional(),
      accessories: z
        .array(
          z.object({
            id: z.string(),
            type: z.enum(['blank', 'shelf', 'keystone', 'cable-tray']),
            slots: z.number().int().min(1).max(12).optional(),
            shelfDepth: z.union([z.number().positive(), z.literal('full')]).optional(),
            frontPlate: z.boolean().optional(),
            vented: z.boolean().optional(),
          }),
        )
        .optional(),
      fans: z
        .array(
          z.object({
            id: z.string(),
            side: z.enum(['left', 'right']),
            size: z.union([
              z.literal(40),
              z.literal(60),
              z.literal(80),
              z.literal(92),
              z.literal(120),
            ]),
            y: z.number().positive(),
            z: z.number().positive(),
          }),
        )
        .optional(),
      // Issue #153 — plate-tab ledge fit. Optional; absent = 'tight'.
      fit: fitVariantSchema.optional(),
    })
    .optional(),
  stand: z
    .object({
      enabled: z.boolean(),
      mount: z.enum(['desk', 'wall', 'slider', 'pocket']).optional(),
      shroudDepth: z.number().positive().optional(),
      shroudWall: z.number().positive().optional(),
      plateThickness: z.number().positive().optional(),
      plateBorder: z.number().positive().optional(),
      drywallScrewDiameter: z.number().positive().optional(),
      drywallHeadDiameter: z.number().positive().optional(),
      tiltAngleDeg: z.number().min(0).max(60),
      frameThickness: z.number().positive(),
      bezelMargin: z.number().nonnegative(),
      openingClearance: z.number().nonnegative(),
      screwHoleDiameter: z.number().positive(),
      baseDepth: z.number().positive(),
      baseThickness: z.number().positive(),
      gussetThickness: z.number().positive(),
      gussetHeightFraction: z.number().min(0.1).max(1),
    })
    .optional(),
  seal: z
    .object({
      enabled: z.boolean(),
      profile: z.enum(['flat', 'o-ring']),
      width: z.number().positive(),
      depth: z.number().positive(),
      compressionFactor: z.number().min(0.1).max(0.4),
      gasketMaterial: z.enum(['tpu', 'eva', 'epdm']),
      // Issue #117 — closure style. Absent = 'recess' (issued #30 behaviour).
      mode: z.enum(['recess', 'clamshell']).optional(),
      // Issue #113 — per-printer gasket clearance tolerance.
      gasketClearance: z.number().nonnegative().max(1).optional(),
    })
    .optional(),
  // Issue #109 — spring-cam locking latches. Optional array; legacy
  // projects load with no latches.
  latches: z
    .array(
      z.object({
        id: z.string(),
        wall: z.enum(['+x', '-x', '+y', '-y']),
        uPosition: z.number(),
        enabled: z.boolean(),
        throw: z.number().positive(),
        width: z.number().positive(),
        height: z.number().positive(),
        // Issue #113 — per-printer cam/striker engagement tolerance.
        tolerance: z.number().nonnegative().max(1).optional(),
      }),
    )
    .optional(),
  // Issue #111 — rugged exterior. Optional.
  rugged: z
    .object({
      enabled: z.boolean(),
      corners: z.object({
        enabled: z.boolean(),
        radius: z.number().positive(),
        // Issue #121 — discrete cap height (top + bottom). Optional;
        // defaults to 12 mm at the compiler boundary.
        capHeight: z.number().positive().optional(),
        flexBumper: z.boolean(),
      }),
      ribbing: z.object({
        enabled: z.boolean(),
        direction: z.enum(['vertical', 'horizontal']),
        ribCount: z.number().int().min(0),
        ribDepth: z.number().positive(),
        clearBand: z.number().nonnegative(),
      }),
      feet: z.object({
        enabled: z.boolean(),
        pads: z.union([z.literal(4), z.literal(6)]),
        padDiameter: z.number().positive(),
        padHeight: z.number().positive(),
      }),
    })
    .optional(),
  snapCatches: z
    .array(
      z.object({
        id: z.string(),
        wall: z.enum(['+x', '-x', '+y', '-y']),
        uPosition: z.number(),
        enabled: z.boolean(),
        // Issue #69 + #78 — barb cross-section. Defaults to 'hook' at parse
        // time so older projects load with an explicit value (avoids the
        // UI-shows-wrong-option bug where the select didn't reflect the
        // engine's compile-time fallback).
        barbType: z
          .enum(['hook', 'asymmetric-ramp', 'symmetric-ramp', 'half-round', 'ball-socket'])
          .default('hook'),
        insertionRampDeg: z.number().optional(),
        retentionRampDeg: z.number().optional(),
        // Issue #64 — which part holds the flexing cantilever. Optional so
        // legacy projects load with the implicit 'lid' default; geometry
        // dispatch keys off the .default() at parse time.
        cantileverOn: z.enum(['lid', 'case']).default('lid'),
        // Issue #153 — per-catch fit override; absent inherits case.fit.
        fit: fitVariantSchema.optional(),
      }),
    )
    .optional(),
  // Issue #76 — freeform user-placed cutouts. Optional so legacy projects
  // load with no migration; a missing field is treated as an empty list.
  customCutouts: z
    .array(
      z.object({
        id: z.string(),
        face: z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']),
        shape: z.enum(['rect', 'round', 'slot']),
        u: z.number(),
        v: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        rotationDeg: z.number().optional(),
        enabled: z.boolean(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  // Issue #148 — offer a bolted split of the shell when it is over the bed.
  // Optional (v14 stamps it absent), so legacy projects load unchanged and a
  // project that never asks for the split builds none of its geometry.
  splitForPrint: z.boolean().optional(),
  // Issue #152 — magnet pockets cut into a face for magnetic retention.
  // Optional so legacy projects load with no migration (v7 hinge precedent);
  // a missing field is treated as an empty list. Geometry lives in
  // engine/compiler/fasteners' MAGNETS table, not here.
  magnetPockets: z
    .array(
      z.object({
        id: z.string(),
        face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
        u: z.number(),
        v: z.number(),
        size: z.enum(['6x2', '8x3', '10x2']),
        retention: z.enum(['glue', 'press', 'captured']).optional(),
        enabled: z.boolean(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  // Issue #92 — optional barrel hinge. Side faces only; one per case in v1.
  // Missing on disk = no hinge emitted.
  hinge: z
    .object({
      id: z.string(),
      style: z.enum([
        'external-pin',
        'print-in-place',
        // Issue #110 — protective-case styles.
        'piano-continuous',
        'piano-segmented',
        'pip-pivot',
        // Issue #114 — two M3 screws, one at each end of the face. Widening
        // this enum needs no schema bump: no older file can contain the value,
        // so every existing project still parses unchanged.
        'hardware-screw',
      ]),
      face: z.enum(['+x', '-x', '+y', '-y']),
      numKnuckles: z.number().int().min(3),
      knuckleOuterDiameter: z.number().positive(),
      pinDiameter: z.number().positive(),
      knuckleClearance: z.number().nonnegative(),
      positioning: z.enum(['continuous', 'pair-at-ends', 'centered']),
      hingeLength: z.number().positive(),
      stopAngle: z.number().optional(),
      pinMode: z.enum(['separate', 'print-in-place']),
      enabled: z.boolean(),
    })
    .optional(),
  // Issue #167 — badge archetype (types/badge.ts). Optional so legacy projects
  // load unchanged (the v7 hinge precedent); absent/disabled = normal
  // shell+lid box. The pocket is `.nullable()` rather than optional because
  // the compiler distinguishes "no pocket" from "a pocket of size zero".
  badge: z
    .object({
      enabled: z.boolean(),
      width: z.number().positive(),
      height: z.number().positive(),
      thickness: z.number().positive(),
      cornerRadius: z.number().nonnegative(),
      splitHeight: z.number().positive(),
      magnetPocket: z
        .object({
          length: z.number().positive(),
          width: z.number().positive(),
          depth: z.number().positive(),
        })
        .nullable(),
      bottomExtruder: z.number().int().positive(),
      topExtruder: z.number().int().positive(),
    })
    .optional(),
  // Issue #158 — tool-insert holder archetype (types/insert.ts). Optional so
  // legacy projects load unchanged (the v7 hinge precedent); absent/disabled =
  // normal shell+lid box. A single `insert-plate` node, pockets subtracted.
  insert: z
    .object({
      enabled: z.boolean(),
      width: z.number().positive(),
      depth: z.number().positive(),
      thickness: z.number().positive(),
      cornerRadius: z.number().nonnegative(),
      clearance: z.number().nonnegative(),
      chamfer: z.number().nonnegative(),
      floor: z.number().nonnegative(),
      pitchGap: z.number().nonnegative(),
      // Issue #262 — tool retention. Optional and absent = 'friction', the
      // geometry every project saved before it existed has, so no migration.
      retention: z.enum(['friction', 'magnet']).optional(),
      magnetSize: z.enum(['6x2', '8x3', '10x2']).optional(),
      items: z.array(
        z.object({
          id: z.string(),
          shape: z.enum(['round', 'hex']),
          size: z.number().positive(),
          depth: z.number().positive(),
        }),
      ),
    })
    .optional(),
});

const portPlacementSchema = z.object({
  id: z.string(),
  sourceComponentId: z.string().nullable(),
  kind: z.enum([
    'usb-c',
    'usb-a',
    'usb-b',
    'micro-usb',
    'hdmi',
    'micro-hdmi',
    'barrel-jack',
    'ethernet-rj45',
    'gpio-header',
    'sd-card',
    'flat-cable',
    'fan-mount',
    'text-label',
    'antenna-connector',
    'custom',
  ]),
  position: xyzSchema,
  size: xyzSchema,
  facing: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  cutoutMargin: z.number().nonnegative(),
  locked: z.boolean(),
  enabled: z.boolean(),
  cutoutShape: z.enum(['rect', 'round']).optional(),
});

const externalAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.enum(['stl', '3mf']),
  data: z.string(),
  transform: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    scale: z.number(),
  }),
  visibility: z.enum(['reference', 'subtract', 'union']),
});

const hatPlacementSchema = z.object({
  id: z.string(),
  hatId: z.string(),
  stackIndex: z.number().int().nonnegative(),
  liftOverride: z.number().optional(),
  offsetOverride: z.object({ x: z.number(), y: z.number() }).optional(),
  mountingPositionId: z.string().optional(),
  ports: z.array(portPlacementSchema),
  enabled: z.boolean(),
});

const mountingFeatureSchema = z.object({
  id: z.string(),
  type: z.enum([
    // Issue #80 — extended type set. Internal mounts live on the cavity
    // floor; external mounts extrude past the case envelope.
    'screw-tab',
    'end-flange',
    'zip-tie-slot',
    'vesa-mount',
    'extrusion-mount',
    'aligned-standoff',
    'saddle',
  ]),
  // Issue #80 — required field. .default('external') so v5-vintage
  // entries (no mountClass on disk) load with the right class — every
  // pre-#80 mounting type is external by definition.
  mountClass: z.enum(['external', 'internal']).default('external'),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  rotation: z.number(),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  enabled: z.boolean(),
  presetId: z.string().optional(),
});

const displayPlacementSchema = z.object({
  id: z.string(),
  displayId: z.string(),
  framing: z.enum([
    'top-window',
    'recessed-bezel',
    'flush-glass',
    'hood-shade',
    'tilted',
    'removable-cap',
    'bracket-only',
  ]),
  tiltAngle: z.number().optional(),
  hoodHeight: z.number().optional(),
  bezelInset: z.number().optional(),
  offset: z.object({ x: z.number(), y: z.number() }),
  hostSupport: z.enum(['gpio-only', 'case-rim-bracket', 'under-board-posts', 'full-cradle']),
  enabled: z.boolean(),
});

// Issue #54 — schema authoring uses .extend() chains instead of redeclaring
// the full field set per version. Each version adds (or shadows) what's new
// since the previous; v1 carries the common fields, every later vN extends
// vN-1. Keeps the diff between versions surgical and prevents copy-paste
// drift when a field gets renamed (the original v1..v5 redeclaration style
// hid that drift).

const projectV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  board: boardProfileSchema,
  case: caseParamsSchema,
  ports: z.array(portPlacementSchema),
  externalAssets: z.array(externalAssetSchema),
});

const projectV2Schema = projectV1Schema.extend({
  schemaVersion: z.literal(2),
  hats: z.array(hatPlacementSchema),
  customHats: z.array(hatProfileSchema),
});

const projectV3Schema = projectV2Schema.extend({
  schemaVersion: z.literal(3),
  mountingFeatures: z.array(mountingFeatureSchema),
  display: displayPlacementSchema.nullable(),
  customDisplays: z.array(displayProfileSchema),
});

const fanMountSchema = z.object({
  id: z.string(),
  size: z.enum(['30x30x10', '40x40x10', '40x40x20', '50x50x10', '60x60x15']),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  grille: z.enum(['cross', 'spiral', 'honeycomb', 'concentric', 'open']),
  bladeStandoff: z.number().nonnegative(),
  bossesEnabled: z.boolean(),
  enabled: z.boolean(),
});

const textLabelSchema = z.object({
  id: z.string(),
  text: z.string(),
  // Issue #169 — a font registry id (bundled or a project customFonts id), no longer a
  // two-value enum. Legacy 'sans-default' / 'mono-default' remain valid ids.
  font: z.string(),
  weight: z.enum(['regular', 'bold']),
  size: z.number().positive(),
  face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']),
  position: z.object({ u: z.number(), v: z.number() }),
  rotation: z.number(),
  depth: z.number().positive(),
  mode: z.enum(['engrave', 'emboss']),
  enabled: z.boolean(),
  attachedToPortId: z.string().optional(),
});

const projectV4Schema = projectV3Schema.extend({
  schemaVersion: z.literal(4),
  fanMounts: z.array(fanMountSchema),
  textLabels: z.array(textLabelSchema),
});

const antennaPlacementSchema = z.object({
  id: z.string(),
  type: z.enum(['internal', 'rpi-external', 'external-mount']),
  enabled: z.boolean(),
  facing: z.enum(['+x', '-x', '+y', '-y']).optional(),
  uOffset: z.number().optional(),
});

const projectV5Schema = projectV4Schema.extend({
  schemaVersion: z.literal(5),
  antennas: z.array(antennaPlacementSchema),
});

// Issue #80 — v6 differs from v5 only in that mountingFeatures items now
// REQUIRE `mountClass`. The schema's .default('external') already fills
// missing values on parse, so the wire-format change is technically
// backwards-compatible; the version bump is bookkeeping for "this project
// understands the internal/external split."
const projectV6Schema = projectV5Schema.extend({
  schemaVersion: z.literal(6),
});

// Issue #92 — v7 adds the optional `case.hinge` field. The schema diff is
// purely additive (the new field lives on caseParamsSchema as `.optional()`),
// so the wire format stays backwards-compatible; the bump is bookkeeping for
// "this project understands the hinge feature." A v6 project on disk parses
// against v6, then this transform stamps schemaVersion: 7 — `hinge` is just
// absent on the resulting object (i.e. `undefined`, no hinge emitted).
const projectV7Schema = projectV6Schema.extend({
  schemaVersion: z.literal(7),
});

const customFontSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.string(),
});

// Issue #169 — v8 adds `customFonts` (user-supplied TTFs embedded as base64) and
// widens textLabel.font from a two-value enum to a registry id string. Older
// projects get customFonts: [] in the transform below; their 'sans-default' /
// 'mono-default' font ids are still valid registry ids, so no label rewrite.
const projectV8Schema = projectV7Schema.extend({
  schemaVersion: z.literal(8),
  customFonts: z.array(customFontSchema).default([]),
});

// Issue #152 — v9 adds the optional `case.magnetPockets` field. Like the v7
// hinge bump it is purely additive (the field is `.optional()` on
// caseParamsSchema, which every version embeds), so the wire format stays
// backwards-compatible; the bump is bookkeeping for "this project understands
// magnet pockets." A v8 project on disk parses against v8, then this transform
// stamps schemaVersion: 10 — `magnetPockets` is simply absent (undefined, no
// pockets emitted).
const projectV9Schema = projectV8Schema.extend({
  schemaVersion: z.literal(9),
});

// Issue #153 — v10 adds the optional `case.fit`, per-`SnapCatch.fit`, and
// `case.rack.fit` fields (fit variants). Like the v7 hinge bump it is purely
// additive (all three live on schemas every version embeds as `.optional()`),
// so the wire format stays backwards-compatible; the bump is bookkeeping for
// "this project understands fit variants." A v9 project on disk parses against
// v9, then this transform stamps schemaVersion: 10 — every `fit` is simply
// absent (undefined, resolving to 'tight' at the compiler boundary).
const projectV10Schema = projectV9Schema.extend({
  schemaVersion: z.literal(10),
});

// Issue #167 — v11 adds the optional `case.badge` field. Like the v7 hinge bump
// it is purely additive (the field lives on caseParamsSchema as `.optional()`,
// which every version embeds), so the wire format stays backwards-compatible;
// the bump is bookkeeping for "this project understands the badge archetype." A
// v10 project on disk parses against v10, then the transform below stamps
// schemaVersion: 11 — `badge` is simply absent (undefined, no badge emitted).
const projectV11Schema = projectV10Schema.extend({
  schemaVersion: z.literal(11),
});

// Issue #158 — v12 adds the optional `case.insert` field. Like the v7 hinge
// bump it is purely additive (the field lives on caseParamsSchema as
// `.optional()`, which every version embeds), so the wire format stays
// backwards-compatible; the bump is bookkeeping for "this project understands
// the tool-insert archetype." A v11 project on disk parses against v11, then
// the transform below stamps schemaVersion: 13 — `insert` is simply absent
// (undefined, no insert plate emitted).
const projectV12Schema = projectV11Schema.extend({
  schemaVersion: z.literal(12),
});

// Issue #117 — v13 adds the optional `case.seal.mode` field. Like the v7 hinge
// bump it is purely additive (the field lives on the seal schema every version
// embeds, as `.optional()`), so the wire format stays backwards-compatible; the
// bump is bookkeeping for "this project understands clamshell closure." A v12
// project on disk parses against v12, then the transform below stamps
// schemaVersion: 13 — `seal.mode` is simply absent (undefined, which the
// compiler reads as 'recess').
const projectV13Schema = projectV12Schema.extend({
  schemaVersion: z.literal(13),
});

// Issue #148 — v14 moves the printer build volume from the rack archetype up to
// the project, so the shell (and anything else that has to fit a bed) can
// fit-check without a rack. Purely additive: `printer` is optional and the old
// `case.rack.printer` still parses, so the transform is a version bump — see
// `resolvePrinter` for the read-through that makes both homes work.
const projectV14Schema = projectV13Schema.extend({
  schemaVersion: z.literal(14),
  printer: printerVolumeSchema.optional(),
});

export const projectSchema = z
  .union([
    projectV1Schema,
    projectV2Schema,
    projectV3Schema,
    projectV4Schema,
    projectV5Schema,
    projectV6Schema,
    projectV7Schema,
    projectV8Schema,
    projectV9Schema,
    projectV10Schema,
    projectV11Schema,
    projectV12Schema,
    projectV13Schema,
    projectV14Schema,
  ])
  .transform((p) => {
    if (p.schemaVersion === 1) {
      return {
        ...p,
        schemaVersion: 14 as const,
        customFonts: [],
        hats: [],
        customHats: [],
        mountingFeatures: [],
        display: null,
        customDisplays: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 2) {
      return {
        ...p,
        schemaVersion: 14 as const,
        customFonts: [],
        mountingFeatures: [],
        display: null,
        customDisplays: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 3) {
      return {
        ...p,
        schemaVersion: 14 as const,
        customFonts: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 4) {
      return {
        ...p,
        schemaVersion: 14 as const,
        customFonts: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 5) {
      // mountingFeatures items already have mountClass filled by the
      // mountingFeatureSchema default at parse time; just stamp the version.
      return { ...p, schemaVersion: 14 as const, customFonts: [] };
    }
    if (p.schemaVersion === 6) {
      // v6 → v7 is a pure version bump — `hinge` is optional and absent on
      // legacy projects, so the parsed object already has the right shape.
      return { ...p, schemaVersion: 14 as const, customFonts: [] };
    }
    if (p.schemaVersion === 7) {
      return { ...p, schemaVersion: 14 as const, customFonts: [] };
    }
    if (p.schemaVersion === 8) {
      // v8 → v9 is a pure version bump — `magnetPockets` is optional and
      // absent on legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 14 as const };
    }
    if (p.schemaVersion === 9) {
      // v9 → v10 is a pure version bump — the `fit` fields are optional and
      // absent on legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 14 as const };
    }
    if (p.schemaVersion === 10) {
      // v10 → v11 is a pure version bump — `badge` is optional and absent on
      // legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 14 as const };
    }
    if (p.schemaVersion === 11) {
      // v11 → v12 is a pure version bump — `insert` is optional and absent on
      // legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 14 as const };
    }
    if (p.schemaVersion === 12) {
      // v12 → v13 → v14 are pure version bumps — `seal.mode` and the hoisted
      // `printer` are both optional and absent on legacy projects, so the
      // parsed object already has the shape.
      return { ...p, schemaVersion: 14 as const };
    }
    if (p.schemaVersion === 13) {
      // v13 → v14 is a pure version bump: `printer` is optional. A project
      // written before the move still carries its bed on `case.rack.printer`,
      // and `resolvePrinter` reads both, so no field is rewritten here.
      return { ...p, schemaVersion: 14 as const };
    }
    return p;
  });

export type ProjectInput = z.infer<typeof projectSchema>;
