// #478 — the receipt module: the schema every command emits, and the renderer that is the ONLY
// place a result line is formatted. A receipt that does not parse is a programming error, so most
// of these cases build the smallest valid document and break one thing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  diagnostic,
  gateForStage,
  parseReceipt,
  provenance,
  provenanceForDefault,
  RECEIPT_VERSION,
  receiptJson,
  receiptSchema,
  renderReceipt,
  type Receipt,
} from '@/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const GUIDE = readFileSync(join(APP, 'src/docs/cnc-guide.md'), 'utf8');
const CHAPTER_8 = GUIDE.slice(GUIDE.indexOf('\n## 8 · '));
/**
 * A real run's receipt, from the committed bench document beside it. It is generated on Windows,
 * so its output paths carry backslashes; that is a property of the machine it ran on, not of the
 * document, and the tier-3 round-trip test normalises paths before comparing a fresh run.
 */
const FIXTURE = join(APP, '..', 'docs', 'bench', '176-g32-stroke.receipt.json');

function engraveReceipt(over: Partial<Extract<Receipt, { command: 'engrave' }>> = {}): Receipt {
  return {
    version: RECEIPT_VERSION,
    command: 'engrave',
    ok: true,
    stage: 'done',
    gate: null,
    inputs: [{ path: 'job.json', sha256: 'a'.repeat(64), bytes: 120 }],
    outputs: [
      { path: '/out/badge.nc', sha256: 'b'.repeat(64), bytes: 2048 },
      { path: '/out/badge-run-sheet.md', sha256: 'c'.repeat(64), bytes: 4096 },
    ],
    diagnostics: [
      diagnostic('vise-default', 'warning', 'the vise is the shipped set', 'findings', 'Badge'),
    ],
    provenance: [provenance('rest.overlapMm', 0.5, 'mm', 'located')],
    refusals: [],
    details: {
      kind: 'job',
      outDir: '/out',
      programs: [
        {
          name: 'Badge',
          stage: 'done',
          ok: true,
          ncFile: 'badge.nc',
          ncLines: 42,
          frameFile: null,
          cam: {
            operations: 3,
            cuttingMoves: 120,
            passes: 2,
            estimatedSeconds: 95,
            rapidMm: 310.5,
            cutMm: 170.25,
            baselineRapidMm: 560,
          },
          sim: { ok: true, engine: 'exact', count: 7, removedVolumeMm3: 12.345, errorCount: 0 },
          sheet: { file: 'badge-run-sheet.md', ncHash: 'deadbeef', estimatedTime: '1 min 35 s' },
          previews: [],
          images: [],
        },
      ],
      coupon: null,
      pair: null,
    },
    ...over,
  } as Receipt;
}

describe('#478 the receipt schema', () => {  it('accepts a receipt each command can build, and round-trips through JSON', () => {
    const receipts: Receipt[] = [
      engraveReceipt(),
      {
        version: RECEIPT_VERSION,
        command: 'export',
        ok: true,
        stage: 'written',
        gate: null,
        inputs: [{ path: 'p.caseproj.json', sha256: 'a'.repeat(64), bytes: 900 }],
        outputs: [
          { path: '/out/p.stl', sha256: 'b'.repeat(64), bytes: 2048 },
          { path: '/out/p-PRINT-NOTES.txt', sha256: 'c'.repeat(64), bytes: 300 },
        ],
        diagnostics: [],
        provenance: [],
        refusals: [],
        details: { triangles: 1200 },
      },
      {
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
        details: { section: 'tools', document: null, records: [] },
      },
      {
        version: RECEIPT_VERSION,
        command: 'readback',
        ok: true,
        stage: 'applied',
        gate: null,
        inputs: [{ path: 'record.json', sha256: 'a'.repeat(64), bytes: 10 }],
        outputs: [],
        diagnostics: [],
        provenance: [],
        refusals: [],
        details: {
          section: 'feeds',
          record: 'record.json',
          target: 'feeds.ts',
          dryRun: true,
          feeds: {
            measurement: {
              material: 'PLA',
              diameter: 1,
              parameter: 'feed',
              value: 300,
              coupon: 'c1',
              on: '2026-10-18',
            },
            row: {
              material: 'PLA',
              minDiameter: 0.5,
              maxDiameter: 1.2,
              status: 'measured',
              provenance: 'measured',
            },
            written: null,
          },
          run: null,
        },
      },
      {
        // #481 — the variant the pure MCP tools return: no command ran, so there is no
        // command-specific details block, only the tool, the document and the items it read.
        version: RECEIPT_VERSION,
        command: 'mcp',
        ok: true,
        stage: 'read',
        gate: null,
        inputs: [],
        outputs: [],
        diagnostics: [],
        provenance: [],
        refusals: [],
        details: { tool: 'list_boards', document: null, items: ['rpi-4b', 'esp32-devkit'] },
      },
    ];
    for (const receipt of receipts) {
      const parsed = parseReceipt(JSON.parse(receiptJson(receipt)));
      expect(parsed).toEqual(receipt);
    }
  });

  it('refuses a malformed receipt by naming the field that is wrong', () => {
    const broken = engraveReceipt() as unknown as Record<string, unknown>;
    delete broken['stage'];
    expect(() => parseReceipt(broken)).toThrow(/stage/);

    const badSource = engraveReceipt({
      provenance: [provenance('x', 1, 'mm', 'located')],
    });
    (badSource.provenance[0] as { source: string }).source = 'invented';
    expect(receiptSchema.safeParse(badSource).success).toBe(false);

    const badGate = engraveReceipt({ gate: 'shipped' as never });
    expect(receiptSchema.safeParse(badGate).success).toBe(false);

    const badHash = engraveReceipt({
      inputs: [{ path: 'x', sha256: 'not-a-hash', bytes: 1 }],
    });
    expect(receiptSchema.safeParse(badHash).success).toBe(false);
  });

  it('names the cnc-guide row for every diagnostic, and refuses a code without one', () => {
    const d = diagnostic('item-empty', 'error', 'nothing to cut', 'findings', 'Badge');
    expect(d.guideRow).toBe('item-empty');
    expect(CHAPTER_8).toContain('`item-empty`');
    expect(() => diagnostic('', 'error', 'x', 'findings')).toThrow(/chapter 8/);
  });

  it('maps a generator stage to the #206 gate that stopped it', () => {
    expect(gateForStage('findings')).toBe('generated');
    expect(gateForStage('feeds')).toBe('generated');
    expect(gateForStage('cam')).toBe('generated');
    expect(gateForStage('post')).toBe('generated');
    expect(gateForStage('verify')).toBe('verified');
  });

  it('maps a shop default’s source to the receipt’s four provenance sources', () => {
    expect(provenanceForDefault('k', 1, 'mm', 'user').source).toBe('typed');
    expect(provenanceForDefault('k', 1, 'mm', 'measured').source).toBe('measured');
    expect(provenanceForDefault('k', 1, 'mm', 'seeded').source).toBe('located');
    expect(provenanceForDefault('k', 1, 'mm', 'chosen').source).toBe('located');
    expect(provenanceForDefault('k', 1, 'mm', 'fallback').source).toBe('seeded');
  });
});

describe('#478 a committed bench job’s receipt', () => {
  it('parses, round-trips byte for byte, and names a chapter 8 row for every diagnostic', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const receipt = parseReceipt(JSON.parse(text));
    expect(receipt.command).toBe('engrave');
    expect(receipt.ok).toBe(true);
    // The JSON a command writes is exactly this document: the fixture is the round trip's reference
    // (tier 3 step 9), so a serialiser change that reorders or reformats is a test failure here.
    expect(receiptJson(receipt)).toBe(text);
    for (const d of receipt.diagnostics) {
      expect(d.guideRow, `the fixture's code ${d.code} must be its own guide row`).toBe(d.code);
      expect(CHAPTER_8, `chapter 8 has no row for ${d.code}`).toContain('`' + d.code + '`');
    }
    // The human form is rendered FROM this document, so the fixture also pins what an operator saw.
    const rendered = renderReceipt(receipt).join('\n');
    expect(rendered).toContain('  stage      done, ok=true');
    // The bytes come from `outputs`, whose paths carry this machine's separator — the fixture is
    // generated on Windows, so it is the case that a `/`-only match would report `? bytes`.
    expect(rendered).toContain('  file       176-g32-stroke.nc  (1171 bytes, 41 lines)');
    expect(rendered).toContain('  frame      176-g32-stroke-frame.nc  (1072 bytes)');
  });
});

describe('#478 the human output is rendered from the receipt', () => {
  it('renders an engrave run’s stage, CAM, travel, findings, sim and sheet blocks', () => {
    const text = renderReceipt(engraveReceipt()).join('\n');
    expect(text).toContain('Badge');
    expect(text).toContain('  file       badge.nc  (2048 bytes, 42 lines)');
    expect(text).toContain('  stage      done, ok=true');
    expect(text).toContain('  cam        3 ops, 120 cutting moves, 2 passes, ~95s');
    expect(text).toContain('  travel     310.5 mm rapid / 170.3 mm cut');
    expect(text).toContain('  findings   0 error, 1 warning');
    expect(text).toContain('     warn  vise-default: the vise is the shipped set');
    expect(text).toContain('  sim        ok=true, engine=exact, count=7, removed=12.35 mm³, 0 errors');
    expect(text).toContain('  sheet      badge-run-sheet.md  hash=deadbeef  time=1 min 35 s');
  });

  it('renders a stopped run’s errors and refusal from the receipt', () => {
    const stopped = engraveReceipt({
      ok: false,
      stage: 'findings',
      gate: 'generated',
      details: { kind: 'job', outDir: '/out', programs: [], coupon: null, pair: null },
      diagnostics: [diagnostic('item-empty', 'error', 'nothing to cut', 'findings', 'Badge')],
      refusals: [{ code: 'stopped', reason: 'stopped at findings' }],
    });
    const text = renderReceipt(stopped).join('\n');
    expect(text).toContain('  ERROR item-empty: nothing to cut');
    expect(text).toContain('  !! stopped at findings');
  });

  it('renders an export from its outputs and triangle count', () => {
    const text = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'export',
      ok: true,
      stage: 'written',
      gate: null,
      inputs: [],
      outputs: [
        { path: '/out/p.stl', sha256: 'b'.repeat(64), bytes: 2048 },
        { path: '/out/p-PRINT-NOTES.txt', sha256: 'c'.repeat(64), bytes: 300 },
      ],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: { triangles: 1200 },
    }).join('\n');
    expect(text).toContain('p.stl  1200 triangles  2.0 KB');
    expect(text).toContain('  notes      p-PRINT-NOTES.txt');
    expect(text).toContain('Wrote /out/p.stl');
  });

  it('renders a pure MCP tool from its tool, document, items and refusal (#481)', () => {
    const text = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'mcp',
      ok: true,
      stage: 'written',
      gate: null,
      inputs: [],
      outputs: [{ path: '/out/p.caseproj.json', sha256: 'b'.repeat(64), bytes: 900 }],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: { tool: 'new_project', document: '/out/p.caseproj.json', items: ['prj-1'] },
    }).join('\n');
    expect(text).toContain('mcp new_project  ok=true');
    expect(text).toContain('  document   /out/p.caseproj.json');
    expect(text).toContain('  item       prj-1');

    const refused = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'mcp',
      ok: false,
      stage: 'validated',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [{ code: 'patch-refused', reason: 'invalid case patch: wallThickness: too small' }],
      details: { tool: 'patch_case', document: null, items: ['wallThickness: too small'] },
    }).join('\n');
    expect(refused).toContain('mcp patch_case  ok=false');
    expect(refused).not.toContain('document   ');
    expect(refused).toContain('  !! invalid case patch: wallThickness: too small');
  });

  it('renders a machine read from the receipt, and the guarded action’s confirmation (#477)', () => {
    const text = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'machine',
      ok: true,
      stage: 'status',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        section: 'status',
        host: '192.0.2.10',
        port: 2222,
        status: {
          line: '<Idle|MPos:0,0,0|P:4,100,120>',
          state: 'Idle',
          progressLine: 4,
          percent: 100,
          elapsedS: 120,
          alarm: null,
          finished: true,
        },
        version: null,
        hashes: [],
        finished: null,
        action: null,
      },
    }).join('\n');
    expect(text).toContain('machine status  ok=true');
    expect(text).toContain('  host       192.0.2.10:2222');
    expect(text).toContain('  job        finished — percent 100 and Idle');

    const action = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'machine',
      ok: true,
      stage: 'play',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        section: 'play',
        host: '192.0.2.10',
        port: 2222,
        status: null,
        version: null,
        hashes: [],
        finished: null,
        action: {
          confirm: '3fa2b1c9',
          programHash: '3fa2b1c9',
          path: '/sd/gcodes/badge.nc',
          sent: 'play /sd/gcodes/badge.nc',
          dryRun: false,
          ackCodes: ['vise-default'],
          alreadyPresent: false,
        },
      },
    }).join('\n');
    expect(action).toContain('  confirm    3fa2b1c9');
    expect(action).toContain('  cleared    vise-default');
    expect(action).toContain('  sent       play /sd/gcodes/badge.nc');

    const dry = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'machine',
      ok: true,
      stage: 'upload',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        section: 'upload',
        host: null,
        port: 2222,
        status: null,
        version: null,
        hashes: [],
        finished: null,
        action: {
          confirm: null,
          programHash: '3fa2b1c9',
          path: '/sd/gcodes/badge.nc',
          sent: null,
          dryRun: true,
          ackCodes: [],
          alreadyPresent: false,
        },
      },
    }).join('\n');
    expect(dry).toContain('  confirm    (none — --dry)');
    expect(dry).toContain('  next       re-run with --confirm 3fa2b1c9 to send it');
  });

  it('renders a location section from its records, and the no-document case', () => {
    const text = renderReceipt({
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
        section: 'tools',
        document: { kind: 'location', name: 'Test bench', path: '/l.json', tools: 2, inventory: 1 },
        records: [{ label: 'tool', fields: ['user:1', 'Cutter', 'Ø1 mm', 'flat', '— seeded'] }],
      },
    }).join('\n');
    expect(text).toContain('location "Test bench": /l.json — 2 tools');
    expect(text).toContain('  tool       user:1  Cutter  Ø1 mm  flat  — seeded');

    const empty = renderReceipt({
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
      details: { section: 'stock', document: null, records: [] },
    }).join('\n');
    expect(empty).toContain('no location document');
  });

  it('renders a feeds readback and a run readback from their details', () => {
    const feeds = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'readback',
      ok: true,
      stage: 'applied',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        section: 'feeds',
        record: 'record.json',
        target: 'feeds.ts',
        dryRun: false,
        feeds: {
          measurement: {
            material: 'PLA',
            diameter: 1,
            parameter: 'feed',
            value: 300,
            coupon: 'c1',
            on: '2026-10-18',
          },
          row: { material: 'PLA', minDiameter: 0.5, maxDiameter: 1.2, status: 'measured', provenance: 'measured' },
          written: 3,
        },
        run: null,
      },
    }).join('\n');
    expect(feeds).toContain('record.json  ->  feeds.ts');
    expect(feeds).toContain('  measurement  PLA Ø1 feed = 300  (coupon "c1", cut 2026-10-18)');
    expect(feeds).toContain('  row          PLA 0.5-1.2 mm -> measured');
    expect(feeds).toContain('wrote 3 measurement(s) into the feeds.ts region');

    const run = renderReceipt({
      version: RECEIPT_VERSION,
      command: 'readback',
      ok: true,
      stage: 'applied',
      gate: null,
      inputs: [],
      outputs: [],
      diagnostics: [],
      provenance: [],
      refusals: [],
      details: {
        section: 'run',
        record: 'run.json',
        target: 'runHistory.ts',
        dryRun: true,
        feeds: null,
        run: {
          job: 'Badge',
          ncFile: 'badge.nc',
          ncHash: 'abc',
          minutes: 14.5,
          cutOn: '2026-10-18',
          tool: 'flat-1.0',
          estimatedSeconds: 900,
          depths: [{ name: 'text', planned: 0.6, measured: 0.62 }],
          legible: true,
          finish: 'clean',
          notes: '',
          replaced: false,
          measuredRuns: null,
        },
      },
    }).join('\n');
    expect(run).toContain('  run          Badge  (badge.nc, hash abc)');
    expect(run).toContain('  measured     14 min 30 s on 2026-10-18  ·  flat-1.0');
    expect(run).toContain('  depth        text: posted 0.6 mm, measured 0.62 mm');
    expect(run).toContain('(dry run — runHistory.ts not written)');
  });
});
