// #732, bullet 4 of the off-bench exercise (`docs/bench/2026-10-27-z1-typical-jobs`): the metal-line
// finding refused the metal O-flute on PLA ("tool-metal-line"), while Makera rates that same bit for
// plastic at 10000/1000/300/1 (the manifest's j01-proxy note). The rule the app enforces — "a metal
// line cuts metal, not plastic" — is a fact about MAKERA'S OWN pairing, so a catalogue row that lists
// this exact cutter for a plastic DISPROVES the premise. The finding must then stand down, and the
// job must take the vendor's plastic numbers.
//
// This is deliberately a pipeline test: the defect was not the predicate alone but the sentence the
// run showed, so it goes through `engraveRegions` (findings) and `feedsFor` (the answer) with the
// bench job's own file. The catalogue rows are HAND-BUILT fixtures in the service's shape; no number
// is read from Studio's database (`/Fabrication.md` §3, #186).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogueCoverageFor, feedsFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { Z1 } from '@/engine/cnc/machine';
import { withMakeraId } from '@/engine/cnc/registerCutter';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import { engraveRegions } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';

const JOBS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs');
const job = JSON.parse(readFileSync(join(JOBS, 'j01-topclamp-alu-proxy.json'), 'utf8')) as EngraveJob;

/** The house's metal O-flute 3.175 × 12, as its printed label materialises it: `id: null`. */
const tool = (id: string | null): Tool => ({
  number: null,
  id,
  name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 3.175mm * 12mm',
  typeText: 'Flat End',
  shape: 'flat',
  handleDiameter: 3.175,
  tipDiameter: 3.175,
  diameter: 3.175,
  cornerRadius: 0,
  angle: null,
  halfAngle: null,
  fluteLength: 12,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

/** Makera's g_ID for that bit — the same real id j01's aluminium `.nc` header carries. */
const G_METAL_FLAT_3_175_12 = '112111313812';

/** Makera's plastic row for it, as the manifest records the proxy's expected answer. */
const CATALOGUE: readonly FeedCatalogueRow[] = [
  { cutterId: G_METAL_FLAT_3_175_12, material: 'ABS', rpm: 10000, feed: 1000, plungeFeed: 300, stepDown: 1 },
];

const metalLineFindings = (cutter: Tool) =>
  engraveRegions(tl, job, cutter, effectiveMargins(job, MARGIN_DEFAULTS), {}, Z1, CATALOGUE).findings.filter(
    (f) => f.code === 'tool-metal-line',
  );

describe('#732 the metal line stands down when Makera itself lists the cutter for a plastic', () => {
  it('the proxy job is PLA, and the unconfirmed cutter is still refused by the metal-line finding', () => {
    expect(job.stock.material).toBe('pla');
    expect(metalLineFindings(tool(null))).toHaveLength(1);
  });

  it('after the operator confirms the Makera id, the finding is gone and Makera’s plastic numbers answer', () => {
    const confirmed = withMakeraId(
      {
        id: 'kz-o-flute-m-3-175-12',
        tool: tool(null),
        origin: null,
        quantity: 1,
        codes: [{ symbology: 'qr', value: 'C1-BIT-O-FLUTE-M-3.175-12' }],
        addedAt: '2026-10-12T00:00:00.000Z',
        notes: null,
        copies: [],
        colletFits: null,
      },
      G_METAL_FLAT_3_175_12,
    );
    expect(metalLineFindings(confirmed.tool)).toHaveLength(0);
    // A `covered` pairing — the direct row or the app's plastic→ABS/acrylic mapping — is what the
    // finding consults; without it the finding above stands.
    expect(catalogueCoverageFor(CATALOGUE, job.stock.material, confirmed.tool).kind).toBe('covered');

    const res = feedsFor(CATALOGUE, job.stock.material, confirmed.tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(10000);
    expect(res.params.feed).toBe(1000);
    expect(res.params.plungeFeed).toBe(300);
    expect(res.params.stepDown).toBe(1);
    expect(res.provenance).toContain('row standing in');
  });
});
