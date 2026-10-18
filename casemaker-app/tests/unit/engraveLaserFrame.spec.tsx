// @vitest-environment jsdom
// #457 — the laser frame panel prints the surface its lift was checked against (the registered
// surface and its date, the obstacle above it, or that none was recorded), and a fixed height that
// does not clear the obstacle is refused before the console is even opened.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveLaserFrame } from '@/components/panels/EngraveLaserFrame';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import type { LaserLift } from '@/platform/machineLaser';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOUNDS = { minX: 0, minY: 0, maxX: 36.5, maxY: 74.25 };
const AT = '<Idle|MPos:-1.0000,-1.0000,-1.0000>';
const PLAIN: LaserLift = { zMachine: -3, zFloorMachine: -102 };

function fake(): string[] {
  const sent: string[] = [];
  setMachineConsoleLoader(async () => ({
    open: async () => ({
      async send(line: string): Promise<ConsoleSend> {
        sent.push(line);
        return { ok: true, line, text: line === '?' ? AT : 'ok', frames: 1, elapsedMs: 1 };
      },
      async close() {},
    }),
  }));
  return sent;
}

afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
});

describe('#457 EngraveLaserFrame', () => {
  it('names the registered surface, when it was measured, and the clamp above it', () => {
    fake();
    render(
      <EngraveLaserFrame
        host="192.0.2.10"
        port={2222}
        bounds={BOUNDS}
        lift={{
          ...PLAIN,
          stockTopMachineZ: -56.6,
          stockTop: {
            surfaceMachineZ: -57.6,
            measuredAt: '2026-10-18T02:14:00.000Z',
            obstacle: { label: 'the vise jaws', machineZ: -56.6 },
          },
        }}
      />,
    );
    const text = screen.getByTestId('engrave-laser-frame-surface').textContent ?? '';
    expect(text).toContain('machine Z -57.6');
    expect(text).toContain('measured 2026-10-18 02:14');
    expect(text).toContain('the vise jaws');
  });

  it('says the top was not checked rather than implying it was, with no registration', () => {
    fake();
    render(<EngraveLaserFrame host="192.0.2.10" port={2222} bounds={BOUNDS} lift={PLAIN} />);
    const text = screen.getByTestId('engrave-laser-frame-surface').textContent ?? '';
    expect(text).toContain('No registration recorded for this job on this machine');
    expect(text).toContain('machine Z -3');
  });

  it('refuses, sending nothing, when the fixed height is not above the clamp', async () => {
    const sent = fake();
    render(
      <EngraveLaserFrame
        host="192.0.2.10"
        port={2222}
        bounds={BOUNDS}
        lift={{
          ...PLAIN,
          stockTopMachineZ: -2,
          stockTop: {
            surfaceMachineZ: -16,
            measuredAt: '2026-10-18T02:14:00.000Z',
            obstacle: { label: 'the clamp on the back edge', machineZ: -2 },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-laser-frame-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-frame-run'));
    await waitFor(() =>
      expect(screen.getByTestId('engrave-laser-frame-note').textContent).toContain(
        'nothing was sent: the travel height (machine Z -3) is not above the clamp on the back edge (machine Z -2)',
      ),
    );
    expect(sent).toEqual([]); // the console was never opened
  });

  it('frames from the registered lift when it clears: lift, laser, corners, laser off, home', async () => {
    const sent = fake();
    render(
      <EngraveLaserFrame
        host="192.0.2.10"
        port={2222}
        bounds={BOUNDS}
        lift={{
          ...PLAIN,
          stockTopMachineZ: -56.6,
          stockTop: {
            surfaceMachineZ: -57.6,
            measuredAt: '2026-10-18T02:14:00.000Z',
            obstacle: { label: 'the vise jaws', machineZ: -56.6 },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('engrave-laser-frame-arm'));
    fireEvent.click(screen.getByTestId('engrave-laser-frame-run'));
    await waitFor(() => expect(screen.getByTestId('engrave-laser-frame-note').textContent).toContain('Framed.'));
    expect(sent[0]).toBe('?');
    expect(sent[1]).toBe('G53 G0 Z-3');
    expect(sent[2]).toBe('M831');
    expect(sent.slice(-2)).toEqual(['M832', '$H']);
  });
});
