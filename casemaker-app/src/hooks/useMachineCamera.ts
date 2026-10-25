/**
 * #530 — the camera a connected machine offers, if its profile names one.
 *
 * The profile is the source (engine/cnc/machine.ts): a machine with no camera block has no camera,
 * and every surface that offers one reads this hook rather than re-deciding. The camera is a fact
 * about the machine model, not a calibration — nothing here reads the saved frame — so the vendor
 * profile is resolved without one.
 *
 * The URL's shape is `cameraStreamUrl`'s: direct to the machine from the desktop shell, through
 * the embedded server from a LAN browser. Both entry points and the pane itself take the same
 * answer, so there is one URL per machine rather than one per surface.
 */

import { resolvedMachineById } from '@/engine/cnc/calibration';
import { cameraStreamUrl, type CameraSite } from '@/platform/cameraStream';
import { useMachineStore } from '@/store/machineStore';

export interface MachineCamera {
  /** The machine's LAN address, for the pane's title and the saved frame's name. */
  host: string;
  url: string;
  /** Where the camera block came from (`engine/cnc/machine.ts`'s `source`), for the hover. */
  source: string;
}

/** The pure part: a machine observation (or none) → its camera, or null. */
export function machineCamera(machine: { host: string; profileId: string | null } | null): MachineCamera | null {
  if (machine === null || machine.profileId === null) return null;
  const camera = resolvedMachineById(machine.profileId, null)?.camera ?? null;
  if (camera === null) return null;
  const site: CameraSite = { host: machine.host, camera };
  const url = cameraStreamUrl({ site });
  return url === null ? null : { host: machine.host, url, source: camera.source };
}

/** The connected machine's camera, reactive to the machine store. */
export function useMachineCamera(): MachineCamera | null {
  const machine = useMachineStore((s) => s.machine);
  return machineCamera(machine);
}
