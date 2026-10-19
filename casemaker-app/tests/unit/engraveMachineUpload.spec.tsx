// @vitest-environment jsdom
// #255 — the "Upload to machine" control in the engrave panel, as a person meets it: what it says
// when there is nowhere to send, what the confirmation names before anything is written, and how
// each outcome reads afterwards. The socket is the only fake (`setMachineUploadLoader`), so the
// gate and the mapping under test are the ones the app runs.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
import { setInventoryEntries, resetRegistry } from '@/engine/cnc/toolRegistry';
import { flatEndMill } from '@/engine/cnc/tool';
import {
  resetInventoryConditions,
  setInventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import type { InventoryItem } from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  setMachineUploadLoader(null);
  resetRegistry();
  resetInventoryConditions();
  useToolRegistryStore.setState({ items: [] });
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
    // The Z1's `toolChange.clearanceZ` and `softEndstop.zMin`, as the panel hands them in — required,
    // never defaulted, and guarded at the point of use (#448).
    lift: { zMachine: -3, zFloorMachine: -102 },
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

describe('#491 EngraveMachineUpload — the cutter line', () => {
  const TOOL = flatEndMill(0.5, { name: '0.5*2mm Engraving(Metal)' });
  const ITEM: InventoryItem = {
    id: 'engraver',
    tool: TOOL,
    origin: null,
    quantity: 1,
    codes: [{ symbology: 'qr', value: 'C1-BIT-ENGRAVE' }],
    addedAt: '2026-10-17T00:00:00.000Z',
    notes: null,
    copies: [],
    colletFits: null,
  };
  const copy = (where: ToolCopy['whereabouts']): ToolCopy => ({
    id: 'c-1',
    condition: 'new',
    whereabouts: where,
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  });

  /** The panel reads a possession's identity from the registry entry and the store's items. */
  const seed = (where: ToolCopy['whereabouts']): void => {
    setInventoryEntries([{ key: 'inv:engraver', tool: TOOL, provenance: 'registered here' }]);
    useToolRegistryStore.setState({ items: [ITEM] });
    setInventoryConditions(
      [{ id: 'engraver', quantity: 1, copies: [copy(where)] }],
      (id) => `inv:${id}`,
    );
  };

  it('names the chosen copy’s case first, then the full label and the box code', () => {
    seed({ kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } });
    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'inv:engraver' } })} />);

    expect(screen.getByTestId('engrave-upload-cutter').textContent).toBe(
      'Cutter: Yellow case — 0.5*2mm Engraving(Metal) (C1-BIT-ENGRAVE)',
    );
  });

  it('shows the old colourless line when the copy states no case — never a guessed one', () => {
    seed({ kind: 'box' });
    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'inv:engraver' } })} />);

    const text = screen.getByTestId('engrave-upload-cutter').textContent!;
    expect(text).toBe('Cutter: 0.5*2mm Engraving(Metal) (C1-BIT-ENGRAVE)');
    expect(text.toLowerCase()).not.toContain('case');
  });

  it('draws no cutter line when the run names no cutter', () => {
    render(<EngraveMachineUpload {...props()} />);
    expect(screen.queryByTestId('engrave-upload-cutter')).toBeNull();
  });
});

describe('#538 EngraveMachineUpload — the fitted checkbox resets', () => {
  const withTool = (toolKey: string): Partial<EngraveMachineUploadProps> => ({ runContext: { toolKey } });
  const openConfirm = (): void => {
    fireEvent.click(screen.getByTestId('engrave-upload'));
  };
  // The fitted checkbox is scoped by its label — the run panel under the upload mounts its own controls.
  const fittedBox = (): HTMLInputElement =>
    screen.getByTestId('engrave-upload-fitted').querySelector('input') as HTMLInputElement;
  const checkBox = (): void => {
    // The native `.click()` runs the checkbox activation behaviour (toggles checked + fires the
    // click/change React wires onChange to), which `fireEvent.click` (a bare dispatch) does not.
    act(() => {
      fittedBox().click();
    });
  };
  const sendDisabled = (): boolean =>
    (screen.getByTestId('engrave-upload-confirm-send') as HTMLButtonElement).disabled;

  it('clears a ticked box when the confirmation is reopened', () => {
    render(<EngraveMachineUpload {...props(withTool('inv:engraver'))} />);
    openConfirm();
    checkBox();
    expect(fittedBox().checked).toBe(true);
    expect(sendDisabled()).toBe(false);
    fireEvent.click(screen.getByTestId('engrave-upload-confirm-cancel'));
    openConfirm();
    expect(fittedBox().checked).toBe(false);
    expect(sendDisabled()).toBe(true);
  });

  it('clears a ticked box when the posted cutter changes', () => {
    const { rerender } = render(<EngraveMachineUpload {...props(withTool('inv:engraver'))} />);
    openConfirm();
    checkBox();
    expect(fittedBox().checked).toBe(true);
    rerender(<EngraveMachineUpload {...props(withTool('inv:other'))} />);
    expect(fittedBox().checked).toBe(false);
    expect(sendDisabled()).toBe(true);
  });
});

describe('#537 EngraveMachineUpload — the cutter-mismatch selector', () => {
  const openConfirm = (): void => {
    fireEvent.click(screen.getByTestId('engrave-upload'));
  };
  const cutterSelect = (): HTMLSelectElement =>
    screen.getByTestId('engrave-upload-cutter-select') as HTMLSelectElement;
  const fittedBox = (): HTMLInputElement =>
    screen.getByTestId('engrave-upload-fitted').querySelector('input') as HTMLInputElement;
  const tickFitted = (): void => {
    act(() => {
      fittedBox().click();
    });
  };
  const sendDisabled = (): boolean =>
    (screen.getByTestId('engrave-upload-confirm-send') as HTMLButtonElement).disabled;

  it('defaults to the program cutter and allows Send once fitted is ticked', () => {
    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'flat-1.0' } })} />);
    openConfirm();

    expect(cutterSelect().value).toBe('flat-1.0');
    expect(screen.queryByTestId('engrave-upload-cutter-mismatch')).toBeNull();
    // The fitted tick is still required before anything is written.
    expect(sendDisabled()).toBe(true);
    tickFitted();
    expect(sendDisabled()).toBe(false);
  });

  it('refuses a different cutter with the mismatch finding, even when fitted is ticked', () => {
    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'flat-1.0' } })} />);
    openConfirm();

    fireEvent.change(cutterSelect(), { target: { value: 'flat-3.175x12-metal' } });
    // #516 item 3's fix names the RECOMMENDED cutter — colour first when one is known, then label.
    expect(screen.getByTestId('engrave-upload-cutter-mismatch').textContent).toBe(
      'fit 1 mm flat end (assumed)',
    );
    // The mismatch is a refusal: the fitted tick cannot override it.
    tickFitted();
    expect(sendDisabled()).toBe(true);
  });

  it('names the recommended cutter’s case colour and label in the mismatch fix', () => {
    const TOOL = flatEndMill(0.5, { name: '0.5*2mm Engraving(Metal)' });
    const ITEM: InventoryItem = {
      id: 'engraver',
      tool: TOOL,
      origin: null,
      quantity: 1,
      codes: [{ symbology: 'qr', value: 'C1-BIT-ENGRAVE' }],
      addedAt: '2026-10-17T00:00:00.000Z',
      notes: null,
      copies: [],
      colletFits: null,
    };
    const yellowCopy = (): ToolCopy => ({
      id: 'c-1',
      condition: 'new',
      whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    });
    setInventoryEntries([{ key: 'inv:engraver', tool: TOOL, provenance: 'registered here' }]);
    useToolRegistryStore.setState({ items: [ITEM] });
    setInventoryConditions(
      [{ id: 'engraver', quantity: 1, copies: [yellowCopy()] }],
      (id) => `inv:${id}`,
    );

    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'inv:engraver' } })} />);
    openConfirm();
    fireEvent.change(cutterSelect(), { target: { value: 'flat-1.0' } });

    expect(screen.getByTestId('engrave-upload-cutter-mismatch').textContent).toBe(
      'fit Yellow case — 0.5*2mm Engraving(Metal)',
    );
  });

  it('returns to the recommended cutter — no mismatch — when the box is reopened', () => {
    render(<EngraveMachineUpload {...props({ runContext: { toolKey: 'flat-1.0' } })} />);
    openConfirm();
    fireEvent.change(cutterSelect(), { target: { value: 'flat-3.175x12-metal' } });
    expect(screen.getByTestId('engrave-upload-cutter-mismatch')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-upload-confirm-cancel'));
    openConfirm();

    expect(cutterSelect().value).toBe('flat-1.0');
    expect(screen.queryByTestId('engrave-upload-cutter-mismatch')).toBeNull();
    tickFitted();
    expect(sendDisabled()).toBe(false);
  });
});

