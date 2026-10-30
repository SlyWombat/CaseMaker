// @vitest-environment jsdom
// #772 — the card's files panel: what it lists, what it offers to delete, and what it refuses.
//
// The seam is the loader (`setMachineFilesLoader`), so the panel's real path runs against a fake
// client. The safety clauses are pinned in `machineFiles.spec.ts` where the seam owns them; what
// this spec pins is what the PERSON sees: a directory is a folder, a file this browser did not
// upload is read-only with the sentence, a running job hides every Delete, and a delete is two
// presses with the file's name said between them.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachineFiles, fileSizeWords, fileStampWords } from '@/components/manage/MachineFiles';
import {
  recordUploadedFile,
  setMachineFilesLoader,
  type DeleteFileResult,
  type MachineFilesClient,
  type ListFilesResult,
} from '@/platform/machineFiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

const HOST = '192.168.10.43';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const ENTRIES = [
  { name: 'job.nc', size: 2048, modified: '20261029120304', directory: false },
  { name: 'old', size: 0, modified: '20260101000000', directory: true },
  { name: 'studio.nc', size: 512, modified: '20261028100000', directory: false },
];

interface Fake {
  client: MachineFilesClient;
  lists: number;
  removed: string[];
}

function fake(remove?: (name: string) => DeleteFileResult): Fake {
  const state: Fake = { lists: 0, removed: [], client: null as unknown as MachineFilesClient };
  state.client = {
    list: async (): Promise<ListFilesResult> => {
      state.lists += 1;
      return { kind: 'listed', entries: ENTRIES.filter((e) => !state.removed.includes(e.name)) };
    },
    remove: async (_t, name) => {
      const result = remove === undefined
        ? ({ kind: 'deleted', name, detail: `"${name}" was deleted from the machine's card.` } as const)
        : remove(name);
      // The CARD only loses a file the delete actually removed — a refusal leaves it listed.
      if (result.kind === 'deleted') state.removed.push(name);
      return result;
    },
  };
  return state;
}

const q = (id: string) => screen.queryByTestId(id);

beforeEach(() => {
  cleanup();
  caps.drive = true;
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  recordUploadedFile(HOST, 'job.nc');
});

afterEach(() => setMachineFilesLoader(null));

describe('#772 the card’s files panel', () => {
  it('draws nothing in a build that cannot reach a machine', () => {
    caps.drive = false;
    setMachineFilesLoader(async () => fake().client);
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    expect(q('manage-files')).toBeNull();
  });

  it('lists the card: folders, sizes and stamps; only this app’s upload gets a Delete', async () => {
    setMachineFilesLoader(async () => fake().client);
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(q('manage-files-table')).not.toBeNull());

    expect(screen.getByTestId('manage-files-table').textContent).toContain('job.nc');
    expect(screen.getByTestId('manage-files-table').textContent).toContain('2.0 kB');
    expect(screen.getByTestId('manage-files-table').textContent).toContain('2026-10-29 12:03');
    expect(screen.getByTestId('manage-files-table').textContent).toContain('(folder)');
    // `studio.nc` was not uploaded here: the sentence, and no Delete button for it.
    const foreign = screen.getAllByTestId('manage-files-foreign');
    expect(foreign).toHaveLength(1); // only the studio file; the folder says "folder"
    expect(foreign.map((el) => el.textContent)).toContain('not uploaded here');
    // One Delete… for the uploaded file (the other non-folder row is read-only).
    expect(screen.queryAllByTestId(/manage-files-delete-/)).toHaveLength(1);
  });

  it('deletes on the SECOND press, naming the file in between', async () => {
    const state = fake();
    setMachineFilesLoader(async () => state.client);
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(screen.getByTestId('manage-files-delete-0')).not.toBeNull());

    fireEvent.click(screen.getByTestId('manage-files-delete-0'));
    // Nothing sent yet: the row asks, with the name in the question.
    expect(q('manage-files-confirm')?.textContent).toContain('Delete “job.nc”? This cannot be undone.');
    expect(state.removed).toEqual([]);

    fireEvent.click(screen.getByTestId('manage-files-confirm-0'));
    await waitFor(() => expect(q('manage-files-note')?.textContent).toContain('was deleted'));
    expect(state.removed).toEqual(['job.nc']);
    // The card is read again, and the deleted file is gone from it.
    await waitFor(() => expect(state.lists).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId('manage-files-table').textContent).not.toContain('job.nc'));
  });

  it('Cancel sends nothing', async () => {
    const state = fake();
    setMachineFilesLoader(async () => state.client);
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(screen.getByTestId('manage-files-delete-0')).not.toBeNull());
    fireEvent.click(screen.getByTestId('manage-files-delete-0'));
    fireEvent.click(screen.getByTestId('manage-files-cancel-0'));
    expect(q('manage-files-confirm')).toBeNull();
    expect(state.removed).toEqual([]);
  });

  it('hides every Delete while a job is running', async () => {
    setMachineFilesLoader(async () => fake().client);
    render(<MachineFiles host={HOST} port={2222} busy />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(q('manage-files-table')).not.toBeNull());
    expect(screen.queryAllByTestId(/manage-files-delete-/)).toHaveLength(0);
    expect(screen.getAllByTestId('manage-files-busy').length).toBeGreaterThan(0);
  });

  it('shows the machine’s refusal as its own sentence, and keeps the file listed', async () => {
    const state = fake(() => ({ kind: 'refused', detail: 'rm: cannot remove: permission denied' }));
    setMachineFilesLoader(async () => state.client);
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(screen.getByTestId('manage-files-delete-0')).not.toBeNull());
    fireEvent.click(screen.getByTestId('manage-files-delete-0'));
    fireEvent.click(screen.getByTestId('manage-files-confirm-0'));
    await waitFor(() => expect(q('manage-files-note')?.textContent).toContain('permission denied'));
    expect(q('manage-files-note')?.getAttribute('data-status')).toBe('refused');
    // The delete did not go through, so the row is still there.
    await waitFor(() => expect(screen.getByTestId('manage-files-table').textContent).toContain('job.nc'));
  });

  it('says why the card could not be read', async () => {
    setMachineFilesLoader(async () => ({
      list: async () => ({ kind: 'timeout', detail: 'no answer to `ls`' }),
      remove: async () => ({ kind: 'error', detail: 'unreachable' }),
    }));
    render(<MachineFiles host={HOST} port={2222} busy={false} />);
    fireEvent.click(screen.getByTestId('manage-files-refresh'));
    await waitFor(() => expect(q('manage-files-error')?.textContent).toContain('no answer to `ls`'));
  });
});

describe('#772 a release this app is driving also blocks deletes', () => {
  it('reads the release phase, so an armed job hides Delete even before the machine says busy', async () => {
    const { useEngraveReleaseStore } = await import('@/store/engraveReleaseStore');
    const original = useEngraveReleaseStore.getState().records;
    useEngraveReleaseStore.setState({
      records: {
        [`${HOST}:2222`]: { phase: 'running' } as unknown as (typeof original)[string],
      },
    });
    try {
      setMachineFilesLoader(async () => fake().client);
      render(<MachineFiles host={HOST} port={2222} busy={false} />);
      fireEvent.click(screen.getByTestId('manage-files-refresh'));
      await waitFor(() => expect(q('manage-files-table')).not.toBeNull());
      expect(screen.queryAllByTestId(/manage-files-delete-/)).toHaveLength(0);
      expect(screen.getAllByTestId('manage-files-busy').length).toBeGreaterThan(0);
    } finally {
      useEngraveReleaseStore.setState({ records: original });
    }
  });
});

describe('#772 the card panel’s words', () => {
  it('formats sizes and the listing’s stamp', () => {
    expect(fileSizeWords(512)).toBe('512 B');
    expect(fileSizeWords(2048)).toBe('2.0 kB');
    expect(fileSizeWords(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fileStampWords('20261029120304')).toBe('2026-10-29 12:03');
    expect(fileStampWords(null)).toBe('—');
    expect(fileStampWords('not-a-stamp')).toBe('not-a-stamp');
  });
});
