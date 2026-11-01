/**
 * #845 — WHICH POST WRITES THIS MACHINE'S FILE. The machine's own `post` decides; absent is the
 * Z1's Smoothie dialect, so every machine and record written before the field existed posts
 * exactly as it did.
 *
 * The posts share one signature (`ir, ctx, machine, opts → PostResult`), so the call sites in the
 * generator choose an EMITTER here and never test the machine's name or dialect themselves.
 */

import type { MachineIdentity, MachinePost, MillProfile } from '../machine';
import type { ToolpathIR } from '../cam/ir';
import type { PostContext, PostOptions, PostResult } from './z1';
import { postZ1 } from './z1';
import { postGrbl } from './grbl';

/** One emitter: the IR and its context in, the file's text (or refusals) out. */
export type PostEmitter = (
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  opts?: PostOptions,
) => PostResult;

/** The post a machine's files are written by: its own `post`, else the Z1's. */
export function postKey(machine: Pick<MachineIdentity, 'post'>): MachinePost {
  return machine.post ?? 'z1';
}

/** The emitter for a machine's post. */
export function postFor(machine: Pick<MachineIdentity, 'post'>): PostEmitter {
  return postKey(machine) === 'grbl' ? postGrbl : postZ1;
}
