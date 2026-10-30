// @vitest-environment jsdom
// #530 — the Camera pane: the live frame and its AGE, pause/resume of the socket, a saved frame,
// and the two ways out. The socket is a fake with the browser's face on it, and the clock is fake,
// so the replay skip and the stall are exercised rather than waited out.
//
// Nothing here reaches a machine: the stream module is driven through the global WebSocket, which
// this spec replaces.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CameraPanel } from '@/components/panels/CameraPanel';
import { resetCameraPaneStore, useCameraPaneStore } from '@/store/cameraPaneStore';
import { setMachineConsoleLoader } from '@/platform/machineConsole';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import type { MachineObservation } from '@/platform/machineProbe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = '';
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  frame(): void {
    this.onmessage?.({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) } as MessageEvent);
  }
  /** Four frames: the three the module replays, then the first real picture. */
  live(): void {
    for (let i = 0; i < 4; i += 1) this.frame();
  }
}

const AT = new Date(2026, 9, 25, 10, 15, 9).getTime();

function remember(profileId: string | null, host = '192.0.2.10'): void {
  const observation: MachineObservation = {
    name: 'QA Z1',
    host,
    port: 2222,
    busy: false,
    ip: null,
    mac: null,
    status: '<Idle|MPos:0,0,0>',
    profileId,
    observedAt: '2026-10-25T09:00:00.000Z',
    notes: [],
  };
  useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null });
}

const createObjectURL = vi.fn((_blob: Blob) => `blob:frame-${createObjectURL.mock.calls.length}`);
const revokeObjectURL = vi.fn();
const savedCreate = URL.createObjectURL;
const savedRevoke = URL.revokeObjectURL;

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetCameraPaneStore();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = savedCreate;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = savedRevoke;
  resetCameraPaneStore();
});

/** Open the pane and hand back the socket it opened (none when there is no camera). */
function openPane(profileId: string | null = 'Z1'): FakeSocket | undefined {
  remember(profileId);
  useCameraPaneStore.getState().openPane();
  render(<CameraPanel />);
  return FakeSocket.all[FakeSocket.all.length - 1];
}

describe('#530 the camera pane', () => {
  it('shows the live frame, names the machine, and says how old the picture is', () => {
    const ws = openPane()!;
    // A LAN browser is served by the embedded server: the pane opens the server's own origin.
    expect(ws.url).toBe('ws://localhost:3000/api/v1/machine/camera?host=192.0.2.10&port=82');
    expect(screen.getByTestId('camera-title').textContent).toBe('QA Z1');
    expect(screen.getByTestId('camera-frame-age').textContent).toBe('no frame yet');

    act(() => {
      ws.open();
      ws.live();
    });
    expect(screen.getByTestId('camera-frame').getAttribute('src')).toBe('blob:frame-1');
    expect(screen.getByTestId('camera-frame-age').textContent).toBe('last frame just now');
    expect(screen.queryByTestId('camera-frame-stale')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('camera-frame-age').textContent).toBe('last frame 5 s ago');
    // Five seconds of silence is a stalled stream, and the pane says both facts.
    expect(screen.getByTestId('camera-frame-stale').textContent).toBe('The stream has stopped sending.');
    expect(screen.getByTestId('camera-state').textContent).toContain('reconnecting');
  });

  it('pauses by closing the socket, and resumes with a fresh one', () => {
    const ws = openPane()!;
    act(() => {
      ws.open();
      ws.live();
    });
    fireEvent.click(screen.getByTestId('camera-pause'));
    expect(ws.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(1);
    // The picture stays, with its age: pausing does not invent a live one.
    expect(screen.getByTestId('camera-frame')).toBeTruthy();
    expect(screen.getByTestId('camera-state').textContent).toBe('paused');

    fireEvent.click(screen.getByTestId('camera-pause'));
    expect(FakeSocket.all).toHaveLength(2);
    expect(screen.getByTestId('camera-state').textContent).toBe('connecting to the camera');
  });

  it('drops a picture from another machine rather than relabelling it', () => {
    const ws = openPane()!;
    act(() => {
      ws.open();
      ws.live();
    });
    expect(screen.getByTestId('camera-frame')).toBeTruthy();

    // A different machine is remembered while the pane is open. The old bed is not this bed.
    act(() => remember('Z1', '192.0.2.11'));
    expect(screen.queryByTestId('camera-frame')).toBeNull();
    expect(screen.getByTestId('camera-frame-age').textContent).toBe('no frame yet');
    expect(FakeSocket.all[FakeSocket.all.length - 1]!.url).toContain('host=192.0.2.11');
  });

  it('saves the frame as a download named for the machine and the moment', () => {
    const clicks: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    const ws = openPane()!;
    expect((screen.getByTestId('camera-save') as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      ws.open();
      ws.live();
    });
    fireEvent.click(screen.getByTestId('camera-save'));
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe('camera-192.0.2.10-20261025-101509.jpg');
    // A second URL for the download, so the live picture is not revoked out from under the pane.
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('closes on the button and on Escape, and the socket goes with it', () => {
    const ws = openPane()!;
    act(() => ws.open());
    fireEvent.click(screen.getByTestId('camera-close'));
    expect(screen.queryByTestId('camera-panel')).toBeNull();
    expect(useCameraPaneStore.getState().open).toBe(false);
    expect(ws.closed).toBe(true);

    act(() => useCameraPaneStore.getState().openPane());
    // The pane is back, with its own socket.
    expect(FakeSocket.all).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useCameraPaneStore.getState().open).toBe(false);
  });

  it('says what is missing rather than opening a socket to nothing', () => {
    resetMachineStore();
    useCameraPaneStore.getState().openPane();
    render(<CameraPanel />);
    expect(screen.getByTestId('camera-empty').textContent).toBe('No machine is connected.');
    expect(FakeSocket.all).toHaveLength(0);

    cleanup();
    resetCameraPaneStore();
    openPane('GRBL');
    expect(screen.getByTestId('camera-empty').textContent).toBe('This machine has no camera.');
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('#770 camera to home', () => {
  afterEach(() => setMachineConsoleLoader(null));

  function rememberStatus(status: string, busy: boolean): void {
    const observation: MachineObservation = {
      name: 'QA Z1',
      host: '192.0.2.10',
      port: 2222,
      busy,
      ip: null,
      mac: null,
      status,
      profileId: 'Z1',
      observedAt: '2026-10-25T09:00:00.000Z',
      notes: [],
    };
    useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null });
  }

  function fakeConsole(sent: string[], status: string): void {
    setMachineConsoleLoader(async () => ({
      async open() {
        return {
          async send(line: string) {
            sent.push(line);
            return line === '?'
              ? { ok: true as const, line, text: status, frames: 1, elapsedMs: 20 }
              : { ok: true as const, line, text: 'ok', frames: 1, elapsedMs: 10 };
          },
          async close() {},
        };
      },
    }));
  }

  it('offers the move on an idle machine, sends the clearance pose, and reports where it went', async () => {
    const sent: string[] = [];
    fakeConsole(sent, '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>');
    openPane('Z1');

    const button = screen.getByTestId('camera-home') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // The pose states the machine's own config keys and numbers — the provenance line.
    expect(screen.getByTestId('camera-home-pose').textContent).toContain('coordinate.clearance_x/y/z');
    expect(screen.getByTestId('camera-home-pose').textContent).toContain('X -11.6, Y -14.6, Z -3');
    expect(screen.queryByTestId('camera-home-refused')).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(sent).toEqual(['?', 'G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
    expect(screen.getByTestId('camera-home-note').textContent).toContain("camera's viewing pose");
  });

  it('is disabled on a running machine and says why', () => {
    rememberStatus('<Run|MPos:1.0000,2.0000,-1.0000|Bf:14,128|P:389,40,88>', true);
    useCameraPaneStore.getState().openPane();
    render(<CameraPanel />);

    const button = screen.getByTestId('camera-home') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('camera-home-refused').textContent).toContain('Run');
    expect(screen.getByTestId('camera-home-refused').textContent).toContain('40%');
  });

  it('is absent with no machine at all', () => {
    resetMachineStore();
    useCameraPaneStore.getState().openPane();
    render(<CameraPanel />);
    // The pane is reachable through the machine only; without one there is no button to press.
    expect(screen.getByTestId('camera-empty').textContent).toBe('No machine is connected.');
    expect(screen.queryByTestId('camera-home')).toBeNull();
  });
});
