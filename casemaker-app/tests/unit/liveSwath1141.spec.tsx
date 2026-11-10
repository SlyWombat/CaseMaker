// @vitest-environment jsdom
// #1141 — THE LIVE SWATH MUST SUBSCRIBE WITH A STABLE SNAPSHOT.
//
// Its WPos selector builds a `{x,y,z}` object. Without `useShallow`, zustand v5 + React 19 read the
// store through `useSyncExternalStore`, which requires getSnapshot to be stable between store
// changes; a fresh object per call is React's "The result of getSnapshot should be cached to avoid
// an infinite loop". The first machine-store change then re-renders forever ("Maximum update depth
// exceeded") — and because LiveSwath renders inside the react-three-fiber canvas, that loop took
// the whole page down when a registration run started (the #1166 UI proof).
//
// The walk: no release record, so LiveSwath returns null by design and the mesh JSX never runs —
// the subscription this test pins is still made. Five machine-store changes must all settle.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveSwath } from '@/components/viewport/LiveSwath';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { useMachineRunStore } from '@/store/machineRunStore';

afterEach(cleanup);

/** The remembered machine as the heartbeat writes it — a fresh status line per tick. */
function machineWithWpos(i: number): never {
  return {
    name: 'QA Z1',
    host: '192.0.2.10',
    port: 2222,
    busy: false,
    ip: null,
    mac: null,
    status: `<Idle|MPos:${i},${i},${i}|WPos:${i},${i},${i}>`,
    profileId: 'Z1',
    observedAt: '2026-11-10T00:00:00.000Z',
    notes: [],
    statusLine: { wpos: { x: i, y: i, z: i } },
  } as never;
}

describe('#1141 the live swath subscribes without looping', () => {
  it('takes five machine-store changes without an unstable getSnapshot', () => {
    resetMachineStore();
    useEngraveReleaseStore.setState({ records: {} });
    useMachineRunStore.setState({ runs: {} });

    render(<LiveSwath machineKey={null} />);

    for (let i = 1; i <= 5; i++) {
      // A looping snapshot throws React's own "Maximum update depth exceeded" from inside act, so
      // this loop completing IS the assertion.
      act(() => {
        useMachineStore.setState({ machine: machineWithWpos(i) });
      });
    }

    // The last tick is on the store and the component read it without a retained error.
    expect(useMachineStore.getState().machine?.statusLine?.wpos).toEqual({ x: 5, y: 5, z: 5 });
  });
});
