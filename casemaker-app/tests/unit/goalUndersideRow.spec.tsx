// @vitest-environment jsdom
/**
 * #898 — the goal row's UNDERSIDE control: nothing chosen says what the app proposes (read off
 * the mesh), and picking a kind stores the operator's choice. The mesh is generated here, so the
 * test owns every number it reads.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { expandEngraveRow, resetEngraveRows } from '@/store/engraveRowStore';
import { EngraveTargetObjectRow } from '@/components/panels/EngraveTargetObjectRow';
import { tl } from './helpers/manifoldExec';
import type { EngraveTargetObject } from '@/types/engraveJob';

beforeEach(() => {
  // The row's fields live behind its fold; open it the way the panel does.
  expandEngraveRow('goal-row');
});

afterEach(() => {
  cleanup();
  clearTargetObjectMeshCache();
  resetEngraveRows();
});

function stlOf(solid: { getMesh: () => { vertProperties: Float32Array; triVerts: Uint32Array } }): string {
  const mesh = solid.getMesh();
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const n = tv.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let i = 0; i < tv.length; i += 3) {
    off += 12;
    for (let k = 0; k < 3; k++) {
      const v = tv[i + k]! * 3;
      dv.setFloat32(off, vp[v]!, true);
      dv.setFloat32(off + 4, vp[v + 1]!, true);
      dv.setFloat32(off + 8, vp[v + 2]!, true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function flatPart(): EngraveTargetObject {
  const base = tl.Manifold.cube([30, 30, 2], true).translate(0, 0, 1);
  const body = tl.Manifold.cube([10, 10, 8], true).translate(0, 0, 6);
  return {
    id: 'goal-row',
    name: 'elephant.stl',
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: stlOf(base.add(body)),
    size: { x: 30, y: 30, z: 10 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

const stock = { length: 100, width: 60, thickness: 20, edgeMargin: 2 };

describe('#898 — the goal row’s underside control', () => {
  it('says what the app proposes, and a press stores the choice', () => {
    const target = flatPart();
    const onChange = vi.fn();
    render(
      <EngraveTargetObjectRow
        target={target}
        index={0}
        onChange={onChange}
        onRemove={() => {}}
        findings={[]}
        stock={stock}
      />,
    );
    const select = screen.getByTestId('engrave-target-underside-0') as HTMLSelectElement;
    expect(select.value).toBe('');
    // The unselected entry carries the proposal read off the mesh: a flat base.
    expect(select.options[0]!.textContent).toContain("the app proposes flat on the stock's bottom");
    expect(screen.getByTestId('engrave-target-underside-why-0').textContent).toContain('flat face');
    fireEvent.change(select, { target: { value: 'plinth' } });
    expect(onChange).toHaveBeenCalledWith({ underside: { kind: 'plinth', source: 'user' } });
  });

  it('a chosen kind states what it does', () => {
    const target: EngraveTargetObject = { ...flatPart(), underside: { kind: 'flat', skinMm: 0.5 } };
    render(
      <EngraveTargetObjectRow
        target={target}
        index={0}
        onChange={() => {}}
        onRemove={() => {}}
        findings={[]}
        stock={stock}
      />,
    );
    expect(screen.getByTestId('engrave-target-underside-why-0').textContent).toContain('0.5 mm skin');
    // Choosing "not chosen" clears the block.
    const onChange = vi.fn();
    render(
      <EngraveTargetObjectRow
        target={target}
        index={0}
        onChange={onChange}
        onRemove={() => {}}
        findings={[]}
        stock={stock}
      />,
    );
    fireEvent.change(screen.getAllByTestId('engrave-target-underside-0')[1]!, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ underside: undefined });
  });
});
