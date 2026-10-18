// The v3 job document (#425): the envelope, its migration, and the rules that keep an old build,
// an unknown key and a changed source from being mistaken for one another.
//
// Pure zod + the fingerprint engine: no store, no DOM, no worker.

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { programHash } from '@/engine/cnc/programHash';
import {
  jobFingerprint,
  packageHash,
  packageStaleness,
  type FrozenProgram,
} from '@/engine/cnc/engrave/package';
import { embedSource } from '@/engine/cnc/engrave/jobSources';
import {
  JOB_FILE_EXTENSION,
  jobFileName,
  parseJobFile,
  serializeJobFile,
} from '@/engine/cnc/engrave/jobFile';
import {
  CURRENT_JOB_SCHEMA_VERSION,
  newerJobVersionMessage,
  parseEngraveJob,
} from '@/store/engraveJobSchema';
import type { EngraveJob, JobRunLogEntry, JobSource } from '@/types/engraveJob';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const AT = '2026-10-17T09:00:00.000Z';
const NC = 'G21\nM2\n';

/** A v2 document as every build before #425 wrote it: the v2 keys only, v2 literal. */
function v2Doc(): Record<string, unknown> {
  const job = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
  return { ...job, schemaVersion: 2 };
}

function source(over: Partial<JobSource> = {}): JobSource {
  return {
    sha256: SHA_A,
    kind: 'svg',
    name: 'logo.svg',
    embedded: { encoding: 'base64', data: 'PHN2Zy8+' },
    size: 8,
    path: null,
    ...over,
  };
}

function frozenProgram(over: Partial<FrozenProgram> = {}): FrozenProgram {
  return {
    setupIndex: 0,
    setupId: 'setup-implicit',
    toolKey: 'flat-1.0',
    nc: NC,
    hash: programHash(NC),
    frameNc: null,
    frameHash: null,
    ...over,
  };
}

/** A document with the package block a freeze would write for it. */
function withPackage(job: EngraveJob): { doc: EngraveJob; programs: FrozenProgram[] } {
  const programs = [frozenProgram()];
  const jobHash = jobFingerprint(job);
  const doc: EngraveJob = {
    ...job,
    package: {
      jobId: job.id,
      frozenAt: AT,
      hash: packageHash(jobHash, programs),
      jobHash,
      programs,
      setups: jobSetups(job),
      stockEntryId: null,
    },
  };
  return { doc, programs };
}

function runEntry(over: Partial<JobRunLogEntry> = {}): JobRunLogEntry {
  return {
    programHash: programHash(NC),
    setupIndex: 0,
    setupId: 'setup-implicit',
    toolKey: 'flat-1.0',
    at: AT,
    outcome: 'finished',
    ...over,
  };
}

describe('the v3 document envelope (#425)', () => {
  it('starts at v3 and parses through its own schema unchanged', () => {
    const job = defaultEngraveJob();
    expect(job.schemaVersion).toBe(3);
    expect(CURRENT_JOB_SCHEMA_VERSION).toBe(3);
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(job);
    // The three v3 blocks are ABSENT on a job that has not used them — not null, not empty.
    expect('sourceFiles' in parsed.job).toBe(false);
    expect('package' in parsed.job).toBe(false);
    expect('runLog' in parsed.job).toBe(false);
  });

  it('migrates v2 by changing the literal and nothing else (#425)', () => {
    const raw = v2Doc();
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual({ ...raw, schemaVersion: 3 });
    expect('sourceFiles' in parsed.job).toBe(false);
    expect('package' in parsed.job).toBe(false);
    expect('runLog' in parsed.job).toBe(false);
  });

  it('migrates v1 through the existing transform and then stamps v3', () => {
    const v2 = v2Doc();
    const v1: Record<string, unknown> = { ...v2, schemaVersion: 1 };
    // Remove every key a v1 document did not have; the v1 schema is the document before them.
    for (const key of [
      'id',
      'sacrificial',
      'breakthrough',
      'jawClearance',
      'margins',
      'cutOverride',
      'facing',
      'shapes',
      'combined',
      'traces',
      'vectors',
      'keepOuts',
      'drills',
      'threads',
      'sources',
      'tool',
      'stockEntry',
      'setups',
    ]) {
      delete v1[key];
    }
    const parsed = parseEngraveJob(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(3);
    expect(typeof parsed.job.id).toBe('string');
    expect(parsed.job.id.length).toBeGreaterThan(0);
    expect(parsed.job.sacrificial).toBeDefined();
    expect(parsed.job.breakthrough).toBeTypeOf('number');
    expect(parsed.job.jawClearance).toBeTypeOf('number');
    expect(parsed.job.shapes).toEqual([]);
    expect(parsed.job.labels).toEqual(v2.labels);
  });

  it('round-trips the three v3 blocks without changing them', () => {
    const base = defaultEngraveJob();
    const { doc } = withPackage(base);
    const full: EngraveJob = {
      ...doc,
      sourceFiles: [source()],
      runLog: [runEntry()],
    };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(full)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(full);
    expect(parsed.job.package?.programs[0]!.hash).toBe(programHash(NC));
    expect(parsed.job.sourceFiles?.[0]!.sha256).toBe(SHA_A);
    expect(parsed.job.runLog?.[0]!.outcome).toBe('finished');
  });

  it('preserves an unknown TOP-LEVEL key through an open/save round trip', () => {
    const raw = { ...v2Doc(), schemaVersion: 3, futureSetting: { mode: 'x' } };
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.job as unknown as Record<string, unknown>).futureSetting).toEqual({ mode: 'x' });
  });

  it('refuses an unknown key INSIDE the owned blocks, naming its path', () => {
    const base = defaultEngraveJob();
    const { doc } = withPackage(base);

    const badPackage = parseEngraveJob({
      ...doc,
      package: { ...doc.package, futureVerdict: true },
    });
    expect(badPackage.ok).toBe(false);
    if (badPackage.ok) return;
    expect(badPackage.errors[0]).toMatch(/^package\.futureVerdict: /);

    const badSource = parseEngraveJob({ ...base, sourceFiles: [{ ...source(), future: 1 }] });
    expect(badSource.ok).toBe(false);
    if (badSource.ok) return;
    expect(badSource.errors[0]).toMatch(/^sourceFiles\[0\]\.future: /);
  });

  it('refuses a document from a newer build by name, not as a bad literal', () => {
    const parsed = parseEngraveJob({ ...defaultEngraveJob(), schemaVersion: 4 });
    expect(parsed).toEqual({
      ok: false,
      errors: [newerJobVersionMessage(4)],
    });
  });

  it('formats an invalid nested field the way a person reads it', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as {
      labels: Record<string, unknown>[];
    };
    delete raw.labels[0]!.text;
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]).toMatch(/^labels\[0\]\.text: /);
  });

  it('a document with no schemaVersion is invalid, not "newer"', () => {
    const raw = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    delete raw.schemaVersion;
    const parsed = parseEngraveJob(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(' ')).not.toContain('newer version');
    expect(parsed.errors.join(' ')).toContain('schemaVersion');
  });
});

describe('the job file (#425 §6)', () => {
  it('names the file from the job, with the one extension every job uses', () => {
    expect(JOB_FILE_EXTENSION).toBe('.cutjob.json');
    expect(jobFileName('Badge blank')).toBe('Badge_blank.cutjob.json');
    expect(jobFileName('***')).toBe('job.cutjob.json');
  });

  it('serializes the document itself, and a round trip keeps package, run log and sources', async () => {
    const { doc } = withPackage(defaultEngraveJob());
    const raw = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const { source: embedded } = await embedSource({ kind: 'svg', name: 'logo.svg', bytes });
    const full: EngraveJob = {
      ...doc,
      sourceFiles: [embedded],
      runLog: [runEntry()],
    };

    const parsed = await parseJobFile(serializeJobFile(full));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(full);
    expect(parsed.package).toEqual({ ok: true, reason: null });
    expect(parsed.sources.map((check) => [check.source.name, check.status])).toEqual([['logo.svg', 'ok']]);
    expect(parsed.sourceError).toBeNull();
  });

  it('refuses malformed JSON and a schema-invalid field with the named error', async () => {
    const malformed = await parseJobFile('{ not json');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.errors[0]).toContain('the file is not valid JSON');

    const bad = JSON.parse(JSON.stringify(defaultEngraveJob())) as {
      labels: Record<string, unknown>[];
    };
    delete bad.labels[0]!.text;
    const refused = await parseJobFile(JSON.stringify(bad));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors[0]).toMatch(/^labels\[0\]\.text: /);
  });

  it('opens a tampered package and a missing unrequired source, reporting both', async () => {
    const { doc } = withPackage(defaultEngraveJob());
    const pkg = doc.package!;
    const tampered: EngraveJob = {
      ...doc,
      package: { ...pkg, programs: pkg.programs.map((p) => ({ ...p, nc: `${p.nc}G0 X0\n` })) },
      sourceFiles: [source({ embedded: null })],
    };

    const parsed = await parseJobFile(serializeJobFile(tampered));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The document is the owner: a bad package is a state the run gate refuses, not a lost job.
    expect(parsed.job.package?.programs[0]!.nc).toBe(`${NC}G0 X0\n`);
    expect(parsed.package).toEqual({
      ok: false,
      reason: 'the saved program text does not match its hash; the package will not be offered for a run',
    });
    expect(parsed.sources.map((check) => check.status)).toEqual(['missing']);
    expect(parsed.sourceError).toBeNull();
  });
});

describe('the package fingerprint survives the document (#425)', () => {
  it('ignores the package block, the run log and embedded bytes, and moves on a real edit', () => {
    const base = defaultEngraveJob();
    const plain = jobFingerprint(base);
    const { doc } = withPackage(base);

    expect(jobFingerprint({ ...doc, runLog: [runEntry()] })).toBe(plain);
    // Embedding the SAME file later (same sha256) changes nothing; the payload is not an input.
    const embedded: EngraveJob = { ...doc, sourceFiles: [source()] };
    expect(
      jobFingerprint({
        ...embedded,
        sourceFiles: [source({ embedded: { encoding: 'base64', data: 'ZGlmZmVyZW50' } })],
      }),
    ).toBe(jobFingerprint(embedded));
    // A source record that predates embedding fingers the same once its bytes arrive.
    expect(jobFingerprint({ ...embedded, sourceFiles: [source({ embedded: null })] })).toBe(
      jobFingerprint(embedded),
    );
    // A different file is a different source and does move it.
    expect(jobFingerprint({ ...embedded, sourceFiles: [source({ sha256: SHA_B })] })).not.toBe(
      jobFingerprint(embedded),
    );

    const edited: EngraveJob = {
      ...doc,
      labels: doc.labels.map((label, i) => (i === 0 ? { ...label, depth: label.depth + 0.1 } : label)),
    };
    expect(jobFingerprint(edited)).not.toBe(plain);
  });

  it('freezes around the program-relevant job, so writing the block cannot stale itself', () => {
    const base = defaultEngraveJob();
    const { doc } = withPackage(base);
    const pkg = doc.package!;
    expect(jobFingerprint(doc)).toBe(pkg.jobHash);
    expect(packageStaleness(pkg, doc)).toEqual({ stale: false, reason: null });

    const edited: EngraveJob = { ...doc, name: 'Renamed' };
    expect(packageStaleness(pkg, edited).stale).toBe(true);
    expect(packageStaleness(pkg, edited).reason).toBe('the job changed since the package was frozen');
  });

  it('appending a run log does not stale an approved package', () => {
    const base = defaultEngraveJob();
    const { doc } = withPackage(base);
    const logged: EngraveJob = { ...doc, runLog: [runEntry()] };
    expect(packageStaleness(doc.package!, logged)).toEqual({ stale: false, reason: null });
  });
});
