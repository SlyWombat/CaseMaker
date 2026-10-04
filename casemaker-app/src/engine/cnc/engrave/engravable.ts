import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { pOffset, type Profile } from '@/engine/compiler/profile';

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
 */
export function engravableProfile(glyph: Profile, toolRadius: number): Profile {
  const segments = segmentsForRadius(toolRadius);
  return pOffset(
    pOffset(glyph, -toolRadius, 'round', { segments }),
    toolRadius,
    'round',
    { segments },
  );
}
