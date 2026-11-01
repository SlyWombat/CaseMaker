// Issue #149 — a project WITHOUT connectors compiles exactly as it did before
// the stacking connector existed.
//
// The hashes below were taken on origin/main 3992d16d (ids seeded), before any connector
// code landed: the build plan (every BuildOp, serialized) and the evaluated
// Manifold mesh of every node, for three stock boards and the feature-heavy
// protective-case template. They are pinned, not recomputed, so the test
// would catch a change that moved geometry for everybody — the failure a new
// shell feature is most likely to cause.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { findTemplate } from '@/library/templates';
import type { Project } from '@/types';
import { resetSeed } from '@/utils/id';
import { exec } from './helpers/manifoldExec';

function sha(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function planHash(p: Project): string {
  return sha(JSON.stringify(compileProject(p)));
}

function meshHash(p: Project): string {
  const h = createHash('sha256');
  for (const n of compileProject(p).nodes) {
    const m = exec(n.op);
    try {
      const mesh = m.getMesh();
      h.update(n.id);
      h.update(new Uint8Array(mesh.vertProperties.buffer, mesh.vertProperties.byteOffset, mesh.vertProperties.byteLength));
      h.update(new Uint8Array(mesh.triVerts.buffer, mesh.triVerts.byteOffset, mesh.triVerts.byteLength));
    } finally {
      m.delete();
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** A stock project with seeded ids — the board copy's id is random otherwise. */
function stock(boardId: string): Project {
  resetSeed();
  return createDefaultProject(boardId);
}

function protectiveCase(): Project {
  resetSeed();
  const tpl = findTemplate('protective-case');
  if (!tpl) throw new Error('protective-case template not found');
  return tpl.build();
}

const CASES: Array<{ name: string; project: () => Project; plan: string; mesh: string }> = [
  { name: 'rpi-4b', project: () => stock('rpi-4b'), plan: '3b3c27c902025c9a', mesh: 'f2f0eaf7f197b209' },
  { name: 'arduino-uno-r3', project: () => stock('arduino-uno-r3'), plan: '6fd17d3e74cb04fb', mesh: 'caafa37eb220b912' },
  { name: 'esp32-devkit-v1', project: () => stock('esp32-devkit-v1'), plan: '3abbf69b9c4efa30', mesh: '2173ce7132bd3747' },
  { name: 'protective-case', project: protectiveCase, plan: '7163f90fe6953446', mesh: '8de0e37209aad076' },
];

/** The same project carrying a connector block that asks for nothing. */
function withEmptyConnector(p: Project): Project {
  return { ...p, case: { ...p.case, stackConnector: { sockets: [], key: 'short', keys: 0 } } };
}

describe('a project without connectors is unchanged (#149)', () => {
  for (const c of CASES) {
    it(`${c.name}: plan and mesh hashes match main`, () => {
      expect(planHash(c.project())).toBe(c.plan);
      expect(meshHash(c.project())).toBe(c.mesh);
    }, 120_000);

    it(`${c.name}: an empty connector block changes nothing`, () => {
      expect(planHash(withEmptyConnector(c.project()))).toBe(c.plan);
    }, 120_000);
  }
});
