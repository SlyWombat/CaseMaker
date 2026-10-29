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
 * WHEN TWO TIERS MATCH EQUALLY, THIS STORE ASKS (#316). A file whose TOOL record answers as well
 * for an owned `inv:` row as for a `cat:` row does not name one of them, so `toolKey` stays null,
 * `toolCandidates` carries both and the panel puts the question to the person — a preselected
 * candidate would be a silent choice with an extra click. Their answer is applied as `'picked'`, a
 * source of its own, and remembered in `settingsStore.toolPicks` under the header's signature so
 * the same program does not ask twice and a reload does not re-ask. A remembered key is used only
 * while it is still among the rows that match that signature: that one check is what makes Forget
 * on the row and a catalogue sync clear it, with no subscription between the two stores.
 *
 * Not persisted, and plain zustand — no immer needed. (The PICKS are persisted; the form is not.)
 */

import { create } from 'zustand';
import { getTools, parseGcode, setupFromHeader, stubSetup, Z1 } from '@/engine/cnc';
import {
  headerSignature,
  matchHeaderTool,
  type MatchProvenance,
  type MatchStrength,
  type ToolMatchCandidate,
} from '@/engine/cnc/headerMatch';
import { toolFromMkrRecord } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import { defaultRotaryChuck } from '@/engine/cnc/engrave/setupFlow';
import { useSettingsStore } from './settingsStore';
import { shopDefault } from './shopDefaultsStore';
import type { Setup, StartingTool } from '@/engine/cnc';

/**
 * Where a field's current value came from. `'picked'` is the sim setup's own (#316): the file's TOOL
 * record matched rows in two tiers, so the person was asked, and this is the row they chose. It is
 * deliberately NOT `'user'` — a `'user'` claim wins over every file that follows (#315), which would
 * carry one program's answer onto another whose rows may differ. A pick is scoped to its signature.
 */
export type FieldSource = 'header' | 'user' | 'picked' | 'default';

export interface SimStock {
  /** X, mm. For a rod, its LENGTH along the axis. */
  length: number;
  /** Y, mm. For a rod, the box around it (width = thickness = diameter). */
  width: number;
  /** Z, mm. */
  thickness: number;
  /**
   * #761 — `'rod'` says ROUND stock in the rotary chuck, in the axis frame the CAM plans in:
   * `length` runs along X, and the box's width and thickness are the diameter. ABSENT is the
   * rectangle every non-rotary file gets — the same word the job schema uses (#240).
   */
  shape?: 'rod';
  /**
   * The rod's outer diameter, mm — present iff `shape` is `'rod'`. 0 means the file moves A but
   * states no radius, so the operator must give it before Simulate can build the setup.
   */
  diameter?: number;
}

export interface SimHeaderDiagnostic {
  severity: 'warning' | 'info';
  message: string;
}

export interface SimSetupState {
  fileName: string | null;
  gcodeText: string | null;
  /**
   * #726 W8 — WHEN this file was opened, ms. The Simulate panel compares it with the SIM session's
   * own start: a job loaded after a file was opened here is the newer statement and takes the panel.
   */
  openedAt: number | null;
  stock: SimStock;
  stockSource: {
    length: FieldSource;
    width: FieldSource;
    thickness: FieldSource;
    /** #761 — present only while the stock is a rod; absent for every prism. */
    shape?: FieldSource;
    diameter?: FieldSource;
  };
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
   * The rows that answer the file's TOOL record EQUALLY, when they come from two or more tiers
   * (#316). Non-null means the question is open: `toolKey` is null because no row is entitled to
   * win, and the panel asks rather than choosing. Null is the ordinary case — either one row
   * answered, or a remembered pick already did.
   */
  toolCandidates: ToolMatchCandidate[] | null;
  /**
   * The header's own identity in the match order (#316), as `headerSignature` reads it — what a
   * remembered pick is filed under, so it follows the program rather than the file name.
   */
  toolSignature: string | null;
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
  /**
   * Answer the open question (#316): the person chose between rows that matched equally. Applies
   * the row as `'picked'` and remembers it under this header's signature, so the same program does
   * not ask again.
   */
  pickTool(key: string): void;
  reset(): void;
}

/**
 * Default blank when the file states no stock (`/Simulation.md` §6): 100 x 100 x 10 mm. This is the
 * LABELLED no-service fallback for #451's three `sim.defaultStock*Mm` seeds; a session reads the
 * shop's values when the form opens, so a location that changed them is what the form starts with.
 */
export const DEFAULT_STOCK: SimStock = { length: 100, width: 100, thickness: 10 };

/** The blank a form starts with right now (#451): the shop's three seeds, or the fallbacks. */
function defaultStock(): SimStock {
  return {
    length: shopDefault('sim.defaultStockLengthMm').value,
    width: shopDefault('sim.defaultStockWidthMm').value,
    thickness: shopDefault('sim.defaultStockThicknessMm').value,
  };
}

const allDefault = (): SimSetupState['stockSource'] => ({ length: 'default', width: 'default', thickness: 'default' });

const EMPTY = {
  openedAt: null as number | null,
  fileName: null,
  gcodeText: null,
  stock: { ...DEFAULT_STOCK },
  stockSource: allDefault(),
  toolKey: null,
  toolSource: null,
  toolMatch: null,
  toolMatchProvenance: null,
  toolCandidates: null,
  toolSignature: null,
  statedToolKey: null,
  headerDiagnostics: [] as SimHeaderDiagnostic[],
};

/** `3.175*12mm Flat End(Metal) (flat-3.175x12-metal)` — the entry's name with its key, or the bare key. */
function describeTool(key: string): string {
  const entry = getTools().find((e) => e.key === key);
  return entry ? `${entry.tool.name} (${key})` : key;
}

/** The rows named in a sentence: `A or B`, `A, B or C`. */
function nameRows(keys: readonly string[]): string {
  const named = keys.map(describeTool);
  if (named.length <= 1) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`;
}

export const useSimSetupStore = create<SimSetupState>()((set, get) => ({
  ...EMPTY,
  // #451 — the form's own starting blank, read when this store is created (the fallbacks when the
  // location has not answered yet; a load after the answer reads them in `openFile`/`reset`).
  stock: defaultStock(),
  openFile(name, text) {
    set({ openedAt: Date.now() });
    const parsed = parseGcode(text);
    const fromHeader = setupFromHeader(parsed.header);
    // #761 — a file that moves A is rotary work: the form offers a ROD in the chuck instead of the
    // prism box. Our own post writes the radius (`;@CM|ROTARY|radius=`, kept by the parser); a
    // vendor file states none, so the diameter starts at 0 and the form asks for it.
    const usesRotary = parsed.summary.usesRotary;
    const statedRadius = parsed.header?.cm?.rotary?.radius ?? null;
    const headerRodDiameter = statedRadius !== null ? 2 * statedRadius : null;

    // What THIS file says, before the user's own edits are laid over it. With no header stock, the
    // blank is the shop's (#451), read here so a location that answered since this store loaded
    // still applies to the first file opened.
    const headerStock: SimStock = defaultStock();
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
    const headerTool = toolRecord ? toolFromMkrRecord(toolRecord) : null;
    const headerMatch = matchHeaderTool(headerTool, getTools(), statedKey);
    const headerToolKey = headerMatch?.key ?? null;
    const signature = headerSignature(headerTool, statedKey);

    // #316 — two tiers answered equally, so the match names both and nobody has picked yet. Nothing
    // is applied: `toolKey` stays null and the panel asks. A remembered pick answers it instead,
    // but ONLY if it is still one of the rows that match THIS signature today. That single test is
    // the whole of the clearing rule: Forget on the row and a catalogue sync both change what
    // `getTools()` holds, so the pick lapses with nothing to subscribe to — and it lapses rather
    // than being deleted, because a service that is merely unreachable refreshes the registry to
    // built-ins only (`toolRegistryStore`), and a self-cleaning map would then delete the user's
    // picks to punish a network hiccup.
    const candidates = headerMatch?.candidates ?? null;
    const remembered = signature === null ? undefined : useSettingsStore.getState().toolPicks[signature];
    const picked =
      candidates !== null && remembered !== undefined && candidates.some((c) => c.key === remembered)
        ? remembered
        : null;

    set((s) => {
      // A field the user has claimed survives the open; every other field takes this file's value.
      // The rule is per FIELD, so opening a file after choosing a cutter keeps the cutter and still
      // brings the stock in — and the reverse. `reset()` is the only way back (#315). A `'picked'`
      // claim is NOT one of these: it belongs to the signature it was made for, and this open has
      // just worked out whether it still answers (#316).
      const stock: SimStock = { ...s.stock };
      const stockSource = { ...s.stockSource };
      for (const field of ['length', 'width', 'thickness'] as const) {
        if (s.stockSource[field] === 'user') continue;
        stock[field] = headerStock[field];
        stockSource[field] = headerSource[field];
      }
      // #761 — the SHAPE follows the file: a program with an A word is round stock in the chuck,
      // and one without is the prism box. Only a user's own claim outranks it (the shape row is
      // not editable today, so in practice the file decides). The rod's box is its diameter.
      if (usesRotary && s.stockSource.shape !== 'user') {
        stock.shape = 'rod';
        stockSource.shape = 'header';
        if (s.stockSource.diameter !== 'user') {
          stock.diameter = headerRodDiameter ?? 0;
          stockSource.diameter = headerRodDiameter !== null ? 'header' : 'default';
          if (s.stockSource.width !== 'user') {
            stock.width = stock.diameter;
            stockSource.width = stockSource.diameter;
          }
          if (s.stockSource.thickness !== 'user') {
            stock.thickness = stock.diameter;
            stockSource.thickness = stockSource.diameter;
          }
        }
      } else if (!usesRotary && s.stockSource.shape !== 'user') {
        delete stock.shape;
        delete stockSource.shape;
        if (s.stockSource.diameter !== 'user') {
          delete stock.diameter;
          delete stockSource.diameter;
        }
      }
      const keepTool = s.toolSource === 'user';
      const headerDiagnostics: SimHeaderDiagnostic[] = fromHeader.diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
      }));
      // The user's cutter wins, but a file that names a DIFFERENT one must say so (#338): the
      // sweep is about to be drawn for a cutter the file was not written for. A file naming the
      // same entry, or none the registry knows, adds nothing.
      //
      // An AMBIGUOUS file is the one case that cannot be put this way (#316): there is no "the
      // file's cutter" to name, so the warning names the rows it matches instead. Silence here
      // would be worse than the extra sentence — the user would be holding a cutter chosen for a
      // previous program while the sweep is drawn with nothing saying the file disagrees.
      if (keepTool && s.toolKey !== null) {
        if (candidates !== null) {
          if (!candidates.some((c) => c.key === s.toolKey)) {
            headerDiagnostics.push({
              severity: 'warning',
              message:
                `the file's TOOL record matches ${nameRows(candidates.map((c) => c.key))}; your ` +
                `choice of ${describeTool(s.toolKey)} was kept — Reset to take one of the file's`,
            });
          }
        } else if (headerToolKey !== null && headerToolKey !== s.toolKey) {
          headerDiagnostics.push({
            severity: 'warning',
            message:
              `the file's TOOL record names ${describeTool(headerToolKey)}; your choice of ` +
              `${describeTool(s.toolKey)} was kept — Reset to take the file's`,
          });
        }
      }
      // What the form will USE, in the order it is known: a cutter the user claimed, then one they
      // PICKED for this signature, then the file's own best row — and nothing at all while the
      // question is still open, because a preselected candidate would be a silent choice (#316).
      const key = keepTool ? s.toolKey : (picked ?? (candidates === null ? headerToolKey : null));
      const source: FieldSource | null = keepTool
        ? 'user'
        : picked !== null
          ? 'picked'
          : candidates === null && headerToolKey !== null
            ? 'header'
            : null;
      return {
        fileName: name,
        gcodeText: text,
        stock,
        stockSource,
        toolKey: key,
        toolSource: source,
        // The match describes the tool the form will USE, so a cutter the user chose carries none.
        toolMatch: keepTool ? null : (headerMatch?.strength ?? null),
        toolMatchProvenance: keepTool ? null : (headerMatch?.provenance ?? null),
        // The open question, and the signature it is filed under — kept even while the user's own
        // cutter wins, because both are facts about the FILE.
        toolCandidates: keepTool ? null : picked !== null ? null : candidates,
        toolSignature: signature,
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
      const stock: SimStock = { ...s.stock, ...patch };
      // #761 — a rod's box is its diameter: editing the diameter carries width and thickness with
      // it, so the two representations of the same fact cannot disagree.
      if (stock.shape === 'rod' && patch.diameter !== undefined) {
        stock.width = patch.diameter;
        stock.thickness = patch.diameter;
        stockSource.width = 'user';
        stockSource.thickness = 'user';
      }
      return { stock, stockSource };
    });
  },
  setTool(key) {
    // The user's own claim on the cutter (#315), which outranks every file that follows. Answering
    // an open question is `pickTool`'s job and NOT this one's: a pick is scoped to its signature,
    // and stamping `'user'` here would carry it onto a different program (#316).
    set({ toolKey: key, toolSource: 'user', toolCandidates: null });
  },
  pickTool(key) {
    const { toolSignature: signature } = get();
    // Remembered first, so a failed write cannot leave the form answered but the memory empty. The
    // signature is only null for a file with no TOOL record and no key line — which cannot have
    // produced candidates, so this is unreachable in practice and cheap to state.
    if (signature !== null) useSettingsStore.getState().setToolPick(signature, key);
    set({ toolKey: key, toolSource: 'picked', toolCandidates: null });
  },
  reset() {
    set({ ...EMPTY, stock: defaultStock(), stockSource: allDefault() });
  },
}));

/**
 * #761 — the chuck facts a rod in the Simulate form is held by: the Holding step's own rule
 * (`defaultRotaryChuck`), fed the shop's grip, so the stick-out is the rod's length less it and the
 * tailstock is in. Shared by the setup builder and the panel's holding line, so the number the
 * operator reads is the number the sweep uses.
 */
export function rodChuckFor(stock: SimStock): ReturnType<typeof defaultRotaryChuck> {
  const diameter = stock.diameter ?? stock.width;
  return defaultRotaryChuck(
    {
      stock: {
        material: 'softwood',
        shape: 'cylinder',
        length: stock.length,
        width: diameter,
        thickness: diameter,
        diameter,
      },
    },
    shopDefault('rotary.gripMm').value,
  );
}

/**
 * The `Setup` a load runs with (#196 §4). A pure function so the test can assert it without a
 * store. `startingTool` is a UI choice only because a program cannot know the machine's starting
 * tool: the Z1's `M6`-to-the-already-active-tool is a no-op, so the first `T1 M6` is only
 * simulable if it is stated (`setup.ts`, `StartingTool`). It defaults to `'unknown'` — the same
 * value the `LED/ACRYLIC-Balloon.nc` session test uses.
 */
export function buildSimSetup(stock: SimStock, startingTool: StartingTool = 'unknown'): Setup {
  // #761 — a rotary file's stock is a rod in the chuck: a cylinder part and the Holding step's own
  // chuck facts (the shop's grip, so the stick-out is the rod's length less the grip). The column
  // engine and the exact sweeper both place a cylinder's work origin on the axis.
  if (stock.shape === 'rod') {
    const diameter = stock.diameter ?? stock.width;
    if (!(diameter > 0)) throw new Error('a rod needs a diameter above 0 mm');
    const chuck = rodChuckFor(stock);
    return stubSetup(
      { kind: 'cylinder', diameter, length: stock.length },
      { kind: 'rotary-chuck', jawDiameter: chuck.gripDiameter ?? diameter, stickout: chuck.stickout },
      { startingTool },
      Z1,
    );
  }
  const outline = rectProfile(stock.length, stock.width);
  return stubSetup(
    { kind: 'prism', outline, thickness: stock.thickness },
    { kind: 'tape-down', contact: outline },
    { startingTool },
    Z1,
  );
}
