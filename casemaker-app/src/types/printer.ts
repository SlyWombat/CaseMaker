import type { Mm } from './units';

/**
 * The build volume the project is being printed on (#148).
 *
 * It lives on the PROJECT, not on an archetype: a bed is a property of the
 * print job, and every archetype needs to know it — the rack to size its
 * sliders, the box shell to decide whether its floor and walls clear, a
 * future toolbox module to check a drawer. Until #148 the only copy lived on
 * `RackParams`, which meant a case could not be fit-checked at all.
 *
 * `preset` is informational — which picker row filled in x/y/z. The numbers are
 * authoritative, so a project keeps working when a preset's numbers change.
 * These are the flat values the panel and the fit checks speak; the six rows
 * themselves live on the machine profile (#184, `PRINTER_PROFILES`).
 */
export interface PrinterVolume {
  preset?: string;
  x: Mm;
  y: Mm;
  z: Mm;
}

/** Does a part of this size fit the bed, ignoring rotation? */
export function printerFits(printer: PrinterVolume, x: number, y: number, z: number): boolean {
  return (
    ((x <= printer.x && y <= printer.y) || (y <= printer.x && x <= printer.y)) && z <= printer.z
  );
}
