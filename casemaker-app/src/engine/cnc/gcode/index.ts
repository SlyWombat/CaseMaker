// Public surface of the G-code parser (#174, #182). See interpreter.ts for the design.
export { parseGcode } from './interpreter';
export { hasErrors } from './types';
export type {
  CmHeader,
  Diagnostic,
  Frame,
  GcodeEvent,
  MkrHeader,
  MkrRecord,
  MoveEvent,
  ParseResult,
  ParseSummary,
  Pos,
  Severity,
  ToolChangeEvent,
} from './types';
export { CM_PREFIX, MKR_PREFIX, mkrNumber, parseCmRecord, parseMkrRecord } from './mkrHeader';
export { splitCommands, stripComment } from './lexer';
export { tessellateArc } from './arcs';
