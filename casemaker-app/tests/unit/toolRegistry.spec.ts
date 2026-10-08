// The tool registry (#305, tracking #212): ONE module that answers "which tool is this key?".
//
// The whole point of the issue is the case where NO tier above the built-ins is loaded — V1, and
// the acceptance line names it: a job naming `flat-1.0` or `flat-3.175x12-metal` must resolve with
// an empty registry. So the first thing these tests pin is that an empty registry is not "no
// tools": the built-ins are a permanent tier, and `setRegistry([])` returns to them rather than
// clearing them.
//
// Pure: no wasm, no React, no worker. The module holds one snapshot, so every test puts it back.

import { describe, it, expect, afterEach } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  entryFor,
  getTools,
  resetRegistry,
  resolveTool,
  setRegistry,
  subscribeRegistry,
  toolForIn,
  toolForJob,
} from '@/engine/cnc/toolRegistry';

afterEach(() => resetRegistry());

/** A stand-in for a later tier's row (a Studio catalogue clone, a user's own cutter). */
function entry(key: string, opts: Parameters<typeof flatEndMill>[1] = {}): ToolLibraryEntry {
  return { key, tool: flatEndMill(2, { name: key, ...opts }), provenance: 'test' };
}

/** Library order, asserted rather than derived: renaming a builtin key is a loud change. */
const BUILTIN_KEYS = ['flat-3.175x12-metal', 'flat-1.0'];

describe('the builtins are permanent (#305)', () => {
  it('resolves both builtin keys with no registry at all', () => {
    // The acceptance line, as written.
    expect(resolveTool('flat-1.0')).not.toBeNull();
    expect(resolveTool('flat-3.175x12-metal')).not.toBeNull();
  });

  it('treats an empty registry as "no service yet", not "no tools"', () => {
    setRegistry([]);
    expect(resolveTool('flat-1.0')).not.toBeNull();
    expect(resolveTool('flat-3.175x12-metal')).not.toBeNull();
    // And the list a picker lists is the same object the default was — `setRegistry([])` restores
    // `TOOL_LIBRARY`, so the default is one identity and not a copy of it.
    expect(getTools()).toBe(TOOL_LIBRARY);
  });

  it('keeps the builtins first, and cannot be talked out of them by a later tier', () => {
    setRegistry([entry('user:mine'), entry('flat-1.0')]);
    const keys = getTools().map((e) => e.key);
    expect(keys.slice(0, TOOL_LIBRARY.length)).toEqual(BUILTIN_KEYS);
    // The later tier's own `flat-1.0` is a separate row (keys are namespaced), and the key
    // resolves to the BUILTIN — `find` stops at the first match.
    expect(entryFor('flat-1.0')?.provenance).toBe(TOOL_LIBRARY[1]!.provenance);
  });

  it('returns the same array between calls, so useSyncExternalStore cannot loop', () => {
    const a = getTools();
    expect(getTools()).toBe(a);
    setRegistry([entry('user:mine')]);
    const b = getTools();
    expect(getTools()).toBe(b);
    expect(b).not.toBe(a); // a real change does swap the snapshot
  });
});

describe('setRegistry / subscribeRegistry', () => {
  it('notifies on every replacement, including back to empty', () => {
    let calls = 0;
    const off = subscribeRegistry(() => (calls += 1));
    setRegistry([entry('user:mine')]);
    expect(calls).toBe(1);
    setRegistry([]);
    expect(calls).toBe(2);
    off();
    setRegistry([entry('user:other')]);
    expect(calls).toBe(2); // unsubscribed
  });

  it('finds a later tier by key', () => {
    setRegistry([entry('cat:112111313812', { name: '3.175*12mm Flat End(Metal)' })]);
    expect(resolveTool('cat:112111313812')?.name).toBe('3.175*12mm Flat End(Metal)');
    expect(resolveTool('cat:nope')).toBeNull();
  });
});

describe('the resolved tool is a copy', () => {
  it('cannot be edited through the resolver', () => {
    const t = resolveTool('flat-1.0')!;
    t.diameter = 99;
    t.name = 'mutated';
    expect(entryFor('flat-1.0')?.tool.diameter).toBe(1);
    expect(entryFor('flat-1.0')?.tool.name).not.toBe('mutated');
  });
});

describe('toolForJob — snapshot, then registry, then null (#305 design point 2)', () => {
  it('prefers the job snapshot over the registry entry with the same key', () => {
    // A cutter re-collared and re-measured after the job was written must not re-prove the job at
    // a new stick-out: the snapshot is what the job was generated against.
    setRegistry([entry('cat:WIDGET', { stickout: 2 })]);
    const job = { toolKey: 'cat:WIDGET', tool: flatEndMill(2, { name: 'as written', stickout: 17 }) };
    expect(toolForJob(job, getTools())?.name).toBe('as written');
    expect(toolForJob(job, getTools())?.stickout).toBe(17);
  });

  it('falls back to the key when the job carries no snapshot', () => {
    expect(toolForJob({ toolKey: 'flat-1.0' }, getTools())?.name).toMatch(/flat end/);
    // A pre-#305 document parses with no `tool` field at all, and one with an explicit `null` is
    // the same statement — neither is a snapshot.
    expect(toolForJob({ toolKey: 'flat-1.0', tool: null }, getTools())).not.toBeNull();
  });

  it('is null for a key nothing names — the registry is not a guess', () => {
    expect(toolForJob({ toolKey: 'cat:absent' }, getTools())).toBeNull();
  });

  it('is pure: it resolves against the list handed in, not the module state', () => {
    // This is the worker's path — the list crosses the Comlink boundary as plain data.
    const handed = [entry('cat:WIDGET', { name: 'handed over' })];
    expect(toolForJob({ toolKey: 'cat:WIDGET' }, handed)?.name).toBe('handed over');
    // The same key does NOT resolve against the module's own snapshot, which never saw it.
    expect(toolForJob({ toolKey: 'cat:WIDGET' }, getTools())).toBeNull();
    expect(toolForIn(handed, 'cat:WIDGET')?.name).toBe('handed over');
    expect(toolForIn(handed, 'flat-1.0')).toBeNull(); // the worker gets exactly what it was sent
  });

  it('snapshots a copy too, so a consumer cannot edit the job', () => {
    const writ = flatEndMill(2, { name: 'as written' });
    const got = toolForJob({ toolKey: 'flat-1.0', tool: writ }, getTools())!;
    got.name = 'mutated';
    expect(writ.name).toBe('as written');
  });
});
