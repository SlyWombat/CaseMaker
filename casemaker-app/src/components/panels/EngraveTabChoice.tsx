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
import { useEffect } from 'react';
import type { JSX } from 'react';

import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useTabChoiceStore } from '@/store/tabChoiceStore';
import { TabChoiceCard } from './TabChoiceCard';

/** The tab settings are the cut-out row's count and width; bring the first into view and focus it. */
function showTabSettings(): void {
  const el = document.querySelector<HTMLElement>('[data-testid^="engrave-cutout-tabs-count-"]');
  if (el === null) return;
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

export function EngraveTabChoice({ onGenerate, tabWidthMm }: { onGenerate: () => void; tabWidthMm?: number }): JSX.Element | null {
  const generated = useEngraveRunStore((s) => s.generated);
  const answer = useEngraveJobStore((s) => s.job.tabChoice);
  const ui = useTabChoiceStore();
  const phone = useMediaQuery('(max-width: 640px)');
  const needed = generated?.tabChoiceNeeded;
  const stale = generated?.tabChoiceStale === true;
  useEffect(() => {
    if (needed !== undefined) ui.ask(needed, stale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed, stale]);
  const use = (choice: 'insideMargin' | 'longerStretch'): void => {
    const q = needed ?? ui.asked;
    if (q === null) return;
    useEngraveJobStore.getState().setTabChoice({ choice, answeredFor: q.fingerprint });
    ui.settle();
    onGenerate();
  };
  const common = {
    phone,
    ...(tabWidthMm === undefined ? {} : { tabWidthMm }),
    onUse: use,
    onCancel: () => ui.collapse(),
    onChoose: () => ui.expand(),
    onChange: () => ui.reopen(),
    // Option 3 is not an answer: the question stays visible as the bar (Generate stays paused), and the
    // operator goes to the cut-out's own tab count.
    onChangeTabs: () => {
      ui.collapse();
      showTabSettings();
    },
  };
  if (needed !== undefined) {
    return <TabChoiceCard {...common} needed={needed} stale={stale} mode={ui.collapsed ? 'collapsed' : 'ask'} />;
  }
  const asked = ui.asked;
  if (asked !== null && answer !== undefined && answer.answeredFor === asked.fingerprint) {
    return ui.reopened ? (
      <TabChoiceCard {...common} needed={asked} mode="ask" />
    ) : (
      <TabChoiceCard {...common} needed={asked} mode="answered" answer={answer.choice} />
    );
  }
  return null;
}
