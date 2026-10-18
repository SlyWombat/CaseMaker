import { z } from 'zod';
import { boardProfileSchema } from '@/library/schema';
import { hatProfileSchema } from '@/library/hatSchema';
import { displayProfileSchema } from '@/library/displaySchema';

// #480 — every field carries `.describe()`. The current project document is emitted as JSON
// Schema for the headless MCP tools, and the description is what a model reads before it authors
// or patches a project. Keep the text about the DATA (units, meaning, legal values).

const xyzSchema = z.object({
  x: z.number().describe('X in millimetres.'),
  y: z.number().describe('Y in millimetres.'),
  z: z.number().describe('Z in millimetres.'),
});

/** Issue #148 — the bed, shared by `Project.printer` (the new home) and the
 *  deprecated `case.rack.printer` (the old one). Both must parse. */
const printerVolumeSchema = z.object({
  preset: z.string().optional().describe('Name of the printer preset these bounds came from.'),
  x: z.number().positive().describe('Build volume along X, in millimetres.'),
  y: z.number().positive().describe('Build volume along Y, in millimetres.'),
  z: z.number().positive().describe('Build volume along Z, in millimetres.'),
});

/** Issue #153 — print-fit variant (see `types/snap.ts`). Shared by the
 *  case-level default, the per-catch override, and the rack. */
const fitVariantSchema = z
  .enum(['tight', 'standard', 'loose'])
  .describe('Print-fit variant for a snap interface: tight, standard or loose.');

export const caseParamsSchema = z.object({
  wallThickness: z.number().positive().describe('Case wall thickness, in millimetres.'),
  floorThickness: z.number().positive().describe('Case floor thickness, in millimetres.'),
  lidThickness: z.number().positive().describe('Lid thickness, in millimetres.'),
  cornerRadius: z.number().nonnegative().describe('Outer vertical corner radius, in millimetres.'),
  internalClearance: z
    .number()
    .nonnegative()
    .describe('Gap between the board and the cavity walls, in millimetres.'),
  clearanceTweaks: z
    .object({
      xMin: z.number().nonnegative().describe('Clearance on the −X side, in millimetres.'),
      xMax: z.number().nonnegative().describe('Clearance on the +X side, in millimetres.'),
      yMin: z.number().nonnegative().describe('Clearance on the −Y side, in millimetres.'),
      yMax: z.number().nonnegative().describe('Clearance on the +Y side, in millimetres.'),
    })
    .optional()
    .describe('Per-side overrides of internalClearance, in millimetres; omit to use it on every side.'),
  zClearance: z.number().nonnegative().describe('Gap above the board, in millimetres.'),
  joint: z
    .preprocess(
      (v) => (v === 'sliding' ? 'flat-lid' : v),
      z.enum(['snap-fit', 'screw-down', 'flat-lid']),
    )
    .describe(
      'How the lid joins the case: snap-fit, screw-down, or flat-lid ' +
        '(the legacy value "sliding" is read as flat-lid).',
    ),
  lidRecess: z
    .boolean()
    .optional()
    .describe('True cuts a recess so the lid seats into the case; omit for a flush lid.'),
  /** Pelican shell-lid cavity height (mm). 0 / undefined = flat-plate lid (legacy). */
  lidCavityHeight: z
    .number()
    .nonnegative()
    .optional()
    .describe('Height of a shell lid cavity, in millimetres; 0 or omitted means a flat plate lid.'),
  /** How the board is retained — independent of the lid's `joint`. */
  boardRetention: z
    .enum(['screws', 'snap', 'press-fit', 'none'])
    .optional()
    .describe('How the board is held in the case; omit for the archetype default.'),
  extraCavityZ: z
    .number()
    .nonnegative()
    .optional()
    .describe('Extra cavity depth above the board, in millimetres.'),
  snapType: z
    .enum(['barb', 'full-lid'])
    .optional()
    .describe('Snap style: small barbs or a full-length lid snap.'),
  // Issue #153 — project-level print-fit variant for the snap interfaces
  // (snap catches + board snap clips). Optional so legacy projects load
  // unchanged (v7 hinge precedent); absent resolves to 'tight' (the
  // as-designed number) at the compiler boundary.
  fit: fitVariantSchema.optional().describe("Project print-fit variant; omit for 'tight'."),
  ventilation: z
    .object({
      // Issue #75 — surfaces the vent pattern is cut into. Optional so legacy
      // projects load with no migration; compiler defaults to ['back'].
      surfaces: z
        .array(z.enum(['top', 'bottom', 'front', 'back', 'left', 'right']))
        .optional()
        .describe("Surfaces the vent pattern is cut into; omit for ['back']."),
      enabled: z.boolean().describe('True cuts ventilation openings.'),
      pattern: z
        .enum(['none', 'slots', 'hex', 'chevron'])
        .describe('Vent opening pattern.'),
      coverage: z
        .number()
        .min(0)
        .max(1)
        .describe('Fraction of the surface the vents cover, from 0 to 1.'),
    })
    .describe('Ventilation openings cut into the case.'),
  bosses: z
    .object({
      enabled: z.boolean().describe('True adds mounting bosses under the board holes.'),
      insertType: z
        .enum(['self-tap', 'heat-set-m2.5', 'heat-set-m3', 'pass-through', 'none'])
        .describe('Screw interface the bosses provide.'),
      outerDiameter: z.number().positive().describe('Boss outer diameter, in millimetres.'),
      holeDiameter: z.number().positive().describe('Boss hole diameter, in millimetres.'),
      // Issue #104 — 'bottom' (default) anchors bosses to the case floor;
      // 'top' anchors them to the lid underside, with a tapered support
      // column on the inside wall providing material continuity. Optional
      // so legacy projects load as 'bottom' without a migration.
      position: z
        .enum(['bottom', 'top'])
        .optional()
        .describe("Whether bosses grow from the floor ('bottom') or hang from the lid ('top'); omit for bottom."),
    })
    .describe('Standoff bosses for the board mounting holes.'),
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
      enabled: z.boolean().describe('True builds the rack assembly instead of a box.'),
      width: z.number().positive().describe('Rack width (front-to-back panel span), in millimetres.'),
      depth: z.number().positive().describe('Rack depth, in millimetres.'),
      slots: z.number().int().min(2).max(40).describe('Number of rack units (2–40).'),
      // Deprecated home (#148) — the bed now lives on the project; still parsed
      // so pre-#148 files load, and `resolvePrinter` reads it as a fallback.
      printer: printerVolumeSchema
        .optional()
        .describe('Deprecated home of the printer bed; the project-level printer takes precedence.'),
      wallMount: z
        .enum(['none', 'ears', 'cleat', 'keyhole'])
        .optional()
        .describe('How the rack mounts to a wall; omit for no wall mount.'),
      assembledExport: z
        .boolean()
        .optional()
        .describe('True exports the rack assembled rather than as separate parts.'),
      floorRibs: z.boolean().optional().describe('True adds ribs to the rack floor.'),
      cableNotches: z
        .object({
          plate: z.enum(['top', 'bottom', 'both']).describe('Which plate carries the notches.'),
          count: z.number().int().min(1).max(12).describe('Number of notches (1–12).'),
          width: z.number().positive().describe('Notch width, in millimetres.'),
          depth: z.number().positive().describe('Notch depth, in millimetres.'),
        })
        .optional()
        .describe('Cable pass-through notches; omit for none.'),
      accessories: z
        .array(
          z.object({
            id: z.string().describe('Unique accessory id.'),
            type: z
              .enum(['blank', 'shelf', 'keystone', 'cable-tray'])
              .describe('Accessory kind.'),
            slots: z
              .number()
              .int()
              .min(1)
              .max(12)
              .optional()
              .describe('Rack units the accessory spans (1–12).'),
            shelfDepth: z
              .union([z.number().positive(), z.literal('full')])
              .optional()
              .describe('Shelf depth in millimetres, or "full" for the whole rack depth.'),
            frontPlate: z.boolean().optional().describe('True adds a front plate.'),
            vented: z.boolean().optional().describe('True cuts vents in the accessory.'),
          }),
        )
        .optional()
        .describe('Accessories fitted into the rack; omit for none.'),
      fans: z
        .array(
          z.object({
            id: z.string().describe('Unique fan id.'),
            side: z.enum(['left', 'right']).describe('Rack side the fan is on.'),
            size: z
              .union([
                z.literal(40),
                z.literal(60),
                z.literal(80),
                z.literal(92),
                z.literal(120),
              ])
              .describe('Fan size in millimetres (40, 60, 80, 92 or 120).'),
            y: z.number().positive().describe('Fan centre along the rack depth, in millimetres.'),
            z: z.number().positive().describe('Fan centre above the rack bottom, in millimetres.'),
          }),
        )
        .optional()
        .describe('Fans mounted in the rack sides; omit for none.'),
      // Issue #153 — plate-tab ledge fit. Optional; absent = 'tight'.
      fit: fitVariantSchema.optional().describe("Rack plate-tab fit; omit for 'tight'."),
    })
    .optional()
    .describe('Mini-rack archetype settings; omit or disable for a normal shell and lid.'),
  stand: z
    .object({
      enabled: z.boolean().describe('True builds a desk/wall stand instead of a case.'),
      mount: z
        .enum(['desk', 'wall', 'slider', 'pocket'])
        .optional()
        .describe('How the stand is mounted.'),
      shroudDepth: z.number().positive().optional().describe('Shroud depth, in millimetres.'),
      shroudWall: z.number().positive().optional().describe('Shroud wall thickness, in millimetres.'),
      plateThickness: z.number().positive().optional().describe('Mounting plate thickness, in millimetres.'),
      plateBorder: z.number().positive().optional().describe('Border around the mounting plate, in millimetres.'),
      drywallScrewDiameter: z
        .number()
        .positive()
        .optional()
        .describe('Drywall screw shank diameter, in millimetres.'),
      drywallHeadDiameter: z
        .number()
        .positive()
        .optional()
        .describe('Drywall screw head diameter, in millimetres.'),
      tiltAngleDeg: z
        .number()
        .min(0)
        .max(60)
        .describe('Tilt of the device from vertical, in degrees (0–60).'),
      frameThickness: z.number().positive().describe('Frame thickness, in millimetres.'),
      bezelMargin: z.number().nonnegative().describe('Margin between the device and the bezel, in millimetres.'),
      openingClearance: z.number().nonnegative().describe('Clearance in the device opening, in millimetres.'),
      screwHoleDiameter: z.number().positive().describe('Screw hole diameter, in millimetres.'),
      baseDepth: z.number().positive().describe('Foot depth, in millimetres.'),
      baseThickness: z.number().positive().describe('Foot thickness, in millimetres.'),
      gussetThickness: z.number().positive().describe('Gusset thickness, in millimetres.'),
      gussetHeightFraction: z
        .number()
        .min(0.1)
        .max(1)
        .describe('Gusset height as a fraction of the frame height (0.1–1).'),
    })
    .optional()
    .describe('Desk-stand archetype settings; omit or disable for a normal shell and lid.'),
  seal: z
    .object({
      enabled: z.boolean().describe('True cuts a gasket channel and tongue.'),
      profile: z.enum(['flat', 'o-ring']).describe('Gasket cross-section: flat or O-ring.'),
      width: z.number().positive().describe('Gasket channel width, in millimetres.'),
      depth: z.number().positive().describe('Gasket channel depth, in millimetres.'),
      compressionFactor: z
        .number()
        .min(0.1)
        .max(0.4)
        .describe('Fraction the gasket is compressed when closed (0.1–0.4).'),
      gasketMaterial: z.enum(['tpu', 'eva', 'epdm']).describe('Gasket material.'),
      // Issue #117 — closure style. Absent = 'recess' (issued #30 behaviour).
      mode: z
        .enum(['recess', 'clamshell'])
        .optional()
        .describe("Closure style: a recessed lid or a clamshell; omit for 'recess'."),
      // Issue #113 — per-printer gasket clearance tolerance.
      gasketClearance: z
        .number()
        .nonnegative()
        .max(1)
        .optional()
        .describe('Extra gasket clearance, in millimetres (at most 1); omit for the printer default.'),
    })
    .optional()
    .describe('Waterproof gasket settings; omit or disable for no seal geometry.'),
  // Issue #109 — spring-cam locking latches. Optional array; legacy
  // projects load with no latches.
  latches: z
    .array(
      z.object({
        id: z.string().describe('Unique latch id.'),
        wall: z.enum(['+x', '-x', '+y', '-y']).describe('Case wall the latch is on.'),
        uPosition: z.number().describe('Position along that wall, in millimetres.'),
        enabled: z.boolean().describe('False keeps the latch in the document but builds none.'),
        throw: z.number().positive().describe('Cam throw, in millimetres.'),
        width: z.number().positive().describe('Latch width, in millimetres.'),
        height: z.number().positive().describe('Latch height, in millimetres.'),
        // Issue #113 — per-printer cam/striker engagement tolerance.
        tolerance: z
          .number()
          .nonnegative()
          .max(1)
          .optional()
          .describe('Cam/striker engagement tolerance, in millimetres (at most 1).'),
      }),
    )
    .optional()
    .describe('Spring-cam locking latches; omit for none.'),
  // Issue #111 — rugged exterior. Optional.
  rugged: z
    .object({
      enabled: z.boolean().describe('True builds the rugged exterior features.'),
      corners: z
        .object({
          enabled: z.boolean().describe('True adds protective corner caps.'),
          radius: z.number().positive().describe('Corner cap radius, in millimetres.'),
          // Issue #121 — discrete cap height (top + bottom). Optional;
          // defaults to 12 mm at the compiler boundary.
          capHeight: z
            .number()
            .positive()
            .optional()
            .describe('Corner cap height, in millimetres; omit for 12 mm.'),
          flexBumper: z.boolean().describe('True cuts a flexible bumper profile into the caps.'),
        })
        .describe('Protective corner caps.'),
      ribbing: z
        .object({
          enabled: z.boolean().describe('True adds exterior ribs.'),
          direction: z
            .enum(['vertical', 'horizontal'])
            .describe('Rib direction.'),
          ribCount: z.number().int().min(0).describe('Number of ribs.'),
          ribDepth: z.number().positive().describe('Rib depth, in millimetres.'),
          clearBand: z.number().nonnegative().describe('Band kept clear of ribs around the rim, in millimetres.'),
        })
        .describe('Exterior ribbing.'),
      feet: z
        .object({
          enabled: z.boolean().describe('True adds feet.'),
          pads: z.union([z.literal(4), z.literal(6)]).describe('Number of feet: 4 or 6.'),
          padDiameter: z.number().positive().describe('Foot diameter, in millimetres.'),
          padHeight: z.number().positive().describe('Foot height, in millimetres.'),
        })
        .describe('Feet or pads on the case bottom.'),
    })
    .optional()
    .describe('Rugged exterior settings; omit or disable for a plain shell.'),
  snapCatches: z
    .array(
      z.object({
        id: z.string().describe('Unique snap-catch id.'),
        wall: z.enum(['+x', '-x', '+y', '-y']).describe('Case wall the catch is on.'),
        uPosition: z.number().describe('Position along that wall, in millimetres.'),
        enabled: z.boolean().describe('False keeps the catch in the document but builds none.'),
        // Issue #69 + #78 — barb cross-section. Defaults to 'hook' at parse
        // time so older projects load with an explicit value (avoids the
        // UI-shows-wrong-option bug where the select didn't reflect the
        // engine's compile-time fallback).
        barbType: z
          .enum(['hook', 'asymmetric-ramp', 'symmetric-ramp', 'half-round', 'ball-socket'])
          .default('hook')
          .describe('Barb cross-section; omitted values load as "hook".'),
        insertionRampDeg: z
          .number()
          .optional()
          .describe('Insertion ramp angle in degrees; omit for the barb default.'),
        retentionRampDeg: z
          .number()
          .optional()
          .describe('Retention ramp angle in degrees; omit for the barb default.'),
        // Issue #64 — which part holds the flexing cantilever. Optional so
        // legacy projects load with the implicit 'lid' default; geometry
        // dispatch keys off the .default() at parse time.
        cantileverOn: z
          .enum(['lid', 'case'])
          .default('lid')
          .describe('Which part carries the flexing cantilever; omitted values load as "lid".'),
        // Issue #153 — per-catch fit override; absent inherits case.fit.
        fit: fitVariantSchema.optional().describe('Per-catch fit override; omit to inherit case.fit.'),
      }),
    )
    .optional()
    .describe('Snap catches that hold the lid on; omit for none.'),
  // Issue #76 — freeform user-placed cutouts. Optional so legacy projects
  // load with no migration; a missing field is treated as an empty list.
  customCutouts: z
    .array(
      z.object({
        id: z.string().describe('Unique cutout id.'),
        face: z
          .enum(['top', 'bottom', 'front', 'back', 'left', 'right'])
          .describe('Case face the cutout is on.'),
        shape: z.enum(['rect', 'round', 'slot']).describe('Cutout outline.'),
        u: z.number().describe('Position along the face, in millimetres.'),
        v: z.number().describe('Position across the face, in millimetres.'),
        width: z.number().positive().describe('Cutout width, in millimetres.'),
        height: z.number().positive().describe('Cutout height, in millimetres.'),
        rotationDeg: z.number().optional().describe('Rotation on the face, in degrees; omit for 0.'),
        enabled: z.boolean().describe('False keeps the cutout in the document but cuts nothing.'),
        label: z.string().optional().describe('Optional label shown with the cutout.'),
      }),
    )
    .optional()
    .describe('Freeform user-placed cutouts; omit for none.'),
  // Issue #148 — offer a bolted split of the shell when it is over the bed.
  // Optional (v14 stamps it absent), so legacy projects load unchanged and a
  // project that never asks for the split builds none of its geometry.
  splitForPrint: z
    .boolean()
    .optional()
    .describe('Split the shell into bed-sized pieces; omit for no split.'),
  // Issue #152 — magnet pockets cut into a face for magnetic retention.
  // Optional so legacy projects load with no migration (v7 hinge precedent);
  // a missing field is treated as an empty list. Geometry lives in
  // engine/compiler/fasteners' MAGNETS table, not here.
  magnetPockets: z
    .array(
      z.object({
        id: z.string().describe('Unique magnet-pocket id.'),
        face: z
          .enum(['+x', '-x', '+y', '-y', '+z', '-z'])
          .describe('Case face the pocket is cut into.'),
        u: z.number().describe('Position along the face, in millimetres.'),
        v: z.number().describe('Position across the face, in millimetres.'),
        size: z.enum(['6x2', '8x3', '10x2']).describe('Magnet size as diameter×thickness, in millimetres.'),
        retention: z
          .enum(['glue', 'press', 'captured'])
          .optional()
          .describe('How the magnet is retained; omit for the builder default.'),
        enabled: z.boolean().describe('False keeps the pocket in the document but cuts nothing.'),
        label: z.string().optional().describe('Optional label shown with the pocket.'),
      }),
    )
    .optional()
    .describe('Magnet pockets for magnetic retention; omit for none.'),
  // Issue #92 — optional barrel hinge. Side faces only; one per case in v1.
  // Missing on disk = no hinge emitted.
  hinge: z
    .object({
      id: z.string().describe('Unique hinge id.'),
      style: z
        .enum([
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
        ])
        .describe('Hinge style.'),
      face: z.enum(['+x', '-x', '+y', '-y']).describe('Case side face the hinge is on.'),
      numKnuckles: z.number().int().min(3).describe('Number of knuckles (at least 3).'),
      knuckleOuterDiameter: z.number().positive().describe('Knuckle outer diameter, in millimetres.'),
      pinDiameter: z.number().positive().describe('Hinge pin diameter, in millimetres.'),
      knuckleClearance: z.number().nonnegative().describe('Clearance between knuckles, in millimetres.'),
      positioning: z
        .enum(['continuous', 'pair-at-ends', 'centered'])
        .describe('How knuckles are distributed along the face.'),
      hingeLength: z.number().positive().describe('Hinge length along the face, in millimetres.'),
      stopAngle: z.number().optional().describe('Opening stop angle in degrees; omit for no stop.'),
      pinMode: z
        .enum(['separate', 'print-in-place'])
        .describe('Whether the pin prints separately or as part of the hinge.'),
      enabled: z.boolean().describe('False keeps the hinge in the document but builds none.'),
    })
    .optional()
    .describe('Barrel hinge settings; omit for no hinge.'),
  // Issue #167 — badge archetype (types/badge.ts). Optional so legacy projects
  // load unchanged (the v7 hinge precedent); absent/disabled = normal
  // shell+lid box. The pocket is `.nullable()` rather than optional because
  // the compiler distinguishes "no pocket" from "a pocket of size zero".
  badge: z
    .object({
      enabled: z.boolean().describe('True builds a badge blank instead of a box.'),
      width: z.number().positive().describe('Badge width, in millimetres.'),
      height: z.number().positive().describe('Badge height, in millimetres.'),
      thickness: z.number().positive().describe('Badge thickness, in millimetres.'),
      cornerRadius: z.number().nonnegative().describe('Badge corner radius, in millimetres.'),
      splitHeight: z.number().positive().describe('Height of the bottom colour layer, in millimetres.'),
      magnetPocket: z
        .object({
          length: z.number().positive().describe('Magnet pocket length, in millimetres.'),
          width: z.number().positive().describe('Magnet pocket width, in millimetres.'),
          depth: z.number().positive().describe('Magnet pocket depth, in millimetres.'),
        })
        .nullable()
        .describe('Magnet pocket dimensions, or null for no pocket.'),
      bottomExtruder: z.number().int().positive().describe('Extruder index for the bottom colour.'),
      topExtruder: z.number().int().positive().describe('Extruder index for the top colour.'),
      // Issue #368 — the slicing the blank was printed with (#166, `BadgePrint`). OPTIONAL and
      // additive: a legacy project has no key and loads unchanged, and a badge that states no
      // print leaves the engrave job's depth limit analytic (#285) — so every version's embedded
      // `caseParamsSchema` accepts it without a bump (the v11 badge precedent).
      print: z
        .object({
          layerHeight: z.number().positive().describe('Print layer height, in millimetres.'),
          firstLayerHeight: z.number().positive().describe('First-layer height, in millimetres.'),
        })
        .optional()
        .describe('Slicing facts the blank was printed with; omit when unknown.'),
    })
    .optional()
    .describe('Badge archetype settings; omit or disable for a normal shell and lid.'),
  // Issue #158 — tool-insert holder archetype (types/insert.ts). Optional so
  // legacy projects load unchanged (the v7 hinge precedent); absent/disabled =
  // normal shell+lid box. A single `insert-plate` node, pockets subtracted.
  insert: z
    .object({
      enabled: z.boolean().describe('True builds a tool-insert holder instead of a box.'),
      width: z.number().positive().describe('Plate width, in millimetres.'),
      depth: z.number().positive().describe('Plate depth, in millimetres.'),
      thickness: z.number().positive().describe('Plate thickness, in millimetres.'),
      cornerRadius: z.number().nonnegative().describe('Plate corner radius, in millimetres.'),
      clearance: z.number().nonnegative().describe('Clearance around each tool pocket, in millimetres.'),
      chamfer: z.number().nonnegative().describe('Chamfer on the pocket mouths, in millimetres.'),
      floor: z.number().nonnegative().describe('Material left under each pocket, in millimetres.'),
      pitchGap: z.number().nonnegative().describe('Gap between adjacent pockets, in millimetres.'),
      // Issue #262 — tool retention. Optional and absent = 'friction', the
      // geometry every project saved before it existed has, so no migration.
      retention: z
        .enum(['friction', 'magnet'])
        .optional()
        .describe("How tools are held: friction or magnets; omit for 'friction'."),
      magnetSize: z
        .enum(['6x2', '8x3', '10x2'])
        .optional()
        .describe('Magnet size as diameter×thickness, in millimetres; used with magnetic retention.'),
      items: z
        .array(
          z.object({
            id: z.string().describe('Unique tool-pocket id.'),
            shape: z.enum(['round', 'hex']).describe('Pocket cross-section.'),
            size: z.number().positive().describe('Pocket across-flats or diameter, in millimetres.'),
            depth: z.number().positive().describe('Pocket depth, in millimetres.'),
          }),
        )
        .describe('Tool pockets cut into the plate.'),
    })
    .optional()
    .describe('Tool-insert holder archetype settings; omit or disable for a normal shell and lid.'),
  // Issue #280 — bare-blank archetype (types/blank.ts). Optional so legacy
  // projects load unchanged (the v7 hinge precedent); absent/disabled = normal
  // shell+lid box. A single `blank` node: one plate, no board, no cavity, no
  // lid. Without this entry the field would be SILENTLY STRIPPED on load — a
  // TypeScript type alone does not make it survive a round trip.
  blank: z
    .object({
      enabled: z.boolean().describe('True builds a bare plate instead of a box.'),
      width: z.number().positive().describe('Plate width, in millimetres.'),
      height: z.number().positive().describe('Plate height, in millimetres.'),
      thickness: z.number().positive().describe('Plate thickness, in millimetres.'),
      cornerRadius: z.number().nonnegative().describe('Plate corner radius, in millimetres.'),
    })
    .optional()
    .describe('Bare-blank archetype settings; omit or disable for a normal shell and lid.'),
  // Issue #155 — stacking-toolbox archetype (types/toolbox.ts). Optional so
  // legacy projects load unchanged (the v7 hinge precedent); absent/disabled =
  // normal shell+lid box. Two `toolbox-*` nodes: a bin and a lid, registering
  // on each other by a foot-in-opening fit. Same strip trap as `blank` — a
  // TypeScript field with no entry here does not survive a round trip.
  toolbox: z
    .object({
      enabled: z.boolean().describe('True builds the stacking toolbox instead of a box.'),
      width: z.number().positive().describe('Bin width, in millimetres.'),
      depth: z.number().positive().describe('Bin depth, in millimetres.'),
      height: z.number().positive().describe('Bin height, in millimetres.'),
      grid: z.boolean().describe('True adds the divider lattice to the bin floor.'),
      // Issue #150 — the drop-in dividers standing in the bin. Optional and
      // needing NO version bump: a v16 project has no `pegs` key at all, which
      // reads back as `undefined`, which the panel and `buildToolboxNodes` both
      // treat as "none" (`p.pegs ?? []`). So absent and empty mean the same
      // thing and neither is a migration.
      //
      // These bounds are structural only — "a positive number", matching the
      // sibling width/depth/height — and nothing more. Whether a span lands on
      // the lattice, fits the floor, or lets a wall clear the ledge is
      // `toolboxPegProblem`'s call, next to the constants it depends on, not a
      // second copy of the geometry buried in a schema. That split is not
      // cosmetic: a rejected patch here would have to silence the panel, where
      // the predicate can say WHICH divider is wrong and why.
      pegs: z
        .array(
          z.object({
            id: z.string().describe('Unique divider id.'),
            spans: z.number().positive().describe('Divider span across the bin, in lattice units.'),
            height: z.number().positive().describe('Divider height, in millimetres.'),
            thickness: z.number().positive().describe('Divider thickness, in millimetres.'),
            axis: z.enum(['x', 'y']).describe('Axis the divider runs along.'),
            enabled: z.boolean().describe('False keeps the divider in the document but builds none.'),
          }),
        )
        .optional()
        .describe('Drop-in dividers standing in the bin; omit for none.'),
    })
    .optional()
    .describe('Stacking-toolbox archetype settings; omit or disable for a normal shell and lid.'),
});

const portPlacementSchema = z.object({
  id: z.string().describe('Unique port id.'),
  sourceComponentId: z
    .string()
    .nullable()
    .describe('Id of the board component this port opens for, or null for a hand-placed port.'),
  kind: z
    .enum([
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
    ])
    .describe('Connector kind; chooses the cutout profile.'),
  position: xyzSchema.describe('Port position on the board, in millimetres.'),
  size: xyzSchema.describe('Port opening extents, in millimetres.'),
  facing: z
    .enum(['+x', '-x', '+y', '-y', '+z', '-z'])
    .describe('Direction the port faces.'),
  cutoutMargin: z.number().nonnegative().describe('Extra clearance around the opening, in millimetres.'),
  locked: z.boolean().describe('True pins the port to its source component position.'),
  enabled: z.boolean().describe('False keeps the port in the document but cuts no opening.'),
  cutoutShape: z
    .enum(['rect', 'round'])
    .optional()
    .describe('Opening outline; omit for the kind default.'),
});

const externalAssetSchema = z.object({
  id: z.string().describe('Unique asset id.'),
  name: z.string().describe('Display name of the asset.'),
  format: z.enum(['stl', '3mf']).describe('Mesh file format.'),
  data: z.string().describe('Base64 of the mesh file.'),
  transform: z
    .object({
      position: z
        .tuple([z.number(), z.number(), z.number()])
        .describe('[x, y, z] placement of the mesh, in millimetres.'),
      rotation: z
        .tuple([z.number(), z.number(), z.number()])
        .describe('[x, y, z] rotation of the mesh, in degrees.'),
      scale: z.number().describe('Uniform scale applied to the mesh.'),
    })
    .describe('Placement of the asset in the model.'),
  visibility: z
    .enum(['reference', 'subtract', 'union'])
    .describe('How the asset participates: a reference display, a subtraction, or a union.'),
});

const hatPlacementSchema = z.object({
  id: z.string().describe('Unique placement id.'),
  hatId: z.string().describe('Id of the HAT profile being placed.'),
  stackIndex: z
    .number()
    .int()
    .nonnegative()
    .describe('Position in the stacking order, 0 nearest the board.'),
  liftOverride: z
    .number()
    .optional()
    .describe('Override of the HAT lift above the board, in millimetres.'),
  offsetOverride: z
    .object({
      x: z.number().describe('X offset in millimetres.'),
      y: z.number().describe('Y offset in millimetres.'),
    })
    .optional()
    .describe('Override of the HAT offset from the board centre, in millimetres.'),
  mountingPositionId: z
    .string()
    .optional()
    .describe('Id of the HAT mounting position this placement uses.'),
  ports: z.array(portPlacementSchema).describe('Ports opened for this HAT.'),
  enabled: z.boolean().describe('False keeps the placement in the document but models none.'),
});

const mountingFeatureSchema = z.object({
  id: z.string().describe('Unique mounting-feature id.'),
  type: z
    .enum([
      // Issue #80 — extended type set. Internal mounts live on the cavity
      // floor; external mounts extrude past the case envelope.
      'screw-tab',
      'end-flange',
      'zip-tie-slot',
      'vesa-mount',
      'extrusion-mount',
      'aligned-standoff',
      'saddle',
    ])
    .describe('What kind of mounting feature this is.'),
  // Issue #80 — required field. .default('external') so v5-vintage
  // entries (no mountClass on disk) load with the right class — every
  // pre-#80 mounting type is external by definition.
  mountClass: z
    .enum(['external', 'internal'])
    .default('external')
    .describe('Whether the feature lives inside the cavity or extrudes outside; omitted values load as "external".'),
  face: z
    .enum(['+x', '-x', '+y', '-y', '+z', '-z'])
    .describe('Case face the feature is attached to.'),
  position: z
    .object({
      u: z.number().describe('Position along the face, in millimetres.'),
      v: z.number().describe('Position across the face, in millimetres.'),
    })
    .describe('Placement on the face, in millimetres.'),
  rotation: z.number().describe('Rotation on the face, in degrees.'),
  params: z
    .record(z.string(), z.union([z.number(), z.string()]))
    .describe('Feature-specific parameters, keyed by name.'),
  enabled: z.boolean().describe('False keeps the feature in the document but builds none.'),
  presetId: z.string().optional().describe('Id of the preset the feature was created from.'),
});

const displayPlacementSchema = z.object({
  id: z.string().describe('Unique display placement id.'),
  displayId: z.string().describe('Id of the display profile being placed.'),
  framing: z
    .enum([
      'top-window',
      'recessed-bezel',
      'flush-glass',
      'hood-shade',
      'tilted',
      'removable-cap',
      'bracket-only',
    ])
    .describe('How the display is framed in the case.'),
  tiltAngle: z.number().optional().describe('Display tilt in degrees; omit for none.'),
  hoodHeight: z.number().optional().describe('Hood height in millimetres; for a hood shade.'),
  bezelInset: z.number().optional().describe('Bezel inset in millimetres; for a recessed bezel.'),
  offset: z
    .object({
      x: z.number().describe('X offset in millimetres.'),
      y: z.number().describe('Y offset in millimetres.'),
    })
    .describe('Offset of the display from its default position, in millimetres.'),
  hostSupport: z
    .enum(['gpio-only', 'case-rim-bracket', 'under-board-posts', 'full-cradle'])
    .describe('How the display host board is supported.'),
  enabled: z.boolean().describe('False keeps the placement in the document but models none.'),
});

// Issue #54 — schema authoring uses .extend() chains instead of redeclaring
// the full field set per version. Each version adds (or shadows) what's new
// since the previous; v1 carries the common fields, every later vN extends
// vN-1. Keeps the diff between versions surgical and prevents copy-paste
// drift when a field gets renamed (the original v1..v5 redeclaration style
// hid that drift).

const projectV1Schema = z.object({
  schemaVersion: z.literal(1).describe('Project document schema version.'),
  id: z.string().describe('Stable project id.'),
  name: z.string().describe('Human-readable project name.'),
  createdAt: z.string().describe('When the project was created.'),
  modifiedAt: z.string().describe('When the project was last saved.'),
  board: boardProfileSchema.describe('The board the case is built around.'),
  case: caseParamsSchema.describe('The case parameters and archetypes.'),
  ports: z.array(portPlacementSchema).describe('Openings cut for the board ports.'),
  externalAssets: z
    .array(externalAssetSchema)
    .describe('Imported meshes placed in the model.'),
});

const projectV2Schema = projectV1Schema.extend({
  schemaVersion: z.literal(2).describe('Project document schema version.'),
  hats: z.array(hatPlacementSchema).describe('HAT boards stacked on the main board.'),
  customHats: z.array(hatProfileSchema).describe('HAT profiles embedded in the project.'),
});

const projectV3Schema = projectV2Schema.extend({
  schemaVersion: z.literal(3).describe('Project document schema version.'),
  mountingFeatures: z
    .array(mountingFeatureSchema)
    .describe('Mounting features attached to the case.'),
  display: displayPlacementSchema
    .nullable()
    .describe('The display mounted in the case, or null for none.'),
  customDisplays: z
    .array(displayProfileSchema)
    .describe('Display profiles embedded in the project.'),
});

const fanMountSchema = z.object({
  id: z.string().describe('Unique fan-mount id.'),
  size: z
    .enum(['30x30x10', '40x40x10', '40x40x20', '50x50x10', '60x60x15'])
    .describe('Fan size as width×height×thickness, in millimetres.'),
  face: z
    .enum(['+x', '-x', '+y', '-y', '+z', '-z'])
    .describe('Case face the fan is mounted on.'),
  position: z
    .object({
      u: z.number().describe('Position along the face, in millimetres.'),
      v: z.number().describe('Position across the face, in millimetres.'),
    })
    .describe('Fan centre on the face, in millimetres.'),
  grille: z
    .enum(['cross', 'spiral', 'honeycomb', 'concentric', 'open'])
    .describe('Grille pattern cut over the fan.'),
  bladeStandoff: z
    .number()
    .nonnegative()
    .describe('Clearance between the fan blades and the case, in millimetres.'),
  bossesEnabled: z.boolean().describe('True adds screw bosses for the fan.'),
  enabled: z.boolean().describe('False keeps the mount in the document but builds none.'),
});

const textLabelSchema = z.object({
  id: z.string().describe('Unique label id.'),
  text: z.string().describe('The text to place.'),
  // Issue #169 — a font registry id (bundled or a project customFonts id), no longer a
  // two-value enum. Legacy 'sans-default' / 'mono-default' remain valid ids.
  font: z.string().describe('Font registry id: a bundled face or a project custom font id.'),
  weight: z.enum(['regular', 'bold']).describe('Stroke weight.'),
  size: z.number().positive().describe('Cap height in millimetres.'),
  face: z
    .enum(['+x', '-x', '+y', '-y', '+z', '-z'])
    .describe('Case face the label is on.'),
  position: z
    .object({
      u: z.number().describe('Position along the face, in millimetres.'),
      v: z.number().describe('Position across the face, in millimetres.'),
    })
    .describe('Label centre on the face, in millimetres.'),
  rotation: z.number().describe('Rotation on the face, in degrees.'),
  depth: z.number().positive().describe('Engraving depth or emboss height, in millimetres.'),
  mode: z.enum(['engrave', 'emboss']).describe('Cut the label in or raise it.'),
  enabled: z.boolean().describe('False keeps the label in the document but cuts nothing.'),
  attachedToPortId: z
    .string()
    .optional()
    .describe('Id of the port the label is attached to; omit for a free-placed label.'),
});

const projectV4Schema = projectV3Schema.extend({
  schemaVersion: z.literal(4).describe('Project document schema version.'),
  fanMounts: z.array(fanMountSchema).describe('Fans mounted on the case.'),
  textLabels: z.array(textLabelSchema).describe('Text labels on the case.'),
});

const antennaPlacementSchema = z.object({
  id: z.string().describe('Unique antenna id.'),
  type: z
    .enum(['internal', 'rpi-external', 'external-mount'])
    .describe('Antenna arrangement: internal, an external Raspberry Pi antenna, or an external mount.'),
  enabled: z.boolean().describe('False keeps the antenna in the document but models none.'),
  facing: z
    .enum(['+x', '-x', '+y', '-y'])
    .optional()
    .describe('Direction the antenna exits the case; omit for internal arrangements.'),
  uOffset: z
    .number()
    .optional()
    .describe('Offset along the chosen face, in millimetres.'),
});

const projectV5Schema = projectV4Schema.extend({
  schemaVersion: z.literal(5).describe('Project document schema version.'),
  antennas: z.array(antennaPlacementSchema).describe('Antennas placed in the design.'),
});

// Issue #80 — v6 differs from v5 only in that mountingFeatures items now
// REQUIRE `mountClass`. The schema's .default('external') already fills
// missing values on parse, so the wire-format change is technically
// backwards-compatible; the version bump is bookkeeping for "this project
// understands the internal/external split."
const projectV6Schema = projectV5Schema.extend({
  schemaVersion: z.literal(6).describe('Project document schema version.'),
});

// Issue #92 — v7 adds the optional `case.hinge` field. The schema diff is
// purely additive (the new field lives on caseParamsSchema as `.optional()`),
// so the wire format stays backwards-compatible; the bump is bookkeeping for
// "this project understands the hinge feature." A v6 project on disk parses
// against v6, then this transform stamps schemaVersion: 7 — `hinge` is just
// absent on the resulting object (i.e. `undefined`, no hinge emitted).
const projectV7Schema = projectV6Schema.extend({
  schemaVersion: z.literal(7).describe('Project document schema version.'),
});

const customFontSchema = z.object({
  id: z.string().describe('Id labels use to name this font.'),
  name: z.string().describe('Human-readable font name.'),
  data: z.string().describe('Base64 of the TTF/OTF file.'),
});

// Issue #169 — v8 adds `customFonts` (user-supplied TTFs embedded as base64) and
// widens textLabel.font from a two-value enum to a registry id string. Older
// projects get customFonts: [] in the transform below; their 'sans-default' /
// 'mono-default' font ids are still valid registry ids, so no label rewrite.
const projectV8Schema = projectV7Schema.extend({
  schemaVersion: z.literal(8).describe('Project document schema version.'),
  customFonts: z
    .array(customFontSchema)
    .default([])
    .describe('Fonts embedded in the project; omitted values load as an empty list.'),
});

// Issue #152 — v9 adds the optional `case.magnetPockets` field. Like the v7
// hinge bump it is purely additive (the field is `.optional()` on
// caseParamsSchema, which every version embeds), so the wire format stays
// backwards-compatible; the bump is bookkeeping for "this project understands
// magnet pockets." A v8 project on disk parses against v8, then this transform
// stamps schemaVersion: 10 — `magnetPockets` is simply absent (undefined, no
// pockets emitted).
const projectV9Schema = projectV8Schema.extend({
  schemaVersion: z.literal(9).describe('Project document schema version.'),
});

// Issue #153 — v10 adds the optional `case.fit`, per-`SnapCatch.fit`, and
// `case.rack.fit` fields (fit variants). Like the v7 hinge bump it is purely
// additive (all three live on schemas every version embeds as `.optional()`),
// so the wire format stays backwards-compatible; the bump is bookkeeping for
// "this project understands fit variants." A v9 project on disk parses against
// v9, then this transform stamps schemaVersion: 10 — every `fit` is simply
// absent (undefined, resolving to 'tight' at the compiler boundary).
const projectV10Schema = projectV9Schema.extend({
  schemaVersion: z.literal(10).describe('Project document schema version.'),
});

// Issue #167 — v11 adds the optional `case.badge` field. Like the v7 hinge bump
// it is purely additive (the field lives on caseParamsSchema as `.optional()`,
// which every version embeds), so the wire format stays backwards-compatible;
// the bump is bookkeeping for "this project understands the badge archetype." A
// v10 project on disk parses against v10, then the transform below stamps
// schemaVersion: 11 — `badge` is simply absent (undefined, no badge emitted).
const projectV11Schema = projectV10Schema.extend({
  schemaVersion: z.literal(11).describe('Project document schema version.'),
});

// Issue #158 — v12 adds the optional `case.insert` field. Like the v7 hinge
// bump it is purely additive (the field lives on caseParamsSchema as
// `.optional()`, which every version embeds), so the wire format stays
// backwards-compatible; the bump is bookkeeping for "this project understands
// the tool-insert archetype." A v11 project on disk parses against v11, then
// the transform below stamps schemaVersion: 13 — `insert` is simply absent
// (undefined, no insert plate emitted).
const projectV12Schema = projectV11Schema.extend({
  schemaVersion: z.literal(12).describe('Project document schema version.'),
});

// Issue #117 — v13 adds the optional `case.seal.mode` field. Like the v7 hinge
// bump it is purely additive (the field lives on the seal schema every version
// embeds, as `.optional()`), so the wire format stays backwards-compatible; the
// bump is bookkeeping for "this project understands clamshell closure." A v12
// project on disk parses against v12, then the transform below stamps
// schemaVersion: 13 — `seal.mode` is simply absent (undefined, which the
// compiler reads as 'recess').
const projectV13Schema = projectV12Schema.extend({
  schemaVersion: z.literal(13).describe('Project document schema version.'),
});

// Issue #148 — v14 moves the printer build volume from the rack archetype up to
// the project, so the shell (and anything else that has to fit a bed) can
// fit-check without a rack. Purely additive: `printer` is optional and the old
// `case.rack.printer` still parses, so the transform is a version bump — see
// `resolvePrinter` for the read-through that makes both homes work.
const projectV14Schema = projectV13Schema.extend({
  schemaVersion: z.literal(14).describe('Project document schema version.'),
  printer: printerVolumeSchema
    .optional()
    .describe("The printer's build volume, used for fit checks; omit when unknown."),
});

// Issue #280 — v15 adds the bare-blank archetype. Purely additive: `case.blank`
// is optional (it lives on `caseParamsSchema`, which every version extends) and
// absent on every project saved before it, so the transform is a version bump
// with no field rewriting.
const projectV15Schema = projectV14Schema.extend({
  schemaVersion: z.literal(15).describe('Project document schema version.'),
});

// Issue #155 — v16 adds the stacking-toolbox archetype. Same shape of change as
// v15: `case.toolbox` is optional (it lives on `caseParamsSchema`, which every
// version extends) and absent on every project saved before it, so the
// transform is a version bump with no field rewriting.
const projectV16Schema = projectV15Schema.extend({
  schemaVersion: z.literal(16).describe('Project document schema version.'),
});

/**
 * The CURRENT project document, exactly as this build writes it (#480). The versioned union below
 * is what `projectSchema` accepts and migrates; a caller that AUTHORS a document — the MCP tools —
 * should speak this shape, so the schema generator emits one document rather than sixteen migrated
 * copies of it. Older versions stay readable through `projectSchema`.
 */
export const projectDocumentSchema = projectV16Schema.describe(
  "A Case Maker project: the board, the case parameters and every feature of the case's design.",
);

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
    projectV15Schema,
    projectV16Schema,
  ])
  .transform((p) => {
    if (p.schemaVersion === 1) {
      return {
        ...p,
        schemaVersion: 16 as const,
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
        schemaVersion: 16 as const,
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
        schemaVersion: 16 as const,
        customFonts: [],
        fanMounts: [],
        textLabels: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 4) {
      return {
        ...p,
        schemaVersion: 16 as const,
        customFonts: [],
        antennas: [],
      };
    }
    if (p.schemaVersion === 5) {
      // mountingFeatures items already have mountClass filled by the
      // mountingFeatureSchema default at parse time; just stamp the version.
      return { ...p, schemaVersion: 16 as const, customFonts: [] };
    }
    if (p.schemaVersion === 6) {
      // v6 → v7 is a pure version bump — `hinge` is optional and absent on
      // legacy projects, so the parsed object already has the right shape.
      return { ...p, schemaVersion: 16 as const, customFonts: [] };
    }
    if (p.schemaVersion === 7) {
      return { ...p, schemaVersion: 16 as const, customFonts: [] };
    }
    if (p.schemaVersion === 8) {
      // v8 → v9 is a pure version bump — `magnetPockets` is optional and
      // absent on legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 9) {
      // v9 → v10 is a pure version bump — the `fit` fields are optional and
      // absent on legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 10) {
      // v10 → v11 is a pure version bump — `badge` is optional and absent on
      // legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 11) {
      // v11 → v12 is a pure version bump — `insert` is optional and absent on
      // legacy projects, so the parsed object already has the shape.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 12) {
      // v12 → v15 are pure version bumps — `seal.mode`, the hoisted `printer`
      // and `blank` are all optional and absent on legacy projects, so the
      // parsed object already has the shape.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 13) {
      // v13 → v15 is a pure version bump: `printer` and `blank` are optional.
      // A project written before the move still carries its bed on
      // `case.rack.printer`, and `resolvePrinter` reads both, so no field is
      // rewritten here.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 14) {
      // v14 → v15 is a pure version bump — `blank` is optional and absent on
      // every project saved before the archetype existed.
      return { ...p, schemaVersion: 16 as const };
    }
    if (p.schemaVersion === 15) {
      // v15 → v16 is a pure version bump — `toolbox` is optional and absent on
      // every project saved before the archetype existed.
      return { ...p, schemaVersion: 16 as const };
    }
    return p;
  });

export type ProjectInput = z.infer<typeof projectSchema>;
