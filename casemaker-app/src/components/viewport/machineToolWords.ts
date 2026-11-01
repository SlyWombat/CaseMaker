/**
 * #883 — THE TOOL THE MACHINE SAYS IT HOLDS, from its own `T:` number.
 *
 * The status strip used to pair the machine's reported `T` with the OPEN JOB's cutter, so a Z1
 * holding the 3D probe (T8888) read "T8888 · ⌀1 mm flat end". The name must come from the machine:
 * `T8888` is Makera's 3D probe, `T0` (or no T at all) is nothing fitted, and any other number is
 * looked up in the app's tool table — the registry's entries by their own numbers. The job's cutter
 * is never a source for the label; when the two differ, that is stated separately.
 */
export const PROBE_TOOL_NUMBER = 8888;

/** `3D probe` for the machine's probe number; the table's name otherwise; null when nothing fits. */
export function machineToolName(
  toolNumber: number | null,
  lookup: (number: number) => string | null,
): string | null {
  if (toolNumber === null || toolNumber <= 0) return null;
  if (toolNumber === PROBE_TOOL_NUMBER) return '3D probe';
  return lookup(toolNumber);
}

/**
 * The fact when the machine's tool and the job's cutter are not the same tool: "the job wants
 * ⌀1 mm flat end; the spindle holds the 3D probe". Null when they agree, when the job names no
 * cutter, or when the machine has not said what it holds.
 */
export function spindleMismatchWords(
  jobCutterName: string | null,
  jobCutterNumber: number | null,
  machineToolNumber: number | null,
  machineTool: string | null,
): string | null {
  if (jobCutterName === null || jobCutterNumber === null) return null;
  if (machineToolNumber === null || machineToolNumber <= 0) return null;
  if (jobCutterNumber === machineToolNumber) return null;
  // The issue's own example: "the spindle holds the 3D probe"; a number with no name keeps its T.
  return `the job wants ${jobCutterName}; the spindle holds ${machineTool === null ? `T${machineToolNumber}` : `the ${machineTool}`}`;
}
