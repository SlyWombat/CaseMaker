/**
 * The Simulate form's state (#196): the file, the stock and the tool the user confirms, kept
 * apart from the simulation's own state (`simStore`, which this never imports and never writes).
 *
 * `openFile` prefills from the `.nc` header — via `setupFromHeader`, which reads the UNTRUSTED
 * `;@MKR` records and only ever suggests. A user edit always wins: `setStock`/`setTool` flip that
 * field's `source` to `'user'`, and a reopened header never overwrites it (#315). `reset()` is the
 * only way back to the defaults, because it is the only explicit statement that the user wants them.
 *
 * "Never overwrites it" is per FIELD, not per file: opening while the tool is `'user'` keeps the
 * tool and takes the header's stock, and the other way round — a fresh file supplies whatever the
 * user has not claimed, and nothing they have.
 *
 * Keeping the user's cutter is not the same as hiding the file's (#338): when the two name
 * different registry entries, `headerDiagnostics` gains a warning naming both, so a sweep valid
 * for the 1 mm cutter is never silently shown against a file written for a 3.175 mm one.
 *
 * How well the file's TOOL record fits what it matched (#316) is `toolMatch` — the rule itself
 * lives in `engine/cnc/headerMatch.ts`, where a test can hand it a list and the store cannot. The
 * file's own `;@CM|TOOL|key=` line leads that rule (#332), and `statedToolKey` keeps what it says
 * even when the registry cannot resolve it, so the form can say WHICH cutter this house is missing
 * instead of quietly offering the closest one it has.
 *
 * Not persisted, and plain zustand — no immer needed.
 */

import { create } from 'zustand';
import { getTools, parseGcode, setupFromHeader, stubSetup, Z1 } from '@/engine/cnc';
import { matchHeaderTool, type MatchProvenance, type MatchStrength } from '@/engine/cnc/headerMatch';
import { toolFromMkrRecord } from '@/engine/cnc/tool';
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
  /**
   * How well the file's TOOL record fits the entry `toolKey` names (#316), when the header is what
   * supplied it: `exact` = every length the header states agrees with the entry, `suggested` =
   * shape and diameter only. Null when the user chose the cutter, or when nothing matched.
   */
  toolMatch: MatchStrength | null;
  /** Which rule answered — our key line (#332), the vendor `id=`, or shape and diameter (#316). */
  toolMatchProvenance: MatchProvenance | null;
  /**
   * The registry key the file itself named (`;@CM|TOOL|key=`, #332), or null when it names none —
   * a file from another house, or one posted before the line existed. Kept even when the registry
   * cannot resolve it: "this house does not have the cutter the file names" is a fact about the
   * file, and the panel says it rather than passing the shape match off as the answer.
   */
  statedToolKey: string | null;
  headerDiagnostics: SimHeaderDiagnostic[];
  /**
   * Parse the header and prefill every field the user has not already claimed; fields whose source
   * is `'user'` are kept (#315). `reset()` is the way back to the defaults.
   */
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
  toolMatch: null,
  toolMatchProvenance: null,
  statedToolKey: null,
  headerDiagnostics: [] as SimHeaderDiagnostic[],
};

/** `3.175*12mm Flat End(Metal) (flat-3.175x12-metal)` — the entry's name with its key, or the bare key. */
function describeTool(key: string): string {
  const entry = getTools().find((e) => e.key === key);
  return entry ? `${entry.tool.name} (${key})` : key;
}

export const useSimSetupStore = create<SimSetupState>()((set) => ({
  ...EMPTY,
  openFile(name, text) {
    const parsed = parseGcode(text);
    const fromHeader = setupFromHeader(parsed.header);

    // What THIS file says, before the user's own edits are laid over it.
    const headerStock: SimStock = { ...DEFAULT_STOCK };
    const headerSource = allDefault();
    const part = fromHeader.patch.part;
    if (part && part.kind === 'prism' && part.outline.kind === 'p-rect') {
      headerStock.length = part.outline.size[0];
      headerStock.width = part.outline.size[1];
      headerStock.thickness = part.thickness;
      headerSource.length = 'header';
      headerSource.width = 'header';
      headerSource.thickness = 'header';
    }

    // The file's TOOL record, matched against the registry list (#316) — see `headerMatch.ts` for
    // the order. A fit that leans on shape and diameter alone comes back `suggested`, and that
    // travels with the key so the panel can say which answer it is holding. The file's OWN key
    // (#332) leads the order, and is worth keeping whether or not the registry holds it. A file with
    // the key line and NO TOOL record (hand-edited, or a post that writes identity only) still
    // matches: step (0) needs no geometry, and `null` here is that file, not a missing answer.
    const statedKey = parsed.header?.cm?.tool?.key ?? null;
    const toolRecord = parsed.header?.records.find((r) => r.tag === 'TOOL');
    const headerMatch = matchHeaderTool(
      toolRecord ? toolFromMkrRecord(toolRecord) : null,
      getTools(),
      statedKey,
    );
    const headerToolKey = headerMatch?.key ?? null;

    set((s) => {
      // A field the user has claimed survives the open; every other field takes this file's value.
      // The rule is per FIELD, so opening a file after choosing a cutter keeps the cutter and still
      // brings the stock in — and the reverse. `reset()` is the only way back (#315).
      const stock = { ...s.stock };
      const stockSource = { ...s.stockSource };
      for (const field of ['length', 'width', 'thickness'] as const) {
        if (s.stockSource[field] === 'user') continue;
        stock[field] = headerStock[field];
        stockSource[field] = headerSource[field];
      }
      const keepTool = s.toolSource === 'user';
      const headerDiagnostics: SimHeaderDiagnostic[] = fromHeader.diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
      }));
      // The user's cutter wins, but a file that names a DIFFERENT one must say so (#338): the
      // sweep is about to be drawn for a cutter the file was not written for. A file naming the
      // same entry, or none the registry knows, adds nothing.
      if (keepTool && s.toolKey !== null && headerToolKey !== null && headerToolKey !== s.toolKey) {
        headerDiagnostics.push({
          severity: 'warning',
          message:
            `the file's TOOL record names ${describeTool(headerToolKey)}; your choice of ` +
            `${describeTool(s.toolKey)} was kept — Reset to take the file's`,
        });
      }
      return {
        fileName: name,
        gcodeText: text,
        stock,
        stockSource,
        toolKey: keepTool ? s.toolKey : headerToolKey,
        toolSource: keepTool ? 'user' : headerToolKey ? 'header' : null,
        // The match describes the tool the form will USE, so a cutter the user chose carries none.
        toolMatch: keepTool ? null : (headerMatch?.strength ?? null),
        toolMatchProvenance: keepTool ? null : (headerMatch?.provenance ?? null),
        // The file's own statement stands whatever the user does: it is what the file says, and
        // #338's warning about a disagreement is the other half of the same fact.
        statedToolKey: statedKey,
        headerDiagnostics,
      };
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
