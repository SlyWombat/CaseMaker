/**
 * #845 slice B — A GRBL MACHINE IN THE HOUSE LOCATION.
 *
 * The presets (`engine/cnc/machine.ts`: Shapeoko 4 XXL, Shapeoko 5 Pro, X-Carve Pro, 3018-PROVer
 * V2) are stated machines: Case Maker writes their `.nc` for the owner's own sender and never
 * connects to them. The manager's rule for where they live is the Makera machines' rule — the
 * HOUSE LOCATION, as ordinary machine records, so a shop's machines are visible from any LAN
 * browser and a second window does not need its own copy:
 *   - the record's `profileId` is the preset model's id (`grbl:shapeoko-4`), which is how every
 *     reader (`machineRecordByProfile`, the run sheet, the job's `machineId`) already finds the
 *     machine's values;
 *   - no `address`: there is no controller to reach, and a fake address would offer a check that
 *     can only fail;
 *   - no bed profiles: a bed is described on the machine card once the owner has one to describe.
 *
 * The record is written through the ordinary guarded machine PUT (`saveMachineWithRetry`), so a
 * second writer's edit is merged rather than clobbered. Pure here: the caller supplies the id and
 * the clock, and the tests pin the shape without a service.
 */

import { MachineRecordSchema, type MachineRecord } from './locationClient';
import { MILL_MODELS, type MillModel } from '@/engine/cnc/machine';

/** The record a preset starts as: the model's name, its id, and nothing invented. */
export function machineRecordFromPreset(
  preset: MillModel,
  opts: { id: string; now: string; nickname?: string | null },
): MachineRecord {
  const record = MachineRecordSchema.parse({
    id: opts.id,
    profileId: preset.id,
    name: preset.name,
    nickname: opts.nickname ?? null,
    address: null,
    updatedAt: opts.now,
  });
  return record;
}

/**
 * True when the id names a GRBL preset this build ships (a stated machine, export only). The
 * Manage panel offers the presets Z1 does not already have in the location; the Cut panel asks
 * the same question of the resolved machine.
 */
export function isGrblPresetId(id: string | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  const model = MILL_MODELS[id];
  return model !== undefined && model.post === 'grbl';
}
