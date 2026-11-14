// #1175 — THE HOUSE PATH PLANS WITH THE BROWSER'S OWN INPUTS, and the whole package is identical.
//
// The browser's Generate hands its worker ten arguments (`engraveRunStore.ts`, the Generate call).
// Two of them are not in the job document: the ideal plan's candidate set — the app's whole tool
// library, `getTools().map((entry) => entry.tool)` — and the run sheet's ladder press (#1046).
// The house path reaches the same engine as `casemaker cut`, and #1126's wrapper used to drop
// both. This spec drives the SAME job through both doors with the same location, catalogue, tool
// list and ladder choice, and compares the FULL package byte for byte: every program and every
// frame the job posts.
//
// THE JOB IS THE BENCH'S m1trayF-banded2 — two setups, the tray mesh embedded in the document
// itself (the goal STLs are base64 inside, so the .cutjob.json is self-contained). It is NOT
// committed (it names a licensed Makera tray), so the case reads it from CM_1175_TRAY_JOB and
// skips with that reason where the file is absent. On k3 the gate exports the path.
//
// THE LOCATION AND CATALOGUE are the committed bench pair `pipelineIdentity.spec.ts` uses: the
// fixture location with the house's 29 `kz-` cutters in its inventory, and the Makera catalogue
// written beside it — the same file the CLI reads as the location's sibling.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { bootstrap, loadCatalogue } from '@/platform/headless/bootstrap';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { setLocatedFeedTable } from '@/engine/cnc/feeds';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { getTools, resetRegistry } from '@/engine/cnc/toolRegistry';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { engraveJobMain, programFileNames } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCATION_FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const HOUSE = join(HERE, 'fixtures', 'ball863', 'house-cutters.json');

/** The bench job, beside the licensed tray mesh it embeds. Absent on a machine without it. */
const TRAY_JOB = process.env.CM_1175_TRAY_JOB ?? '';
const HAVE_TRAY = TRAY_JOB !== '' && existsSync(TRAY_JOB);
const SKIP = HAVE_TRAY
  ? false
  : 'CM_1175_TRAY_JOB is not set (or names no file) — the m1trayF-banded2 job is the house’s, not the repo’s';

/**
 * The package the bench job posts, as MEASURED on 2026-11-10 through the browser door (with the
 * ladder on) against the committed bench pair: 17 programs (16 before #1251's band-driven ⌀2 rest, see EXPECTED_PROGRAMS). The analyst's list said 17 with a
 * p09 frame — that is the LIVE house location/catalogue's package; different inputs post a
 * different package (the Manager's ruling). The comparison still covers every program and every
 * frame THIS package carries, and the frame names are printed for the record.
 */
// #1251 — 16 -> 17. The stamp's edge band changes the chain's pick on this tray the way it does on the
// tray top (8 -> 9): a NEW ⌀2 x 8 O-flute REST (inv:kz-o-flute-m-2-8, program 4, seven ops: pocket-6 ..
// pocket-11) now comes before the ⌀1.5 x 6 rest, which does 14 ops (519 s) where it did 21 (887 s).
// The job's priced cycle FALLS, 12,032 s -> 11,951 s (cutting +39 s, bit changes -121 s); both doors
// post the same 17 programs byte for byte. (This job's CLI receipt carries no goal block, so its end
// state is not measured here; the same pick on the tray top is no worse.)
const EXPECTED_PROGRAMS = 17;

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-house-1175-'));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  resetRegistry();
});

interface HouseFixture {
  inventory: { key: string; tool: unknown }[];
  catalogue: unknown[];
  feeds: unknown[];
}

const house = JSON.parse(readFileSync(HOUSE, 'utf8')) as HouseFixture;

let locationPath: string | null = null;

/**
 * The bench's location: the committed fixture document with the house's cutters in its inventory,
 * and the Makera catalogue the same location served, written beside it as `catalogue.json` — the
 * file the CLI reads as the location's sibling (the same setup `pipelineIdentity.spec.ts` uses).
 */
function benchLocation(): string {
  if (locationPath !== null) return locationPath;
  const doc = JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as { inventory: unknown[] };
  for (const item of house.inventory) {
    doc.inventory.push({
      id: item.key.replace(/^inv:/, ''),
      tool: item.tool,
      origin: null,
      quantity: 1,
      codes: [],
      addedAt: '2026-11-01T00:00:00.000Z',
      notes: null,
    });
  }
  locationPath = join(SCRATCH, 'location.json');
  writeFileSync(locationPath, JSON.stringify(doc));
  writeFileSync(
    join(SCRATCH, 'catalogue.json'),
    JSON.stringify({
      kind: 'casemaker-catalogue',
      schemaVersion: 1,
      syncedAt: '2026-11-01T00:00:00.000Z',
      tools: house.catalogue.map((tool) => ({ ...(tool as object), provenance: 'fixture' })),
      feeds: house.feeds,
    }),
  );
  return locationPath;
}

describe('#1175 the house path is the browser path: the same job, the same package', () => {
  it.skipIf(SKIP)(
    'm1trayF-banded2 through both doors with the ladder and the tool list: every program and frame byte-identical',
    async () => {
      const location = benchLocation();
      const cataloguePath = join(SCRATCH, 'catalogue.json');
      const boot = await bootstrap({ location });
      const catalogue = loadCatalogue(cataloguePath);
      setLocatedFeedTable((JSON.parse(readFileSync(location, 'utf8')) as { feeds: [] }).feeds);

      const parsed = parseEngraveJob(JSON.parse(readFileSync(TRAY_JOB, 'utf8')));
      if (!parsed.ok) throw new Error(`the tray job does not parse: ${parsed.errors.join('; ')}`);
      const job = parsed.job;
      const tool = jobTool(job);
      if (tool === null) throw new Error(`the job's cutter ${job.toolKey} is not in the bench registry`);

      // ——— THE BROWSER DOOR: the worker, handed what the app's Generate hands it. ———
      const toolsList = getTools().map((entry) => entry.tool);
      const worker = await engraveGenerate(
        boot.manifold,
        job,
        tool,
        catalogue?.rows ?? [],
        null,
        undefined,
        engraveShopOpts(boot.location?.defaults ?? null),
        undefined,
        toolsList,
        { restLadder: true },
      );
      if (!worker.ok || worker.nc === null) {
        throw new Error(`the worker stopped at ${worker.stage}: ${worker.errors.map((e) => e.message).join('; ')}`);
      }
      // The package's real size, pinned: the analyst's 17, stated rather than assumed.
      expect(worker.programs.length, 'the job posts the package the bench runs').toBe(EXPECTED_PROGRAMS);

      // ——— THE HOUSE DOOR: the CLI, handed the same list and ladder as a house run forwards. ———
      const toolsPath = join(SCRATCH, 'tools.json');
      writeFileSync(toolsPath, JSON.stringify(toolsList));
      const outDir = join(SCRATCH, 'out-house');
      mkdirSync(outDir, { recursive: true });
      let receipt: Receipt | null = null;
      const options: CommandOptions = {
        ...HUMAN,
        sink: { progress: () => {}, receipt: (r) => (receipt = r) },
      };
      const code = await engraveJobMain(
        [
          relative(process.cwd(), TRAY_JOB),
          '--out',
          outDir,
          '--location',
          relative(process.cwd(), location),
          '--tools',
          relative(process.cwd(), toolsPath),
          '--rest-ladder',
        ],
        options,
      );
      expect(receipt, 'the CLI must emit a receipt').not.toBeNull();
      const r = parseReceipt(receipt!);
      expect(code, `casemaker cut exited ${code}: ${JSON.stringify(r.refusals)}`).toBe(0);
      const details = r.command === 'engrave' && r.details !== null && 'programs' in r.details ? r.details : null;
      expect(details, 'the CLI receipt lists its programs').not.toBeNull();
      expect(details!.programs).toHaveLength(EXPECTED_PROGRAMS);

      // ——— THE COMPARISON: every program, then every frame, byte for byte. ———
      const names = programFileNames(job.name, worker.programs);
      let frames = 0;
      for (let i = 0; i < worker.programs.length; i++) {
        const program = worker.programs[i]!;
        const name = names[i]!;
        const file = join(outDir, name.ncFile);
        expect(existsSync(file), `the CLI wrote ${name.ncFile}`).toBe(true);
        expect(readFileSync(file, 'utf8'), `${name.ncFile} is byte-identical`).toBe(program.nc);
        if (program.frameNc !== null) {
          const frameFile = name.frameFile!;
          expect(existsSync(join(outDir, frameFile)), `the CLI wrote ${frameFile}`).toBe(true);
          expect(readFileSync(join(outDir, frameFile), 'utf8'), `${frameFile} is byte-identical`).toBe(
            program.frameNc,
          );
          frames += 1;
        }
      }
      // The frames are in the comparison, named for the record (the analyst's live-house package
      // puts one on p09; this package's own frame set is whatever the plan produces).
      const frameNames = names
        .filter((_, i) => worker.programs[i]!.frameNc !== null)
        .map((n) => n.frameFile!);
      // eslint-disable-next-line no-console -- the record of which frames the comparison covered
      console.log(`[#1175] ${worker.programs.length} programs; frames compared: ${frameNames.join(', ') || 'none'}`);
      expect(frameNames.length, 'the package posts at least one frame, and each was compared').toBe(frames);
    },
    1_800_000,
  );
});
