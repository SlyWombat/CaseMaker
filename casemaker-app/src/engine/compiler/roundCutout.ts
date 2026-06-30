import type { Facing } from '@/types';
import { cube, cylinder, rotate, translate, type BuildOp } from './buildPlan';

/**
 * Build a round cutout occupying the same axis-aligned bounding box that a
 * rectangular cutout would. The cylinder's axis is parallel to the wall the
 * cutout pierces (derived from `facing`); its diameter matches the larger of
 * the two perpendicular dimensions. Used for connectors with circular bodies
 * such as XLR-3, SMA, U.FL panel mounts, where a rectangular hole would leave
 * a visible gap around the connector body.
 */
export function buildAxisAlignedCutout(
  facing: Facing,
  xMin: number,
  yMin: number,
  zMin: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  shape: 'rect' | 'round',
  segments = 48,
): BuildOp {
  if (shape === 'rect' || facing === '+z') {
    return translate([xMin, yMin, zMin], cube([sizeX, sizeY, sizeZ], false));
  }

  switch (facing) {
    case '+y':
    case '-y': {
      const radius = Math.max(sizeX, sizeZ) / 2;
      const cyl = cylinder(sizeY, radius, segments);
      const rotated = rotate([-90, 0, 0], cyl);
      const cx = xMin + sizeX / 2;
      const cz = zMin + sizeZ / 2;
      return translate([cx, yMin, cz], rotated);
    }
    case '+x':
    case '-x': {
      const radius = Math.max(sizeY, sizeZ) / 2;
      const cyl = cylinder(sizeX, radius, segments);
      const rotated = rotate([0, 90, 0], cyl);
      const cy = yMin + sizeY / 2;
      const cz = zMin + sizeZ / 2;
      return translate([xMin, cy, cz], rotated);
    }
    case '-z': {
      // Floor cutout: cylinder axis is already aligned with +Z (the
      // primitive defaults). Center on (cx, cy) of the bbox; start at
      // zMin (which extends below the floor outer surface).
      const radius = Math.max(sizeX, sizeY) / 2;
      const cyl = cylinder(sizeZ, radius, segments);
      const cx = xMin + sizeX / 2;
      const cy = yMin + sizeY / 2;
      return translate([cx, cy, zMin], cyl);
    }
    default:
      return translate([xMin, yMin, zMin], cube([sizeX, sizeY, sizeZ], false));
  }
}
