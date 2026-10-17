// The files a job was made from (#425 §4): content-addressed records, the 4 MiB embedding rule,
// and verification. Derived geometry is the job's to cut; a record is the provenance a re-import
// proves itself against and the thing a missing or changed file is reported by.
//
// No DOM and no picker: a `File` is bytes here. The 3MF route's hook is covered by the wizard's
// own spec; this one holds the rules the route relies on.

import { describe, expect, it } from 'vitest';

import { arrayBufferToBase64, base64ToArrayBuffer } from '@/engine/import/base64';
import { sha256Hex } from '@/engine/import/meshStock';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  MAX_EMBEDDED_SOURCE_BYTES,
  SOURCE_MISSING_SENTENCE,
  embedSource,
  jobSourceRefusal,
  sourceForFont,
  sourceKindForName,
  sourceRefusal,
  verifyJobSources,
  verifySource,
  verifySources,
  withSource,
} from '@/engine/cnc/engrave/jobSources';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveVectorShape, JobSource } from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

/** An axis-aligned square ring — the smallest stand-in for an imported outline. */
function squareRing(cx: number, cy: number, half: number): [number, number][] {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

function vector(
  contours: [number, number][][],
  over: Partial<EngraveVectorShape> = {},
): EngraveVectorShape {
  return {
    id: 'v',
    kind: 'vector',
    sourceName: 'logo.svg',
    contours,
    fillRule: 'NonZero',
    width: 20,
    height: 20,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    ...over,
  };
}

function record(over: Partial<JobSource> = {}): JobSource {
  return {
    sha256: 'a'.repeat(64),
    kind: 'svg',
    name: 'logo.svg',
    embedded: null,
    size: 100,
    path: null,
    ...over,
  };
}

describe('a source record (#425 §4)', () => {
  it('names the kind a file extension implies, and nothing for an unknown one', () => {
    expect(sourceKindForName('logo.svg')).toBe('svg');
    expect(sourceKindForName('PLATE.DXF')).toBe('dxf');
    expect(sourceKindForName('scan.png')).toBe('image');
    expect(sourceKindForName('badge.3mf')).toBe('3mf');
    expect(sourceKindForName('Inter.ttf')).toBe('font');
    expect(sourceKindForName('notes.txt')).toBeNull();
    expect(sourceKindForName('no-extension')).toBeNull();
  });

  it('embeds bytes up to 4 MiB, with the SHA-256 of the raw bytes and the size', async () => {
    const raw = bytes(SVG);
    const { source, skipped } = await embedSource({ kind: 'svg', name: 'logo.svg', bytes: raw });

    expect(skipped).toBeNull();
    expect(source.sha256).toBe(await sha256Hex(raw));
    expect(source.size).toBe(raw.byteLength);
    expect(source.embedded).toEqual({ encoding: 'base64', data: arrayBufferToBase64(raw) });
    expect(source.path).toBeNull();
    // The recorded digest is the one a re-import compares against: decoding the payload and
    // hashing it gives the same number.
    const decoded = base64ToArrayBuffer(source.embedded!.data);
    expect(await sha256Hex(decoded)).toBe(source.sha256);
  });

  it('keeps a file over 4 MiB by name, size and hash, with no bytes, and says why', async () => {
    const big = new ArrayBuffer(MAX_EMBEDDED_SOURCE_BYTES + 1);
    const { source, skipped } = await embedSource({ kind: 'image', name: 'scan.png', bytes: big });

    expect(source.embedded).toBeNull();
    expect(source.size).toBe(MAX_EMBEDDED_SOURCE_BYTES + 1);
    expect(source.sha256).toBe(await sha256Hex(big));
    expect(skipped).not.toBeNull();
    // Names the file and its size — a silent downgrade is what the sentence exists to prevent.
    expect(skipped).toContain('scan.png');
    expect(skipped).toContain('4.0 MB');
    expect(skipped).toContain('4 MiB');
  });

  it('dedupes identical content by SHA-256, keeping the record that has the bytes', async () => {
    const raw = bytes(SVG);
    const first = (await embedSource({ kind: 'svg', name: 'logo.svg', bytes: raw })).source;
    const again = (await embedSource({ kind: 'svg', name: 'logo-copy.svg', bytes: raw })).source;
    expect(again.sha256).toBe(first.sha256);

    const one = withSource(undefined, first);
    expect(withSource(one, again)).toHaveLength(1);

    // A header-only record for the same content is upgraded when the bytes arrive, and an
    // embedded record is not downgraded by a later header-only one.
    const headerOnly: JobSource = { ...first, embedded: null };
    expect(withSource([headerOnly], first)[0]!.embedded).toEqual(first.embedded);
    expect(withSource([first], headerOnly)[0]!.embedded).toEqual(first.embedded);
  });
});

describe('verifying a source (#425 §4)', () => {
  it('reports ok for the bytes it was made from and changed for a tampered payload', async () => {
    const { source } = await embedSource({ kind: 'svg', name: 'logo.svg', bytes: bytes(SVG) });
    expect(await verifySource(source)).toBe('ok');

    const tamperedBytes = base64ToArrayBuffer(source.embedded!.data);
    new Uint8Array(tamperedBytes)[0] = new Uint8Array(tamperedBytes)[0]! ^ 0xff;
    const tampered: JobSource = {
      ...source,
      embedded: { encoding: 'base64', data: arrayBufferToBase64(tamperedBytes) },
    };
    expect(await verifySource(tampered)).toBe('changed');
  });

  it('reports missing when a record carries no bytes and no source is reachable', async () => {
    expect(await verifySource(record())).toBe('missing');
    // …and takes the bytes a desktop build read from the recorded path.
    const raw = bytes(SVG);
    expect(
      await verifySource(record({ sha256: await sha256Hex(raw), size: raw.byteLength }), {
        bytesFor: () => raw,
      }),
    ).toBe('ok');
  });

  it('matches a font record to its hash in customFonts, without duplicating the bytes', async () => {
    const font: CustomFont = { id: 'font-inter', name: 'Inter.ttf', data: arrayBufferToBase64(bytes('font-bytes')) };
    const source = await sourceForFont(font);

    expect(source.kind).toBe('font');
    expect(source.embedded).toBeNull();
    expect(source.size).toBe(bytes('font-bytes').byteLength);
    expect(source.sha256).toBe(await sha256Hex(bytes('font-bytes')));
    expect(await verifySource(source, { fonts: [font] })).toBe('ok');
    // The font is gone from the job: the line that names it has no outlines to fall back on.
    expect(await verifySource(source, { fonts: [] })).toBe('missing');
  });

  it('checks every record in document order', async () => {
    const a = (await embedSource({ kind: 'svg', name: 'a.svg', bytes: bytes('a') })).source;
    const b = (await embedSource({ kind: 'dxf', name: 'b.dxf', bytes: bytes('b') })).source;
    const checks = await verifySources([a, { ...b, embedded: null }], {});
    expect(checks.map((c) => [c.source.name, c.status])).toEqual([
      ['a.svg', 'ok'],
      ['b.dxf', 'missing'],
    ]);
  });
});

describe('a job with its sources (#425 §4)', () => {
  const SHA = 'b'.repeat(64);

  /** A design job whose ONE outline still carries the geometry the design made. */
  function designJob(contours: [number, number][][]): EngraveJob {
    return {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      vectors: [
        vector(contours, { importedFrom: { name: 'badge.3mf', sha256: SHA } }),
      ],
      sourceFiles: [
        {
          sha256: SHA,
          kind: '3mf',
          name: 'badge.3mf',
          embedded: null,
          size: 3421,
          path: null,
        },
      ],
    };
  }

  it('opens and generates when the source is gone but the derived geometry is stored', async () => {
    const job = designJob([squareRing(0, 0, 10)]);
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The record is honestly reported as missing …
    const checks = await verifyJobSources(parsed.job);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe('missing');
    // … but nothing needs its bytes, so no refusal and the program still comes out.
    expect(sourceRefusal(checks, new Set())).toBeNull();
    expect(await jobSourceRefusal(parsed.job)).toBeNull();

    const generated = generate(tl, parsed.job);
    expect(
      generated.nc,
      JSON.stringify({
        stage: generated.stage,
        errors: generated.errors,
        findings: generated.findings,
      }),
    ).not.toBeNull();
  });

  it('refuses a required source that is missing or changed with §6’s exact sentence', async () => {
    // Geometry absent: the item names its file but carries no outlines to cut from. (The schema
    // will not write such a vector today; this is the rule a future image/font item inherits, and
    // the caller states what it needs by handing over the hash.)
    const job = designJob([]);
    const checks = await verifyJobSources(job);
    expect(checks[0]!.status).toBe('missing');

    expect(sourceRefusal(checks, new Set([SHA]))).toBe(SOURCE_MISSING_SENTENCE);
    expect(await jobSourceRefusal(job)).toBe(SOURCE_MISSING_SENTENCE);
    expect(SOURCE_MISSING_SENTENCE).toBe('the file this job was made from is missing or changed');

    // A changed file is refused the same way: the bytes are not the file the job was made from.
    const changed = [{ source: checks[0]!.source, status: 'changed' as const }];
    expect(sourceRefusal(changed, new Set([SHA]))).toBe(SOURCE_MISSING_SENTENCE);

    // A source nobody requires is a note, whatever its state.
    expect(sourceRefusal(changed, new Set())).toBeNull();
  });

  it('reports every source a job carries, including the ones it no longer needs', async () => {
    const job = designJob([squareRing(50, 30, 10)]);
    const embedded = (await embedSource({ kind: '3mf', name: 'badge.3mf', bytes: bytes('project') })).source;
    job.sourceFiles = [embedded, { ...record({ name: 'old.svg' }), sha256: SHA }];

    const checks = await verifySources(job.sourceFiles);
    expect(checks.map((c) => c.status)).toEqual(['ok', 'missing']);
  });
});
