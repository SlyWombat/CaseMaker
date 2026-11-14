/**
 * #1258 — THE HOLDING ROW'S SUFFIX: "4 tabs · 1 by your choice". Once the operator has answered the
 * tab question, the choice stays visible on the cut-out's own row after the card has scrolled away.
 * It reads the job's answer and the question it was given for (display state, `tabChoiceStore`), and
 * names the cut-out the engine says each stretch belongs to; when the engine does not say, the first
 * cut-out carries it.
 */
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useTabChoiceStore } from '@/store/tabChoiceStore';
import { holdingChoiceSuffix, type TabStretchOf } from './tabChoiceWords';

export function useTabChoiceSuffix(cutId: string, index: number): string | null {
  const answer = useEngraveJobStore((s) => s.job.tabChoice);
  const asked = useTabChoiceStore((s) => s.asked);
  if (answer === undefined || asked === null || answer.answeredFor !== asked.fingerprint) return null;
  const stretches = asked.stretches as readonly TabStretchOf[];
  const named = stretches.some((s) => s.cut !== undefined);
  const mine = named ? stretches.filter((s) => s.cut?.id === cutId) : index === 0 ? stretches : [];
  if (mine.length === 0) return null;
  return holdingChoiceSuffix(answer.choice, { ...asked, stretches: [...mine] });
}
