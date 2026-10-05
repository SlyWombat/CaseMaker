// @vitest-environment jsdom
// #130 — the board picker's data-driven preview: photo-with-licence when the
// profile carries visualAssets.topImage (falling back to the SVG on error),
// round fixture shapes for XLR/audio/barrel connectors, and silkscreen text
// for text-label components.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BoardPreviewSvg } from '@/components/welcome/BoardPreviewSvg';
import { getBuiltinBoard } from '@/library';
import type { BoardComponent, BoardProfile } from '@/types';

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

function component(overrides: Partial<BoardComponent> = {}): BoardComponent {
  return {
    id: 'c1',
    kind: 'custom',
    position: { x: 10, y: 10, z: 0 },
    size: { x: 12, y: 12, z: 2 },
    ...overrides,
  } as BoardComponent;
}

describe('#130 — BoardPreviewSvg', () => {
  it('renders the synthesised SVG when a board has no visualAssets', () => {
    const { container } = render(<BoardPreviewSvg board={board()} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('aria-label')).toBe('Top view of Test Board');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the top photo, licence and source when topImage is present', () => {
    const { container } = render(
      <BoardPreviewSvg
        board={board({
          visualAssets: {
            topImage: '/board-assets/foo/top.png',
            license: 'CC-BY-SA-4.0',
            sourceUrl: 'https://example.com/foo',
          },
        })}
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('/board-assets/foo/top.png');
    expect(img!.getAttribute('loading')).toBe('lazy');
    expect(container.querySelector('svg')).toBeNull();
    const credit = container.querySelector('[data-testid="board-preview-credit"]');
    expect(credit?.textContent).toContain('CC-BY-SA-4.0');
    expect(credit?.textContent).toContain('https://example.com/foo');
  });

  it('falls back to the SVG if the photo fails to load', () => {
    const { container } = render(
      <BoardPreviewSvg
        board={board({
          visualAssets: { topImage: '/missing.png', license: 'CC0-1.0', sourceUrl: 'https://example.com' },
        })}
      />,
    );
    expect(container.querySelector('svg')).toBeNull();
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('draws an audio-jack fixture as a round body with a bore', () => {
    const { container } = render(
      <BoardPreviewSvg
        board={board({
          components: [
            component({ kind: 'custom', fixtureId: 'audio-jack-3-5', size: { x: 8, y: 8, z: 3 } }),
          ],
        })}
      />,
    );
    // Outer shell + dark bore, and no rectangular component block.
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('rect[width="8"]')).toBeNull();
  });

  it('draws an xlr-3 fixture as a round shell with three pins', () => {
    const { container } = render(
      <BoardPreviewSvg
        board={board({
          components: [component({ kind: 'custom', fixtureId: 'xlr-3', size: { x: 16, y: 16, z: 4 } })],
        })}
      />,
    );
    // Shell + 3 gold pins.
    expect(container.querySelectorAll('circle')).toHaveLength(4);
  });

  it('renders a text-label as silkscreen text', () => {
    render(
      <BoardPreviewSvg
        board={board({
          components: [
            component({
              kind: 'text-label',
              size: { x: 24, y: 4, z: 0.1 },
              text: 'DIGITAL',
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText('DIGITAL')).toBeTruthy();
  });

  it('draws nothing for a text-label with no text', () => {
    const { container } = render(
      <BoardPreviewSvg
        board={board({
          components: [component({ kind: 'text-label', size: { x: 24, y: 4, z: 0.1 } })],
        })}
      />,
    );
    expect(container.querySelector('text')).toBeNull();
  });

  it("uses the shipped Giga profile's audio jack without throwing", () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    const { container } = render(<BoardPreviewSvg board={giga} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
