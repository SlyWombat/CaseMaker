// #1126 slice 2 — THE RESULT DOCUMENT STOPS CARRYING THE BYTES.
//
// A tray bottom's `generated.json` was 229 MB: `camIr` (an internal IR nothing in the browser reads
// off the document) and every NC text (also written as files). v2 writes a small result: `camIr`
// omitted, all NC text nulled, and a `files` list naming what the run wrote under `--out`, with the
// index each top-level alias (`nc`, `frameNc`, `facingNc`) mirrors so a reader can rebuild the SAME
// `EngraveGenerated` the in-page worker returns.
import { describe, expect, it } from 'vitest';

import { programFileNames, resultDocument } from '../../scripts/lib/casemaker/engrave';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

function generatedFixture(): EngraveGenerated {
  const programs = [
    { name: 'tray', stage: 'done', ok: true, kind: 'facing', nc: 'FACING', frameNc: null, cam: null },
    { name: 'tray', stage: 'done', ok: true, kind: 'engrave', nc: 'P1', frameNc: 'FRAME1', cam: null },
    // The FINISHING program: the generator's summary describes this one, so it is the top-level
    // `nc` — the same match `writeProgram` makes for `sweptIndex`.
    { name: 'tray', stage: 'done', ok: true, kind: 'engrave', nc: 'P2', frameNc: 'FRAME2', cam: null },
  ];
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: null,
    nc: 'P2',
    frameNc: 'FRAME1',
    facingNc: 'FACING',
    verify: null,
    frameVerify: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    programs,
    errors: [],
    predicted: [],
    designItems: [],
    // The IR that made the document big. The browser never reads it from a result: its only
    // references in the tree are inside engraveGenerate.ts itself.
    camIr: { operations: [{ id: 'big' }] },
  } as unknown as EngraveGenerated;
}

describe('#1126 — the v2 result document', () => {
  it('drops camIr and every NC text, and names the files the run wrote', () => {
    const generated = generatedFixture();
    const doc = resultDocument('tray', generated);

    expect(doc.resultVersion).toBe(2);
    expect('camIr' in doc).toBe(false);
    expect(doc.nc).toBeNull();
    expect(doc.frameNc).toBeNull();
    expect(doc.facingNc).toBeNull();
    expect(doc.findings).toEqual([]);
    expect(doc.ok).toBe(true);
    for (const program of doc.programs as { nc: unknown; camIr?: unknown }[]) {
      expect(program.nc).toBeNull();
      expect('camIr' in program).toBe(false);
    }

    // The files are named exactly as `writeProgram` names them: every program's .nc, and a frame
    // only where the program has one (the face pass never does).
    const names = programFileNames('tray', generated.programs);
    expect(doc.files).toEqual([
      { name: names[0]!.ncFile, what: 'program', index: 0 },
      { name: names[1]!.ncFile, what: 'program', index: 1 },
      { name: names[1]!.frameFile, what: 'frame', index: 1 },
      { name: names[2]!.ncFile, what: 'program', index: 2 },
      { name: names[2]!.frameFile, what: 'frame', index: 2 },
    ]);
  });

  it('says which program each top-level alias mirrors, so the reader rebuilds the exact object', () => {
    const doc = resultDocument('tray', generatedFixture());
    // The top-level nc is the finishing program (2), the frame the first engraving one (1), the
    // facing text the face pass (0) — each found by matching the text, as writeProgram does.
    expect(doc.ncProgram).toBe(2);
    expect(doc.frameProgram).toBe(1);
    expect(doc.facingProgram).toBe(0);
  });

  it('a job with no frame, no facing and no sweep alias says so with nulls', () => {
    const plain = {
      ...generatedFixture(),
      nc: 'P1',
      frameNc: null,
      facingNc: null,
      programs: [{ name: 'tray', stage: 'done', ok: true, kind: 'engrave', nc: 'P1', frameNc: null, cam: null }],
    } as unknown as EngraveGenerated;
    const doc = resultDocument('tray', plain);
    expect(doc.ncProgram).toBe(0);
    expect(doc.frameProgram).toBeNull();
    expect(doc.facingProgram).toBeNull();
    // One program is named `<stem>.nc`; the numbered `-pN` form appears when there are several.
    const names = programFileNames('tray', plain.programs);
    expect(doc.files).toEqual([{ name: names[0]!.ncFile, what: 'program', index: 0 }]);
  });
});
