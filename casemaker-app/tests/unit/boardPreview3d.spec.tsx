// @vitest-environment jsdom
// #130 — the optional GLB preview always degrades to the caller's fallback
// (the synthesised SVG) when there is no GLB, or no WebGL to draw one with.
// jsdom has no WebGL context, so this is exactly the fallback path a machine
// without a GPU takes. The three.js path itself is unexercised here — no board
// ships a licence-cleared GLB yet (see src/docs/board-assets.md).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { BoardPreview3d } from '@/components/welcome/BoardPreview3d';
import type { BoardProfile } from '@/types';

afterEach(cleanup);

function board(overrides: Partial<BoardProfile> = {}): BoardProfile {
  return {
    id: 'test-board',
    name: 'Test Board',
    manufacturer: 'Test',
    pcb: { size: { x: 50, y: 40, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 5,
    builtin: false,
    ...overrides,
  } as BoardProfile;
}

describe('#130 — BoardPreview3d', () => {
  it('renders the fallback when the board has no GLB', () => {
    const { getByTestId, queryByTestId } = render(
      <BoardPreview3d board={board()} fallback={<span data-testid="fb" />} />,
    );
    expect(getByTestId('fb')).toBeTruthy();
    expect(queryByTestId('board-preview-3d')).toBeNull();
  });

  it('renders the fallback under a runtime with no WebGL (jsdom)', () => {
    const { getByTestId, queryByTestId } = render(
      <BoardPreview3d
        board={board({
          visualAssets: {
            glb: '/board-assets/x/model.glb',
            license: 'CC-BY-4.0',
            sourceUrl: 'https://example.com/x',
          },
        })}
        fallback={<span data-testid="fb" />}
      />,
    );
    expect(getByTestId('fb')).toBeTruthy();
    expect(queryByTestId('board-preview-3d')).toBeNull();
  });
});
