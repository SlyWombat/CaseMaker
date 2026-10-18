// #441 — pick resolution for the engrave preview, without a canvas.
//
// `EngravePreview` tags each cut's floor mesh with `userData.engraveFloor` = the job item's id.
// The resolver is what turns the object R3F reports for a click back into that id, and the
// activation is the two store writes the click makes. Plain `Object3D` instances stand in for
// the scene graph, so nothing here builds a renderer or a WebGL context.

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';

import {
  activateEngraveItem,
  engraveItemIdFromPick,
} from '@/components/viewport/engravePick';
import {
  isEngraveItemSelected,
  selectEngraveItem,
  useViewportStore,
} from '@/store/viewportStore';
import { resetEngraveRows, useEngraveRowStore } from '@/store/engraveRowStore';

/** A mesh-like object carrying one tag, as `Floor` renders it. */
function tagged(tag: unknown): Object3D {
  const object = new Object3D();
  object.userData = { engraveFloor: tag };
  return object;
}

/** A mesh-like object carrying the lost-layer tag, as `Lost` renders it (§5.7). */
function taggedLost(tag: unknown): Object3D {
  const object = new Object3D();
  object.userData = { engraveLost: tag };
  return object;
}

beforeEach(() => {
  useViewportStore.setState({ selection: null, activeSidebarSection: null });
  resetEngraveRows();
});

describe('#441 — resolving a clicked preview object to its engrave item', () => {
  it('reads the item id off the clicked floor', () => {
    expect(engraveItemIdFromPick(tagged('label-7'))).toBe('label-7');
  });

  it('reads a lost-layer tag too — the loss belongs to the same item as the cut (§5.7)', () => {
    expect(engraveItemIdFromPick(taggedLost('label-9'))).toBe('label-9');
    expect(activateEngraveItem(taggedLost('label-9'))).toBe(true);
    expect(useViewportStore.getState().selection).toEqual({ kind: 'engrave-item', itemId: 'label-9' });
  });

  it('reads a 3D primitive and the target object by their own tags (#435)', () => {
    const primitive = new Object3D();
    primitive.userData = { engravePrimitive: 'prm-4' };
    expect(engraveItemIdFromPick(primitive)).toBe('prm-4');

    const target = new Object3D();
    target.userData = { engraveTarget: 'tgt-1' };
    expect(engraveItemIdFromPick(target)).toBe('tgt-1');
    expect(activateEngraveItem(target)).toBe(true);
    expect(useViewportStore.getState().selection).toEqual({ kind: 'engrave-item', itemId: 'tgt-1' });
  });

  it('walks up to the nearest tagged ancestor', () => {
    const floor = tagged('trace-2');
    const wrapper = new Object3D();
    const child = new Object3D();
    wrapper.add(floor);
    floor.add(child);
    expect(engraveItemIdFromPick(child)).toBe('trace-2');
  });

  it('prefers the nearest tag when an ancestor is tagged too', () => {
    const outer = tagged('outer-item');
    const inner = tagged('inner-item');
    outer.add(inner);
    expect(engraveItemIdFromPick(inner)).toBe('inner-item');
  });

  it('returns null for an untagged object, an empty tag, a non-string tag or no object', () => {
    expect(engraveItemIdFromPick(new Object3D())).toBeNull();
    expect(engraveItemIdFromPick(tagged(''))).toBeNull();
    expect(engraveItemIdFromPick(tagged(42))).toBeNull();
    expect(engraveItemIdFromPick(tagged(null))).toBeNull();
    expect(engraveItemIdFromPick(null)).toBeNull();
    expect(engraveItemIdFromPick(undefined)).toBeNull();
  });
});

describe('#441 — a click selects the item and opens its row', () => {
  it('sets an engrave-item selection carrying the job id', () => {
    expect(activateEngraveItem(tagged('drill-3'))).toBe(true);
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'engrave-item',
      itemId: 'drill-3',
    });
  });

  it('expands that item row and only that row', () => {
    activateEngraveItem(tagged('shape-4'));
    expect([...useEngraveRowStore.getState().open]).toEqual(['shape-4']);
  });

  it('a second click on the same floor keeps the row open rather than folding it', () => {
    activateEngraveItem(tagged('vector-5'));
    activateEngraveItem(tagged('vector-5'));
    expect(useEngraveRowStore.getState().open.has('vector-5')).toBe(true);
  });

  it('leaves both stores alone when the object carries no item id', () => {
    activateEngraveItem(tagged('shape-1'));
    const before = useEngraveRowStore.getState().open;
    expect(activateEngraveItem(new Object3D())).toBe(false);
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'engrave-item',
      itemId: 'shape-1',
    });
    expect(useEngraveRowStore.getState().open).toBe(before);
  });

  it('keeps the engrave section open so the row it opened is visible', () => {
    useViewportStore.setState({ activeSidebarSection: 'cnc-engrave' });
    activateEngraveItem(tagged('label-1'));
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });
});

/**
 * #441 — the two sides write and read ONE selection.
 *
 * `selectEngraveItem` is what a row's name calls; `isEngraveItemSelected` is what a row and a
 * preview floor both read. Testing them apart from React is what keeps the pair from growing a
 * second notion of "selected" that a redraw of the preview would drop.
 */
describe('#441 — one selection shared by the row list and the preview', () => {
  it('selects an item by id, as the row name does', () => {
    selectEngraveItem('trace-9');
    expect(useViewportStore.getState().selection).toEqual({
      kind: 'engrave-item',
      itemId: 'trace-9',
    });
  });

  it('answers yes only for the selected item', () => {
    selectEngraveItem('label-2');
    const { selection } = useViewportStore.getState();
    expect(isEngraveItemSelected(selection, 'label-2')).toBe(true);
    expect(isEngraveItemSelected(selection, 'label-3')).toBe(false);
  });

  it('answers no for no selection or another kind of selection', () => {
    expect(isEngraveItemSelected(null, 'label-2')).toBe(false);
    expect(isEngraveItemSelected({ kind: 'host' }, 'label-2')).toBe(false);
  });
});
