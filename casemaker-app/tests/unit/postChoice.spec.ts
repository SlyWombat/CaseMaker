/**
 * #845 — WHICH POST WRITES A MACHINE'S FILE. The machine's `post` decides; absent is the Z1's
 * Smoothie dialect, so nothing written before the field existed changes.
 */
import { describe, expect, it } from 'vitest';

import { postFor, postKey } from '@/engine/cnc/post';
import { postZ1 } from '@/engine/cnc/post/z1';
import { postGrbl } from '@/engine/cnc/post/grbl';

describe('#845 the post a machine is written by', () => {
  it('is the Z1 post when the machine states no post, and for post: z1', () => {
    expect(postKey({})).toBe('z1');
    expect(postFor({})).toBe(postZ1);
    expect(postFor({ post: 'z1' })).toBe(postZ1);
  });

  it('is the GRBL post when the machine states it', () => {
    expect(postKey({ post: 'grbl' })).toBe('grbl');
    expect(postFor({ post: 'grbl' })).toBe(postGrbl);
  });
});
