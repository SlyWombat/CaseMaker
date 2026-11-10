/**
 * #1180 — the shared ring fixtures and the external-memory read for the manifold glue leak cases.
 * Each leak group lives in its own spec file now (three workers run the synchronous 5k/10k loops);
 * the fixtures are the same 654-vertex rings the old single file built.
 */
import type { Polygons } from '@/engine/cnc/cam/pocket';

export const RING: [number, number][] = Array.from({ length: 654 }, (_, i) => {
  const a = (2 * Math.PI * i) / 654;
  return [60 * Math.cos(a), 60 * Math.sin(a)] as [number, number];
});

/** A second 654-vertex ring, shifted so the two operands differ (the leak does not need it to). */
export const RING_B: [number, number][] = RING.map(([x, y]) => [x + 5, y] as [number, number]);
export const REGION: Polygons = [RING];
export const REGION_B: Polygons = [RING_B];

export const externalMb = (): number => process.memoryUsage().external / 1e6;
