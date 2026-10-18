// #454 — the two failure modes the issue names, end to end through the rule that picks the cutter.
//
// `toolCondition.spec.ts` pins the linkage itself: which copies a built-in or catalogue key adopts,
// and the note that says whose copies they are. This file pins what the bench then sees. A broken
// owned cutter must not leave the identical built-in looking fresh, and a worn one must not lose a
// tie to the built-in in silence — in both cases the pick or the table has to carry the caution.
//
// Pure, like the modules under test: the measurement is a stub, so no wasm is needed.

import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { reachabilityFor, reachTable } from '@/engine/cnc/engrave/reachability';
import { recommendTool, type ToolCandidate } from '@/engine/cnc/engrave/recommendTool';
import { flatEndMill } from '@/engine/cnc/tool';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  inventoryConditions,
  resetInventoryConditions,
  setInventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';
import { inventoryKey } from '@/engine/cnc/toolRegistry';
import type { LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

const BUILTIN_1MM = TOOL_LIBRARY.find((e) => e.key === 'flat-1.0')!;
const BUILTIN_31 = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal')!;

/** One described copy, in its box. */
function copy(id: string, condition: ToolCopy['condition']): ToolCopy {
  return { id, condition, whereabouts: { kind: 'box' }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null };
}

/** An owned cutter's registry entry, the way the inventory pushes it. */
function ownedEntry(key: string, tool: ToolLibraryEntry['tool']): ToolLibraryEntry {
  return { key, tool, provenance: 'the inventory' };
}

/** One labelled job; the rule under test reads only text, size, depth and enabled. */
function jobWithLabel(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [
    {
      id: 'l1',
      text: 'CASE',
      font: 'sans-default',
      weight: 'bold',
      size: 8,
      position: { x: 20, y: 30 },
      rotation: 0,
      depth: 1,
      enabled: true,
    },
  ];
  return job;
}

/** Every cutter keeps the whole item, so the size rule is the only one that decides. */
function allRows(): LabelEngravability[] {
  return [{ labelId: 'l1', glyphArea: 1, openedArea: 1, ratio: 1, emptyChars: [], outsideArea: 0, polygons: [] }];
}

function candidate(rec: { candidates: ToolCandidate[] }, key: string): ToolCandidate {
  const found = rec.candidates.find((c) => c.key === key);
  if (!found) throw new Error(`no candidate ${key}`);
  return found;
}

afterEach(resetInventoryConditions);

describe('#454 the condition follows the physical cutter', () => {
  it('does not fall back to the identical built-in when the only owned 1 mm cutter is broken', () => {
    const ownedOne = flatEndMill(1, { name: '1 mm flat end' });
    setInventoryConditions(
      [{ id: 'only', quantity: 1, copies: [copy('only-1', 'broken')], tool: ownedOne }],
      inventoryKey,
      [BUILTIN_1MM],
    );

    const tools = [BUILTIN_1MM, ownedEntry('inv:only', ownedOne)];
    const rec = recommendTool(jobWithLabel(), tools, [], allRows, inventoryConditions());

    // The built-in is the same physical cutter, so it is out by the same operator statement — there
    // is no silent fresh fallback, and the no-pick sentence says a cutter is marked broken.
    expect(candidate(rec, 'flat-1.0').excluded).toBe('broken');
    expect(candidate(rec, 'inv:only').excluded).toBe('broken');
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('marked broken');

    // The engine-side wording of the "Why?" list, as `reachTable` prints it. The panel's own
    // "every copy is marked broken (the shop's copies)" / "· worn (the shop's copies)" text is
    // pinned by `engraveRecommendationNotes.spec.tsx` (#458).
    const table = reachTable(reachabilityFor(jobWithLabel(), tools, [], allRows, inventoryConditions()));
    expect(table.find((r) => r.key === 'flat-1.0')!.excluded).toBe('every copy of it is marked broken');
  });

  it('keeps the worn owned 3.175 mm cutter’s caution when it ties with the built-in', () => {
    const ownedWide = flatEndMill(3.175, { name: '3.175 mm flat end (Metal)', shoulderLength: 12 });
    setInventoryConditions(
      [{ id: 'worn', quantity: 1, copies: [copy('worn-1', 'worn')], tool: ownedWide }],
      inventoryKey,
      [BUILTIN_31],
    );

    const tools = [BUILTIN_31, ownedEntry('inv:worn', ownedWide)];
    const rec = recommendTool(jobWithLabel(), tools, [], allRows, inventoryConditions());

    // Both entries rank as worn, so the pick goes to the key order; what must not happen is the
    // built-in standing in as an untested cutter. Its summary names the shop's own copies, and
    // whichever key wins the tie the recommendation carries the caution.
    expect(candidate(rec, 'flat-3.175x12-metal').condition!.best).toBe('worn');
    expect(candidate(rec, 'flat-3.175x12-metal').condition!.note).toContain('shop’s own copies');
    expect(candidate(rec, 'inv:worn').condition!.best).toBe('worn');
    expect(rec.conditionNote).toContain('marked worn');
  });
});
