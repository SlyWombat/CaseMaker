/**
 * #752 R-UI-4 — THE ROTARY OPERATION STEP'S TABLE (design `rotary-flow.md` §3.6).
 *
 * The three groups are named for where the cut lands, not for the machine's mode: operations on
 * the map's surface (`wrapped`), on a face (`indexed` — turn, hold, cut flat), and in 3D
 * (`relief`). The flat picker is unchanged; this table is what the wizard's step 4 draws when the
 * job is a rod in the rotary chuck.
 *
 * THE FACE GROUP IS AUTHORABLE SINCE #241 SLICE 2. A Flat, a ring of flats and a Cross-hole each
 * carry their own index (A) and are cut as an indexed program: the job's `faces` list holds them
 * in cut order, and Generate walks them into `cam/indexed.ts`'s faces and holes. The three chips
 * are enabled; each shows its one field under the grid.
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
        reason: null,
        tag: null,
      },
      {
        id: 'faces-all-round',
        label: 'Faces all round',
        blurb: 'Evenly indexed flats — a square, a hex, an octagon',
        reason: null,
        tag: null,
      },
      {
        id: 'cross-hole',
        label: 'Cross-hole',
        blurb: 'Turn to an angle and drill across the rod',
        reason: null,
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
