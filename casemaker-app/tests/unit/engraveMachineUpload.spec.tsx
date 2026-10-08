// @vitest-environment jsdom
// #255 — the "Upload to machine" control in the engrave panel, as a person meets it: what it says
// when there is nowhere to send, what the confirmation names before anything is written, and how
// each outcome reads afterwards. The socket is the only fake (`setMachineUploadLoader`), so the
// gate and the mapping under test are the ones the app runs.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  EngraveMachineUpload,
  type EngraveMachineUploadProps,
} from '@/components/panels/EngraveMachineUpload';
import { describeUpload } from '@/components/panels/engraveUploadCopy';
import {
  setMachineUploadLoader,
  type MachineUploadResult,
} from '@/platform/machineUpload';
import type { MachineObservation } from '@/platform/machineProbe';
import type { VerifyReport } from '@/engine/cnc/verify';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  setMachineUploadLoader(null);
});

beforeEach(() => {
  setMachineUploadLoader(async () => ({
    status: IDLE,
    upload: async () => ({ ok: true, bytes: 41, packets: 1, alreadyPresent: false }),
  }));
});

const VERIFY: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 3, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } },
};

const MACHINE: MachineObservation = {
  name: 'Makera_Z1_010290',
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: '192.168.10.43',
  mac: 'e0:72:a1:cf:6f:ec',
  status: '<Idle|MPos:0,0,0>',
  profileId: 'Z1',
  observedAt: '2026-10-06T21:14:00.000Z',
  notes: [],
};

const IDLE = async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' });

const NC = ';@MKR|BEGIN\nG21 G90\nM02\n';

function props(over: Partial<EngraveMachineUploadProps> = {}): EngraveMachineUploadProps {
  return {
    blocker: null,
    machine: MACHINE,
    program: { nc: NC, verify: VERIFY },
    filename: 'Untitled-engrave-job.nc',
    ...over,
  };
}

/** The upload button, as a button — every assertion about it is about `disabled`. */
const button = (): HTMLButtonElement => screen.getByTestId('engrave-upload') as HTMLButtonElement;

describe('#255 EngraveMachineUpload — where it would go', () => {
  it('says plainly when no machine has been reached, and shuts the button', () => {
    render(<EngraveMachineUpload {...props({ machine: null })} />);
    expect(screen.getByTestId('engrave-upload-target').textContent).toContain('No machine has been reached');
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain('no machine has been reached');
  });

  it('names the machine, its address and when it was reached', () => {
    render(<EngraveMachineUpload {...props()} />);
    const target = screen.getByTestId('engrave-upload-target').textContent!;
    expect(target).toContain('Makera_Z1_010290');
    expect(target).toContain('192.168.10.43:2222');
    // The date is the point of `observedAt` (#280): a check is a note of when we looked, never a
    // standing claim that the machine is there now. Asserted as "a date is shown", not a format.
    expect(target).toMatch(/20\d\d/);
    expect(button().disabled).toBe(false);
  });

  it('falls back to the address when the machine never announced a name', () => {
    render(<EngraveMachineUpload {...props({ machine: { ...MACHINE, name: null } })} />);
    expect(screen.getByTestId('engrave-upload-target').textContent).toContain('192.168.10.43');
  });
});

describe('#255 EngraveMachineUpload — when it will not send', () => {
  it('carries the run’s own blocker, word for word', () => {
    render(<EngraveMachineUpload {...props({ blocker: 'the simulation does not match the prediction' })} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain('the simulation does not match the prediction');
  });

  it('does not let the wizard’s remembered "busy" shut the button — the upload asks the machine live (#296)', () => {
    render(<EngraveMachineUpload {...props({ machine: { ...MACHINE, busy: true } })} />);
    expect(button().disabled).toBe(false);
  });

  it('shuts when the run has no program', () => {
    render(<EngraveMachineUpload {...props({ program: null })} />);
    expect(button().disabled).toBe(true);
  });
});

describe('#255 EngraveMachineUpload — the second press', () => {
  it('names the machine, the file and its size before anything is written', () => {
    render(<EngraveMachineUpload {...props()} />);
    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();

    fireEvent.click(button());
    const confirm = screen.getByTestId('engrave-upload-confirm').textContent!;
    expect(confirm).toContain('Untitled-engrave-job.nc');
    expect(confirm).toContain('Makera_Z1_010290');
    expect(confirm).toContain('192.168.10.43:2222');
    // The exact byte count, because that is what the machine will report back.
    expect(confirm).toContain(`${NC.length} bytes`);
    // And it says what it will NOT do, so the confirm cannot be read as "run the job".
    expect(confirm).toContain('does not start the job');
  });

  it('writes nothing when the confirmation is cancelled', async () => {
    let uploads = 0;
    setMachineUploadLoader(async () => ({
    status: IDLE,
      upload: async () => {
        uploads += 1;
        return { ok: true, bytes: 1, packets: 1, alreadyPresent: false };
      },
    }));
    render(<EngraveMachineUpload {...props()} />);
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-cancel'));

    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();
    expect(screen.queryByTestId('engrave-upload-result')).toBeNull();
    expect(uploads).toBe(0);
  });

  it('sends on the second press and reports what the machine did', async () => {
    const seen: Array<{ host: string; port: number; filename: string }> = [];
    setMachineUploadLoader(async () => ({
    status: IDLE,
      upload: async (target, program) => {
        seen.push({ host: target.host, port: target.port, filename: program.filename });
        return { ok: true, bytes: 41, packets: 2, alreadyPresent: false };
      },
    }));
    render(<EngraveMachineUpload {...props()} />);
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));

    await waitFor(() => expect(screen.getByTestId('engrave-upload-result')).toBeTruthy());
    expect(seen).toEqual([{ host: '192.168.10.43', port: 2222, filename: 'Untitled-engrave-job.nc' }]);
    const result = screen.getByTestId('engrave-upload-result');
    expect(result.getAttribute('data-state')).toBe('uploaded');
    expect(result.textContent).toContain('41 bytes');
    // The confirm is gone once it has been answered — it is not a mode to be stuck in.
    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();
  });

  it('shows a machine’s refusal as a result, not as a crash', async () => {
    setMachineUploadLoader(async () => ({
    status: IDLE,
      upload: async () => ({ ok: false, reason: 'refused', detail: 'the machine rejected the transfer (file cancel)' }),
    }));
    render(<EngraveMachineUpload {...props()} />);
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));

    await waitFor(() => expect(screen.getByTestId('engrave-upload-result')).toBeTruthy());
    const result = screen.getByTestId('engrave-upload-result');
    expect(result.getAttribute('data-state')).toBe('refused');
    expect(result.textContent).toContain('rejected the transfer');
  });
});

describe('#295 EngraveMachineUpload — the gate is asked again at the second press', () => {
  it('writes nothing, and closes the box, when the run went stale after the first press', async () => {
    let uploads = 0;
    setMachineUploadLoader(async () => ({
      status: IDLE,
      upload: async () => {
        uploads += 1;
        return { ok: true, bytes: 1, packets: 1, alreadyPresent: false };
      },
    }));
    const { rerender } = render(<EngraveMachineUpload {...props()} />);
    fireEvent.click(button());
    expect(screen.getByTestId('engrave-upload-confirm')).toBeTruthy();

    // The job changes while the confirmation is open: the run's own blocker comes up.
    rerender(<EngraveMachineUpload {...props({ blocker: 'the job or the machine frame changed since it was generated' })} />);
    await waitFor(() => expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull());
    expect(uploads).toBe(0);

    // And clearing the blocker later does not resurrect a box nobody pressed.
    rerender(<EngraveMachineUpload {...props()} />);
    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();
    expect(uploads).toBe(0);
  });
});

describe('#296 EngraveMachineUpload — a machine that is not idle now', () => {
  it('shows the refusal and hands the live status back to be remembered', async () => {
    let uploads = 0;
    const told: Array<{ busy: boolean; status: string }> = [];
    setMachineUploadLoader(async () => ({
      status: async () => ({ ok: true, text: '<Run|MPos:1,2,3>' }),
      upload: async () => {
        uploads += 1;
        return { ok: true, bytes: 1, packets: 1, alreadyPresent: false };
      },
    }));
    render(<EngraveMachineUpload {...props({ onLiveStatus: (l) => told.push(l) })} />);
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));

    await waitFor(() => expect(screen.getByTestId('engrave-upload-result')).toBeTruthy());
    const result = screen.getByTestId('engrave-upload-result');
    expect(result.getAttribute('data-state')).toBe('busy');
    expect(result.textContent).toContain('busy');
    expect(uploads).toBe(0);
    expect(told).toEqual([{ busy: true, status: '<Run|MPos:1,2,3>' }]);
  });
});

describe('#296 EngraveMachineUpload — the live answer replaces the remembered one', () => {
  it('lets a machine remembered as busy be uploaded to, and records that it was idle', async () => {
    const told: Array<{ busy: boolean; status: string }> = [];
    render(
      <EngraveMachineUpload
        {...props({ machine: { ...MACHINE, busy: true }, onLiveStatus: (l) => told.push(l) })}
      />,
    );
    fireEvent.click(button());
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-send'));
    await waitFor(() => expect(screen.getByTestId('engrave-upload-result')).toBeTruthy());
    expect(screen.getByTestId('engrave-upload-result').getAttribute('data-state')).toBe('uploaded');
    expect(told).toEqual([{ busy: false, status: '<Idle|MPos:0,0,0>' }]);
  });
});

describe('#255 EngraveMachineUpload — the sentence for each outcome', () => {
  const cases: Array<[MachineUploadResult, string]> = [
    [{ kind: 'uploaded', filename: 'job.nc', bytes: 41, packets: 2, alreadyPresent: false, status: '<Idle>' }, 'received job.nc'],
    [{ kind: 'uploaded', filename: 'job.nc', bytes: 41, packets: 0, alreadyPresent: true, status: '<Idle>' }, 'already had job.nc'],
    [{ kind: 'refused', filename: 'job.nc', detail: 'nope' }, 'declined job.nc'],
    [{ kind: 'busy', filename: 'job.nc', detail: 'it reports Run rather than Idle, so nothing was sent', status: '<Run>' }, 'is busy'],
    [{ kind: 'timeout', filename: 'job.nc', detail: 'silent' }, 'timed out'],
    [{ kind: 'error', filename: 'job.nc', detail: 'socket died' }, 'was not uploaded'],
    [{ kind: 'unavailable', filename: 'job.nc', reason: 'web build' }, 'cannot reach a machine'],
  ];

  it('states what happened for every one of the six outcomes', () => {
    for (const [result, expected] of cases) {
      expect(describeUpload(result, 'The Z1')).toContain(expected);
    }
  });

  it('does not call an already-present file a fresh transfer', () => {
    // The distinction is the whole reason `alreadyPresent` exists: 0 packets means no data moved.
    const sentence = describeUpload(cases[1]![0], 'The Z1');
    expect(sentence).toContain('no data was sent');
    expect(sentence).not.toContain('packets');
  });
});
