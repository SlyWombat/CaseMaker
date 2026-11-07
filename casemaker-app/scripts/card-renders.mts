/**
 * #972 — THE STANDING PICTURE SET. One command turns the #959/#965 acceptance run's own outputs
 * into the same pictures for every scored sha, committed beside it:
 *
 *   npx tsx scripts/card-renders.mts <out-dir> <sha> [--figures-out <dir>] [--vendor-dir <dir>]
 *                                    [--card <name> …] [--section <card>:<axis>=<mm> …]
 *
 * `<out-dir>` is where `tests/unit/opsAcceptance959.spec.ts` wrote its `<card>-plan.json` /
 * `<card>-pics.json` (CM_959_OUT); `--figures-out` is the #965 run's (CM_965_OUT), for the elephant
 * and the panther. The pictures land in `docs/bench/img/cards/<sha>/<card>/` and are produced by
 * `tests/tools/acceptancePics.ts` from the gate's own planning artefacts — nothing is planned,
 * swept or re-measured here.
 *
 * Every picture carries the sha, the card row and the gate's SIMULATOR_VERSION in its caption, so
 * two shas' sets are comparable file by file. The named sections are the team's standing lines —
 * the organizer at y = 89.5 and the tray at y = 114.6 — drawn at the same coordinate on every sha
 * instead of at the current worst cell.
 *
 * NOT IN THE VITEST RUN: this reads the acceptance's outputs and writes image files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIMULATOR_VERSION } from '../src/workers/geometry/simVersion';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPO = resolve(APP, '..');
const RENDERER = join(APP, 'tests', 'tools', 'acceptancePics.ts');

/** The card rows the #959 acceptance writes, in the page's own order. */
const ROWS = ['tray', 'tray-stl', 'organizer', 'organizer-stl'] as const;
/** The #965 figures. */
const FIGURES = ['elephant', 'panther'] as const;
/** The vendor's NC per row pair, resolved by file name from the Makerables evaluation downloads. */
const VENDOR_NC: Record<string, string> = {
  tray: 'Tool_Tray_70mm_Top-msfi5w1b.nc',
  'tray-stl': 'Tool_Tray_70mm_Top-msfi5w1b.nc',
  organizer: 'Tool_Organizer_Z1-msfh3m77.nc',
  'organizer-stl': 'Tool_Organizer_Z1-msfh3m77.nc',
};
/** The team's standing section lines: the coordinate is part of the evidence, not of the moment. */
const STANDING_SECTIONS: { match: (card: string) => boolean; axis: 'x' | 'y'; mm: number }[] = [
  { match: (c) => c.includes('organizer'), axis: 'y', mm: 89.5 },
  { match: (c) => c.includes('tray'), axis: 'y', mm: 114.6 },
];

function parseArgs(argv: readonly string[]) {
  const positional: string[] = [];
  const cards: string[] = [];
  const sections: { card: string; axis: 'x' | 'y'; mm: number }[] = [];
  let figuresOut: string | null = null;
  let vendorDir: string | null = process.env.CM_MAKERABLES ?? null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--figures-out') figuresOut = argv[++i] ?? null;
    else if (a === '--vendor-dir') vendorDir = argv[++i] ?? null;
    else if (a === '--card') cards.push(argv[++i]!);
    else if (a === '--section') {
      const v = argv[++i]!;
      const m = /^([\w.-]+):([xy])=(-?\d+(?:\.\d+)?)$/.exec(v);
      if (m === null) throw new Error(`--section ${v}: expected <card>:<axis>=<mm>`);
      sections.push({ card: m[1]!, axis: m[2] as 'x' | 'y', mm: Number(m[3]) });
    } else positional.push(a);
  }
  const [outDir, sha] = positional;
  if (outDir === undefined || sha === undefined) {
    throw new Error(
      'usage: card-renders.mts <out-dir> <sha> [--figures-out <dir>] [--vendor-dir <dir>] [--card <name> …] [--section <card>:<axis>=<mm> …]',
    );
  }
  return { outDir, sha, figuresOut, vendorDir, cards, sections };
}

/** The first file under `root` with this name, or null. */
function findFile(root: string | null, name: string): string | null {
  if (root === null || !existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit !== null) return hit;
    } else if (entry.name === name) return p;
  }
  return null;
}

function render(card: string, plan: string, pics: string, dest: string, vendor: string | null, sections: { axis: 'x' | 'y'; mm: number }[]): void {
  mkdirSync(dest, { recursive: true });
  const titleExtra = `sha ${args.sha} · ${card} · SIMULATOR_VERSION ${SIMULATOR_VERSION}`;
  const argv = [
    '--no-install',
    'tsx',
    '--tsconfig',
    'tsconfig.app.json',
    RENDERER,
    '--plan',
    plan,
    '--pics',
    pics,
    '--out',
    dest,
    '--title-extra',
    titleExtra,
  ];
  for (const s of sections) {
    // The named line keeps the team's coordinate; the renderer marks the worst cell along it.
    argv.push('--section', `section-${s.axis}${s.mm}:${s.axis}=${s.mm}`);
  }
  if (vendor !== null) argv.push('--vendor', vendor);
  execFileSync('npx', argv, { cwd: APP, stdio: 'inherit' });
}

const args = parseArgs(process.argv.slice(2));
const destRoot = join(REPO, 'docs', 'bench', 'img', 'cards', args.sha);
const want = (card: string): boolean => args.cards.length === 0 || args.cards.includes(card);
/** Every set's status, written beside them: a row whose inputs are absent is STATED, never skipped silently. */
const status: { card: string; state: 'rendered' | 'missing inputs'; detail: string }[] = [];
const startedAt = Date.now();
const sectionsFor = (card: string): { axis: 'x' | 'y'; mm: number }[] => {
  const explicit = args.sections.filter((s) => s.card === card).map((s) => ({ axis: s.axis, mm: s.mm }));
  const standing = STANDING_SECTIONS.filter((s) => s.match(card)).map((s) => ({ axis: s.axis, mm: s.mm }));
  return [...standing, ...explicit];
};

let made = 0;
for (const card of ROWS) {
  if (!want(card)) continue;
  const plan = join(args.outDir, `${card}-plan.json`);
  const pics = join(args.outDir, `${card}-pics.json`);
  if (!existsSync(plan) || !existsSync(pics)) {
    process.stdout.write(`${card}: no plan/pics in ${args.outDir} — not rendered\n`);
    status.push({ card, state: 'missing inputs', detail: `no \`${card}-plan.json\` / \`${card}-pics.json\` in \`${args.outDir}\`` });
    continue;
  }
  const vendorName = VENDOR_NC[card];
  const vendor = args.vendorDir === null || vendorName === undefined ? null : findFile(args.vendorDir, vendorName);
  render(card, plan, pics, join(destRoot, card), vendor, sectionsFor(card));
  status.push({ card, state: 'rendered', detail: vendor === null ? 'vendor NC not found — the plan panel is ours alone' : 'vendor NC beside ours' });
  made++;
}
if (args.figuresOut !== null) {
  for (const figure of FIGURES) {
    if (!want(figure)) continue;
    const plan = join(args.figuresOut, `${figure}-plan.json`);
    const pics = join(args.figuresOut, `${figure}-pics.json`);
    if (!existsSync(plan) || !existsSync(pics)) {
      process.stdout.write(`${figure}: no plan/pics in ${args.figuresOut} — not rendered\n`);
      status.push({ card: figure, state: 'missing inputs', detail: `no \`${figure}-plan.json\` / \`${figure}-pics.json\` in \`${args.figuresOut}\` (the local-only figure meshes are not on this machine)` });
      continue;
    }
    render(figure, plan, pics, join(destRoot, figure), null, sectionsFor(figure));
    made++;
  }
}
{
  // THE SET'S OWN INDEX: the command line, the sha, the gate version, each row's state (a row whose
  // inputs are absent is stated here — the set never silently loses a card), and the wall time.
  const lines = [
    `# The standing picture set — ${args.sha}`,
    '',
    `- SIMULATOR_VERSION: ${SIMULATOR_VERSION}`,
    `- command: \`npx tsx scripts/card-renders.mts ${process.argv.slice(2).join(' ')}\``,
    `- wall: ${((Date.now() - startedAt) / 1000).toFixed(0)} s for ${made} set(s)`,
    '',
    '| card | state | detail |',
    '|---|---|---|',
    ...status.map((s) => `| ${s.card} | ${s.state} | ${s.detail} |`),
    '',
  ];
  mkdirSync(destRoot, { recursive: true });
  writeFileSync(join(destRoot, 'index.md'), lines.join('\n'));
}
process.stdout.write(`card-renders: ${made} set(s) under ${destRoot} (${((Date.now() - startedAt) / 1000).toFixed(0)} s)\n`);
