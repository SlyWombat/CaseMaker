// The CNC pipeline (#174, #182): parse, frame, run. Geometry (the sweep) is not here yet.
export * from './setup';
export * from './frames';
export { buildTimeline, applyEvent, initialState, isRealToolChange } from './emulator/timeline';
export type {
  Checkpoint,
  MachineState,
  PauseKind,
  PausePoint,
  Segment,
  Timeline,
  TimelineDiagnostic,
  ToolState,
} from './emulator/timeline';
export { parseGcode, hasErrors } from './gcode';
