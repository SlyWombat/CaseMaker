/**
 * #1258 — THE TAB QUESTION AT THE POINT GENERATE STOPPED. Reads the run's result and the job; draws
 * `TabChoiceCard`; writes the operator's answer to the job and generates again. It is mounted in the
 * generate slot, above the Generate press, so the question sits where the flow stopped.
 *
 *   result asks (unanswered, or the answer is stale) → the question, or its bar after Cancel
 *   result done, the job holds an answer for the question last asked → the answered summary
 *   anything else → nothing
 *
 * "Change the tabs myself" collapses the card to its amber bar (the question stays visible, Generate
 * stays paused) and takes the operator to the cut-out's tab count; the stretches stay marked in the
 * preview. Generate asks again if the new tabs still leave a stretch too long.
 */
import type { JSX } from 'react';

import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useTabChoiceStore } from '@/store/tabChoiceStore';
import { TabChoiceCard } from './TabChoiceCard';
import { cutPosition, withCutNames } from './tabChoiceWords';

/** The tab settings are the cut-out row's count and width; bring the first such row's into view and focus it. */
function showTabSettings(row: number | null): void {
  const el = document.querySelector<HTMLElement>(
    row === null ? '[data-testid^="engrave-cutout-tabs-count-"]' : `[data-testid="engrave-cutout-tabs-count-${row}"]`,
  );
  if (el === null) return;
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

export function EngraveTabChoice({
  onGenerate,
  tabWidthMm,
  cutNames = [],
}: {
  onGenerate: () => void;
  tabWidthMm?: number;
  /** The job's cut-out rows as the operation list names them, in row order. */
  cutNames?: readonly string[];
}): JSX.Element | null {
  const generated = useEngraveRunStore((s) => s.generated);
  const answer = useEngraveJobStore((s) => s.job.tabChoice);
  const ui = useTabChoiceStore();
  const phone = useMediaQuery('(max-width: 640px)');
  const needed = generated?.tabChoiceNeeded;
  // Once answered, the plan states the question it honoured (same shape, plus the answer): the summary and "Change…" read it from the run's result, so a job reopened with an answer shows them too.
  const applied = generated?.plan?.tabChoiceApplied;
  const stale = generated?.tabChoiceStale === true;
  const use = (choice: 'insideMargin' | 'longerStretch'): void => {
    const q = needed ?? applied;
    if (q === undefined) return;
    useEngraveJobStore.getState().setTabChoice({ choice, answeredFor: q.fingerprint });
    ui.settle();
    onGenerate();
  };
  // Option 3 goes to a cut-out's tab count; a goal job has no such row, so it is not offered there.
  const canChangeTabs = useEngraveJobStore((s) => (s.job.cutouts?.length ?? 0) > 0);
  const common = {
    phone,
    canChangeTabs,
    ...(tabWidthMm === undefined ? {} : { tabWidthMm }),
    onUse: use,
    onCancel: () => ui.collapse(),
    onChoose: () => ui.expand(),
    onChange: () => ui.reopen(),
    // Option 3 is not an answer: the question stays visible as the bar (Generate stays paused), and the
    // operator goes to the cut-out's own tab count.
    onChangeTabs: () => {
      ui.collapse();
      const first = (needed ?? applied)?.stretches[0];
      showTabSettings(first === undefined ? null : cutPosition(first));
    },
  };
  if (needed !== undefined) {
    return <TabChoiceCard {...common} needed={withCutNames(needed, cutNames)} stale={stale} mode={ui.collapsed ? 'collapsed' : 'ask'} />;
  }
  if (applied !== undefined && answer !== undefined && answer.answeredFor === applied.fingerprint) {
    return ui.reopened ? (
      <TabChoiceCard {...common} needed={withCutNames(applied, cutNames)} mode="ask" />
    ) : (
      <TabChoiceCard {...common} needed={withCutNames(applied, cutNames)} mode="answered" answer={answer.choice} />
    );
  }
  return null;
}
