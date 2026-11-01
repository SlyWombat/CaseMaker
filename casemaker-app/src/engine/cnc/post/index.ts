/**
 * #845 — WHICH POST WRITES THIS MACHINE'S FILE. The machine's own `post` decides; absent is the
 * Z1's Smoothie dialect, so every machine and record written before the field existed posts
 * exactly as it did.
 *
 * The emitter is CHOSEN WITH THE MACHINE and returned bound to it (`postFor(mill)`), so the call
 * sites in the generator never test the machine's name or post themselves: `postFor(mill)(ir, ctx,
 * opts)` is the whole of it. Binding is also what lets the two posts keep their own machine types —
 * the Z1 post needs a framed profile's tool-change macro, the GRBL post needs only the stated
 * data — without a cast or a shared structural type that would let a frame-dependent field be read
 * off a machine that has none.
 */

import { workOriginOf, type MachineIdentity, type MachinePost, type Mill } from '../machine';
import type { ToolpathIR } from '../cam/ir';
import type { PostContext, PostOptions, PostResult } from './z1';
import { postZ1 } from './z1';
import { postGrbl } from './grbl';

/** One emitter, bound to its machine: the IR and its context in, the file's text (or refusals) out. */
export type PostEmitter = (ir: ToolpathIR, ctx: PostContext, opts?: PostOptions) => PostResult;

/** The post a machine's files are written by: its own `post`, else the Z1's. */
export function postKey(machine: Pick<MachineIdentity, 'post'>): MachinePost {
  return machine.post ?? 'z1';
}

/**
 * The PostContext origin a machine's files are written against. A framed profile is the Z1's
 * `topFrontLeft`; a stated machine writes its owner's own convention ({@link workOriginOf}), so
 * the header sentence and the coordinates cannot disagree about where X0 Y0 is.
 */
export function postOriginFor(machine: Mill): PostContext['origin'] {
  if (machine.frameState === 'read') return 'topFrontLeft';
  return workOriginOf(machine) === 'top-centre' ? 'topCentre' : 'topFrontLeft';
}

/**
 * The emitter for a machine, bound to it.
 *
 * A stated machine must name `post: 'grbl'`: it carries no frame, so the Z1 post's tool-change
 * macro would have no positions to write. A stated model with no post is refused by name rather
 * than dereferenced — it cannot post at all, and the throw is the guard behind the picker, which
 * only ever offers a stated machine that names its post.
 */
export function postFor(machine: Mill): PostEmitter {
  if (postKey(machine) === 'grbl') return (ir, ctx, opts) => postGrbl(ir, ctx, machine, opts);
  if (machine.frameState !== 'read') {
    throw new Error(`${machine.name} names no post and carries no frame: there is no file it could write`);
  }
  return (ir, ctx, opts) => postZ1(ir, ctx, machine, opts);
}
