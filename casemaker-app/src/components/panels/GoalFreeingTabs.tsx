/**
 * #1271 — "TABS HOLDING THE PART": where a goal job states the tabs that hold its part while the
 * outline is cut free. One group inside the goal object's own row, the cut-out row's three fields
 * (tabs · width · height) in the same words.
 *
 * It starts from the shop's values and the job keeps its own: a field the operator has not typed
 * shows the shop's number and the job stores nothing; a typed field is outlined, is the job's own
 * and is the only thing stored. "Use the shop's" clears them. Below the fields one sentence says
 * what the planner did with the numbers, from the plan's own counts (placed, and added to meet the
 * span limit). The shop's three keys are read at the panel and handed in; this component reads
 * nothing ambient.
 */

import type { CSSProperties, JSX } from 'react';

// The registry first: `tabSettings` and `defaultsClient` are an import cycle, and the registry must
// finish evaluating before `tabSettings` is entered from here.
import { readDefault, ruleBounds, type ShopDefaults } from '@/platform/defaultsClient';
import { freeingTabsFrom } from '@/engine/cnc/cam/tabSettings';
import type { EngraveTargetObject } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

/** What the planner did with the tabs: `ContourOutcome.tabCounts`. */
export interface FreeingTabCounts {
  asked: number;
  placed: number;
  added: number;
  unplaceable: number;
}

/** The shop's three numbers and the span limit, read by the panel. */
export interface FreeingTabsShop {
  count: number;
  widthMm: number;
  heightMm: number;
  /** `tabs.maxSpanMm`: the longest stretch of outline left between two tabs. */
  limitMm: number;
}

/** The shop's freeing tabs and span limit from the settings map the panel holds (`null` = the recommendations). */
export function freeingTabsShopFrom(defaults: ShopDefaults | null): FreeingTabsShop {
  return { ...freeingTabsFrom(defaults), limitMm: readDefault(defaults, 'tabs.maxSpanMm').value };
}

export interface GoalFreeingTabsProps {
  target: Pick<EngraveTargetObject, 'tabs'>;
  index: number;
  shop: FreeingTabsShop;
  /** The last Generate's counts, or null before one (or when the result is stale). */
  counts: FreeingTabCounts | null;
  onChange: (tabs: EngraveTargetObject['tabs']) => void;
}

/**
 * The tab counts of the run's LAST setup's freeing contour (the one that frees the part), from the
 * plan's own result; null when the run has no plan or its contour stated none.
 */
export function freeingCountsOf(generated: EngraveGenerated | null): FreeingTabCounts | null {
  const perSetup = generated?.plan?.perSetup;
  const last = perSetup === undefined ? undefined : perSetup[perSetup.length - 1];
  const contour = last?.ops.find((op) => op.kind === 'contour');
  return contour?.outcome.tabCounts ?? null;
}

const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10.5, color: '#9aa4b0', flex: 1, minWidth: 0 };
const OWN = { border: '2px solid #4d8eff' } as const;
const MUTED: CSSProperties = { margin: '6px 0 0', fontSize: 12, color: '#c8d3de', lineHeight: 1.45 };

/** The registry's own bounds for the three keys, one source (#1207): the inputs offer no more than the rules allow. */
const BOUNDS = {
  count: ruleBounds('tabs.count'),
  widthMm: ruleBounds('tabs.freeingWidthMm'),
  heightMm: ruleBounds('tabs.heightMm'),
} as const;

const mmWords = (v: number): string => `${Number(v.toFixed(1))} mm`;
const tabsWords = (n: number): string => `${n} tab${n === 1 ? '' : 's'}`;

/** The one sentence under the fields, from the plan's counts. Null when there is nothing to say yet. */
export function freeingTabsSentence(
  counts: FreeingTabCounts | null,
  typedCount: boolean,
  limitMm: number,
  effectiveCount: number,
): string | null {
  if (effectiveCount === 0) return 'No tabs: the part is cut free and needs tape, glue or screws to keep it from moving.';
  if (counts === null) return null;
  const { asked, placed, added, unplaceable } = counts;
  if (added > 0) {
    return `${typedCount ? 'You asked' : 'The shop asks'} for ${tabsWords(asked)}; the shop's limit is ${mmWords(limitMm)}, so the planner placed ${placed} (${added} added).`;
  }
  if (unplaceable > 0) {
    return `${asked} asked, ${placed} placed — the remaining edges are too short for another tab clear of the corners.`;
  }
  return `${tabsWords(placed)} placed.`;
}

export function GoalFreeingTabs({ target, index, shop, counts, onChange }: GoalFreeingTabsProps): JSX.Element {
  const typed = target.tabs ?? {};
  const anyTyped = typed.count !== undefined || typed.widthMm !== undefined || typed.heightMm !== undefined;
  const effectiveCount = typed.count ?? shop.count;
  const sentence = freeingTabsSentence(counts, typed.count !== undefined, shop.limitMm, effectiveCount);

  /** Write one field: only what was typed is stored; an emptied field returns to the shop's. */
  const set = (field: 'count' | 'widthMm' | 'heightMm', raw: string): void => {
    const next: NonNullable<EngraveTargetObject['tabs']> = { ...typed };
    const text = raw.trim();
    if (text === '') delete next[field];
    else {
      const v = Number(text);
      if (!Number.isFinite(v)) return;
      // A typed value outside the registry's rule is not stored (the schema would refuse it too).
      const b = BOUNDS[field];
      if ((b.min !== undefined && v < b.min) || (b.max !== undefined && v > b.max)) return;
      if (field === 'count') {
        if (!Number.isInteger(v)) return;
        next.count = v;
      } else {
        next[field] = v;
      }
    }
    onChange(next);
  };

  return (
    <div
      data-testid={`engrave-goal-tabs-${index}`}
      style={{ borderTop: '1px dashed #2a3448', marginTop: 8, paddingTop: 8 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>Tabs holding the part</strong>
        {anyTyped ? (
          <button
            type="button"
            data-testid="engrave-goal-tabs-reset"
            onClick={() => onChange(undefined)}
            style={{ background: 'none', border: 'none', color: '#4d8eff', fontSize: 11, cursor: 'pointer', padding: 0, minHeight: 24, whiteSpace: 'nowrap' }}
          >
            {`Use the shop's (${shop.count} × ${Number(shop.widthMm.toFixed(2))} × ${Number(shop.heightMm.toFixed(2))})`}
          </button>
        ) : (
          <span style={{ fontSize: 11, color: '#7f8aa8' }} data-testid="engrave-goal-tabs-follows">the shop's values</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <label style={FIELD}>
          <span>tabs</span>
          <input
            type="number"
            min={BOUNDS.count.min}
            max={BOUNDS.count.max}
            step={1}
            value={typed.count ?? shop.count}
            data-testid="engrave-goal-tabs-count"
            aria-label="Tabs holding the part: how many"
            title="How many bridges of material hold the part while its outline is cut free. 0 cuts it free — which needs tape, glue or screws to keep it from moving."
            style={typed.count === undefined ? undefined : OWN}
            onChange={(e) => set('count', e.target.value)}
          />
        </label>
        <label style={FIELD}>
          <span>width</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="number"
              min={BOUNDS.widthMm.min}
              max={BOUNDS.widthMm.max}
              step="any"
              value={typed.widthMm ?? shop.widthMm}
              data-testid="engrave-goal-tabs-width"
              aria-label="Tabs holding the part: width in millimetres"
              title="Tab width in MATERIAL, mm. The cutter's centre stops one tool radius short on each side, so the move span is this plus two radii."
              style={{ minWidth: 0, width: '100%', ...(typed.widthMm === undefined ? {} : OWN) }}
              onChange={(e) => set('widthMm', e.target.value)}
            />
            <span>mm</span>
          </span>
        </label>
        <label style={FIELD}>
          <span>height</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="number"
              min={BOUNDS.heightMm.min}
              max={BOUNDS.heightMm.max}
              step="any"
              value={typed.heightMm ?? shop.heightMm}
              data-testid="engrave-goal-tabs-height"
              aria-label="Tabs holding the part: height in millimetres"
              title="Material left under the tab, measured up from the part's bottom face, mm."
              style={{ minWidth: 0, width: '100%', ...(typed.heightMm === undefined ? {} : OWN) }}
              onChange={(e) => set('heightMm', e.target.value)}
            />
            <span>mm</span>
          </span>
        </label>
      </div>
      {sentence !== null && (
        <p style={MUTED} data-testid="engrave-goal-tabs-said">
          {sentence}
        </p>
      )}
    </div>
  );
}
