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
import { SIZE_FIELDS, type SizeField, type StockForm, type StockItem } from '../../../src/platform/stockClient';
import type { MachineRecord } from '../../../src/platform/locationClient';
import { CliExit, isCliExit } from './exit';

const SECTIONS = ['tools', 'stock', 'machines'] as const;
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
  'usage: casemaker location tools|stock|machines [--location <location.json|house.json>]';

/** The one-line header: which document this run resolved, and how it read it. */
function header(loaded: LoadedLocation | null): string {
  if (loaded === null) {
    return 'no location document — location.json and house.json are both absent; the built-in tiers are all this run has';
  }
  const what = loaded.kind === 'location' ? `location "${loaded.name}"` : 'house';
  return `${what}: ${loaded.path} — ${loaded.tools.length} tool${loaded.tools.length === 1 ? '' : 's'} ` +
    `from the user's own list, ${loaded.inventory.length} owned cutter${loaded.inventory.length === 1 ? '' : 's'}`;
}

function diameterOf(tool: { tipDiameter: number | null; diameter: number | null }): string {
  const d = tool.tipDiameter ?? tool.diameter;
  return d === null ? 'Ø?' : `Ø${d} mm`;
}

function toolLines(loaded: LoadedLocation): string[] {
  const lines: string[] = [];
  for (const entry of loaded.tools) {
    lines.push(
      `  tool       ${entry.key}  ${entry.tool.name}  ${diameterOf(entry.tool)}  ${entry.tool.shape}` +
        `  — ${entry.provenance}`,
    );
  }
  for (const item of loaded.inventory) {
    lines.push(
      `  owned      inv:${item.id}  ${item.tool.name}  ${diameterOf(item.tool)}  ${item.tool.shape}` +
        `  ×${item.quantity}`,
    );
  }
  if (lines.length === 0) lines.push('  (no tools or owned cutters in this document)');
  return lines;
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

function stockLines(loaded: LoadedLocation): string[] {
  if (loaded.stock.length === 0) return ['  (no stock on this document\'s shelf)'];
  return loaded.stock.map(
    (item) =>
      `  stock      ${item.id}  ${item.material}  ${item.form}  ${sizeOf(item)}  ${item.finish}` +
      `  ×${item.quantity}`,
  );
}

function machineLines(loaded: LoadedLocation): string[] {
  if (loaded.machines.length === 0) return ['  (no machines in this document)'];
  return loaded.machines.map((m: MachineRecord) => {
    const address = m.address === null ? 'no address' : `${m.address.host}:${m.address.port}`;
    return (
      `  machine    ${m.id}  ${m.profileId ?? 'no profile'}  ${m.name ?? 'unnamed'}  @${address}` +
      `  (updated ${m.updatedAt})`
    );
  });
}

/** The rendered lines for one section — pure, so a spec can check it without a document on disk. */
export function locationSectionLines(loaded: LoadedLocation | null, section: Section): string[] {
  if (loaded === null) return [header(null)];
  const lines = [header(loaded)];
  if (section === 'tools') lines.push(...toolLines(loaded));
  else if (section === 'stock') lines.push(...stockLines(loaded));
  else lines.push(...machineLines(loaded));
  return lines;
}

/** Run the command. Returns the process exit code; a refusal has already been printed. */
export async function locationMain(argv: string[]): Promise<number> {
  try {
    return await locationBody(argv);
  } catch (e) {
    if (isCliExit(e)) return e.code;
    throw e;
  }
}

async function locationBody(argv: string[]): Promise<number> {
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
  for (const line of locationSectionLines(loaded, args.section)) console.log(line);
  return 0;
}
