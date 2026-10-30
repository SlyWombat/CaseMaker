/**
 * `casemaker location tools|stock|machines|accessories` (#477) — read the machine's own resolved document.
 *
 * "Resolved" is the bootstrap's rule, not a second one: an explicit `--location <file>`, else
 * `location.json`, else `house.json` (#412), else none. `loadLocation` parses and validates the same
 * document the app would accept; this command only renders the requested section.
 *
 * No hardware is read and nothing is written by a READ: these are the records the user put in the
 * document, exactly as they stand.
 *
 * #560 — `import-catalogue <file>` is the one write here. A catalogue sync reads Makera Studio's own
 * library, which a headless house does not have; this takes the `catalogue.json` a Studio machine
 * synced, validates its text through {@link parseCatalogueDocument} — the very reader `loadCatalogue`
 * uses, so a file this imports is one the app would have accepted — and writes it as the
 * `catalogue.json` beside the house's document, where both the app and the Rust house read it. It
 * is a CLI rather than a house-service endpoint because the catalogue is a file OF the house
 * directory, not an API resource: the service's `/catalogue/sync` deliberately takes no arguments
 * and reads Studio's database from its own disk, and an upload endpoint would put a second
 * validator (and a second set of rules) in Rust. A remote house runs the same command on itself.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CatalogueDocumentError,
  defaultCataloguePath,
  loadLocation,
  LocationDocumentError,
  parseCatalogueDocument,
  type LoadedCatalogue,
  type LoadedLocation,
} from '../../../src/platform/headless/bootstrap';
import { RECEIPT_VERSION, renderReceipt, type Receipt } from '../../../src/platform/headless/receipt';
import { SIZE_FIELDS, type SizeField, type StockForm, type StockItem } from '../../../src/platform/stockClient';
import type { MachineRecord } from '../../../src/platform/locationClient';
import { CliExit, isCliExit } from './exit';
import { commandOutput, HUMAN, type CommandOptions } from './output';
import { fileReceipt } from './receiptFiles';

const SECTIONS = ['tools', 'stock', 'machines', 'accessories'] as const;
type Section = (typeof SECTIONS)[number];

/** #560 — the one section that writes instead of reading. */
const IMPORT_SECTION = 'import-catalogue';
type CommandSection = Section | typeof IMPORT_SECTION;

interface Args {
  section?: CommandSection;
  location?: string;
  /** The catalogue to import — `import-catalogue` only. */
  catalogue?: string;
}

function parseArgs(argv: string[]): Args {
  let section: CommandSection | undefined;
  let location: string | undefined;
  let catalogue: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--location') location = argv[++i];
    else if (a !== undefined && a.startsWith('--')) throw new Error(`unknown flag "${a}"`);
    else if (section === undefined) {
      if (a === IMPORT_SECTION) section = IMPORT_SECTION;
      else if ((SECTIONS as readonly string[]).includes(a ?? '')) section = a as Section;
      else {
        throw new Error(`"${a}" is not a location section — one of ${[...SECTIONS, IMPORT_SECTION].join(', ')}`);
      }
    } else if (section === IMPORT_SECTION && catalogue === undefined) catalogue = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return { section, location, catalogue };
}

function fail(message: string): never {
  console.error(`casemaker location: ${message}`);
  throw new CliExit(1);
}

const USAGE = [
  'usage: casemaker location tools|stock|machines|accessories [--location <location.json|house.json>]',
  '       casemaker location import-catalogue <catalogue.json> [--location <house document>]',
].join('\n');

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

/**
 * #560 — the import as the group's receipt: the file read, the `catalogue.json` written, the counts,
 * and the `syncedAt` the document states (null when it states none — the import still lands, because
 * a valid catalogue without a date is still a valid catalogue).
 */
export function catalogueImportReceipt(
  loaded: LoadedCatalogue,
  source: string,
  destination: string,
  replaced: boolean,
): LocationReceipt {
  return {
    version: RECEIPT_VERSION,
    command: 'location',
    ok: true,
    stage: IMPORT_SECTION,
    gate: null,
    inputs: [fileReceipt(source)],
    outputs: [fileReceipt(destination)],
    diagnostics: [],
    provenance: [],
    refusals: [],
    details: {
      section: IMPORT_SECTION,
      document: null,
      records: [],
      catalogue: {
        source,
        destination,
        tools: loaded.tools.length,
        feeds: loaded.rows.length,
        syncedAt: loaded.syncedOn,
        replaced,
      },
    },
  };
}

/** Where the catalogue belongs: beside the named house document, else the app's data directory. */
function catalogueDestination(document: string | undefined): string | null {
  if (document !== undefined) return join(dirname(document), 'catalogue.json');
  return defaultCataloguePath();
}

/**
 * Write beside the destination and rename over it, so a crash or a full disk leaves the previous
 * catalogue whole rather than a half-written one — the Rust service's `write_atomic` rule (#321).
 */
function writeAtomically(destination: string, text: string): void {
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, destination);
  } catch (e) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The write failure is the one to report; a stray temp file is not worth hiding it for.
    }
    throw e;
  }
}

/**
 * `location import-catalogue <file>` (#560). Validate the text with the app's own reader, then write
 * those exact bytes where the house reads them. A malformed file is refused by name and nothing is
 * written; a valid one is imported, and the receipt states the date the file says it was synced.
 */
function importCatalogue(args: Args, options: CommandOptions): number {
  const source = args.catalogue;
  if (source === undefined) fail(`import-catalogue needs the synced catalogue file\n${USAGE}`);

  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (e) {
    fail(`could not read the catalogue at ${source}: ${(e as Error).message}`);
  }
  let loaded: LoadedCatalogue;
  try {
    // The SAME bytes that are written below: the validation is not of a file read a moment before.
    loaded = parseCatalogueDocument(raw, source);
  } catch (e) {
    if (e instanceof CatalogueDocumentError) fail(e.message);
    throw e;
  }

  const destination = catalogueDestination(args.location);
  if (destination === null) {
    fail(
      'this platform has no data directory, so there is no house directory to write into — ' +
        'pass --location <file> to name the house document the catalogue belongs beside',
    );
  }
  const replaced = existsSync(destination);
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeAtomically(destination, raw);
  } catch (e) {
    fail(`could not write ${destination}: ${(e as Error).message}`);
  }
  commandOutput(options).emitReceipt(catalogueImportReceipt(loaded, source, destination, replaced));
  return 0;
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
  if (args.section === IMPORT_SECTION) return importCatalogue(args, options);

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
