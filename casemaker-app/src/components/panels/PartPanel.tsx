import type React from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  badgeParamsProblem,
  blankParamsProblem,
  defaultBadgeParams,
  type BadgeMagnetPocket,
  type BadgeParams,
  type BlankParams,
} from '@/types';
import type { EngraveJob } from '@/types/engraveJob';
import { LabelledField } from '@/components/ui/LabelledField';
import { derivedKind } from '@/engine/compiler/archetype';
import { BADGE_POCKET_KEEP_OUT_ID, badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { blankStockFor } from '@/engine/cnc/engrave/fromBlank';

/**
 * The board-less part editor (issue #282) — a name badge (#167) or a bare blank (#280).
 *
 * Before this, `case.badge` and `case.blank` were written once by their template's `casePatch` and
 * never again: the wizard could create either one and there was no way on earth to adjust it, even
 * though `badgeParamsProblem`/`blankParamsProblem` were already raising errors about numbers the
 * user could not reach. This panel is that missing repair path.
 *
 * Two things it deliberately is NOT:
 *
 *   - it is not an enclosure panel. `CasePanel` edits walls and lids; a badge and a blank have
 *     neither. The rail gives these two archetypes a `part` section instead, and this panel is the
 *     only thing in it.
 *   - it does not own the ENGRAVE JOB's setup. By #280's rule the project owns the part's geometry
 *     and the job owns the setup, so editing the part here never writes to the job — it says when
 *     the job's stock is a stale hand-off from this part, and points at the bridge that fixes it.
 *
 * IMPORTANT: `patchCase` validates with a TOP-LEVEL partial only, so every update sends the
 * COMPLETE `badge`/`blank` object — never a nested fragment.
 *
 * Sizes are phrased in the part's own physical terms, and the numbers in the quick-adds are named
 * by what they fit (a card outline, a magnet you can buy), because those are the landmarks a user
 * with calipers actually has. Nothing here is phrased in the compiler's frame.
 */
const ROW: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  marginBottom: 6,
  flexWrap: 'wrap',
};
const NUM: React.CSSProperties = { width: 72 };
const SUBHEAD: React.CSSProperties = { margin: '14px 0 6px', fontSize: 13, fontWeight: 600 };
const HINT: React.CSSProperties = { fontSize: 12, color: '#9aa4b0', margin: '2px 0 0' };
const PROBLEM: React.CSSProperties = {
  fontSize: 12,
  color: '#e0b060',
  border: '1px solid #3a3320',
  background: '#221d12',
  borderRadius: 4,
  padding: '6px 8px',
  margin: '2px 0 6px',
};
const STALE: React.CSSProperties = { ...PROBLEM, color: '#8fb4e0', borderColor: '#26364a', background: '#151d27' };
const PRESET_ACTIVE: React.CSSProperties = { borderColor: '#5b8def', color: '#cfe0ff', fontWeight: 600 };

/* ── quick-adds ────────────────────────────────────────────────────────────────────────────────
 * The house rule is fix the default before adding a control, and each archetype's template default
 * is already the honest one — so these are the second-most-likely answers, not a ladder of guesses.
 * Every one of them is a set of REAL dimensions (a card outline, a magnet you can buy), and the
 * raw numbers sit beside them for everything else.
 */
const BADGE_SIZES = [
  { label: '76.2 × 38.1', width: 76.2, height: 38.1, hint: '3 × 1.5 in — the blank the template was cut from' },
  { label: '85.6 × 54', width: 85.6, height: 54, hint: 'ID-1 — the credit-card outline' },
  { label: '90 × 50', width: 90, height: 50, hint: 'A common plastic-card badge' },
];

const MAGNET_PRESETS = [
  { label: '45 × 13 × 2.3', length: 45, width: 13, depth: 2.3, hint: 'The template’s bar magnet' },
  { label: '20 × 20 × 3', length: 20, width: 20, depth: 3, hint: 'A ⌀20 × 3 mm disc, in a square pocket' },
  { label: '15 × 15 × 2', length: 15, width: 15, depth: 2, hint: 'A ⌀15 × 2 mm disc, in a square pocket' },
];

/** What the magnet checkbox turns back on: the template's own pocket, read from
 *  `defaultBadgeParams` rather than typed a second time, so the two cannot drift apart. */
const DEFAULT_MAGNET: BadgeMagnetPocket = defaultBadgeParams().magnetPocket ?? {
  length: 45,
  width: 13,
  depth: 2.3,
};

const BLANK_SIZES = [
  { label: '100 × 60', width: 100, height: 60, hint: 'The template’s blank — a common hobby size' },
  { label: '85.6 × 54', width: 85.6, height: 54, hint: 'ID-1 — the credit-card outline' },
  { label: '105 × 148', width: 105, height: 148, hint: 'A6 — the postcard blank' },
];

/* ── the stale hand-off ────────────────────────────────────────────────────────────────────────
 * #282's own second consequence: "the two can silently disagree". They disagree in one direction
 * only — the part moves, the job's stock does not — and the job's per-field provenance (#254) is
 * exactly what tells a stale hand-off from the user's own answer. A field the user typed or
 * measured is the JOB's business (#280) and is never called stale here.
 */
const STOCK_FIELDS = ['length', 'width', 'thickness'] as const;

function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

function staleStockLines(
  job: EngraveJob,
  wanted: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness'>,
  bridge: string,
): string[] {
  const sources = job.sources?.stock ?? {};
  const moved = STOCK_FIELDS.filter(
    (f) => sources[f] === 'computed' && Math.abs(job.stock[f] - wanted[f]) > 1e-6,
  );
  if (moved.length === 0) return [];
  const detail = moved.map((f) => `${f} ${mm(job.stock[f])} → ${mm(wanted[f])} mm`).join(', ');
  return [
    `The engrave job’s stock was taken from this part and no longer matches it (${detail}). ` +
      `Press “${bridge}” in Engrave text to take the new numbers across.`,
  ];
}

export function PartPanel() {
  const project = useProjectStore((s) => s.project);
  const archetype = useProjectStore((s) => derivedKind(s.project));

  if (!project) return null;
  const { badge, blank } = project.case;
  // The archetype decides which one is the part, exactly as it decides what compiles: `badge`
  // outranks `blank`, so a project with both enabled is a badge project (archetype.ts).
  if (archetype === 'badge' && badge) return <BadgeEditor badge={badge} />;
  if (archetype === 'blank' && blank) return <BlankEditor blank={blank} />;

  return (
    <div className="panel-stack" data-testid="part-panel-empty">
      <p style={HINT}>
        This project has no badge or blank part to edit. The Part section appears for the two
        board-less archetypes — start a “Name badge blank” or “Blank” project to get one.
      </p>
    </div>
  );
}

/* ── the name badge (#167) ─────────────────────────────────────────────────────────────────── */

function BadgeEditor({ badge }: { badge: BadgeParams }) {
  const patchCase = useProjectStore((s) => s.patchCase);
  const job = useEngraveJobStore((s) => s.job);

  /** Complete object, always — see the note at the top of this file. */
  const update = (partial: Partial<BadgeParams>): void => {
    patchCase({ badge: { ...badge, ...partial } });
  };
  const setPocket = (pocket: BadgeMagnetPocket | null): void => update({ magnetPocket: pocket });
  const pocket = badge.magnetPocket;
  const problem = badgeParamsProblem(badge);

  // The job notes come from the same pure bridge the Engrave panel's button calls, so this panel
  // cannot drift from what that button would do — it deliberately does not re-derive the mapping.
  const wanted = badgeBlankFor(badge);
  const stale = staleStockLines(job, wanted.stock, 'Use the badge blank');
  const jobPocket = job.keepOuts?.find((k) => k.id === BADGE_POCKET_KEEP_OUT_ID);
  // A badge's pocket is a rectangle by construction, so a same-id void of any other kind is one
  // this badge cannot be describing: treated below as "no matching void", not read field-wise.
  const jobRect = jobPocket?.kind === 'rect' ? jobPocket : null;
  // `badgeBlankFor` emits the pocket as a rectangle, always — so this narrows a type, not a case.
  const wantedPocket = wanted.pocket?.kind === 'rect' ? wanted.pocket : null;

  // The pocket is only this badge's business once the job has actually taken the badge's blank.
  // Before that the job is just a job — nagging a brand-new badge project about a void it has not
  // been asked for yet would be noise, and the note would be about a bridge that never ran.
  const bridged = STOCK_FIELDS.some((f) => (job.sources?.stock ?? {})[f] === 'computed');

  if (!bridged) {
    // nothing to say: the stock note above already fires only on a hand-off.
  } else if (wanted.pocket && !jobRect) {
    stale.push(
      'This badge has a magnet pocket and the engrave job declares no matching void for it. Press ' +
        '“Use the badge blank” to declare it, or the cutter will gouge the pocket.',
    );
  } else if (wantedPocket && jobRect) {
    const moved =
      Math.abs(jobRect.width - wantedPocket.width) > 1e-6 ||
      Math.abs(jobRect.height - wantedPocket.height) > 1e-6 ||
      Math.abs(jobRect.zCeiling - wantedPocket.zCeiling) > 1e-6;
    if (moved) {
      stale.push(
        `The engrave job declares a ${mm(jobRect.width)} × ${mm(jobRect.height)} mm pocket ${mm(
          jobRect.zCeiling,
        )} mm deep; this badge’s is ${mm(wantedPocket.width)} × ${mm(wantedPocket.height)} mm, ${mm(
          wantedPocket.zCeiling,
        )} mm deep. Press “Use the badge blank” to restate it.`,
      );
    }
  } else if (jobPocket) {
    stale.push(
      'The engrave job still declares a magnet pocket this badge no longer has. Press “Use the ' +
        'badge blank” to clear it.',
    );
  }

  return (
    <div className="panel-stack" data-testid="part-panel">
      <p style={HINT}>
        The two-colour badge blank itself: its outline, where the colour changes, and the magnet
        that holds it on. The name goes on in Engrave text.
      </p>

      <h3 style={SUBHEAD}>Outline</h3>
      <LabelledField
        label="Size"
        unit="mm"
        hint="The badge’s overall length (X) and width (Y), as the finished part measures — not the engraved area."
      >
        <div style={ROW}>
          <input
            type="number"
            min={1}
            step={0.1}
            value={badge.width}
            data-testid="badge-width"
            aria-label="Badge length"
            style={NUM}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            min={1}
            step={0.1}
            value={badge.height}
            data-testid="badge-height"
            aria-label="Badge width"
            style={NUM}
            onChange={(e) => update({ height: Number(e.target.value) })}
          />
        </div>
      </LabelledField>
      <div style={ROW}>
        {BADGE_SIZES.map((p) => {
          const active = badge.width === p.width && badge.height === p.height;
          return (
            <button
              key={p.label}
              type="button"
              title={p.hint}
              data-testid={`badge-size-${p.width}x${p.height}`}
              aria-pressed={active}
              style={active ? PRESET_ACTIVE : undefined}
              onClick={() => update({ width: p.width, height: p.height })}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <LabelledField
        label="Corner radius"
        unit="mm"
        hint="Rounding on the outline’s four corners. 0 gives square corners."
      >
        <input
          type="number"
          min={0}
          step={0.1}
          value={badge.cornerRadius}
          data-testid="badge-corner-radius"
          style={NUM}
          onChange={(e) => update({ cornerRadius: Number(e.target.value) })}
        />
      </LabelledField>

      <h3 style={SUBHEAD}>Colour change</h3>
      <LabelledField
        label="Thickness"
        unit="mm"
        hint="Back face to engraved face. The badge prints flipped — engraved face down on the bed."
      >
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={badge.thickness}
          data-testid="badge-thickness"
          style={NUM}
          onChange={(e) => update({ thickness: Number(e.target.value) })}
        />
      </LabelledField>
      <LabelledField
        label="Split height"
        unit="mm"
        hint="How far the bottom colour rises from the back face — the height at which the printer swaps filament. It must stay below the thickness, and above the magnet pocket’s roof."
      >
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={badge.splitHeight}
          data-testid="badge-split"
          style={NUM}
          onChange={(e) => update({ splitHeight: Number(e.target.value) })}
        />
      </LabelledField>
      {/* Two named fields rather than a `2 then 3` row: which colour goes on which tool is exactly
          the thing a multi-tool printer's owner gets wrong, so neither number is left unlabelled. */}
      <LabelledField
        label="Bottom colour"
        unit="extruder"
        hint="Which tool prints the bottom colour — the back face and everything up to the split. The template’s 2 is the machine its sample was sliced on; set your printer’s own tool number here, 0 on most."
      >
        <input
          type="number"
          min={0}
          step={1}
          value={badge.bottomExtruder}
          data-testid="badge-bottom-extruder"
          style={NUM}
          onChange={(e) => update({ bottomExtruder: Number(e.target.value) })}
        />
      </LabelledField>
      <LabelledField
        label="Top colour"
        unit="extruder"
        hint="Which tool prints the top colour — the engraved face, above the split. The template’s 3 is the machine its sample was sliced on; 1 on most printers."
      >
        <input
          type="number"
          min={0}
          step={1}
          value={badge.topExtruder}
          data-testid="badge-top-extruder"
          style={NUM}
          onChange={(e) => update({ topExtruder: Number(e.target.value) })}
        />
      </LabelledField>

      <h3 style={SUBHEAD}>Magnet</h3>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <input
          type="checkbox"
          checked={pocket !== null}
          data-testid="badge-pocket-on"
          onChange={(e) => setPocket(e.target.checked ? { ...DEFAULT_MAGNET } : null)}
        />
        Recess a magnet pocket into the back
      </label>
      {pocket !== null ? (
        <>
          <div style={{ ...ROW, marginTop: 6 }}>
            {MAGNET_PRESETS.map((p) => {
              const active =
                pocket.length === p.length && pocket.width === p.width && pocket.depth === p.depth;
              return (
                <button
                  key={p.label}
                  type="button"
                  title={p.hint}
                  data-testid={`badge-magnet-${p.length}x${p.width}x${p.depth}`}
                  aria-pressed={active}
                  style={active ? PRESET_ACTIVE : undefined}
                  onClick={() => setPocket({ length: p.length, width: p.width, depth: p.depth })}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <LabelledField
            label="Pocket"
            unit="mm"
            hint="Pocket length (X), width (Y) and depth up from the back face. Give a disc magnet its diameter for both length and width; leave a millimetre of wall per side. The pocket’s roof has to stay in the bottom colour."
          >
            <div style={ROW}>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={pocket.length}
                data-testid="badge-pocket-length"
                aria-label="Magnet pocket length"
                style={NUM}
                onChange={(e) => setPocket({ ...pocket, length: Number(e.target.value) })}
              />
              <span aria-hidden>×</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={pocket.width}
                data-testid="badge-pocket-width"
                aria-label="Magnet pocket width"
                style={NUM}
                onChange={(e) => setPocket({ ...pocket, width: Number(e.target.value) })}
              />
              <span aria-hidden>×</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={pocket.depth}
                data-testid="badge-pocket-depth"
                aria-label="Magnet pocket depth"
                style={NUM}
                onChange={(e) => setPocket({ ...pocket, depth: Number(e.target.value) })}
              />
              <span aria-hidden style={{ fontSize: 12, color: '#9aa4b0' }}>
                deep
              </span>
            </div>
          </LabelledField>
        </>
      ) : (
        <p style={HINT} data-testid="badge-pocket-none">
          No pocket — the badge backs onto its own engraved face, an adhesive strip, or a pin.
        </p>
      )}

      {problem !== null ? (
        <p style={PROBLEM} data-testid="part-problem">
          {problem}
        </p>
      ) : (
        <p style={HINT} data-testid="part-summary">
          A {mm(badge.width)} × {mm(badge.height)} × {mm(badge.thickness)} mm badge, R
          {mm(badge.cornerRadius)}, the colour changing at {mm(badge.splitHeight)} mm
          {pocket
            ? `, with a ${mm(pocket.length)} × ${mm(pocket.width)} mm pocket ${mm(
                pocket.depth,
              )} mm into the back (${mm(badge.thickness - pocket.depth)} mm of material over it)`
            : ', with no magnet pocket'}
          .
        </p>
      )}

      {stale.map((line) => (
        <p key={line} style={STALE} data-testid="part-job-note">
          {line}
        </p>
      ))}
    </div>
  );
}

/* ── the bare blank (#280) ─────────────────────────────────────────────────────────────────── */

function BlankEditor({ blank }: { blank: BlankParams }) {
  const patchCase = useProjectStore((s) => s.patchCase);
  const job = useEngraveJobStore((s) => s.job);

  /** Complete object, always — see the note at the top of this file. */
  const update = (partial: Partial<BlankParams>): void => {
    patchCase({ blank: { ...blank, ...partial } });
  };

  const problem = blankParamsProblem(blank);
  // Same pure bridge the Engrave panel's “Use the blank” button calls. Dimensions only: a blank
  // does not know its material, so nothing here says anything about one.
  const stale = staleStockLines(job, blankStockFor(blank).stock, 'Use the blank');

  return (
    <div className="panel-stack" data-testid="part-panel">
      <p style={HINT}>
        The blank itself — the piece of stock the CNC is about to cut. What gets cut into it is the
        engrave job’s business; this is only the material’s shape.
      </p>

      <h3 style={SUBHEAD}>Outline</h3>
      <LabelledField
        label="Size"
        unit="mm"
        hint="The blank’s length (X) and width (Y). These become the engrave job’s stock, and the corner radius does not — the job works to the bounding rectangle."
      >
        <div style={ROW}>
          <input
            type="number"
            min={1}
            step={1}
            value={blank.width}
            data-testid="blank-width"
            aria-label="Blank length"
            style={NUM}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            min={1}
            step={1}
            value={blank.height}
            data-testid="blank-height"
            aria-label="Blank width"
            style={NUM}
            onChange={(e) => update({ height: Number(e.target.value) })}
          />
        </div>
      </LabelledField>
      <div style={ROW}>
        {BLANK_SIZES.map((p) => {
          const active = blank.width === p.width && blank.height === p.height;
          return (
            <button
              key={p.label}
              type="button"
              title={p.hint}
              data-testid={`blank-size-${p.width}x${p.height}`}
              aria-pressed={active}
              style={active ? PRESET_ACTIVE : undefined}
              onClick={() => update({ width: p.width, height: p.height })}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <LabelledField
        label="Thickness"
        unit="mm"
        hint="Back face to cut face. The engrave job’s usable depth is this minus its own floor allowance."
      >
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={blank.thickness}
          data-testid="blank-thickness"
          style={NUM}
          onChange={(e) => update({ thickness: Number(e.target.value) })}
        />
      </LabelledField>
      <LabelledField
        label="Corner radius"
        unit="mm"
        hint="Rounding on the four corners, measured on the finished part; 0 is a plain rectangle. Nothing downstream models it, so this changes the printed part and not the engraving — the job works to the bounding rectangle, which leaves a little phantom material at each corner."
      >
        <input
          type="number"
          min={0}
          step={0.5}
          value={blank.cornerRadius}
          data-testid="blank-corner-radius"
          style={NUM}
          onChange={(e) => update({ cornerRadius: Number(e.target.value) })}
        />
      </LabelledField>

      {problem !== null ? (
        <p style={PROBLEM} data-testid="part-problem">
          {problem}
        </p>
      ) : (
        <p style={HINT} data-testid="part-summary">
          A {mm(blank.width)} × {mm(blank.height)} × {mm(blank.thickness)} mm blank
          {blank.cornerRadius > 0 ? `, R${mm(blank.cornerRadius)}` : ', square-cornered'}.
        </p>
      )}

      {stale.map((line) => (
        <p key={line} style={STALE} data-testid="part-job-note">
          {line}
        </p>
      ))}
    </div>
  );
}
