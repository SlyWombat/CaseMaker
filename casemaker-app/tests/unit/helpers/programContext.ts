// #1126 — the two context fields every posted program carries, for specs that build a program by
// hand: a standard-hop program with no allowances and no through kerf, and no frame verified.
import { HOP_Z } from '@/engine/cnc/cam/ir';
import type { ProgramVerifyContext } from '@/engine/cnc/engrave/planSummary';

export const STORED_CONTEXT: ProgramVerifyContext = { minRapidZ: HOP_Z, outsideAllowancesMm: [], throughKerf: [] };

/** Spread into a hand-built `EngraveProgram`. */
export const PROGRAM_CONTEXT = { verifyContext: STORED_CONTEXT, frameVerifyContext: null } as const;
