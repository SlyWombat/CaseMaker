// @vitest-environment jsdom
// Save / Open for the job document (#425 §6). The file is the owner: the store serializes the open
// document on every write, and replaces the open document only after a successful parse.
//
// The pickers are stubbed (native dialogs cannot complete in a test); everything between the
// picker and the document is real — the schema, the source verification, the package integrity.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import {
  JOB_FILE_EXTENSION,
  jobFileName,
  serializeJobFile,
} from '@/engine/cnc/engrave/jobFile';
import { jobFingerprint, packageHash, type FrozenProgram } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  JOB_FILE_AUTOSAVE_MS,
  flushJobFileAutosave,
  resetEngraveJobFileStore,
  setJobFileIO,
  useEngraveJobFileStore,
  type JobFileIO,
} from '@/store/engraveJobFileStore';
import type { ProjectFileHandle, SaveTextOutcome } from '@/store/persistence';
import type { EngraveJob, JobSource } from '@/types/engraveJob';

const AT = '2026-10-17T09:00:00.000Z';
const HANDLE: ProjectFileHandle = { name: 'bench.cutjob.json' };

/** The picker/disk seam: records everything, opens whatever the test queues. */
function fakeIO() {
  const writes: { handle: ProjectFileHandle; text: string }[] = [];
  const saves: { text: string; proposed: string }[] = [];
  let next: { text: string; name: string; handle: ProjectFileHandle | null } | null = null;
  const io: JobFileIO = {
    write: async (handle, text) => {
      writes.push({ handle, text });
    },
    save: async (text, proposed): Promise<SaveTextOutcome> => {
      saves.push({ text, proposed });
      return { kind: 'saved', handle: HANDLE };
    },
    open: async () => next,
  };
  setJobFileIO(io);
  return { io, writes, saves, setOpen: (picked: typeof next) => (next = picked) };
}

/** Open a document as if the person had picked it. */
async function openDoc(job: EngraveJob, handle: ProjectFileHandle | null = HANDLE): Promise<void> {
  bed.setOpen({ text: serializeJobFile(job), name: 'bench.cutjob.json', handle });
  await useEngraveJobFileStore.getState().open();
}

let bed: ReturnType<typeof fakeIO>;

beforeEach(() => {
  localStorage.clear();
  useEngraveJobStore.getState().reset();
  resetEngraveJobFileStore();
  bed = fakeIO();
});

afterEach(() => {
  setJobFileIO(null);
  vi.useRealTimers();
});

describe('Save (#425 §6)', () => {
  it('with no bound file, asks for one and adopts the handle it gets', async () => {
    const job = useEngraveJobStore.getState().job;
    await useEngraveJobFileStore.getState().save();

    expect(bed.saves).toHaveLength(1);
    expect(bed.saves[0]!.proposed).toBe(jobFileName(job.name));
    expect(bed.saves[0]!.proposed.endsWith(JOB_FILE_EXTENSION)).toBe(true);
    // The text IS the document, not a wrapper and not a second copy.
    expect(JSON.parse(bed.saves[0]!.text)).toEqual(job);

    const state = useEngraveJobFileStore.getState();
    expect(state.handle).toBe(HANDLE);
    expect(state.fileName).toBe('bench.cutjob.json');
    expect(state.dirty).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.notice?.kind).toBe('ok');
  });

  it('with a bound file, writes in place and never opens a picker', async () => {
    await openDoc(defaultEngraveJob());
    const opened = useEngraveJobStore.getState().job;
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);

    const edited: EngraveJob = { ...opened, name: 'Edited after opening' };
    useEngraveJobStore.getState().replace(edited);
    expect(useEngraveJobFileStore.getState().dirty).toBe(true);

    await useEngraveJobFileStore.getState().save();
    expect(bed.saves).toHaveLength(0);
    expect(bed.writes).toHaveLength(1);
    expect(bed.writes[0]!.handle).toBe(HANDLE);
    expect(JSON.parse(bed.writes[0]!.text).name).toBe('Edited after opening');
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);
  });

  it('a download fallback keeps no handle, so the next Save asks again', async () => {
    bed.io.save = async (): Promise<SaveTextOutcome> => ({ kind: 'downloaded' });
    await useEngraveJobFileStore.getState().save();

    const state = useEngraveJobFileStore.getState();
    expect(state.handle).toBeNull();
    expect(state.fileName).toBe(jobFileName(useEngraveJobStore.getState().job.name));
    expect(state.dirty).toBe(false);
    expect(state.notice?.kind).toBe('info');
    expect(state.notice?.text).toContain('Downloaded');
  });

  it('cancelling writes nothing and leaves the job dirty', async () => {
    bed.io.save = async (): Promise<SaveTextOutcome> => ({ kind: 'cancelled' });
    await useEngraveJobFileStore.getState().save();

    const state = useEngraveJobFileStore.getState();
    expect(state.handle).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.notice?.kind).toBe('info');
    expect(state.notice?.text).toContain('cancelled');
  });

  it('a failed write reports it and keeps the dirty marker', async () => {
    await openDoc(defaultEngraveJob());
    useEngraveJobStore.getState().replace({ ...useEngraveJobStore.getState().job, name: 'Changed' });
    bed.io.write = async () => {
      throw new Error('disk is full');
    };

    await useEngraveJobFileStore.getState().save();
    const state = useEngraveJobFileStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.busy).toBe(false);
    expect(state.notice).toEqual({ kind: 'error', text: 'the job was not saved: disk is full' });
  });
});

describe('Open (#425 §6)', () => {
  it('adopts the document and its handle only after a successful parse', async () => {
    const job: EngraveJob = { ...defaultEngraveJob(), name: 'From the bench' };
    await openDoc(job);

    const state = useEngraveJobFileStore.getState();
    expect(useEngraveJobStore.getState().job.name).toBe('From the bench');
    expect(state.handle).toBe(HANDLE);
    expect(state.fileName).toBe('bench.cutjob.json');
    expect(state.dirty).toBe(false);
    expect(state.notice).toEqual({ kind: 'ok', text: 'Opened bench.cutjob.json.' });
  });

  it('a cancelled open changes nothing', async () => {
    bed.setOpen(null);
    const before = useEngraveJobStore.getState().job;
    await useEngraveJobFileStore.getState().open();

    expect(useEngraveJobStore.getState().job).toBe(before);
    expect(useEngraveJobFileStore.getState().handle).toBeNull();
    expect(useEngraveJobFileStore.getState().dirty).toBe(true);
    expect(useEngraveJobFileStore.getState().notice?.kind).toBe('info');
  });

  it('a refused file leaves the open job, its handle and its dirty marker exactly as they were', async () => {
    await openDoc(defaultEngraveJob());
    useEngraveJobStore.getState().replace({ ...useEngraveJobStore.getState().job, name: 'Work in progress' });
    const before = useEngraveJobStore.getState().job;
    expect(useEngraveJobFileStore.getState().dirty).toBe(true);

    for (const text of [
      '{ not json',
      JSON.stringify({ ...defaultEngraveJob(), name: 'Future', schemaVersion: 4 }),
      JSON.stringify({ ...defaultEngraveJob(), labels: 'not an array' }),
    ]) {
      bed.setOpen({ text, name: 'refused.cutjob.json', handle: { name: 'refused.cutjob.json' } });
      await useEngraveJobFileStore.getState().open();
      const state = useEngraveJobFileStore.getState();
      expect(useEngraveJobStore.getState().job).toBe(before);
      expect(state.handle).toBe(HANDLE);
      expect(state.fileName).toBe('bench.cutjob.json');
      expect(state.dirty).toBe(true);
      expect(state.notice?.kind).toBe('error');
      expect(state.notice?.text).toContain('refused.cutjob.json was not opened');
    }
  });

  it('opens a tampered package and a gone source with a warning, keeping the document', async () => {
    const base: EngraveJob = {
      ...defaultEngraveJob(),
      // A source record with no bytes and no reachable file: reported, not required by any item.
      sourceFiles: [
        {
          sha256: 'a'.repeat(64),
          kind: 'svg',
          name: 'logo.svg',
          embedded: null,
          size: 10,
          path: null,
        } satisfies JobSource,
      ],
    };
    const tampered: FrozenProgram = {
      setupIndex: 0,
      setupId: 'setup-implicit',
      toolKey: 'flat-1.0',
      nc: 'G21\nM2\n',
      // Deliberately not the text's hash.
      hash: programHash('G21\nM3\n'),
      frameNc: null,
      frameHash: null,
    };
    const programs = [tampered];
    const jobHash = jobFingerprint(base);
    const doc: EngraveJob = {
      ...base,
      package: {
        jobId: base.id,
        frozenAt: AT,
        hash: packageHash(jobHash, programs),
        jobHash,
        programs,
        setups: jobSetups(base),
        stockEntryId: null,
      },
    };

    await openDoc(doc);
    const state = useEngraveJobFileStore.getState();
    expect(useEngraveJobStore.getState().job.package).toEqual(doc.package);
    expect(state.packageError).toContain('does not match its hash');
    expect(state.sourceError).toBeNull();
    expect(state.notice?.kind).toBe('warning');
    expect(state.notice?.text).toContain('Opened bench.cutjob.json.');
    expect(state.notice?.text).toContain('does not match its hash');
  });

  it('a source that is reported but not required does not refuse the open', async () => {
    // The record has no bytes and no reachable file, but the vector carries its geometry: the
    // report is honest and the document still opens (the generate gate reads `sourceError`).
    const doc: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      vectors: [
        {
          id: 'v',
          kind: 'vector',
          sourceName: 'badge.3mf',
          contours: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
            ],
          ],
          fillRule: 'NonZero',
          width: 20,
          height: 20,
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 1,
          enabled: true,
          importedFrom: { name: 'badge.3mf', sha256: 'b'.repeat(64) },
        },
      ],
      sourceFiles: [
        {
          sha256: 'b'.repeat(64),
          kind: '3mf',
          name: 'badge.3mf',
          embedded: null,
          size: 3421,
          path: null,
        },
      ],
    };
    await openDoc(doc);

    const state = useEngraveJobFileStore.getState();
    expect(state.sourceError).toBeNull();
    expect(state.notice?.kind).toBe('ok');
    expect(useEngraveJobStore.getState().job.vectors).toHaveLength(1);
  });
});

describe('the dirty marker and autosave (#425 §6)', () => {
  it('is clean exactly when the serialized document matches the text last written', async () => {
    await openDoc(defaultEngraveJob());
    const opened = useEngraveJobStore.getState().job;

    useEngraveJobStore.getState().replace({ ...opened, name: 'Changed' });
    expect(useEngraveJobFileStore.getState().dirty).toBe(true);
    // An undo returns to the text on disk — clean, not a phantom dot.
    useEngraveJobStore.getState().replace(opened);
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);
  });

  it('writes a bound file on the debounce, and an unbound job not at all', async () => {
    // Unbound: edits are not written anywhere.
    useEngraveJobStore.getState().replace({ ...useEngraveJobStore.getState().job, name: 'No file' });
    await flushJobFileAutosave();
    expect(bed.writes).toHaveLength(0);

    await openDoc(defaultEngraveJob());
    const opened = useEngraveJobStore.getState().job;
    useEngraveJobStore.getState().replace({ ...opened, name: 'Bound edit' });
    expect(bed.writes).toHaveLength(0);
    await flushJobFileAutosave();
    expect(bed.writes).toHaveLength(1);
    bed.writes.length = 0;

    vi.useFakeTimers();
    useEngraveJobStore.getState().replace({ ...opened, name: 'Bound edit 2' });
    await vi.advanceTimersByTimeAsync(JOB_FILE_AUTOSAVE_MS - 1);
    expect(bed.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bed.writes).toHaveLength(1);
    expect(JSON.parse(bed.writes[0]!.text).name).toBe('Bound edit 2');
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);
  });

  it('New job unbinds the file and starts dirty', async () => {
    await openDoc(defaultEngraveJob());
    useEngraveJobFileStore.getState().newJob();

    const state = useEngraveJobFileStore.getState();
    expect(state.handle).toBeNull();
    expect(state.fileName).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.notice?.kind).toBe('info');
    await flushJobFileAutosave();
    expect(bed.writes).toHaveLength(0);
  });

  it('replacing the document on Open schedules no write to the file that was just read', async () => {
    await openDoc(defaultEngraveJob());
    vi.useFakeTimers();
    await openDoc({ ...defaultEngraveJob(), name: 'Second open' });
    await vi.advanceTimersByTimeAsync(JOB_FILE_AUTOSAVE_MS + 1);
    expect(bed.writes).toHaveLength(0);
  });
});
