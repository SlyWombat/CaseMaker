// @vitest-environment jsdom
/**
 * #831 — turning and moving a goal to fit the stock: "Lay it flat" (the shallowest of the 24
 * axis-aligned orientations), the +90° turns about the stock's axes, the sampler reading the same
 * turn, the document round-trip, the panel's line and its undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Euler, Matrix4 } from 'three';

import {
  AXIS_ALIGNED_TURNS,
  chooseLayFlat,
  describeTurn,
  turnAboutAxis,
  turnsFromMatrix,
  turnsPatch,
} from '@/engine/cnc/engrave/goalOrientation';
import { placedSize, rotationMatrix } from '@/engine/cnc/engrave/targetScale';
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { serializeJobFile } from '@/engine/cnc/engrave/jobFile';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { EngraveTargetObjectRow } from '@/components/panels/EngraveTargetObjectRow';
import { resetEngraveRows } from '@/store/engraveRowStore';
import { useEngraveJobStore, type TargetObjectPatch } from '@/store/engraveJobStore';
import { useViewportStore } from '@/store/viewportStore';
import {
  rememberGoalPlacement,
  resetGoalTransformUndo,
  undoGoalPlacement,
} from '@/store/goalTransformUndo';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { binaryStlBase64 } from './helpers/meshes';

beforeEach(() => {
  resetEngraveRows();
  resetGoalTransformUndo();
});
afterEach(() => {
  cleanup();
  clearTargetObjectMeshCache();
});

type V = [number, number, number];
type Tri = [V, V, V];

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const c: V[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const q = (a: number, b: number, d: number, e: number): Tri[] => [
    [c[a]!, c[b]!, c[d]!],
    [c[a]!, c[d]!, c[e]!],
  ];
  return [...q(4, 5, 6, 7), ...q(0, 3, 2, 1), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)];
}

let n = 0;
/** A tall 30 × 20 × 75 mm column, the maintainer's 75 mm goal, on a 43 × 32 blank. */
function tall(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-tall',
    name: 'tall.stl',
    format: 'stl',
    sha256: (n++).toString(16).padStart(64, 'c'),
    data: binaryStlBase64(box(0, 30, 0, 20, 0, 75)),
    size: { x: 30, y: 20, z: 75 },
    position: { x: 21.5, y: 16, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}
const STOCK = { length: 43, width: 32, thickness: 20, edgeMargin: 1 };
const ROOM = { x: 41, y: 30 };

describe('#831 — the orientations', () => {
  it('there are exactly 24 axis-aligned orientations', () => {
    expect(AXIS_ALIGNED_TURNS).toHaveLength(24);
    const keys = new Set(AXIS_ALIGNED_TURNS.map((t) => rotationMatrix(t).map((v) => Math.round(v)).join(',')));
    expect(keys.size).toBe(24);
  });

  it('a turn about a stock axis composes on the left, read back as the same XYZ Euler three.js draws', () => {
    const start = { x: 30, y: 15, z: 60 };
    const t = turnAboutAxis(start, 'z', 90);
    const want = new Matrix4()
      .makeRotationZ(Math.PI / 2)
      .multiply(new Matrix4().makeRotationFromEuler(new Euler(30 * (Math.PI / 180), 15 * (Math.PI / 180), 60 * (Math.PI / 180), 'XYZ')));
    const got = new Matrix4().makeRotationFromEuler(new Euler(t.x * (Math.PI / 180), t.y * (Math.PI / 180), t.z * (Math.PI / 180), 'XYZ'));
    for (let i = 0; i < 16; i++) expect(got.elements[i]).toBeCloseTo(want.elements[i]!, 6);
    expect(turnAboutAxis({ x: 0, y: 0, z: 0 }, 'x', 90)).toEqual({ x: 90, y: 0, z: 0 });
    expect(turnsFromMatrix(rotationMatrix({ x: 0, y: 0, z: 0 }))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('turnsPatch stores 0 about X or Y as an absent key', () => {
    expect(turnsPatch({ x: 0, y: 90, z: 0 })).toEqual({ rotation: 0, rotationX: undefined, rotationY: 90 });
  });
});

describe('#831 — Lay it flat', () => {
  it('a 75 mm tall column lies on its widest face: 20 mm deep, the long side along the blank', () => {
    const choice = chooseLayFlat(tall(), ROOM);
    expect(choice.changes).toBe(true);
    expect(choice.currentDepthMm).toBeCloseTo(75, 9);
    expect(choice.depthMm).toBeCloseTo(20, 9);
    const placed = placedSize({ ...tall(), ...turnsPatch(choice.turns) });
    expect(placed.z).toBeCloseTo(20, 9);
    // The tie (75 × 30 or 30 × 75 on a 41 × 30 room) goes to the one that fits larger: 75 along X.
    expect(placed.x).toBeCloseTo(75, 9);
    expect(placed.y).toBeCloseTo(30, 9);
    expect(describeTurn({ x: 0, y: 0, z: 0 }, choice.turns)).toMatch(/^Turned (-?90|180)° about [XYZ], then (-?90|180)° about [XYZ]$/);
  });

  it('a part already lying flat is left as it is', () => {
    const choice = chooseLayFlat(tall({ rotationX: 90 }), ROOM);
    expect(choice.changes).toBe(false);
    expect(choice.turns).toEqual({ x: 90, y: 0, z: 0 });
    expect(choice.depthMm).toBeCloseTo(20, 9);
  });

  it('reads the scale: a stretched part picks by its placed size', () => {
    // Height scaled to 10 %: 7.5 mm tall is already the shallowest.
    const choice = chooseLayFlat(tall({ scale: { x: 1, y: 1, z: 0.1 } }), ROOM);
    expect(choice.changes).toBe(false);
    expect(choice.depthMm).toBeCloseTo(7.5, 9);
  });
});

describe('#831 — the sampler reads the turn', () => {
  /** A 10 × 20 × 40 column on a 10 × 10 × 1 foot: depth 40 standing. */
  const L: Tri[] = [...box(0, 10, 0, 20, 0, 40), ...box(0, 10, 20, 30, 0, 1)];
  const lgoal = (over: Partial<EngraveTargetObject> = {}): EngraveTargetObject => ({
    ...tall(),
    data: binaryStlBase64(L),
    size: { x: 10, y: 30, z: 40 },
    position: { x: 50, y: 50, z: 0 },
    ...over,
  });

  it('a 90° turn about X swaps the height and the length in the sampled bounds', () => {
    const flat = sampleGoalHeightfield(lgoal(), { pitchMm: 0.5 });
    const turned = sampleGoalHeightfield(lgoal({ ...turnsPatch(turnAboutAxis({ x: 0, y: 0, z: 0 }, 'x', 90)) }), {
      pitchMm: 0.5,
    });
    const spanY = (hf: typeof flat) => (hf.ny - 1) * hf.pitch;
    expect(spanY(flat)).toBeGreaterThanOrEqual(30 - 0.5 - 1e-9);
    expect(spanY(flat)).toBeLessThanOrEqual(30 + 0.5 + 1e-9);
    expect(spanY(turned)).toBeGreaterThanOrEqual(40 - 0.5 - 1e-9);
    expect(spanY(turned)).toBeLessThanOrEqual(40 + 0.5 + 1e-9);
    // Standing, the foot is 39 mm below the column's top; laid down, the deepest step is the
    // column's side, 10 mm below the foot's edge.
    expect(flat.minZ).toBeCloseTo(-39, 3);
    expect(turned.minZ).toBeCloseTo(-10, 3);
    expect(placedSize(lgoal({ rotationX: 90 })).z).toBeCloseTo(30, 9);
    expect(placedSize(lgoal({ rotationX: 90 })).y).toBeCloseTo(40, 9);
  });

  it('a goal without the turn fields samples exactly as one with them at 0', () => {
    const plain = sampleGoalHeightfield(lgoal(), { pitchMm: 1 });
    const zero = sampleGoalHeightfield(lgoal({ rotation: 0, rotationX: 0, rotationY: 0 }), { pitchMm: 1 });
    expect(zero.nx).toBe(plain.nx);
    expect(zero.ny).toBe(plain.ny);
    expect(Array.from(zero.z)).toEqual(Array.from(plain.z));
  });
});

describe('#831 — the document', () => {
  it('a turned, moved, fitted goal saves and reloads unchanged', () => {
    const job = defaultEngraveJob();
    job.targetObject = tall({ rotation: 90, rotationX: -90, rotationY: 180, position: { x: 20, y: 15, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 } });
    const parsed = parseEngraveJob(JSON.parse(serializeJobFile(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const t = parsed.job.targetObject!;
    expect([t.rotation, t.rotationX, t.rotationY]).toEqual([90, -90, 180]);
    expect(t.position).toEqual({ x: 20, y: 15, z: 0 });
    expect(t.scale).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });

  it('a job without the fields reloads without gaining them', () => {
    const job = defaultEngraveJob();
    job.targetObject = tall();
    const parsed = parseEngraveJob(JSON.parse(serializeJobFile(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const t = parsed.job.targetObject!;
    expect('rotationX' in t).toBe(false);
    expect('rotationY' in t).toBe(false);
    expect('scale' in t).toBe(false);
  });
});

describe('#831 — the panel', () => {
  function renderRow(target: EngraveTargetObject) {
    const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
    const view = render(
      <EngraveTargetObjectRow
        target={target}
        index={0}
        onChange={onChange}
        onRemove={() => undefined}
        findings={[]}
        stock={STOCK}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
    return { onChange, view };
  }

  it('offers Lay it flat, unasked, when the goal stands far deeper than it could lie', () => {
    renderRow(tall());
    expect(screen.getByTestId('engrave-target-layflat-suggest-0').textContent).toBe(
      'It stands 75 mm tall; laid flat it would be 20 mm deep. Press Lay it flat.',
    );
  });

  it('says nothing when it already lies flat', () => {
    renderRow(tall({ rotationX: 90 }));
    expect(screen.queryByTestId('engrave-target-layflat-suggest-0')).toBeNull();
  });

  it('Lay it flat turns it, fits it to the stock with the aspect kept, and says what it chose', () => {
    const { onChange, view } = renderRow(tall());
    fireEvent.click(screen.getByTestId('engrave-target-layflat-0'));
    const patch = onChange.mock.calls.at(-1)![0];
    const turned = { ...tall(), ...patch, position: { ...tall().position, ...patch.position } } as EngraveTargetObject;
    // Laid flat it is 75 × 30 × 20 at 1×; the blank's room is 41 × 30 × 20, so X binds: 41/75.
    expect(patch.scale!.x).toBeCloseTo(41 / 75, 9);
    expect(patch.position).toEqual({ x: 21.5, y: 16, z: 0 });
    expect(placedSize(turned).z).toBeCloseTo((20 * 41) / 75, 9);
    // The statement shows once the row reads the turned goal back.
    view.rerender(
      <EngraveTargetObjectRow target={turned} index={0} onChange={onChange} onRemove={() => undefined} findings={[]} stock={STOCK} />,
    );
    expect(screen.getByTestId('engrave-target-layflat-said-0').textContent).toMatch(
      /^Turned (-?90|180)° about [XYZ], then (-?90|180)° about [XYZ]: 10\.9 mm deep instead of 75 mm, fitted to the stock at 54\.7 %\.$/,
    );
  });

  it('the +90° buttons turn about the stock axes', () => {
    const { onChange } = renderRow(tall());
    fireEvent.click(screen.getByTestId('engrave-target-turn-x-0'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 0, rotationX: 90, rotationY: undefined });
    fireEvent.click(screen.getByTestId('engrave-target-turn-z-0'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 90, rotationX: undefined, rotationY: undefined });
  });

  it('the angle fields carry degrees', () => {
    renderRow(tall({ rotationX: 90 }));
    expect((screen.getByTestId('engrave-target-rotation-x-0') as HTMLInputElement).value).toBe('90');
    expect(screen.getByTestId('engrave-target-rotation-0').closest('label')!.textContent).toBe('about Z°');
  });
});

describe('#831 — undo', () => {
  it('a remembered placement is put back, and only onto the same goal', () => {
    const store = useEngraveJobStore.getState();
    store.setTargetObject(tall({ data: undefined }));
    rememberGoalPlacement();
    useEngraveJobStore.getState().updateTargetObject({ rotationX: 90, scale: { x: 0.5, y: 0.5, z: 0.5 }, position: { x: 5 } });
    expect(useEngraveJobStore.getState().job.targetObject?.rotationX).toBe(90);
    expect(undoGoalPlacement()).toBe(true);
    const t = useEngraveJobStore.getState().job.targetObject!;
    expect('rotationX' in t).toBe(false);
    expect('scale' in t).toBe(false);
    expect(t.position).toEqual({ x: 21.5, y: 16, z: 0 });
    expect(undoGoalPlacement()).toBe(false);

    rememberGoalPlacement();
    useEngraveJobStore.getState().setTargetObject(tall({ id: 'other', data: undefined }));
    expect(undoGoalPlacement()).toBe(false);
  });
});

// #876 — PLACE ON FACE is armed from the row: the two presses say which way the picked face
// goes, the same press toggles off, and arming writes nothing to the document (the click in the
// viewport is the write).
describe('#876 — arming place-on-face', () => {
  function renderRow(target: EngraveTargetObject) {
    const onChange = vi.fn<(patch: TargetObjectPatch) => void>();
    render(
      <EngraveTargetObjectRow target={target} index={0} onChange={onChange} onRemove={() => undefined} findings={[]} stock={STOCK} />,
    );
    fireEvent.click(screen.getByTestId('engrave-target-expand-0'));
    return { onChange };
  }

  it('arms Face down / Face up first on the viewport store, and toggles off', () => {
    useViewportStore.setState({ placeFace: null });
    const target = tall();
    const { onChange } = renderRow(target);
    fireEvent.click(screen.getByTestId('engrave-target-place-down-0'));
    expect(useViewportStore.getState().placeFace).toEqual({ targetId: target.id, direction: 'down' });
    expect(screen.getByTestId('engrave-target-place-armed-0').textContent).toContain('face down');
    // The same press disarms.
    fireEvent.click(screen.getByTestId('engrave-target-place-down-0'));
    expect(useViewportStore.getState().placeFace).toBeNull();
    // The other direction arms the other choice and says it.
    fireEvent.click(screen.getByTestId('engrave-target-place-up-0'));
    expect(useViewportStore.getState().placeFace).toEqual({ targetId: target.id, direction: 'up' });
    expect(screen.getByTestId('engrave-target-place-armed-0').textContent).toContain('machined first');
    expect(onChange).not.toHaveBeenCalled();
    useViewportStore.setState({ placeFace: null });
  });

  it('nudges the goal with the arrow keys — 1 mm, Shift 10 mm — and never while a field has focus', () => {
    const target = tall();
    const { onChange } = renderRow(target);
    const key = (k: string, opts: KeyboardEventInit = {}): void => {
      fireEvent.keyDown(window, { key: k, ...opts });
    };
    key('ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith({ position: { x: target.position.x + 1 } });
    key('ArrowLeft', { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ position: { x: target.position.x - 10 } });
    key('ArrowUp');
    expect(onChange).toHaveBeenLastCalledWith({ position: { y: target.position.y + 1 } });
    key('ArrowDown', { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ position: { y: target.position.y - 10 } });
    // A focused field keeps the arrows (stepping a number), so the nudge stands aside.
    const calls = onChange.mock.calls.length;
    (screen.getByTestId('engrave-target-x-0') as HTMLInputElement).focus();
    key('ArrowRight');
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('offers Centre / Drop / Flush / Reset as one write each, and states the fit', () => {
    const target = tall();
    const { onChange } = renderRow(target);
    // 75 mm on a 20 mm blank: the fact says so, and names the sink that would fit it.
    expect(screen.getByTestId('engrave-target-fit-said-0').textContent).toBe(
      '55 mm too tall: Resize to fit, or Cut the top 55 mm',
    );
    fireEvent.click(screen.getByTestId('engrave-target-centre-0'));
    expect(onChange).toHaveBeenLastCalledWith({ position: { x: 21.5, y: 16 } });
    fireEvent.click(screen.getByTestId('engrave-target-drop-0'));
    expect(onChange).toHaveBeenLastCalledWith({ position: { z: 55 } });
    fireEvent.click(screen.getByTestId('engrave-target-flush-0'));
    expect(onChange).toHaveBeenLastCalledWith({ position: { z: 0 } });
    fireEvent.click(screen.getByTestId('engrave-target-reset-rotation-0'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 0, rotationX: undefined, rotationY: undefined });
  });

  it('says what fits with room to spare, on the tightest axis', () => {
    // Room is 41 × 30 × 20; this part leaves 3 mm in X, 20 in Y and 12 in Z.
    renderRow(tall({ size: { x: 38, y: 10, z: 8 } }));
    expect(screen.getByTestId('engrave-target-fit-said-0').textContent).toBe('fits the stock with 3 mm to spare in X');
  });

  it('offers no Drop or Flush for a mould: its cavity opens at the stock top, so Z is not a placement', () => {
    renderRow(tall({ goalMode: 'mold' }));
    expect(screen.queryByTestId('engrave-target-drop-0')).toBeNull();
    expect(screen.queryByTestId('engrave-target-flush-0')).toBeNull();
    expect(screen.getByTestId('engrave-target-centre-0')).toBeTruthy();
    expect(screen.getByTestId('engrave-target-reset-rotation-0')).toBeTruthy();
  });
});
