import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { pOffset, pScale, type Profile } from '@/engine/compiler/profile';

/**
 * The reachable region of a glyph — the stock-agnostic half of #171 (#201).
 *
 * With a flat end mill of radius `r`, the region the cutter can actually reach inside a
 * glyph `G` is the morphological OPENING `offset(offset(G, −r), +r)`
 * (`/Fabrication.md` §7.5, decision 15). Strokes thinner than `2r` vanish entirely; every
 * inside corner is rounded to radius `r`. The opened region IS the label from here on:
 * #172 pockets it, #205 previews it, #206 uses it as the prediction the simulation is
 * checked against. Nothing downstream draws the ideal glyph and warns separately.
 *
 * `segments` is passed EXPLICITLY on both offsets. This is not a style point: Manifold's
 * default arc resolution at r = 0.5 is 4 segments, so a "round" offset is a square with
 * 0.146 mm of chord error (#190). `segmentsForRadius` picks the count from a chord-error
 * target instead, so the same 0.005 mm of sagitta holds at a 0.5 mm tool radius and a
 * 25 mm fillet.
 *
 * ROTARY (#240, R10): a wrapped engraving's opening is ANISOTROPIC on its map — `r` along X,
 * `r·R/(R − d)` around (the small-angle form of `R·atan(r/(R − d))`), because the map's around
 * axis is an arc at the full radius while the footprint it is cut with stands on the floor at
 * `R − d`. Pass `wrap.aroundScale = aroundScale(R, d, r)` — the tool's own footprint frame, in
 * which a Y distance IS the tool's work-plane offset — and the opening is built there: scale Y
 * into that frame, open isotropically, and scale the result back. The region this comes out as
 * is exactly the anisotropic one, with no second offset algorithm and no hand-set around radius.
 * The pocket's first erosion uses the same frame (`generateEngrave`), so the region and the path
 * that cuts it cannot disagree. Without `wrap` the profile tree is unchanged.
 */
export function engravableProfile(
  glyph: Profile,
  toolRadius: number,
  wrap?: { aroundScale: number },
): Profile {
  const segments = segmentsForRadius(toolRadius);
  const glyphOnFloor = wrap ? pScale([1, wrap.aroundScale], glyph) : glyph;
  const opened = pOffset(
    pOffset(glyphOnFloor, -toolRadius, 'round', { segments }),
    toolRadius,
    'round',
    { segments },
  );
  return wrap ? pScale([1, 1 / wrap.aroundScale], opened) : opened;
}
