import { glyphProfile } from '@/engine/compiler/glyphs';
import {
  aabbOfProfile,
  pRotate,
  pTranslate,
  rectProfile,
  type Profile,
} from '@/engine/compiler/profile';
import { resolveFont } from '@/engine/fonts/registry';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import type { Mm } from '@/types/units';

/**
 * `PartPlan` is the seam #172 specified (`/Fabrication.md` §5.2): profiles and a target Z,
 * never a mesh. The compiler knows the region and the depth; a mesh discards both and forces
 * CAM to re-infer them.
 *
 * Two differences from the §5.2 sketch (#200):
 *  - `split` is omitted: wood has no colour layers. The badge adds it back in CNC-3.
 *  - `keepOuts` is `[]` for a solid block — no magnet pocket to reserve.
 */
export interface PartPlan {
  stock: {
    outline: Profile;
    thickness: Mm;
    keepOuts: { footprint: Profile; zCeiling: Mm }[];
  };
  engraves: { id: string; profile: Profile; depth: Mm }[];
}

/**
 * The text of one label as a `Profile` in the STOCK frame (front-left at the origin):
 * typeset with its cap height at the origin, centred on its bounding box, rotated about
 * that centre, then translated to `label.position`.
 *
 * `glyphProfile` returns the text with its baseline at the origin, so the placement is three
 * moves in this order (the order matters — rotating after centring keeps the rotation about
 * the text's own centre, not the stock origin).
 *
 * An empty or whitespace-only label yields an empty `p-poly`; it is kept in the plan so
 * #201 can report it rather than the job silently losing a row.
 */
export function labelProfile(label: EngraveLabel, customFonts: readonly CustomFont[]): Profile {
  const glyphs = glyphProfile(label.text, resolveFont(label.font, label.weight, customFonts), label.size);
  const box = aabbOfProfile(glyphs);
  if (!box) return glyphs; // whitespace-only: nothing to centre or place
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const centred = pTranslate([-cx, -cy], glyphs);
  const rotated = pRotate(label.rotation, centred);
  return pTranslate([label.position.x, label.position.y], rotated);
}

/**
 * The pure derivation every downstream consumer reads. The stock outline is
 * `rectProfile(length, width)` with its FRONT-LEFT corner at the origin — the job frame IS
 * the work frame (#200 decision 3), and it is never centred.
 */
export function toPartPlan(job: EngraveJob): PartPlan {
  return {
    stock: {
      outline: rectProfile(job.stock.length, job.stock.width),
      thickness: job.stock.thickness,
      keepOuts: [],
    },
    engraves: job.labels
      .filter((label) => label.enabled)
      .map((label) => ({
        id: label.id,
        profile: labelProfile(label, job.customFonts),
        depth: label.depth,
      })),
  };
}
