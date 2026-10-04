// #213 §4 — the simulation viewport's sacrificial layer. The session already produces the mesh
// (`simSession.spec.ts`); what is new here is the VIEWPORT seam: which body `SimMeshes` selects for
// the current step, and that the layer is absent exactly when the job has no material. There is no
// R3F render harness in the suite, so the selection is tested as the pure helper it is, against
// real frames from a headless session — the same shape `simGeometry.spec.ts` and
// `simFixtures.spec.ts` use.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { drawsSacrificial, SACRIFICIAL_COLOR, sacrificialMesh } from '@/components/viewport/simGeometry';
import { createSimSession } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { stubSetup, type Setup } from '@/engine/cnc';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import { flatEndMill } from '@/engine/cnc/tool';
import { DEFAULT_SIM_LAYERS } from '@/store/simStore';

/** A stand-in mesh: the helper only ever returns the reference, so its contents do not matter. */
const marker = (n: number): NodeMeshOutput => ({ n } as unknown as NodeMeshOutput);

describe('#213 §4: the sacrificial mesh the viewport selects', () => {
  it('prefers the frame delivered for the current checkpoint (the body as cut so far)', () => {
    const frame = { sacrificial: marker(1) };
    const loaded = { sacrificial: marker(2) };
    expect(sacrificialMesh(frame, loaded)).toBe(frame.sacrificial);
  });

  it('falls back to the load’s uncut body before the first frame lands', () => {
    const loaded = { sacrificial: marker(2) };
    expect(sacrificialMesh(null, loaded)).toBe(loaded.sacrificial);
  });

  it('is null when the job has no material — the layer is present iff the material is', () => {
    expect(sacrificialMesh(null, null)).toBeNull();
    expect(sacrificialMesh({ sacrificial: null }, { sacrificial: null })).toBeNull();
    expect(sacrificialMesh({ sacrificial: null }, null)).toBeNull();
    expect(sacrificialMesh(null, { sacrificial: null })).toBeNull();
  });
});

describe('#213 §4: the shared sacrificial colour', () => {
  const mean = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b, 0) / 3;

  it('is one constant, a hex, distinct from — and paler than — the fixture grey', () => {
    expect(SACRIFICIAL_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
    expect(SACRIFICIAL_COLOR).not.toBe('#4b5563');
    expect(mean(SACRIFICIAL_COLOR)).toBeGreaterThan(mean('#4b5563'));
  });
});

describe('#213 §4: the sacrificial layer is independent of the workholding layer', () => {
  // `drawsSacrificial` reads only `layers.sacrificial`; these carry `fixture` to prove its value is
  // irrelevant (the param type excludes it, so the helper cannot read it). The two toggles move
  // the picture separately: hiding the jaws never hides the material, and vice versa.
  const fixtureOff = { sacrificial: true, fixture: false };
  const fixtureOn = { sacrificial: false, fixture: true };
  const bothOn = { sacrificial: true, fixture: true };
  const bothOff = { sacrificial: false, fixture: false };

  it('fixture off + sacrificial on still draws the body', () => {
    expect(drawsSacrificial(fixtureOff, true)).toBe(true);
  });

  it('sacrificial off + fixture on hides it', () => {
    expect(drawsSacrificial(fixtureOn, true)).toBe(false);
  });

  it('nothing to draw when the job has no material, whatever the layer', () => {
    expect(drawsSacrificial(bothOn, false)).toBe(false);
    expect(drawsSacrificial(bothOff, false)).toBe(false);
  });

  it('the store default turns both layers on, as separate keys', () => {
    expect(DEFAULT_SIM_LAYERS.sacrificial).toBe(true);
    expect(DEFAULT_SIM_LAYERS.fixture).toBe(true);
  });
});

describe('#213 §4: a job that cut sacrificial material selects a shrinking body', () => {
  // The #204 blank the session specs use: 100 x 60 x 12, with `presetJawStrips`’ two 6 mm strips
  // flushed to the top.
  const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 12 };
  const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
  const strips = (o: Partial<Setup> = {}): Setup => stubSetup(SLAB, HOLD, { sacrificial: presetJawStrips(), ...o });
  // X = 1 reaches into the left strip, so the stroke cuts part AND strip (#213).
  const STROKE = 'S1000 M3\nG0 X1 Y10 Z1\nG1 Z-5 F100\nG1 Y50\n';

  it('ships an uncut body, and the frame body the layer then draws is the cut one', () => {
    const session = createSimSession(tl);
    const r = session.load(STROKE, strips(), flatEndMill(3.175), null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    // The load’s uncut body is present, and is what the helper draws before any frame lands.
    expect(r.meshes.sacrificial).not.toBeNull();
    expect(sacrificialMesh(null, r.meshes)).toBe(r.meshes.sacrificial);
    // A frame at the cut checkpoint delivers the body as cut; the helper prefers it, and it is a
    // different body from the load’s uncut one — i.e. the layer really does track the cut.
    const cut = session.frameAt(0, 1);
    if (!cut) throw new Error('no frame at checkpoint 0');
    expect(cut.sacrificial).not.toBeNull();
    const selected = sacrificialMesh(cut, r.meshes);
    expect(selected).toBe(cut.sacrificial);
    expect(selected).not.toBe(r.meshes.sacrificial);
    session.dispose();
  });

  it('a job with no sacrificial material selects nothing at every step', () => {
    const session = createSimSession(tl);
    const r = session.load('S1000 M3\nG0 X10 Y10 Z1\nG1 Z-1 F100\nG1 X30\n', stubSetup(SLAB, HOLD), flatEndMill(3.175), null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    const f = session.frameAt(0, 1);
    if (!f) throw new Error('no frame at checkpoint 0');
    expect(sacrificialMesh(f, r.meshes)).toBeNull();
    session.dispose();
  });
});
