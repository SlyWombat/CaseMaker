/**
 * #1202 + #1123 item 9 — THE TOOL CHANGE'S PREVIEW, DERIVED ONCE.
 *
 * The firmware's `Tool` stop is a motion routine of its own: the press that answers it sends
 * `M490.2`, and before any press that moves a machine nobody has proven this sequence on, the
 * surface the operator is looking at must show the exact line, mark a shape this machine has never
 * completed, carry the guard's refusal, and hold the press for the operator's own statement.
 *
 * TWO SURFACES SHOW IT AND THEY MAY NOT DRIFT. The Cut step's waiting card owns Continue and Stop
 * (#1123 item 9), so on that screen the run panel folds its prompt and the card carries the preview
 * — A's #1202 preview, unchanged. Elsewhere (the upload screen) the panel is the only surface and
 * its prompt stays: a safety preview never disappears because controls moved. Both read this hook
 * and `toolContinueHeld`, so the dry line, the mark, the statement, the headless refusal and the
 * hold rule are the same by construction.
 *
 * The completion is recorded by the run store when the controller leaves `Tool` after OUR line
 * (the watch's tool-done event); `routineCompleted` is this machine's record of the shape.
 */
import { useEffect, useMemo, useState } from 'react';

import { clearanceZOf } from '@/engine/cnc/machine';
import { jobMachine } from '@/engine/cnc/calibration';
import type { DryRoutine } from '@/engine/cnc/registration/dryRun';
import { firstRunAutomationRefusal } from '@/platform/automation';
import { routineCompleted } from '@/platform/routineRecord';
import { dryToolChange } from '@/platform/toolChangeDry';
import { useLocationStore } from '@/store/locationStore';
import { useSettingsStore } from '@/store/settingsStore';

export interface ToolChangePreview {
  /** The lines the Continue will send, each with the motion-order guard's verdict. */
  dry: DryRoutine;
  /** This machine's record does not carry this shape: the press is a first run. */
  firstRun: boolean;
  /** The operator's own first-run statement. */
  ticked: boolean;
  setTicked: (checked: boolean) => void;
  /** A first-run press from an automated instance against a real controller; null otherwise. */
  headless: string | null;
}

export function useToolChangePreview(
  target: { host: string; port: number } | null,
  waiting: boolean,
): ToolChangePreview {
  const locationMachine = useLocationStore((s) =>
    target === null
      ? null
      : (s.location?.machines.find((m) => m.address?.host === target.host && m.address.port === target.port) ?? null),
  );
  const calibration = useSettingsStore((s) => s.machineCalibration);
  // D's #1199 — the clearance is REQUIRED, never defaulted. An unknown machine is an unknown
  // clearance: with no record for this host:port there is no frame to read, and inventing one (a
  // Z1 the app assumed) would review the line against numbers this machine never stated. An
  // unread frame cannot answer either; the preview's refusal speaks in both cases.
  const clearanceZ = useMemo(() => {
    if (locationMachine?.profileId == null) return null;
    try {
      return clearanceZOf(jobMachine({ machineId: locationMachine.profileId }, calibration));
    } catch {
      return null;
    }
  }, [locationMachine?.profileId, calibration]);
  const dry = useMemo(() => dryToolChange(clearanceZ), [clearanceZ]);
  const [ticked, setTicked] = useState(false);
  // A new wait is a new statement: the tick does not carry over from the last stop.
  useEffect(() => setTicked(false), [waiting]);
  const firstRun = waiting && !routineCompleted(locationMachine, dry.identity);
  const headless = firstRunAutomationRefusal({ firstRun });
  return { dry, firstRun, ticked, setTicked, headless };
}

/**
 * A's hold rule (#1202): a refused line holds a FIRST-RUN press; on a proved shape the refusal
 * stays visible but never takes away the only way on from a mid-job tool stop. A headless
 * first-run refusal holds the press outright.
 */
export function toolContinueHeld(input: {
  stopAsked: boolean;
  firstRun: boolean;
  refused: boolean;
  ticked: boolean;
  headless: string | null;
}): boolean {
  return input.stopAsked || (input.firstRun && (input.refused || !input.ticked)) || input.headless !== null;
}

/** The tool-change first-run statement — the bit is the thing in the spindle, not the probe. */
export const TOOL_CHANGE_STATEMENT =
  'I am at the machine — the bit is fitted in the spindle, the head is clear, and I will stay at the Stop.';
