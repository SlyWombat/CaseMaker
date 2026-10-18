// @vitest-environment jsdom
// #431 slice 2 — the point-to-origin panel, against a fake console: refused for a tight margin; arm,
// start, jog, confirm, write X/Y, laser off, home; the laser is switched off when the panel goes away.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveLaserPoint } from '@/components/panels/EngraveLaserPoint';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { MachineLaserOptions } from '@/components/manage/MachineLaserOptions';
import { resetLaserHomeStore, useLaserHomeStore } from '@/store/laserHomeStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '<Idle|MPos:-120.5000,-130.2500,-3.0000>';
function fake(fail?: string): string[] {
  const sent: string[] = [];
  setMachineConsoleLoader(async () => ({
    open: async () => ({
      async send(line: string): Promise<ConsoleSend> {
        sent.push(line);
        if (line === fail) return { ok: false, line, reason: 'timeout', detail: 'no reply', text: '' };
        return { ok: true, line, text: line === '?' ? AT : 'ok', frames: 1, elapsedMs: 1 };
      },
      async close() {},
    }),
  }));
  return sent;
}
// `lift` is the Z1's `toolChange.clearanceZ` and `softEndstop.zMin`: the hoist the panel sends before
// the laser moves, with the floor the guard checks it against (#448).
const props = (mm: number) => ({
  host: '192.0.2.10',
  port: 2222,
  margin: { mm, from: "the job's edge margin" },
  uncertainty: { mm: 1, source: 'seeded' },
  lift: { zMachine: -3, zFloorMachine: -102 },
});

afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
  resetLaserHomeStore();
});

describe('#431 EngraveLaserPoint', () => {
  it('is refused, by name, for a job whose margin is tighter than ±1 mm', () => {
    fake();
    render(<EngraveLaserPoint {...props(0.5)} />);
    expect(screen.getByTestId('engrave-laser-point-refused').textContent).toContain('tighter than the laser dot');
    expect(screen.queryByTestId('engrave-laser-point-start')).toBeNull();
  });

  it('arm, start, jog, confirm: writes X and Y, then laser off and home', async () => {
    const sent = fake();
    render(<EngraveLaserPoint {...props(2)} />);
    expect((screen.getByTestId('engrave-laser-point-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-laser-point-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-point-start'));
    await screen.findByTestId('engrave-laser-point-jog');
    fireEvent.click(screen.getByTestId('engrave-laser-jog-X+1'));
    await waitFor(() => expect(sent).toContain('G0 X1'));
    fireEvent.click(screen.getByTestId('engrave-laser-point-set'));
    expect(sent.some((l) => l.startsWith('G10'))).toBe(false); // the confirmation comes first
    fireEvent.click(screen.getByTestId('engrave-laser-point-confirm-yes'));
    await waitFor(() => expect(sent).toContain('$H'));
    expect(sent).toEqual(['?', 'G53 G0 Z-3', 'M831', 'G91', 'G0 X1', 'G90', '?', 'G10 L2 P1 X-120.500 Y-130.250', 'M832', '$H']);
    expect(screen.getByTestId('engrave-laser-point-note').textContent).toContain('The laser is off');
  });

  it('the panel going away switches the laser off and MOVES NOTHING; the home it owes is offered next time, as a button', async () => {
    const sent = fake();
    const view = render(<EngraveLaserPoint {...props(2)} />);
    fireEvent.click(screen.getByTestId('engrave-laser-point-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-point-start'));
    await screen.findByTestId('engrave-laser-point-jog');
    view.unmount();
    await waitFor(() => expect(sent.at(-1)).toBe('M832'));
    expect(sent).not.toContain('$H');
    await waitFor(() => expect(Object.keys(useLaserHomeStore.getState().pending)).toEqual(['192.0.2.10:2222']));
    // Reopened: it says so, and Home is a button — sent only when pressed.
    render(<EngraveLaserPoint {...props(2)} />);
    expect(screen.getByTestId('engrave-laser-point-home-owed').textContent).toContain('Home the machine before the next step');
    expect(sent).not.toContain('$H');
    fireEvent.click(screen.getByTestId('engrave-laser-point-home'));
    await waitFor(() => expect(sent.at(-1)).toBe('$H'));
    await waitFor(() => expect(screen.queryByTestId('engrave-laser-point-home-owed')).toBeNull());
  });

  it('a failed jog: laser off, no home sent, Home offered — here and on the machine card', async () => {
    const sent = fake('G0 X1');
    render(<EngraveLaserPoint {...props(2)} />);
    fireEvent.click(screen.getByTestId('engrave-laser-point-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-point-start'));
    await screen.findByTestId('engrave-laser-point-jog');
    fireEvent.click(screen.getByTestId('engrave-laser-jog-X+1'));
    await screen.findByTestId('engrave-laser-point-home-owed');
    expect(sent.slice(-2)).toEqual(['G90', 'M832']);
    expect(sent).not.toContain('$H');
    render(<MachineLaserOptions />);
    expect(screen.getByTestId('manage-laser-home-owed').textContent).toContain('192.0.2.10');
    fireEvent.click(screen.getByTestId('manage-laser-home'));
    await waitFor(() => expect(sent.at(-1)).toBe('$H'));
  });
});

describe('#457 the point-to-origin lift says what it was checked against', () => {
  const REGISTERED = {
    zMachine: -3,
    zFloorMachine: -102,
    stockTopMachineZ: -56.6,
    stockTop: {
      surfaceMachineZ: -57.6,
      measuredAt: '2026-10-18T02:14:00.000Z',
      obstacle: { label: 'the vise jaws', machineZ: -56.6 },
    },
  };

  it('names the registered surface, when it was measured, and the obstacle above it', () => {
    fake();
    render(<EngraveLaserPoint {...props(2)} lift={REGISTERED} />);
    const text = screen.getByTestId('engrave-laser-point-surface').textContent ?? '';
    expect(text).toContain('machine Z -57.6');
    expect(text).toContain('measured 2026-10-18 02:14');
    expect(text).toContain('the vise jaws');
  });

  it('says no registration was recorded for a job without one', () => {
    fake();
    render(<EngraveLaserPoint {...props(2)} />);
    expect(screen.getByTestId('engrave-laser-point-surface').textContent).toContain('No registration recorded');
  });

  it('refuses before anything is sent when the lift is not above the clamped blank', async () => {
    const sent = fake();
    render(
      <EngraveLaserPoint
        {...props(2)}
        lift={{
          zMachine: -3,
          zFloorMachine: -102,
          stockTopMachineZ: -2,
          stockTop: {
            surfaceMachineZ: -16,
            measuredAt: '2026-10-18T02:14:00.000Z',
            obstacle: { label: 'the clamp on the back edge', machineZ: -2 },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-laser-point-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-point-start'));
    await waitFor(() =>
      expect(screen.getByTestId('engrave-laser-point-note').textContent).toContain(
        'nothing was sent: the travel height (machine Z -3) is not above the clamp on the back edge (machine Z -2)',
      ),
    );
    expect(sent).toEqual([]);
    expect(screen.queryByTestId('engrave-laser-point-jog')).toBeNull();
  });
});
