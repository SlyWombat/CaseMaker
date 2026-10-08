/**
 * The Simulate form's state (#196): the file, the stock and the tool the user confirms, kept
 * apart from the simulation's own state (`simStore`, which this never imports and never writes).
 *
 * `openFile` prefills from the `.nc` header — via `setupFromHeader`, which reads the UNTRUSTED
 * `;@MKR` records and only ever suggests. A user edit always wins: `setStock`/`setTool` flip that
 * field's `source` to `'user'`, and a reopened header never overwrites it.
 *
 * Not persisted, and plain zustand — no immer needed.
 */

import { create } from 'zustand';
import { getTools, parseGcode, setupFromHeader, stubSetup, Z1 } from '@/engine/cnc';
import { toolFromMkrRecord, type Tool } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import type { Setup, StartingTool } from '@/engine/cnc';

/** Where a field's current value came from. */
export type FieldSource = 'header' | 'user' | 'default';

export interface SimStock {
  /** X, mm. */
  length: number;
  /** Y, mm. */
  width: number;
  /** Z, mm. */
  thickness: number;
}

export interface SimHeaderDiagnostic {
  severity: 'warning' | 'info';
  message: string;
}

export interface SimSetupState {
  fileName: string | null;
  gcodeText: string | null;
  stock: SimStock;
  stockSource: { length: FieldSource; width: FieldSource; thickness: FieldSource };
  /** A tool registry key (#305); null = "tool required". */
  toolKey: string | null;
  toolSource: FieldSource | null;
  headerDiagnostics: SimHeaderDiagnostic[];
  /** Parse the header, prefill, and reset everything the header does not supply. */
  openFile(name: string, text: string): void;
  /** Merge a stock edit and mark the edited fields `'user'`. */
  setStock(patch: Partial<SimStock>): void;
  setTool(key: string): void;
  reset(): void;
}

/** Default blank when the file states no stock (`/Simulation.md` §6): 100 x 100 x 10 mm. */
export const DEFAULT_STOCK: SimStock = { length: 100, width: 100, thickness: 10 };

const allDefault = (): SimSetupState['stockSource'] => ({ length: 'default', width: 'default', thickness: 'default' });

const EMPTY = {
  fileName: null,
  gcodeText: null,
  stock: { ...DEFAULT_STOCK },
  stockSource: allDefault(),
  toolKey: null,
  toolSource: null,
  headerDiagnostics: [] as SimHeaderDiagnostic[],
};

/** The file header's cutting diameter, using the same rule as `cuttingRadiusForSweep`. */
function cuttingDiameter(tool: Tool): number | null {
  return tool.tipDiameter ?? tool.diameter;
}

/**
 * The registry entry matching a header tool (#305). The header's `id=` is the catalogue's `g_ID`
 * (`/Makera-Parity.md` §3.2), so it is tried FIRST: shape + diameter alone ties for two 3.175 mm
 * flats and would pick whichever came first in the list. The id is what the file itself asserts
 * the cutter was — and a clone may not inherit it (#212), which is exactly why #309 has to add a
 * step above this one rather than below it.
 *
 * Falls back to shape + cutting diameter within 0.01 mm — the rule `cuttingRadiusForSweep` uses,
 * and the only one that can match a file written for a cutter no tier knows.
 *
 * #309 prepends one step: a Case Maker comment line naming our key, for a clone the post cannot
 * give a vendor `g_ID` to (design point 3).
 */
function matchRegistryTool(tool: Tool): string | null {
  const entries = getTools();
  if (tool.id !== null) {
    const byId = entries.find((e) => e.tool.id !== null && e.tool.id === tool.id);
    if (byId) return byId.key;
  }
  const d = cuttingDiameter(tool);
  if (d === null) return null;
  const entry = entries.find((e) => {
    if (e.tool.shape !== tool.shape) return false;
    const ed = cuttingDiameter(e.tool);
    return ed !== null && Math.abs(ed - d) <= 0.01;
  });
  return entry ? entry.key : null;
}

export const useSimSetupStore = create<SimSetupState>()((set) => ({
  ...EMPTY,
  openFile(name, text) {
    const parsed = parseGcode(text);
    const fromHeader = setupFromHeader(parsed.header);

    const stock: SimStock = { ...DEFAULT_STOCK };
    const stockSource = allDefault();
    const part = fromHeader.patch.part;
    if (part && part.kind === 'prism' && part.outline.kind === 'p-rect') {
      stock.length = part.outline.size[0];
      stock.width = part.outline.size[1];
      stock.thickness = part.thickness;
      stockSource.length = 'header';
      stockSource.width = 'header';
      stockSource.thickness = 'header';
    }

    const toolRecord = parsed.header?.records.find((r) => r.tag === 'TOOL');
    const toolKey = toolRecord ? matchRegistryTool(toolFromMkrRecord(toolRecord)) : null;

    set({
      fileName: name,
      gcodeText: text,
      stock,
      stockSource,
      toolKey,
      toolSource: toolKey ? 'header' : null,
      headerDiagnostics: fromHeader.diagnostics.map((d) => ({ severity: d.severity, message: d.message })),
    });
  },
  setStock(patch) {
    set((s) => {
      const stockSource = { ...s.stockSource };
      for (const key of Object.keys(patch) as (keyof SimStock)[]) {
        if (patch[key] !== undefined) stockSource[key] = 'user';
      }
      return { stock: { ...s.stock, ...patch }, stockSource };
    });
  },
  setTool(key) {
    set({ toolKey: key, toolSource: 'user' });
  },
  reset() {
    set({ ...EMPTY, stock: { ...DEFAULT_STOCK }, stockSource: allDefault() });
  },
}));

/**
 * The `Setup` a load runs with (#196 §4). A pure function so the test can assert it without a
 * store. `startingTool` is a UI choice only because a program cannot know the machine's starting
 * tool: the Z1's `M6`-to-the-already-active-tool is a no-op, so the first `T1 M6` is only
 * simulable if it is stated (`setup.ts`, `StartingTool`). It defaults to `'unknown'` — the same
 * value the `LED/ACRYLIC-Balloon.nc` session test uses.
 */
export function buildSimSetup(stock: SimStock, startingTool: StartingTool = 'unknown'): Setup {
  const outline = rectProfile(stock.length, stock.width);
  return stubSetup(
    { kind: 'prism', outline, thickness: stock.thickness },
    { kind: 'tape-down', contact: outline },
    { startingTool },
    Z1,
  );
}
