/**
 * #752 R-UI-4 — THE ROTARY OPERATION STEP'S TABLE (design `rotary-flow.md` §3.6).
 *
 * The three groups are named for where the cut lands, not for the machine's mode: operations on
 * the map's surface (`wrapped`), on a face (`indexed` — turn, hold, cut flat), and in 3D
 * (`relief`). The flat picker is unchanged; this table is what the wizard's step 4 draws when the
 * job is a rod in the rotary chuck.
 *
 * THE FACE GROUP IS NOT AUTHORABLE YET. The job model carries no face/index block — the indexed
 * CAM (`cam/indexed.ts`) is complete but nothing writes a face into a document, and that model is
 * #241's and R-UI-11's to design. Rather than write schema this slice would have to migrate, the
 * three chips are present, disabled, and each states the same one-sentence reason in operator
 * words; nothing about them reaches the job. (`simulate only` on Relief, by contrast, is a FACT
 * tag like `recommended`: that operation can be authored, generated and simulated.)
 *
 * The words come from §3.6's table; keeping them here means the picker and any later panel entry
 * read one list.
 */

export type RotaryOperationId =
  | 'engrave'
  | 'v-carve'
  | 'pocket'
  | 'flute'
  | 'flat'
  | 'faces-all-round'
  | 'cross-hole'
  | 'relief';

export type RotaryOperationGroupId = 'surface' | 'face' | '3d';

export interface RotaryOperationDef {
  id: RotaryOperationId;
  /** The chip's word. */
  label: string;
  /** One line saying what the operation makes on a round stock. */
  blurb: string;
  /** Non-null: not authorable yet, and this is the one sentence the screen shows. */
  reason: string | null;
  /** A fact tag beside the chip — `simulate only` — never a disabled state. */
  tag: string | null;
}

/**
 * The face group's one sentence, stated once under its chips and carried in each chip's title.
 * Operator words: no code, no issue number, and what CAN be done today.
 */
export const ROTARY_FACE_REASON =
  'Cutting on a face is not planned yet — the job can carry wrapped and 3D operations today.';

export const ROTARY_OPERATION_GROUPS: readonly {
  id: RotaryOperationGroupId;
  label: string;
  operations: readonly RotaryOperationDef[];
}[] = [
  {
    id: 'surface',
    label: 'On the surface',
    operations: [
      {
        id: 'engrave',
        label: 'Engrave text',
        blurb: 'Text on the map, cut at its depth below the surface',
        reason: null,
        tag: null,
      },
      {
        id: 'v-carve',
        label: 'V-carve',
        blurb: 'The same on the map, with a V-bit',
        reason: null,
        tag: null,
      },
      {
        id: 'pocket',
        label: 'Pocket',
        blurb: 'A region on the map to a floor depth',
        reason: null,
        tag: null,
      },
      {
        id: 'flute',
        label: 'Flute',
        blurb: 'A ramped line along the rod',
        reason: null,
        tag: null,
      },
    ],
  },
  {
    id: 'face',
    label: 'On a face',
    operations: [
      {
        id: 'flat',
        label: 'Flat',
        blurb: 'Turn to an angle, hold, and cut a flat to a depth',
        reason: ROTARY_FACE_REASON,
        tag: null,
      },
      {
        id: 'faces-all-round',
        label: 'Faces all round',
        blurb: 'Evenly indexed flats — a square, a hex, an octagon',
        reason: ROTARY_FACE_REASON,
        tag: null,
      },
      {
        id: 'cross-hole',
        label: 'Cross-hole',
        blurb: 'Turn to an angle and drill across the rod',
        reason: ROTARY_FACE_REASON,
        tag: null,
      },
    ],
  },
  {
    id: '3d',
    label: '3D',
    operations: [
      {
        id: 'relief',
        label: 'Relief from a mesh',
        blurb: 'Z follows a mesh as A sweeps',
        reason: null,
        tag: 'simulate only',
      },
    ],
  },
];
