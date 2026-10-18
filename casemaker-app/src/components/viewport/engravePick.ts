/**
 * Turning a click on the engrave preview into the item it belongs to (#441).
 *
 * The preview draws one floor mesh per cut and tags it `userData.engraveFloor` with the id of the
 * job item that produced it (`EngravePreview`'s `Floor`). The id is the job's own — labels,
 * shapes (combined and imported vectors included), traces and drills all reach `cuts` with their
 * own `id`, so the row list and the preview key on the same string.
 *
 * The resolver walks the object AND its ancestors, nearest tag first. A click handler attached to
 * the mesh already hands us the mesh itself, but a wrapper group around it (or a future compound
 * pickable) would still resolve to the item it belongs to rather than silently missing.
 *
 * Four tags are read: `engraveFloor` (the cut's bottom, #441), `engraveLost` (§5.7's lost layer),
 * `engravePrimitive` (a 3D cut-away primitive, #435) and `engraveTarget` (the reference object,
 * #435). Each names a row in the panel, and clicking it should open that row — the loss is a
 * property of the same item as the cut beside it, and a primitive's ghost is the item itself.
 *
 * It lives here, apart from the component, so a node test can call it with a plain `Object3D`:
 * no canvas, no renderer, no WebGL. Only `userData` and `parent` are read.
 *
 * Voids (`userData.engraveVoid`) are deliberately NOT resolved: a void is not an item — it is a
 * pocket the blank already has, with its own row list — and the approved scope of #441 is the
 * item list (#411).
 */

import type { Object3D } from 'three';
import { expandEngraveRow } from '@/store/engraveRowStore';
import { selectEngraveItem } from '@/store/viewportStore';

/** The job item id a clicked preview object belongs to, or null when it is not tied to one. */
export function engraveItemIdFromPick(object: Object3D | null | undefined): string | null {
  for (let node = object ?? null; node; node = node.parent) {
    for (const tag of [
      node.userData?.engraveFloor,
      node.userData?.engraveLost,
      node.userData?.engravePrimitive,
      node.userData?.engraveTarget,
    ]) {
      if (typeof tag === 'string' && tag !== '') return tag;
    }
  }
  return null;
}

/**
 * What a click on a preview floor does (#441): select the item in `viewportStore` and open that
 * item's row in the panel. Returns false when the object carries no item id, so the caller can
 * leave the click alone.
 *
 * `expand`, not `toggle`: clicking the same floor twice must not fold the row the user just
 * opened — the chevron owns folding — and `expand` is a no-op write when the row is already open,
 * so a repeat click costs no re-render of every row.
 */
export function activateEngraveItem(object: Object3D | null | undefined): boolean {
  const itemId = engraveItemIdFromPick(object);
  if (itemId === null) return false;
  selectEngraveItem(itemId);
  expandEngraveRow(itemId);
  return true;
}
