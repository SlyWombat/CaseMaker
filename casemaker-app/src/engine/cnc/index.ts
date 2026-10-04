// The CNC pipeline (#174, #182): parse, frame, run. Geometry (the sweep) is not here yet.
export * from './setup';
export * from './frames';
export * from './machine';
export { buildTimeline, applyEvent, initialState, isRealToolChange, resolveMove, toolChangeMacro, DIAGNOSTIC_CAP } from './emulator/timeline';
export type {
  AirMove,
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
