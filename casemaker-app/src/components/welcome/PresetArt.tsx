/**
 * #1100 — THE EIGHT PRESET DRAWINGS: 64 px line art in the CapabilityArt manner (inline SVG, the
 * app's palette, nothing fetched) so a card says what it makes before its title is read.
 */

import type { JSX } from 'react';

import type { PresetId } from './presets';

export function PresetArt({ id }: { id: PresetId }): JSX.Element {
  const common = {
    width: 64,
    height: 48,
    viewBox: '0 0 64 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (id) {
    case 'sign':
      return (
        <svg {...common}>
          <rect x="8" y="12" width="48" height="24" rx="2" />
          <path d="M16 30V18h6m-6 6h5M26 30l4-12 4 12m-6-4h4M38 30V18h4a3 3 0 0 1 0 6h-4M46 18v12" />
        </svg>
      );
    case 'design-file':
      return (
        <svg {...common}>
          <path d="M14 8h22l12 12v20H14z" />
          <path d="M36 8v12h12M20 30l6-8 5 6 4-4 5 6" />
        </svg>
      );
    case 'part-3d':
      return (
        <svg {...common}>
          <path d="M32 6l20 11v16L32 44 12 33V17z" />
          <path d="M32 24l20-11M32 24 12 13m20 11v20" />
        </svg>
      );
    case 'cutout':
      return (
        <svg {...common}>
          <rect x="10" y="10" width="44" height="28" rx="2" />
          <rect x="20" y="17" width="24" height="14" rx="3" strokeDasharray="3 2" />
          <path d="M14 16v4M14 28v4M50 16v4M50 28v4" />
        </svg>
      );
    case 'pocket':
      return (
        <svg {...common}>
          <path d="M10 14l22-8 22 8-22 8z" />
          <path d="M10 14v14l22 8 22-8V14M32 22v14" />
        </svg>
      );
    case 'pcb':
      return (
        <svg {...common}>
          <rect x="10" y="10" width="44" height="28" rx="2" />
          <circle cx="18" cy="18" r="2" />
          <circle cx="46" cy="30" r="2" />
          <path d="M18 20v10h20M46 28v-8h-8" />
        </svg>
      );
    case 'dowel':
      return (
        <svg {...common}>
          <path d="M14 20h36a4 6 0 0 1 0 12H14" />
          <ellipse cx="14" cy="26" rx="4" ry="6" />
          <path d="M24 22v-2M32 22v-2M40 22v-2" />
        </svg>
      );
    case 'rod-dowel':
      return (
        <svg {...common}>
          <path d="M14 20h36a4 6 0 0 1 0 12H14" />
          <ellipse cx="14" cy="26" rx="4" ry="6" />
          <path d="M24 22v-2M32 22v-2M40 22v-2" />
        </svg>
      );
    case 'rod-faces':
      return (
        <svg {...common}>
          <ellipse cx="16" cy="26" rx="5" ry="8" />
          <path d="M16 18h30M16 34h30M46 18a5 8 0 0 1 0 16" />
          <path d="M24 18v16M32 18v16M40 18v16" opacity="0.6" />
        </svg>
      );
    case 'rod-relief':
      return (
        <svg {...common}>
          <ellipse cx="14" cy="26" rx="4" ry="6" />
          <path d="M14 20h36a4 6 0 0 1 0 12H14" />
          <path d="M24 22l4-3 4 3 4-3 4 3 4-3" />
        </svg>
      );
    case 'something-else':
      return (
        <svg {...common}>
          <circle cx="18" cy="18" r="4" />
          <circle cx="46" cy="18" r="4" />
          <circle cx="18" cy="36" r="4" />
          <circle cx="46" cy="36" r="4" />
        </svg>
      );
  }
}
