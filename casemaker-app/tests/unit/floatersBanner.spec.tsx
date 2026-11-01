// @vitest-environment jsdom
// Issue #850 — the banner states a sealed cavity only when nobody asked for
// it. Deliberate magnet pockets never reach the store (the scheduler classifies
// them away), so the banner simply says what it is handed.

import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { FloatersBanner } from '@/components/layout/FloatersBanner';
import { useJobStore } from '@/store/jobStore';

afterEach(() => {
  cleanup();
  useJobStore.setState({ nodes: new Map(), sealedVoids: [] });
});

describe('#850 — the sealed-void statement', () => {
  it('names the cavity, its volume and where it sits', () => {
    useJobStore.setState({
      nodes: new Map(),
      sealedVoids: [{ node: 'shell', volumeMm3: 2.1, centreMm: [10, 20, -30] }],
    });
    render(<FloatersBanner />);
    const line = screen.getByTestId('sealed-void-0');
    expect(line.textContent).toContain('2.1 mm³');
    expect(line.textContent).toContain('X 10, Y 20, Z -30');
    expect(line.textContent).toContain('trapped air');
  });

  it('is information, not a warning', () => {
    useJobStore.setState({
      nodes: new Map(),
      sealedVoids: [{ node: 'lid', volumeMm3: 0.4, centreMm: [1, 2, 3] }],
    });
    render(<FloatersBanner />);
    expect(screen.getByTestId('floaters-banner').getAttribute('data-severity')).toBe('info');
  });

  it('renders nothing when there is no void and no loose part', () => {
    render(<FloatersBanner />);
    expect(screen.queryByTestId('floaters-banner')).toBeNull();
  });
});
