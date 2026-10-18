/**
 * The `Receipt` every headless command carries (#478) — one structured, versioned result shape.
 *
 * A command's human output is RENDERED FROM this object (#478's recommended answer, confirmed by
 * the manager): `renderReceipt` is the only code that formats a result line, so the terminal and a
 * machine consumer read the same facts. Progress and advisory prose — the reachability table, the
 * seam notes, "nothing to clean up" — is emitted while the command works and is not part of the
 * result; under `--json` it goes to stderr, leaving stdout the receipt alone.
 *
 * The schema is deliberately PURE: no `node:fs`, no hashing, no clock. Paths arrive from the
 * command and hashes from its file layer, so the same module serves the CLI, the MCP server (#481)
 * and a browser-typed consumer. `z.toJSONSchema` emits it as `schemas/receipt.json` (#480), which is
 * why every property below carries a description.
 *
 * DIAGNOSTIC CODES ARE GUIDE ROWS. `cnc-guide.md` §8.1 is the table of every code an engine can
 * raise, keyed by the code itself, and `tests/unit/cncGuide.spec.ts` keeps that table complete.
 * `diagnostic()` therefore states the row key for a code as the code, and refuses an empty one.
 */

import { z } from 'zod';

/**
 * The receipt document's own version. A changed SHAPE bumps it; a new optional field does not.
 *
 * 2 (#481) — the receipt gained a `mcp` command variant, the one pure tools (list/describe/
 * new/patch/compile) return: they run no CLI command whose receipt could be borrowed, and every
 * MCP tool must return a receipt. The four command variants are unchanged.
 *
 * 3 (#477) — the receipt gained a `machine` command variant, for the commands that speak to the
 * controller on the LAN. Same reason as `mcp`: `casemaker machine status` runs no other command
 * whose receipt could be borrowed, and every command emits one.
 */
export const RECEIPT_VERSION = 3;

/**
 * #206's four gates, in the order the panel asks them. `gate` names the one that stopped a run;
 * `null` means none did.
 */
export const RECEIPT_GATES = ['generated', 'verified', 'simulated', 'prediction'] as const;
export type ReceiptGate = (typeof RECEIPT_GATES)[number];

/**
 * Where a number came from (#478): `seeded` is a value this build ships, `located` one read from
 * the machine's own document, `typed` one given on the command line, `measured` one recorded at the
 * bench.
 */
export const RECEIPT_PROVENANCE_SOURCES = ['seeded', 'located', 'typed', 'measured'] as const;
export type ReceiptProvenanceSource = (typeof RECEIPT_PROVENANCE_SOURCES)[number];

/** Which list a diagnostic was raised from, so a receipt can render the same blocks the panels do. */
export const RECEIPT_DIAGNOSTIC_SOURCES = ['findings', 'verify', 'simulation'] as const;

const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('SHA-256 of the file bytes, 64 lowercase hex characters.');

/** One file a command read or wrote. */
export const receiptFileSchema = z
  .object({
    path: z.string().min(1).describe('The file, as the command names it — relative paths stay relative.'),
    sha256: sha256,
    bytes: z.number().int().nonnegative().describe('Size of the file, in bytes.'),
  })
  .describe('A file the command read (an input) or wrote (an output).');

/** One diagnostic, with the cnc-guide row an operator is sent to. */
export const receiptDiagnosticSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe('The diagnostic code, e.g. `item-empty`; every engine code is also a cnc-guide row.'),
    guideRow: z
      .string()
      .min(1)
      .describe('The cnc-guide chapter 8 row key for this code — the code itself for every engine diagnostic.'),
    severity: z.enum(['error', 'warning', 'info']).describe('How the finding is treated by the gates.'),
    message: z.string().describe('The finding, in the words the engine or verifier raised it in.'),
    source: z.enum(RECEIPT_DIAGNOSTIC_SOURCES).describe('Which list raised it.'),
    program: z
      .string()
      .nullable()
      .describe('The program whose pipeline raised it, or null for a run-level diagnostic.'),
  })
  .describe('One code the run raised, with the guide row an operator reads next.');

/** One number an operator acts on, and where it came from. */
export const receiptProvenanceSchema = z
  .object({
    name: z.string().min(1).describe('The setting, as the job or the sheet spells it, e.g. `rest.overlapMm`.'),
    value: z.number().describe('The number this run used.'),
    unit: z.string().nullable().describe('Its unit (`mm`, `%`, …), or null when it has none.'),
    source: z.enum(RECEIPT_PROVENANCE_SOURCES).describe('Where the number came from.'),
  })
  .describe('A number the run used, with its provenance.');

/** A refusal: a reason the run stopped, stated as data rather than an error string. */
export const receiptRefusalSchema = z
  .object({
    code: z.string().min(1).describe('A stable refusal code, e.g. `simulation-refused`.'),
    reason: z.string().min(1).describe('The reason, as an operator reads it.'),
  })
  .describe('A refusal the run reported, as data.');

// ---------------------------------------------------------------------------------------------
// Per-command details
// ---------------------------------------------------------------------------------------------

/** The CAM's own counts, as the panel's "Toolpath generated" row states them. */
export const engraveCamSchema = z
  .object({
    operations: z.number().int().nonnegative().describe('Toolpath operations the CAM emitted.'),
    cuttingMoves: z.number().int().nonnegative().describe('Cutting moves in the program.'),
    passes: z.number().int().nonnegative().describe('Depth passes the program makes.'),
    estimatedSeconds: z.number().nonnegative().describe('Estimated cutting time, in seconds.'),
    rapidMm: z.number().nonnegative().nullable().describe('Rapid (air) travel, mm, or null when not recorded.'),
    cutMm: z.number().nonnegative().nullable().describe('Cutting travel, mm, or null when not recorded.'),
    baselineRapidMm: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Rapid travel the pre-#487 ordering would have spent, mm, or null.'),
  })
  .describe('The CAM summary for one program.');

/** What one simulated program's sweep reported. */
export const engraveSimSchema = z
  .object({
    ok: z.boolean().describe('Whether the sweep produced material.'),
    engine: z.string().describe('The sweep engine that ran, e.g. `exact` or `raster`.'),
    count: z.number().int().nonnegative().describe('Checkpoints the sweep recorded.'),
    removedVolumeMm3: z.number().nullable().describe('Material the sweep removed, mm³, when the mesh is present.'),
    errorCount: z.number().int().nonnegative().describe('Simulation diagnostics of severity `error`.'),
  })
  .describe('The simulation summary for one program.');

/** One program's written files and pipeline result. */
export const engraveProgramSchema = z
  .object({
    name: z.string().min(1).describe('The job name the program was written under.'),
    stage: z.string().min(1).describe('The pipeline stage the program reached, e.g. `done`.'),
    ok: z.boolean().describe('Whether the generator itself reported success.'),
    ncFile: z.string().min(1).describe('The `.nc` file name, without its directory.'),
    ncLines: z.number().int().nonnegative().describe('Line count of the `.nc` text.'),
    frameFile: z.string().nullable().describe('The frame `.nc` file name, or null when none was written.'),
    cam: engraveCamSchema.nullable().describe('The CAM summary, or null when the CAM produced none.'),
    sim: engraveSimSchema.nullable().describe('The simulation summary, or null when no sweep ran.'),
    sheet: z
      .object({
        file: z.string().min(1).describe('The run sheet file name, without its directory.'),
        ncHash: z.string().min(1).describe('The hash of the `.nc` the sheet describes.'),
        estimatedTime: z.string().min(1).describe('The estimated time the sheet prints.'),
      })
      .nullable()
      .describe('The run sheet written for this program, or null when none was.'),
    previews: z.array(z.string()).describe('Preview SVG file names written for this program.'),
    images: z.array(z.string()).describe('Preview PNG file names rendered for this program.'),
  })
  .describe('One program a run wrote.');

/** A coupon sweep's own summary. */
export const engraveCouponSchema = z
  .object({
    title: z.string().min(1).describe('The coupon spec’s title.'),
    parameter: z
      .enum(['depth', 'feed', 'rpm', 'stepDown', 'stepOver'])
      .describe('The case parameter the sweep varies.'),
    values: z.array(z.number()).describe('The values swept, in the spec’s order.'),
    recordFile: z.string().min(1).describe('The coupon record file name the run wrote.'),
    rowCount: z.number().int().nonnegative().describe('Program rows the record carries to fill in.'),
    allOk: z.boolean().describe('Whether every program generated.'),
  })
  .describe('The coupon sweep summary, when the run was a coupon.');

/** The two-program summary a rest pass prints. */
export const engravePairSchema = z
  .object({
    roughFile: z.string().min(1).describe('The first program’s `.nc` file name.'),
    roughDiameterMm: z.number().positive().describe('The first cutter’s cutting diameter, mm.'),
    restFile: z.string().min(1).describe('The second program’s `.nc` file name.'),
    restDiameterMm: z.number().positive().describe('The second cutter’s cutting diameter, mm.'),
    restRemovedVolumeMm3: z.number().nonnegative().describe('Material the second program removed on its own, mm³.'),
    leftoverAreaMm2: z.number().nonnegative().describe('Design area still standing between the two programs, mm².'),
    thirdToolShare: z.number().nonnegative().nullable().describe('The leftover as a share of what the design asks for, or null.'),
    thirdToolThreshold: z.number().nonnegative().nullable().describe('The shop’s third-cutter threshold, as a fraction, or null.'),
    thirdToolSuggested: z.boolean().nullable().describe('Whether a third cutter is suggested, or null when not judged.'),
  })
  .describe('The two-program summary, when a rest pass ran.');

/** Everything `casemaker engrave` reports beyond the receipt envelope. */
export const engraveDetailsSchema = z
  .object({
    kind: z.enum(['job', 'design', 'coupon']).describe('Which input built the run: a job, a 3MF design, or a coupon spec.'),
    outDir: z.string().describe('The directory the files were written into.'),
    programs: z.array(engraveProgramSchema).describe('Every program the run wrote, in the order written.'),
    coupon: engraveCouponSchema.nullable().describe('The coupon summary, or null for a job or design run.'),
    pair: engravePairSchema.nullable().describe('The two-program summary, or null when only one program ran.'),
  })
  .describe('The engrave command’s own details.');

/** Everything `casemaker export` reports beyond the receipt envelope. */
export const exportDetailsSchema = z
  .object({
    triangles: z.number().int().nonnegative().describe('Triangles across the compiled parts, before layout.'),
  })
  .describe('The export command’s own details.');

/** One line of a location section, as label plus ordered values. */
export const locationRecordSchema = z
  .object({
    label: z.string().min(1).describe('The line’s leading label, e.g. `tool`, `owned`, `stock`.'),
    fields: z.array(z.string()).describe('The ordered values the operator reads on the line.'),
  })
  .describe('One record a location section prints.');

/** Everything `casemaker location` reports beyond the receipt envelope. */
export const locationDetailsSchema = z
  .object({
    section: z.enum(['tools', 'stock', 'machines']).describe('Which section was asked for.'),
    document: z
      .object({
        kind: z.enum(['location', 'house']).describe('Which document kind was read.'),
        name: z.string().describe('The location’s name, or `house` for a house document.'),
        path: z.string().describe('The file the document was read from.'),
        tools: z.number().int().nonnegative().describe('Tools on the document’s own list.'),
        inventory: z.number().int().nonnegative().describe('Owned cutters the document states.'),
      })
      .nullable()
      .describe('The document that was resolved, or null when neither location.json nor house.json was found.'),
    records: z.array(locationRecordSchema).describe('The section’s records, in the order it prints them.'),
  })
  .describe('The location command’s own details.');

/** The feeds readback’s applied measurement and the row it lands on. */
export const readbackFeedsSchema = z
  .object({
    measurement: z
      .object({
        material: z.string().describe('The material the coupon measured.'),
        diameter: z.number().positive().describe('The coupon’s cutter diameter, mm.'),
        parameter: z.string().describe('The feeds parameter measured (`feed`, `rpm`, …).'),
        value: z.number().describe('The measured value, in the parameter’s own unit.'),
        coupon: z.string().describe('The coupon the measurement came from.'),
        on: z.string().describe('The date the coupon was cut (YYYY-MM-DD).'),
      })
      .nullable()
      .describe('The measurement applied, or null when the record was refused before one was read.'),
    row: z
      .object({
        material: z.string().describe('The feeds row’s material.'),
        minDiameter: z.number().describe('The row’s inclusive minimum diameter, mm.'),
        maxDiameter: z.number().describe('The row’s inclusive maximum diameter, mm.'),
        status: z.string().describe('The row’s resulting status.'),
        provenance: z.string().describe('The row’s provenance, as the table states it.'),
      })
      .nullable()
      .describe('The feeds row the measurement resolves to, or null when none matched.'),
    written: z.number().int().nonnegative().nullable().describe('Measurements in the region after the write, or null for a dry run.'),
  })
  .describe('The feeds readback’s own details.');

/** The run readback’s applied record. */
export const readbackRunSchema = z
  .object({
    job: z.string().describe('The job the run record names.'),
    ncFile: z.string().describe('The program file the run cut.'),
    ncHash: z.string().describe('The program hash the record states, or an empty string.'),
    minutes: z.number().nonnegative().nullable().describe('Measured wall-clock time, minutes, or null.'),
    cutOn: z.string().describe('The date the run was cut (YYYY-MM-DD).'),
    tool: z.string().nullable().describe('The cutter the record names, or null.'),
    estimatedSeconds: z.number().nonnegative().nullable().describe('The estimate the record carries, seconds, or null.'),
    depths: z
      .array(
        z.object({
          name: z.string().describe('The depth feature’s name.'),
          planned: z.number().describe('The posted depth, mm.'),
          measured: z.number().nullable().describe('The measured depth, mm, or null when unmeasured.'),
        }),
      )
      .describe('Per-feature posted and measured depths.'),
    legible: z.boolean().nullable().describe('Whether the result was legible, or null when unrecorded.'),
    finish: z.string().nullable().describe('The finish recorded, or null.'),
    notes: z.string().describe('The operator’s note, empty when none.'),
    replaced: z.boolean().describe('Whether the write replaced an existing record rather than adding one.'),
    measuredRuns: z.number().int().nonnegative().nullable().describe('Measured runs in the region after the write, or null for a dry run.'),
  })
  .describe('The run readback’s own details.');

/** Everything `casemaker readback` reports beyond the receipt envelope. */
export const readbackDetailsSchema = z
  .object({
    section: z.enum(['feeds', 'run']).describe('Which readback ran.'),
    record: z.string().describe('The record file that was read.'),
    target: z.string().describe('The source file the record is applied to.'),
    dryRun: z.boolean().describe('Whether the write was rehearsed and skipped.'),
    feeds: readbackFeedsSchema.nullable().describe('The feeds readback’s details, or null for `run`.'),
    run: readbackRunSchema.nullable().describe('The run readback’s details, or null for `feeds`.'),
  })
  .describe('The readback command’s own details.');

/**
 * The MCP tools that run NO command of their own (#481): lookups over the library and the project
 * document tools. Each returns this variant; every other tool returns the receipt of the command
 * it ran (`export_parts` → `export`, `generate_program`/`run_sheet` → `engrave`, `read_location`
 * → `location`).
 */
export const RECEIPT_MCP_TOOLS = [
  'list_boards',
  'list_templates',
  'describe_board',
  'new_project',
  'patch_case',
  'compile_project',
] as const;
export type ReceiptMcpTool = (typeof RECEIPT_MCP_TOOLS)[number];

/** Everything an MCP tool reports beyond the receipt envelope. */
export const mcpDetailsSchema = z
  .object({
    tool: z.enum(RECEIPT_MCP_TOOLS).describe('The MCP tool that produced this receipt.'),
    document: z
      .string()
      .nullable()
      .describe('The project document the tool wrote, or null when it wrote none.'),
    items: z
      .array(z.string())
      .describe('The ids the tool listed, built or compiled, in the order the tool returns them.'),
  })
  .describe('An MCP tool’s own details.');

/**
 * The `machine` subcommands (#477). The reads — `status`, `version`, `hashes`, `finished` — are
 * unattended; the two physical actions (`upload`, `play`) are only ever reachable behind
 * `--confirm <program hash>` (#479's confirmed line). Power is not here at all: the plug is this
 * bench's fixture, not a product assumption.
 */
export const RECEIPT_MACHINE_SECTIONS = [
  'status',
  'version',
  'hashes',
  'finished',
  'upload',
  'play',
  'home',
  'probe',
] as const;
export type ReceiptMachineSection = (typeof RECEIPT_MACHINE_SECTIONS)[number];

/** What a `?` status line says, in the protocol's own terms (`readJobProgress`, `alarmLine`). */
export const machineStatusSchema = z
  .object({
    line: z.string().nullable().describe('The `?` status line, verbatim, or null when none came back.'),
    state: z.string().nullable().describe('The state word at the front of the line (`Idle`, `Run`, `Alarm`, …).'),
    progressLine: z.number().int().nonnegative().nullable().describe('`P:`’s first field — the line being run.'),
    percent: z.number().nullable().describe('`P:`’s second field — percent complete, 100 at the end.'),
    elapsedS: z.number().nullable().describe('`P:`’s third field — seconds elapsed in the job.'),
    alarm: z.string().nullable().describe('The controller’s own alarm line, verbatim, or null.'),
    finished: z
      .boolean()
      .describe('Whether the job has ended: percent 100 AND `Idle` — `Idle` alone appears mid-job.'),
  })
  .describe('A status read, as the controller answered it.');

/** One card file’s digest, as the controller itself reports it. */
export const machineHashSchema = z
  .object({
    path: z.string().min(1).describe('The absolute path on the controller’s card.'),
    md5: z.string().nullable().describe('The controller’s MD5, 32 lowercase hex, or null when it had no digest.'),
    detail: z.string().nullable().describe('Why no digest came back, or null on success.'),
  })
  .describe('A file on the card, hashed by the controller.');

/** Everything `casemaker machine` reports beyond the receipt envelope. */
export const machineDetailsSchema = z
  .object({
    section: z.enum(RECEIPT_MACHINE_SECTIONS).describe('Which machine command ran.'),
    host: z.string().nullable().describe('The machine reached, or null when nothing was sent.'),
    port: z.number().int().nonnegative().describe('The command port used (2222 on a Z1).'),
    status: machineStatusSchema.nullable().describe('The status read, or null for another section.'),
    version: z.string().nullable().describe('The firmware version the controller reports, or null.'),
    hashes: z.array(machineHashSchema).describe('The card files hashed, in the order asked about.'),
    finished: z
      .object({
        machine: z.string().min(1).describe('The machine record whose finished list was read.'),
        hashes: z.array(z.string()).describe('Every FNV program hash the record says finished cleanly.'),
      })
      .nullable()
      .describe('The machine record’s finished-program list, or null for another section.'),
    action: z
      .object({
        confirm: z
          .string()
          .nullable()
          .describe('The `--confirm` token the caller gave, or null for a `--dry` run.'),
        programHash: z.string().nullable().describe('The program’s FNV hash, or null before one was computed.'),
        path: z.string().nullable().describe('The card path the action named, or null.'),
        sent: z.string().nullable().describe('The line sent to the controller, or null when nothing was sent.'),
        dryRun: z.boolean().describe('Whether the action stopped before opening a socket.'),
        ackCodes: z
          .array(z.string())
          .describe('The clearance codes the caller acknowledged with `--acknowledge`, or [] for none.'),
        alreadyPresent: z
          .boolean()
          .describe('Whether the machine declined the transfer because it already held identical bytes.'),
      })
      .nullable()
      .describe('The guarded action (upload/play/home/probe), or null for a read.'),
    probe: z
      .object({
        line: z.string().min(1).describe('The line sent to run the tool-length probe (`M491` on a Z1).'),
        prb: z
          .object({
            x: z.number().describe('The trigger’s machine X, mm.'),
            y: z.number().describe('The trigger’s machine Y, mm.'),
            z: z.number().describe('The trigger’s machine Z, mm.'),
            touched: z
              .boolean()
              .describe('Whether the probe touched (`:1`) or travelled its whole distance and hit nothing (`:0`).'),
          })
          .nullable()
          .describe('The last `[PRB:…]` the controller answered, or null when the reply carried none.'),
        text: z.string().describe('The controller’s reply to the probe line, verbatim.'),
      })
      .nullable()
      .describe('The tool-length probe’s reading, or null for another section.'),
  })
  .describe('The machine command’s own details.');

// ---------------------------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------------------------

const envelope = {
  version: z.literal(RECEIPT_VERSION).describe('The receipt document’s shape version.'),
  ok: z.boolean().describe('Whether the command completed its gates.'),
  stage: z.string().nullable().describe('The stage the command reached, or null when it stopped before one.'),
  gate: z.enum(RECEIPT_GATES).nullable().describe('The #206 gate that stopped the run, or null when none did.'),
  inputs: z.array(receiptFileSchema).describe('The files the command read, with their hashes.'),
  outputs: z.array(receiptFileSchema).describe('The files the command wrote, with their hashes.'),
  diagnostics: z.array(receiptDiagnosticSchema).describe('Every code the run raised.'),
  provenance: z.array(receiptProvenanceSchema).describe('Every number an operator acts on, with where it came from.'),
  refusals: z.array(receiptRefusalSchema).describe('Every refusal the run reported, as data.'),
};

/**
 * The receipt for a whole command run, discriminated by `command`. A command that writes files
 * emits one per run, not one per file; `details` carries what only that command can say.
 */
export const receiptSchema = z.discriminatedUnion('command', [
  z
    .object({ ...envelope, command: z.literal('engrave').describe('The command that produced this receipt.'), details: engraveDetailsSchema })
    .describe('The receipt of an engrave run.'),
  z
    .object({ ...envelope, command: z.literal('export').describe('The command that produced this receipt.'), details: exportDetailsSchema })
    .describe('The receipt of a project export.'),
  z
    .object({ ...envelope, command: z.literal('location').describe('The command that produced this receipt.'), details: locationDetailsSchema })
    .describe('The receipt of a location read.'),
  z
    .object({ ...envelope, command: z.literal('readback').describe('The command that produced this receipt.'), details: readbackDetailsSchema })
    .describe('The receipt of a readback.'),
  z
    .object({ ...envelope, command: z.literal('mcp').describe('The command that produced this receipt.'), details: mcpDetailsSchema })
    .describe('The receipt of an MCP tool that runs no command of its own.'),
  z
    .object({ ...envelope, command: z.literal('machine').describe('The command that produced this receipt.'), details: machineDetailsSchema })
    .describe('The receipt of a machine command.'),
]);

export type Receipt = z.infer<typeof receiptSchema>;
export type ReceiptFile = z.infer<typeof receiptFileSchema>;
export type ReceiptDiagnostic = z.infer<typeof receiptDiagnosticSchema>;
export type ReceiptProvenance = z.infer<typeof receiptProvenanceSchema>;
export type ReceiptRefusal = z.infer<typeof receiptRefusalSchema>;
export type EngraveDetails = z.infer<typeof engraveDetailsSchema>;
export type EngraveProgram = z.infer<typeof engraveProgramSchema>;
export type ExportDetails = z.infer<typeof exportDetailsSchema>;
export type LocationDetails = z.infer<typeof locationDetailsSchema>;
export type ReadbackDetails = z.infer<typeof readbackDetailsSchema>;
export type McpDetails = z.infer<typeof mcpDetailsSchema>;
export type MachineDetails = z.infer<typeof machineDetailsSchema>;
export type MachineStatusRead = z.infer<typeof machineStatusSchema>;

/**
 * A diagnostic. The guide row is the code itself — `cnc-guide.md` §8.1's table is keyed by code —
 * so a caller cannot state one without the other, and an empty code is a programming error.
 */
export function diagnostic(
  code: string,
  severity: ReceiptDiagnostic['severity'],
  message: string,
  source: ReceiptDiagnostic['source'],
  program: string | null = null,
): ReceiptDiagnostic {
  if (code.trim() === '') throw new Error('a diagnostic must name its cnc-guide chapter 8 code');
  return { code, guideRow: code, severity, message, source, program };
}

/** A number's provenance. Kept as a function so the four sources are spelled where they are used. */
export function provenance(
  name: string,
  value: number,
  unit: string | null,
  source: ReceiptProvenanceSource,
): ReceiptProvenance {
  return { name, value, unit, source };
}

/** Which #206 gate a generator stage belongs to. `verify` is the one stage that IS a gate. */
export function gateForStage(stage: string): ReceiptGate {
  return stage === 'verify' ? 'verified' : 'generated';
}

/**
 * Parse a receiver-built object into a `Receipt`, or throw. Used at emission, so a malformed
 * receipt is a programming error caught by the spec rather than a document a consumer trips on.
 */
export function parseReceipt(value: unknown): Receipt {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`a command built an invalid receipt: ${detail}`);
  }
  return parsed.data;
}

/** The receipt as the document a `--json` run writes: two-space JSON and one trailing newline. */
export function receiptJson(receipt: Receipt): string {
  return JSON.stringify(receipt, null, 2) + '\n';
}

// ---------------------------------------------------------------------------------------------
// Rendering — the human output is derived from the receipt, and from nothing else
// ---------------------------------------------------------------------------------------------

/** `14 min 20 s` — the shape the run sheet and the run readback use. */
function formatMinutes(minutes: number): string {
  const s = Math.round(minutes * 60);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

/**
 * The byte count of an output the details name by file — matched on either separator, because the
 * receipt records the path the PLATFORM wrote (`C:\…\badge.nc` on the Windows build) while the
 * details keep the bare file name the program was given.
 */
function bytesOf(receipt: Receipt, name: string): number | null {
  const exact = receipt.outputs.find(
    (o) => o.path === name || o.path.endsWith(`/${name}`) || o.path.endsWith(`\\${name}`),
  );
  return exact === undefined ? null : exact.bytes;
}

function findingsOf(receipt: Receipt, program: string): ReceiptDiagnostic[] {
  return receipt.diagnostics.filter((d) => d.program === program && d.source === 'findings');
}

function engraveLines(receipt: Extract<Receipt, { command: 'engrave' }>): string[] {
  const lines: string[] = [];
  const { details } = receipt;

  if (details.coupon !== null) {
    lines.push(
      `${details.coupon.title} — ${details.coupon.parameter} sweep over ${details.coupon.values.join(', ')}`,
      `${details.programs.length} program${details.programs.length === 1 ? '' : 's'} into ${details.outDir}`,
    );
  }

  for (const program of details.programs) {
    lines.push('', program.name);
    const ncBytes = bytesOf(receipt, program.ncFile);
    lines.push(`  file       ${program.ncFile}  (${ncBytes ?? '?'} bytes, ${program.ncLines} lines)`);
    if (program.frameFile !== null) {
      const frameBytes = bytesOf(receipt, program.frameFile);
      lines.push(`  frame      ${program.frameFile}  (${frameBytes ?? '?'} bytes)`);
    }
    lines.push(`  stage      ${program.stage}, ok=${program.ok}`);
    if (program.cam !== null) {
      const cam = program.cam;
      lines.push(
        `  cam        ${cam.operations} ops, ${cam.cuttingMoves} cutting moves, ` +
          `${cam.passes} passes, ~${Math.round(cam.estimatedSeconds)}s`,
      );
      if (cam.rapidMm !== null && cam.cutMm !== null && cam.baselineRapidMm !== null) {
        const ratio = (rapid: number): string => (cam.cutMm! > 0 ? `${(rapid / cam.cutMm!).toFixed(2)} : 1` : '—');
        lines.push(
          `  travel     ${cam.rapidMm.toFixed(1)} mm rapid / ${cam.cutMm.toFixed(1)} mm cut ` +
            `(${ratio(cam.rapidMm)}); pre-#487 order ${cam.baselineRapidMm.toFixed(1)} mm ` +
            `(${ratio(cam.baselineRapidMm)})`,
        );
      }
    }
    const findings = findingsOf(receipt, program.name);
    const errors = findings.filter((f) => f.severity === 'error');
    lines.push(`  findings   ${errors.length} error, ${findings.length - errors.length} warning`);
    for (const f of errors) lines.push(`     ERROR ${f.code}: ${f.message}`);
    for (const f of findings.filter((x) => x.severity === 'warning')) {
      lines.push(`     warn  ${f.code}: ${f.message}`);
    }
    for (const f of receipt.diagnostics.filter(
      (d) => d.program === program.name && d.source === 'verify' && d.severity === 'warning',
    )) {
      lines.push(`     warn  ${f.code}: ${f.message}`);
    }
    if (program.sim !== null) {
      const sim = program.sim;
      lines.push(
        `  sim        ok=${sim.ok}, engine=${sim.engine}, count=${sim.count}, ` +
          `removed=${sim.removedVolumeMm3 === null ? '?' : sim.removedVolumeMm3.toFixed(2)} mm³, ` +
          `${sim.errorCount} errors`,
      );
      for (const f of receipt.diagnostics.filter(
        (d) => d.program === program.name && d.source === 'simulation' && d.severity === 'warning',
      )) {
        lines.push(`     warn  ${f.code}: ${f.message}`);
      }
    }
    if (program.sheet !== null) {
      lines.push(
        `  sheet      ${program.sheet.file}  hash=${program.sheet.ncHash}  time=${program.sheet.estimatedTime}`,
      );
    }
    for (const preview of program.previews) {
      lines.push(`  preview    ${preview}  (the caller renders the PNG)`);
    }
  }

  if (details.pair !== null) {
    const pair = details.pair;
    lines.push(
      '',
      `  pair       ${pair.roughFile} (⌀${pair.roughDiameterMm} mm) then ${pair.restFile} ` +
        `(⌀${pair.restDiameterMm} mm) — the second program removed ` +
        `${pair.restRemovedVolumeMm3.toFixed(2)} mm³ on top of the first, and ` +
        `${pair.leftoverAreaMm2.toFixed(2)} mm² of the design is left standing between them.`,
    );
    if (pair.thirdToolShare !== null && pair.thirdToolThreshold !== null) {
      lines.push(
        `  leftover   ${(pair.thirdToolShare * 100).toFixed(2)} % of what the design asks for ` +
          `(threshold ${(pair.thirdToolThreshold * 100).toFixed(2)} %): ` +
          (pair.thirdToolSuggested
            ? 'a third cutter is suggested for it'
            : 'too small to act on — no third cutter suggested'),
      );
    }
  }

  for (const program of details.programs) {
    for (const image of program.images) {
      const bytes = bytesOf(receipt, image);
      lines.push(`  image      ${image}  (${bytes ?? '?'} bytes — the predicted cut at the real cutter width)`);
    }
  }

  if (details.coupon !== null) {
    lines.push(`  record     ${details.coupon.recordFile}  (${details.coupon.rowCount} row(s) to complete)`);
    lines.push(
      '',
      `receipt: ${details.programs.length} program(s), ${details.coupon.allOk ? 'all generated' : 'SOME STOPPED — see above'}`,
    );
  }

  // A run that stopped: the refusal block is the receipt's own summary, and the guide rows tell an
  // operator where to read next.
  if (!receipt.ok) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    for (const d of receipt.diagnostics.filter((x) => x.severity === 'error')) {
      lines.push(`  ERROR ${d.code}: ${d.message}`);
    }
    for (const refusal of receipt.refusals) {
      lines.push(`  !! ${refusal.reason}`);
    }
  }

  return lines;
}

function exportLines(receipt: Extract<Receipt, { command: 'export' }>): string[] {
  const stl = receipt.outputs.find((o) => o.path.endsWith('.stl'));
  const notes = receipt.outputs.find((o) => o.path.endsWith('-PRINT-NOTES.txt'));
  const name = stl === undefined ? 'the export' : stl.path.split(/[\\/]/).pop()!;
  const lines = [
    `${name}  ${receipt.details.triangles} triangles  ${((stl?.bytes ?? 0) / 1024).toFixed(1)} KB`,
  ];
  if (notes !== undefined) lines.push(`  notes      ${notes.path.split(/[\\/]/).pop()!}`);
  if (stl !== undefined) lines.push('', `Wrote ${stl.path}`);
  return lines;
}

function locationLines(receipt: Extract<Receipt, { command: 'location' }>): string[] {
  const { details } = receipt;
  const lines: string[] = [];
  if (details.document === null) {
    lines.push(
      'no location document — location.json and house.json are both absent; the built-in tiers are all this run has',
    );
    return lines;
  }
  const doc = details.document;
  const what = doc.kind === 'location' ? `location "${doc.name}"` : 'house';
  lines.push(
    `${what}: ${doc.path} — ${doc.tools} tool${doc.tools === 1 ? '' : 's'} ` +
      `from the user's own list, ${doc.inventory} owned cutter${doc.inventory === 1 ? '' : 's'}`,
  );
  if (details.records.length === 0) {
    lines.push(
      details.section === 'tools'
        ? '  (no tools or owned cutters in this document)'
        : details.section === 'stock'
          ? "  (no stock on this document's shelf)"
          : '  (no machines in this document)',
    );
    return lines;
  }
  for (const record of details.records) {
    lines.push(`  ${record.label.padEnd(10)} ${record.fields.join('  ')}`);
  }
  return lines;
}

function readbackLines(receipt: Extract<Receipt, { command: 'readback' }>): string[] {
  const { details } = receipt;
  const lines = [`${details.record}  ->  ${details.target}${details.dryRun ? '  (dry run)' : ''}`];
  if (details.feeds !== null) {
    const feeds = details.feeds;
    if (feeds.measurement !== null) {
      const m = feeds.measurement;
      lines.push(
        `  measurement  ${m.material} Ø${m.diameter} ${m.parameter} = ${m.value}  ` +
          `(coupon "${m.coupon}", cut ${m.on})`,
      );
    }
    if (feeds.row !== null) {
      const row = feeds.row;
      lines.push(`  row          ${row.material} ${row.minDiameter}-${row.maxDiameter} mm -> ${row.status}`);
      lines.push(`  provenance   ${row.provenance}`);
    }
    if (details.dryRun) lines.push('', '(dry run — feeds.ts not written)');
    else lines.push('', `wrote ${feeds.written ?? 0} measurement(s) into the feeds.ts region`);
    return lines;
  }
  const run = details.run;
  if (run === null) return lines;
  lines.push(`  run          ${run.job}  (${run.ncFile}, hash ${run.ncHash || 'unknown'})`);
  lines.push(
    `  measured     ${run.minutes === null ? 'no wall-clock time recorded' : formatMinutes(run.minutes)} ` +
      `on ${run.cutOn}${run.tool === null ? '' : `  ·  ${run.tool}`}`,
  );
  if (run.estimatedSeconds !== null) {
    const est = Math.round(run.estimatedSeconds);
    lines.push(
      `  estimate     ${formatMinutes(est / 60)} (${est} s) — the measured figure shows BESIDE it, never instead of it`,
    );
  }
  for (const d of run.depths) {
    lines.push(
      `  depth        ${d.name}: posted ${d.planned} mm` +
        (d.measured === null ? ', not measured' : `, measured ${d.measured} mm`),
    );
  }
  lines.push(
    `  outcome      ${run.legible === null ? 'legibility not recorded' : run.legible ? 'legible' : 'NOT legible'}` +
      ` · ${run.finish ?? 'finish not recorded'}` +
      (run.notes === '' ? '' : ` · “${run.notes}”`),
  );
  if (details.dryRun) lines.push('', '(dry run — runHistory.ts not written)');
  else {
    lines.push(
      '',
      `${run.replaced ? 'replaced' : 'added'} the record for ${run.ncFile}; ` +
        `${run.measuredRuns ?? 0} measured run(s) in the region`,
    );
  }
  return lines;
}

/**
 * The receipt as the lines a terminal shows. Every result line a command prints comes from here;
 * a command never formats its own. Callers print these with `console.log`.
 */
export function renderReceipt(receipt: Receipt): string[] {
  switch (receipt.command) {
    case 'engrave':
      return engraveLines(receipt);
    case 'export':
      return exportLines(receipt);
    case 'location':
      return locationLines(receipt);
    case 'readback':
      return readbackLines(receipt);
    case 'mcp':
      return mcpLines(receipt);
    case 'machine':
      return machineLines(receipt);
  }
}

/**
 * A machine command's own result (#477): the address it spoke to, then the section's facts. Every
 * line is built from the receipt, so `--json` and the terminal carry the same values.
 */
function machineLines(receipt: Extract<Receipt, { command: 'machine' }>): string[] {
  const { details } = receipt;
  const lines = [`machine ${details.section}  ok=${receipt.ok}`];
  if (details.host === null) lines.push(`  host       (nothing was sent)`);
  else lines.push(`  host       ${details.host}:${details.port}`);

  if (details.status !== null) {
    const status = details.status;
    lines.push(`  status     ${status.line ?? '(no reply)'}`);
    lines.push(`  state      ${status.state ?? '(none)'}`);
    if (status.percent === null && status.progressLine === null) lines.push('  progress   no P: field');
    else {
      lines.push(
        `  progress   line ${status.progressLine ?? '?'}, ${status.percent ?? '?'} %, ` +
          `${status.elapsedS ?? '?'} s`,
      );
    }
    lines.push(`  alarm      ${status.alarm ?? '(none)'}`);
    lines.push(
      status.finished
        ? '  job        finished — percent 100 and Idle'
        : status.percent === null
          ? '  job        no progress reported'
          : '  job        not finished yet',
    );
  }

  if (details.section === 'version') lines.push(`  version    ${details.version ?? '(no reply)'}`);

  for (const hash of details.hashes) {
    lines.push(
      hash.md5 === null
        ? `  file       ${hash.path}  (no digest — ${hash.detail ?? 'no reason given'})`
        : `  file       ${hash.path}  md5=${hash.md5}`,
    );
  }

  if (details.finished !== null) {
    lines.push(`  machine    ${details.finished.machine}`);
    if (details.finished.hashes.length === 0) lines.push('  finished   (no program has finished cleanly yet)');
    for (const hash of details.finished.hashes) lines.push(`  finished   ${hash}`);
  }

  if (details.action !== null) {
    const action = details.action;
    lines.push(`  confirm    ${action.confirm ?? '(none — --dry)'}`);
    if (action.programHash !== null) lines.push(`  program    ${action.programHash}`);
    if (action.ackCodes.length > 0) lines.push(`  cleared    ${action.ackCodes.join(', ')}`);
    if (action.path !== null) lines.push(`  path       ${action.path}`);
    if (action.dryRun) {
      lines.push('  sent       (dry run — nothing was sent)');
      if (action.programHash !== null) {
        lines.push(`  next       re-run with --confirm ${action.programHash} to send it`);
      }
    } else if (action.sent !== null) lines.push(`  sent       ${action.sent}`);
    if (action.alreadyPresent) lines.push('  note       the card already held identical bytes — nothing was rewritten');
  }

  if (details.probe !== null) {
    const probe = details.probe;
    lines.push(
      `  probe      ${
        probe.prb === null
          ? 'the reply carried no [PRB:…] reading'
          : `x ${probe.prb.x}, y ${probe.prb.y}, z ${probe.prb.z} — ` +
            (probe.prb.touched ? 'touched' : 'NO touch (it travelled its whole distance)')
      }`,
    );
  }

  for (const refusal of receipt.refusals) lines.push(`  !! ${refusal.reason}`);
  return lines;
}

/**
 * An MCP tool's own result: the tool, its document if it wrote one, and the ids it produced. The
 * client normally reads `structuredContent`; these lines exist so a receipt is never a shape the
 * one renderer cannot state.
 */
function mcpLines(receipt: Extract<Receipt, { command: 'mcp' }>): string[] {
  const { details } = receipt;
  const lines = [`mcp ${details.tool}  ok=${receipt.ok}`];
  if (details.document !== null) lines.push(`  document   ${details.document}`);
  for (const item of details.items) lines.push(`  item       ${item}`);
  for (const refusal of receipt.refusals) lines.push(`  !! ${refusal.reason}`);
  return lines;
}

/** The provenance of a shop default, mapped to the receipt's four sources (#478). */
export function provenanceForDefault(
  name: string,
  value: number,
  unit: string | null,
  source: 'seeded' | 'chosen' | 'measured' | 'fallback' | 'user',
): ReceiptProvenance {
  switch (source) {
    case 'user':
      return provenance(name, value, unit, 'typed');
    case 'measured':
      return provenance(name, value, unit, 'measured');
    case 'seeded':
    case 'chosen':
      return provenance(name, value, unit, 'located');
    case 'fallback':
      return provenance(name, value, unit, 'seeded');
  }
}
