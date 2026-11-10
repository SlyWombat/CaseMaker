// #1126 slice 2 — THE CHECK BEFORE camIr IS DROPPED: does anything in the BROWSER read it?
//
// A house result no longer carries `camIr` (nor any NC text). If any browser code path read it off
// a result, it would get `undefined` silently — so this spec pins the answer at the source: every
// `camIr` occurrence under `src/` lives inside `workers/sim/engraveGenerate.ts`, where the IR is
// produced and used internally, and nowhere else. It also proves the write path (#1132's freeze)
// works from a result that has none: the package freezes nc + frame text, hashes and all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { freezePackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const OWNER = 'src/workers/sim/engraveGenerate.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('#1126 — camIr is not a browser input', () => {
  it('every camIr reference under src/ is inside engraveGenerate.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split('\\').join('/');
      if (`src/${name}` === OWNER) continue;
      // Comments name it on purpose (this slice explains why it is gone); the pin is about CODE.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (code.includes('camIr')) offenders.push(`src/${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('a result without camIr still freezes (#1132): the package takes nc, frames and hashes', () => {
    const job = { ...defaultEngraveJob(), name: 'trim' };
    // The shape `assembleResult` produces: nc texts restored, frameNc restored, no camIr at all.
    const assembled = {
      ok: true,
      nc: 'G0 P2\n',
      frameNc: 'FRAME1\n',
      programs: [
        { name: 'trim', kind: 'engrave', nc: 'G0 P1\n', frameNc: 'FRAME1\n', toolKey: job.toolKey },
        { name: 'trim', kind: 'engrave', nc: 'G0 P2\n', frameNc: null, toolKey: job.toolKey },
      ],
    };
    expect('camIr' in assembled).toBe(false);
    const inputs: PackageProgramInput[] = assembled.programs.map((program, setupIndex) => ({
      setupIndex,
      setupId: `s${setupIndex}`,
      toolKey: program.toolKey,
      nc: program.nc,
      frameNc: program.frameNc,
      programHash: programHash(program.nc),
      frame: 'flat',
    }));
    const frozen = freezePackage(job, inputs, '2026-11-10T12:00:00.000Z');
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.package.programs.map((p) => p.nc)).toEqual(['G0 P1\n', 'G0 P2\n']);
    expect(frozen.package.programs[0]!.frameHash).not.toBeNull();
    expect(frozen.package.programs[1]!.frameHash).toBeNull();
  });
});
