/**
 * `casemaker location tools|stock|machines` (#477) — read the machine's own resolved document.
 *
 * "Resolved" is the bootstrap's rule, not a second one: an explicit `--location <file>`, else
 * `location.json`, else `house.json` (#412), else none. `loadLocation` parses and validates the same
 * document the app would accept; this command only renders the requested section.
 *
 * No hardware is read and nothing is written: these are the records the user put in the document,
 * exactly as they stand.
 */
import { loadLocation, LocationDocumentError, type LoadedLocation } from '../../../src/platform/headless/bootstrap';
import { RECEIPT_VERSION, renderReceipt, type Receipt } from '../../../src/platform/headless/receipt';
import { SIZE_FIELDS, type SizeField, type StockForm, type StockItem } from '../../../src/platform/stockClient';
import type { MachineRecord } from '../../../src/platform/locationClient';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';

const SECTIONS = ['tools', 'stock', 'machines', 'accessories'] as const;
type Section = (typeof SECTIONS)[number];

interface Args {
  section?: Section;
  location?: string;
}

function parseArgs(argv: string[]): Args {
  let section: Section | undefined;
  let location: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--location') location = argv[++i];
    else if (a !== undefined && a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (section === undefined) {
      if (!(SECTIONS as readonly string[]).includes(a ?? '')) {
        throw new Error(`"${a}" is not a location section — one of ${SECTIONS.join(', ')}`);
      }
      section = a as Section;
    } else throw new Error(`unexpected argument "${a}"`);
  }
  return { section, location };
}

function fail(message: string): never {
  console.error(`casemaker location: ${message}`);
  throw new CliExit(1);
}

const USAGE =
  'usage: casemaker location tools|stock|machines|accessories [--location <location.json|house.json>]';

type LocationReceipt = Extract<Receipt, { command: 'location' }>;
type LocationRecord = LocationReceipt['details']['records'][number];

function diameterOf(tool: { tipDiameter: number | null; diameter: number | null }): string {
  const d = tool.tipDiameter ?? tool.diameter;
  return d === null ? 'Ø?' : `Ø${d} mm`;
}

function toolRecords(loaded: LoadedLocation): LocationRecord[] {
  const records: LocationRecord[] = [];
  for (const entry of loaded.tools) {
    records.push({
      label: 'tool',
      fields: [entry.key, entry.tool.name, diameterOf(entry.tool), entry.tool.shape, `— ${entry.provenance}`],
    });
  }
  for (const item of loaded.inventory) {
    records.push({
      label: 'owned',
      fields: [`inv:${item.id}`, item.tool.name, diameterOf(item.tool), item.tool.shape, `×${item.quantity}`],
    });
  }
  return records;
}

/** `100 × 100 × 5 mm`, in the form's own field order. */
function sizeOf(item: StockItem): string {
  const form = item.form as StockForm;
  const fields: readonly SizeField[] = SIZE_FIELDS[form] ?? ['length', 'width', 'thickness'];
  const parts = fields
    .map((f) => item.size[f])
    .filter((v): v is number => v !== null && v !== undefined)
    .map((v) => String(v));
  return parts.length === 0 ? 'size not stated' : `${parts.join(' × ')} mm`;
}

function stockRecords(loaded: LoadedLocation): LocationRecord[] {
  return loaded.stock.map((item) => ({
    label: 'stock',
    fields: [item.id, item.material, item.form, sizeOf(item), item.finish, `×${item.quantity}`],
  }));
}

function machineRecords(loaded: LoadedLocation): LocationRecord[] {
  return loaded.machines.map((m: MachineRecord) => {
    const address = m.address === null ? 'no address' : `${m.address.host}:${m.address.port}`;
    return {
      label: 'machine',
      fields: [m.id, m.profileId ?? 'no profile', m.name ?? 'unnamed', `@${address}`, `(updated ${m.updatedAt})`],
    };
  });
}

/** #605 — the accessories the location owns, each with where it is right now. */
function accessoryRecords(loaded: LoadedLocation): LocationRecord[] {
  return loaded.accessories.map((a) => ({
    label: 'accessory',
    fields: [
      a.id,
      a.kind,
      a.product ?? 'unnamed',
      a.variant ?? '',
      a.whereabouts.kind === 'box' ? 'in its box' : `on ${a.whereabouts.machineId}`,
    ],
  }));
}

/** The whole read as a receipt (#478): the document resolved, and the section's records. */
export function locationReceipt(loaded: LoadedLocation | null, section: Section): LocationReceipt {
  return {
    version: RECEIPT_VERSION,
    command: 'location',
    ok: true,
    stage: 'read',
    gate: null,
    inputs: [],
    outputs: [],
    diagnostics: [],
    provenance: [],
    refusals: [],
    details: {
      section,
      document:
        loaded === null
          ? null
          : {
              kind: loaded.kind,
              // A house document has no name of its own; the renderer prints the literal `house`.
              name: loaded.kind === 'location' ? (loaded.name ?? 'unnamed location') : 'house',
              path: loaded.path,
              tools: loaded.tools.length,
              inventory: loaded.inventory.length,
            },
      records:
        loaded === null
          ? []
          : section === 'tools'
            ? toolRecords(loaded)
            : section === 'stock'
              ? stockRecords(loaded)
              : section === 'accessories'
                ? accessoryRecords(loaded)
                : machineRecords(loaded),
    },
  };
}

/** The rendered lines for one section — pure, so a spec can check it without a document on disk. */
export function locationSectionLines(loaded: LoadedLocation | null, section: Section): string[] {
  return renderReceipt(locationReceipt(loaded, section));
}

/** Run the command. Returns the process exit code; a refusal has already been printed. */
export async function locationMain(argv: string[], options: CommandOptions = HUMAN): Promise<number> {
  try {
    return await locationBody(argv, options);
  } catch (e) {
    if (isCliExit(e)) return e.code;
    throw e;
  }
}

async function locationBody(argv: string[], options: CommandOptions): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
    throw e; // unreachable; `fail` throws
  }
  if (args.section === undefined) fail(USAGE);

  let loaded: LoadedLocation | null;
  try {
    loaded = loadLocation(args.location);
  } catch (e) {
    if (e instanceof LocationDocumentError) fail(e.message);
    throw e;
  }
  commandOutput(options).emitReceipt(locationReceipt(loaded, args.section));
  return 0;
}
