/**
 * #788 — THE HEAD DIAGRAM, DRAWN: which connector the probe cable goes into, for the probe this
 * job will use.
 *
 * An operator fitting the 3D probe for the first time found two ports on the right side of the
 * spindle housing and put the probe cable into the 3-pin ionizer port. The controller's probe
 * input stayed at 0 and the probe was invisible to the firmware; nothing in the app, Studio or the
 * firmware says which port is which (bench 2026-10-30, `docs/bench/2026-10-30-3d-probe-survey.md`).
 *
 * THE DIAGRAM FOLLOWS THE JOB'S PROBE (review 2026-10-31). A job that registers with the wired
 * probe V2 must not be told to unplug it and fit the 3D probe cable — following that would unplug
 * the probe the job uses. So the drawing names the instrument the machine has checked out:
 * `xyz` is the Makera 3D probe (Studio's T8888), whose cable replaces the wired probe's; `z-only`
 * is the wired probe V2 (T9999), which plugs in and stays. A job with no probe checked out shows
 * no diagram at all — the Cut step must not carry a picture on every job.
 *
 * It is generated as a standalone SVG string so the live panel and the printed run sheet draw the
 * same picture, the way the cutter profile does (#489): `size: 'panel'` uses the app's
 * light-on-dark palette, `size: 'print'` is monochrome ink on paper.
 *
 * Sources: Makera's 3D Probe quick start, step 3 — "Unplug the wired probe connector and connect
 * the 3D probe cable" (wiki `Makera-Accessories/Makera-3D-Probe`, cached at
 * `docs/market-research/raw/makera/Makera-3D-Probe.txt`; the printed leaflet's connector diagram is
 * `docs/bench/img/2026-10-18-makera-3d-probe-quick-start.jpg`). The ionizer port is the one the
 * Ionizer page names: "the 3-pin port on the right side of the spindle" (`Z1-Accessories-Ionizer.txt`).
 */

export type ProbeFitDiagramSize = 'panel' | 'print';

/**
 * The probe the diagram is drawn for: `xyz` is the Makera 3D probe, `z-only` the wired probe V2.
 * These are the registration engine's own instrument words (#525), so the picture cannot disagree
 * with the plan.
 */
export type ProbeFitInstrument = 'xyz' | 'z-only';

/** Makera's 3D Probe quick start, step 3 — shown only when the job uses the 3D probe. */
export const PROBE_FIT_LINE = 'Unplug the wired probe connector and connect the 3D probe cable.';

/** The wired probe V2's own line — it plugs in and stays. */
export const PROBE_FIT_WIRED_LINE = 'Plug the wired probe in here.';

/** The same connector serves every probe Makera sells for the Z1. */
export const PROBE_FIT_ALL = 'The wired probe V2, the 3D probe and the 3D Probe Rod all use this one connector.';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface Ink {
  ink: string;
  fill: string;
  muted: string;
  good: string;
  bad: string;
}

function inkFor(size: ProbeFitDiagramSize): Ink {
  return size === 'print'
    ? { ink: '#111111', fill: '#ffffff', muted: '#555555', good: '#111111', bad: '#111111' }
    : { ink: '#dbe4ee', fill: '#0f1419', muted: '#93a1b1', good: '#49d17d', bad: '#f0736a' };
}

function text(
  x: number,
  y: number,
  body: string,
  opts: { size?: number; colour: string; weight?: number; anchor?: 'start' | 'middle' | 'end' },
): string {
  const anchor = opts.anchor ?? 'start';
  return (
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="ui-sans-serif, system-ui, sans-serif" ` +
    `font-size="${opts.size ?? 12}" font-weight="${opts.weight ?? 400}" fill="${opts.colour}">${esc(body)}</text>`
  );
}

/** What the socket's own label says, for the instrument the job uses. */
function socketLine(instrument: ProbeFitInstrument): string {
  return instrument === 'xyz' ? '3D probe cable in here' : 'wired probe in here';
}

/**
 * The diagram as a standalone SVG string, for the probe the job will use. `panel` is for the live
 * UI (the app's light ink on the dark page); `print` is the run sheet's monochrome, where the word
 * labels carry the meaning.
 */
export function probeFitDiagramSvg(size: ProbeFitDiagramSize, instrument: ProbeFitInstrument): string {
  const c = inkFor(size);
  const font = 12;
  const line = socketLine(instrument);
  const caption = instrument === 'xyz' ? `${PROBE_FIT_LINE} ${PROBE_FIT_ALL}` : PROBE_FIT_WIRED_LINE;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 236" class="probe-fit-svg probe-fit-svg--${size} probe-fit-svg--${instrument}" ` +
      `role="img" aria-label="${esc(`The spindle head from the right: ${line} at the probe connector, not the 3-pin ionizer port. ${caption}`)}">`,
  );
  parts.push(`<title>Which connector the probe cable goes into</title>`);

  // ---- the head, from the right ------------------------------------------------------------
  parts.push(`<g stroke="${c.ink}" fill="none" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`);
  parts.push(`<rect x="16" y="24" width="118" height="150" rx="12" fill="${c.fill}" />`);
  parts.push(`<rect x="54" y="168" width="42" height="14" rx="3" fill="${c.fill}" />`);
  parts.push(`<path d="M58 182 L92 182 L86 210 L64 210 Z" fill="${c.fill}" />`);
  parts.push(`<rect x="132" y="66" width="8" height="20" rx="1.5" fill="${c.fill}" />`);
  parts.push(`<rect x="132" y="116" width="8" height="20" rx="1.5" fill="${c.fill}" />`);
  parts.push('</g>');
  parts.push(`<path d="M75 10 L75 220" stroke="${c.muted}" stroke-width="0.8" stroke-dasharray="4 4" opacity="0.6" />`);
  parts.push(text(75, 228, 'spindle head, from the right', { colour: c.muted, size: font - 1, anchor: 'middle' }));

  // ---- the two connectors, enlarged --------------------------------------------------------
  parts.push(
    `<rect x="176" y="28" width="268" height="160" rx="10" fill="none" stroke="${c.ink}" stroke-width="1" stroke-dasharray="5 4" opacity="0.8" />`,
  );
  parts.push(text(310, 46, 'right side of the head, enlarged', { colour: c.muted, size: font - 1, anchor: 'middle' }));

  // The IONIZER port: three pins, crossed out, "not this one".
  parts.push(`<rect x="204" y="60" width="62" height="42" rx="4" fill="${c.fill}" stroke="${c.ink}" stroke-width="1.2" />`);
  for (const px of [220, 235, 250]) {
    parts.push(`<circle cx="${px}" cy="81" r="3" fill="none" stroke="${c.ink}" stroke-width="1.1" />`);
  }
  parts.push(
    `<g stroke="${c.bad}" stroke-width="2.2" stroke-linecap="round"><path d="M204 60 L266 102" /><path d="M266 60 L204 102" /></g>`,
  );
  parts.push(`<path d="M268 81 L276 81" stroke="${c.bad}" stroke-width="1.2" />`);
  parts.push(text(280, 77, '3-pin ionizer port', { colour: c.bad, size: font, weight: 600 }));
  parts.push(text(280, 93, 'not this one', { colour: c.bad, size: font, weight: 700 }));

  // The PROBE connector: a socket with the cable in it, named for the job's instrument.
  parts.push(`<rect x="204" y="118" width="62" height="42" rx="4" fill="${c.fill}" stroke="${c.good}" stroke-width="1.6" />`);
  parts.push(`<circle cx="235" cy="139" r="10" fill="none" stroke="${c.good}" stroke-width="1.6" />`);
  parts.push(`<circle cx="235" cy="139" r="3" fill="${c.good}" />`);
  parts.push(
    `<path d="M245 139 C 258 139, 262 150, 274 150 L 282 150" fill="none" stroke="${c.good}" stroke-width="3" stroke-linecap="round" />`,
  );
  parts.push(`<path d="M268 139 L276 139" stroke="${c.good}" stroke-width="1.2" />`);
  parts.push(text(280, 135, 'probe connector', { colour: c.good, size: font, weight: 600 }));
  parts.push(text(280, 151, line, { colour: c.good, size: font, weight: 700 }));

  // The check on the probe side, drawn rather than typed so it survives every font.
  parts.push(`<path d="M396 131 L401 136 L410 124" fill="none" stroke="${c.good}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />`);

  // Zoom hint: the two enlarged ports belong to the two nubs on the head.
  parts.push(
    `<g stroke="${c.muted}" stroke-width="0.7" stroke-dasharray="3 3" opacity="0.7"><path d="M140 76 L204 70" /><path d="M140 126 L204 130" /></g>`,
  );

  parts.push('</svg>');
  return parts.join('');
}
