import type { SmartPick, SmartPickRefusal } from '@/engine/cnc/engrave/smartPick';

/**
 * #910 — `smartPick` answers a library with no usable cutter as a stated refusal, not a throw.
 * A test that expects a plan unwraps it here, and a refusal fails the test with its own reasons.
 */
export function picked(result: SmartPick | SmartPickRefusal): SmartPick {
  if (result.refused === true) throw new Error(result.reason);
  return result;
}
