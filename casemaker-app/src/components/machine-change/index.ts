/**
 * #693 — the change-the-machine wizard's public surface.
 *
 * Callers open it with `openMachineChange`; the app mounts `MachineChangeWizard` once, beside the
 * startup wizard. Both are re-exported here so the entry points (Manage now; Holding and Cut in
 * their own slices) import from one place and the wizard's internals stay private.
 */

export { MachineChangeWizard } from './MachineChangeWizard';
export { openMachineChange } from '@/store/machineChangeStore';
export type { MachineChangeJob, MachineChangeRequest, MachineChangeResult } from '@/store/machineChangeStore';
