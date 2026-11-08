/**
 * #1073 — THE RELEASE IS THE FLIPPED SETUP'S LAST PROGRAM, POSTED AND VERIFIED, AND THE SHEET
 * ENDS ON ITS TABS. This drives the real seam end to end: F's flip plan bands the two goal copies,
 * `generateGoalProgram` plans the side-2 setup with `sideFace: 'bottom'`, and the release is
 * appended to that setup's program list before the existing post/verify loop runs. The tab size
 * comes from the SHOP's defaults (8 wide on this fixture), never a compiled-in release constant.
 *
 * The part is a flared prism (strictly widest at its middle) so the flip plan's silhouette plane
 * lands there and the release's section is the wide outline with long straight runs.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planUndersideFlip } from '@/engine/cnc/engrave/goalFlipSetups';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { tl } from './helpers/manifoldExec';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** The flared prism: 60 × 30 at both ends, 80 × 40 at the middle (z −10). */
function flaredStl(): string {
  const rect = (hx: number, hy: number, z: number): V[] => [
    [-hx, -hy, z],
    [hx, -hy, z],
    [hx, hy, z],
    [-hx, hy, z],
  ];
  const solid = tl.Manifold.hull([...rect(30, 15, -20), ...rect(40, 20, -10), ...rect(30, 15, 0)]);
  const mesh = solid.getMesh();
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const tris: Tri[] = [];
  for (let i = 0; i < tv.length; i += 3) {
    const p = (k: number): V => [vp[tv[i + k]! * 3]!, vp[tv[i + k]! * 3 + 1]!, vp[tv[i + k]! * 3 + 2]!];
    tris.push([p(0), p(1), p(2)]);
  }
  return stl(tris);
}

/** The k3 shop's tab default as DATA — 8 wide × 2 thick — the release must read, not bake in. */
const SHOP_DEFAULTS = {
  'tabs.count': { value: 4, source: 'seeded' },
  'tabs.widthMm': { value: 8, source: 'seeded' },
  'tabs.heightMm': { value: 2, source: 'seeded' },
} as unknown as ShopDefaults;

function fixture(): { job: EngraveJob; side1: EngraveTargetObject; side2: EngraveTargetObject } {
  const base: EngraveTargetObject = {
    id: 'g1',
    name: 'part.stl',
    format: 'stl',
    sha256: 'c'.repeat(64),
    data: flaredStl(),
    size: { x: 80, y: 40, z: 20 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    // No tabs block: the press writes only the kind, so the release's count/width must come from
    // the SHOP's defaults (below) and its height from the band's own half-thickness.
    underside: { kind: 'flipped-tabs' },
  };
  const baseJob = defaultEngraveJob();
  const job: EngraveJob = {
    ...baseJob,
    labels: [],
    shapes: [],
    stock: { ...baseJob.stock, length: 100, width: 60, thickness: 30 },
    targetObject: base,
  };
  const split = planUndersideFlip(job, base);
  if (!split.ok) throw new Error(split.reason);
  // The plan's own setups ride the job, so the side-2 goal's setup (and its pins) resolve.
  return { job: { ...job, setups: split.plan.setups }, side1: split.plan.goals[0]!, side2: split.plan.goals[1]! };
}

const TOOL: Tool = flatEndMill(3, { name: 'flat 3', fluteLength: 40 });
const ENTRY: ToolLibraryEntry = { key: 'inv:flat-3', tool: TOOL, provenance: 'spec' };

describe('#1073 — the release posts as the flipped setup’s last program', () => {
  it('appends one release program after the plan’s own, with the shop’s tab size', async () => {
    const { job, side2 } = fixture();
    const out = await generateGoalProgram(job, side2, TOOL, null, {
      shop: { tools: [ENTRY], defaults: SHOP_DEFAULTS },
      sideFace: 'bottom',
    });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    // The plan's own program(s), then the release — posted and verified by the same loop.
    expect(out.programs.length).toBeGreaterThan(1);
    const release = out.programs[out.programs.length - 1]!;
    expect(release.tabRelease).toBeDefined();
    expect(release.tabRelease!.count).toBe(4);
    expect(release.tabRelease!.widthMm).toBe(8); // the shop default, as data
    expect(release.tabRelease!.heightMm).toBe(1); // the goal's band half — the material left
    expect(release.tabRelease!.at).toHaveLength(4);
    for (const p of release.tabRelease!.at) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    // The file is the release, and the earlier programs are not it.
    expect(release.nc).toContain('Tab release');
    expect(release.cam?.operations).toBe(1);
    for (const earlier of out.programs.slice(0, -1)) expect(earlier.tabRelease).toBeUndefined();
  }, 120_000);

  it('ends the run sheet on the hand-cut tabs, with the positions', async () => {
    const { job, side2 } = fixture();
    const out = await generateGoalProgram(job, side2, TOOL, null, {
      shop: { tools: [ENTRY], defaults: SHOP_DEFAULTS },
      sideFace: 'bottom',
    });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    const sheet = buildRunSheet(job, out, null, new Date('2026-11-08T00:00:00Z'));
    const id = `cut-${out.programs.length}`;
    const section = sheet.sections.find((s) => s.id === id);
    expect(section).toBeDefined();
    const last = section!.steps[section!.steps.length - 1]!;
    expect(last.text).toContain('The part is held by 4 tabs');
    expect(last.text).toContain('flush-cut saw or knife');
    expect(last.text).toContain('after the machine is homed');
    expect(last.value).toContain('8 mm wide');
    const c = out.programs[out.programs.length - 1]!.tabRelease!.at[0]!;
    expect(last.text).toContain(`X ${c.x}`);
  }, 120_000);

  it('adds no release to the first setup — only the flipped side frees the part', async () => {
    const { job, side1 } = fixture();
    const out = await generateGoalProgram(job, side1, TOOL, null, {
      shop: { tools: [ENTRY], defaults: SHOP_DEFAULTS },
      sideFace: 'top',
    });
    expect(out.ok, out.errors?.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs.every((p) => p.tabRelease === undefined)).toBe(true);
  }, 120_000);
});
